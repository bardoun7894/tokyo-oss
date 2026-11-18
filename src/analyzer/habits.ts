import * as db from "../db";

export interface HabitsData {
  responseTime: { [jid: string]: { name: string; avgMinutes: number } };
  frequency: { date: string; count: number }[];
  heatmap: number[][];
  messageLength: { date: string; avgChars: number }[];
}

export function computeHabits(): HabitsData {
  const allMessages = db.getAllMessageTimestamps(5000);
  const responseTime: HabitsData["responseTime"] = {};

  const byJid: Record<string, { name: string; timestamps: { ts: number; fromMe: number }[] }> = {};
  for (const m of allMessages) {
    if (!byJid[m.jid]) byJid[m.jid] = { name: m.sender_name || m.jid, timestamps: [] };
    byJid[m.jid].timestamps.push({ ts: m.timestamp, fromMe: m.from_me });
  }

  for (const [jid, data] of Object.entries(byJid)) {
    const sorted = data.timestamps.sort((a, b) => a.ts - b.ts);
    let totalDelay = 0;
    let pairCount = 0;

    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].fromMe === 0 && sorted[i + 1].fromMe === 1) {
        totalDelay += (sorted[i + 1].ts - sorted[i].ts) / 60;
        pairCount++;
      }
    }

    if (pairCount > 0) {
      responseTime[jid] = { name: data.name, avgMinutes: Math.round(totalDelay / pairCount) };
    }
  }

  const freqMap: Record<string, number> = {};
  for (const m of allMessages) {
    const date = new Date(m.timestamp * 1000).toISOString().split("T")[0];
    freqMap[date] = (freqMap[date] || 0) + 1;
  }
  const frequency = Object.entries(freqMap)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const m of allMessages) {
    const date = new Date(m.timestamp * 1000);
    const day = date.getDay();
    const hour = date.getHours();
    heatmap[day][hour]++;
  }

  const messageLength = db.getMessageLengths();

  return { responseTime, frequency, heatmap, messageLength };
}
