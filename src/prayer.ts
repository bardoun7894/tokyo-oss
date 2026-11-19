import db from "./db";
import type { PrayerTimes, NextPrayer, TimeSlot } from "./types";
import { localToday, localNow } from "./utils";
import { setting } from "./settings";
import { prayerOn } from "./profile";

const PRAYER_BUFFER_MINUTES = 20; // buffer after each prayer time

// Fallback times (approximate Riyadh)
const FALLBACK_TIMES: PrayerTimes = {
  fajr: "04:30",
  sunrise: "05:55",
  dhuhr: "12:00",
  asr: "15:15",
  maghrib: "18:00",
  isha: "19:30",
};

/** After a city/country/method change: drop cached times from today on so they refetch. */
export function clearCachedPrayerTimes(): void {
  db.prepare("DELETE FROM prayer_times WHERE date >= ?").run(localToday());
}

export function initPrayerTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prayer_times (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      fajr TEXT NOT NULL,
      sunrise TEXT NOT NULL,
      dhuhr TEXT NOT NULL,
      asr TEXT NOT NULL,
      maghrib TEXT NOT NULL,
      isha TEXT NOT NULL,
      fetched_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

async function fetchFromAladhan(date: string): Promise<PrayerTimes | null> {
  const city = setting("PRAYER_CITY") || setting("PROFILE_CITY") || "Riyadh";
  const country = setting("PRAYER_COUNTRY") || setting("PROFILE_COUNTRY") || "Saudi Arabia";
  const method = setting("PRAYER_METHOD") || "4"; // Umm Al-Qura

  try {
    const [year, month, day] = date.split("-");
    const url = `https://api.aladhan.com/v1/timingsByCity/${day}-${month}-${year}?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&method=${method}`;

    const res = await fetch(url);
    if (!res.ok) return null;

    const data: any = await res.json();
    const timings = data.data.timings;

    return {
      fajr: timings.Fajr.replace(/ \(.*\)/, ""),
      sunrise: timings.Sunrise.replace(/ \(.*\)/, ""),
      dhuhr: timings.Dhuhr.replace(/ \(.*\)/, ""),
      asr: timings.Asr.replace(/ \(.*\)/, ""),
      maghrib: timings.Maghrib.replace(/ \(.*\)/, ""),
      isha: timings.Isha.replace(/ \(.*\)/, ""),
    };
  } catch (err) {
    console.error("Aladhan API error:", err);
    return null;
  }
}

function getCachedTimes(date: string): PrayerTimes | null {
  const row = db.prepare("SELECT * FROM prayer_times WHERE date = ?").get(date) as any;
  if (!row) return null;
  return {
    fajr: row.fajr,
    sunrise: row.sunrise,
    dhuhr: row.dhuhr,
    asr: row.asr,
    maghrib: row.maghrib,
    isha: row.isha,
  };
}

function cacheTimes(date: string, times: PrayerTimes): void {
  db.prepare(
    "INSERT OR REPLACE INTO prayer_times (date, fajr, sunrise, dhuhr, asr, maghrib, isha) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(date, times.fajr, times.sunrise, times.dhuhr, times.asr, times.maghrib, times.isha);
}

export async function getTodayPrayerTimes(): Promise<PrayerTimes> {
  const today = localToday();

  // Check cache first
  const cached = getCachedTimes(today);
  if (cached) return cached;

  // Fetch from API
  const fetched = await fetchFromAladhan(today);
  if (fetched) {
    cacheTimes(today, fetched);
    return fetched;
  }

  // Fallback
  return FALLBACK_TIMES;
}

export async function prefetchTomorrow(): Promise<void> {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().split("T")[0];

  if (!getCachedTimes(dateStr)) {
    const fetched = await fetchFromAladhan(dateStr);
    if (fetched) cacheTimes(dateStr, fetched);
  }
}

function timeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

function nowMinutes(): number {
  const now = localNow();
  return now.getHours() * 60 + now.getMinutes();
}

/** With prayer off, nothing is "about to start": callers that wrap up work before a prayer stay quiet. */
const NO_PRAYER: NextPrayer = { name: "none", time: "00:00", minutesUntil: 24 * 60 };

/** With prayer off, the day splits into plain working blocks instead of the gaps between prayers. */
const PLAIN_WORK_WINDOWS: TimeSlot[] = [
  { start: "09:00", end: "13:00", durationMinutes: 240, label: "Morning" },
  { start: "14:00", end: "18:00", durationMinutes: 240, label: "Afternoon" },
  { start: "19:00", end: "22:00", durationMinutes: 180, label: "Evening" },
];

export async function getNextPrayer(): Promise<NextPrayer> {
  if (!prayerOn()) return NO_PRAYER;
  const times = await getTodayPrayerTimes();
  const now = nowMinutes();

  const prayers: { name: string; time: string }[] = [
    { name: "Fajr", time: times.fajr },
    { name: "Dhuhr", time: times.dhuhr },
    { name: "Asr", time: times.asr },
    { name: "Maghrib", time: times.maghrib },
    { name: "Isha", time: times.isha },
  ];

  for (const prayer of prayers) {
    const mins = timeToMinutes(prayer.time);
    if (mins > now) {
      return { name: prayer.name, time: prayer.time, minutesUntil: mins - now };
    }
  }

  // All prayers passed — next is tomorrow's Fajr
  const fajrMins = timeToMinutes(times.fajr);
  return { name: "Fajr (tomorrow)", time: times.fajr, minutesUntil: (24 * 60 - now) + fajrMins };
}

export async function getWorkWindows(): Promise<TimeSlot[]> {
  if (!prayerOn()) return PLAIN_WORK_WINDOWS.map((w) => ({ ...w }));
  const times = await getTodayPrayerTimes();
  const slots: TimeSlot[] = [];

  const boundaries = [
    { start: times.fajr, end: times.dhuhr, label: "After Fajr" },
    { start: times.dhuhr, end: times.asr, label: "After Dhuhr" },
    { start: times.asr, end: times.maghrib, label: "After Asr" },
    { start: times.maghrib, end: times.isha, label: "After Maghrib" },
    { start: times.isha, end: "22:00", label: "After Isha" },
  ];

  for (const b of boundaries) {
    const startMins = timeToMinutes(b.start) + PRAYER_BUFFER_MINUTES;
    const endMins = timeToMinutes(b.end);
    const duration = endMins - startMins;

    if (duration > 0) {
      const startH = Math.floor(startMins / 60).toString().padStart(2, "0");
      const startM = (startMins % 60).toString().padStart(2, "0");
      slots.push({
        start: `${startH}:${startM}`,
        end: b.end,
        durationMinutes: duration,
        label: b.label,
      });
    }
  }

  return slots;
}

/** ms from now until HH:MM today on the user's clock (prayer times are in the user's timezone, not the server's). */
export function msUntilTime(timeStr: string): number {
  const now = localNow();
  const [h, m] = timeStr.split(":").map(Number);
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  return target.getTime() - now.getTime();
}

export function formatPrayerTimesCompact(times: PrayerTimes): string {
  return `Fajr: ${times.fajr} | Dhuhr: ${times.dhuhr} | Asr: ${times.asr} | Maghrib: ${times.maghrib} | Isha: ${times.isha}`;
}
