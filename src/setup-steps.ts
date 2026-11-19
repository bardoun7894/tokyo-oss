/**
 * The profile questions shared by `npm run setup` (terminal) and /setup (Telegram).
 * Pure: no database, no network, so the terminal wizard can run before Tokyo is installed.
 * API keys are NOT here on purpose: they only go into .env through the terminal wizard,
 * never through chat.
 */

export interface SetupStep {
  key: string;
  question: string;
  kind: "text" | "bool";
  /** Example shown under the question. */
  hint?: string;
  /** A ready answer built from earlier answers (e.g. timezone from country). */
  suggest?: (answers: Record<string, string>) => string | undefined;
}

interface CountryDefaults { timezone: string; currency: string; language: string; prayerMethod: string }

// Common countries; anything else just gets no suggestion and the user types it.
const COUNTRIES: Record<string, CountryDefaults> = {
  egypt: { timezone: "Africa/Cairo", currency: "EGP", language: "Egyptian Arabic", prayerMethod: "5" },
  morocco: { timezone: "Africa/Casablanca", currency: "MAD", language: "Moroccan Darija", prayerMethod: "21" },
  algeria: { timezone: "Africa/Algiers", currency: "DZD", language: "Algerian Darija", prayerMethod: "3" },
  tunisia: { timezone: "Africa/Tunis", currency: "TND", language: "Tunisian Darija", prayerMethod: "3" },
  libya: { timezone: "Africa/Tripoli", currency: "LYD", language: "Libyan Arabic", prayerMethod: "3" },
  sudan: { timezone: "Africa/Khartoum", currency: "SDG", language: "Sudanese Arabic", prayerMethod: "5" },
  "saudi arabia": { timezone: "Asia/Riyadh", currency: "SAR", language: "Saudi Arabic", prayerMethod: "4" },
  "united arab emirates": { timezone: "Asia/Dubai", currency: "AED", language: "Gulf Arabic", prayerMethod: "16" },
  qatar: { timezone: "Asia/Qatar", currency: "QAR", language: "Gulf Arabic", prayerMethod: "4" },
  kuwait: { timezone: "Asia/Kuwait", currency: "KWD", language: "Gulf Arabic", prayerMethod: "4" },
  bahrain: { timezone: "Asia/Bahrain", currency: "BHD", language: "Gulf Arabic", prayerMethod: "4" },
  oman: { timezone: "Asia/Muscat", currency: "OMR", language: "Gulf Arabic", prayerMethod: "4" },
  jordan: { timezone: "Asia/Amman", currency: "JOD", language: "Levantine Arabic", prayerMethod: "3" },
  lebanon: { timezone: "Asia/Beirut", currency: "LBP", language: "Levantine Arabic", prayerMethod: "3" },
  syria: { timezone: "Asia/Damascus", currency: "SYP", language: "Levantine Arabic", prayerMethod: "3" },
  palestine: { timezone: "Asia/Hebron", currency: "ILS", language: "Levantine Arabic", prayerMethod: "3" },
  iraq: { timezone: "Asia/Baghdad", currency: "IQD", language: "Iraqi Arabic", prayerMethod: "3" },
  turkey: { timezone: "Europe/Istanbul", currency: "TRY", language: "Turkish", prayerMethod: "13" },
  france: { timezone: "Europe/Paris", currency: "EUR", language: "French", prayerMethod: "12" },
  germany: { timezone: "Europe/Berlin", currency: "EUR", language: "German", prayerMethod: "3" },
  spain: { timezone: "Europe/Madrid", currency: "EUR", language: "Spanish", prayerMethod: "3" },
  "united kingdom": { timezone: "Europe/London", currency: "GBP", language: "English", prayerMethod: "3" },
  "united states": { timezone: "America/New_York", currency: "USD", language: "English", prayerMethod: "2" },
  canada: { timezone: "America/Toronto", currency: "CAD", language: "English", prayerMethod: "2" },
  pakistan: { timezone: "Asia/Karachi", currency: "PKR", language: "Urdu", prayerMethod: "1" },
  india: { timezone: "Asia/Kolkata", currency: "INR", language: "English", prayerMethod: "1" },
  indonesia: { timezone: "Asia/Jakarta", currency: "IDR", language: "Indonesian", prayerMethod: "20" },
  malaysia: { timezone: "Asia/Kuala_Lumpur", currency: "MYR", language: "Malay", prayerMethod: "17" },
  nigeria: { timezone: "Africa/Lagos", currency: "NGN", language: "English", prayerMethod: "3" },
};

const ALIASES: Record<string, string> = {
  "مصر": "egypt", "masr": "egypt", "المغرب": "morocco", "maroc": "morocco", "الجزائر": "algeria", "algerie": "algeria",
  "تونس": "tunisia", "tunisie": "tunisia", "ليبيا": "libya", "السودان": "sudan",
  "السعودية": "saudi arabia", "saudi": "saudi arabia", "ksa": "saudi arabia",
  "الإمارات": "united arab emirates", "الامارات": "united arab emirates", "uae": "united arab emirates", "emirates": "united arab emirates",
  "قطر": "qatar", "الكويت": "kuwait", "البحرين": "bahrain", "عمان": "oman", "عُمان": "oman",
  "الأردن": "jordan", "الاردن": "jordan", "لبنان": "lebanon", "سوريا": "syria", "فلسطين": "palestine", "العراق": "iraq",
  "تركيا": "turkey", "türkiye": "turkey", "turkiye": "turkey", "فرنسا": "france", "ألمانيا": "germany", "المانيا": "germany",
  "إسبانيا": "spain", "اسبانيا": "spain", "uk": "united kingdom", "england": "united kingdom", "britain": "united kingdom",
  "usa": "united states", "us": "united states", "america": "united states",
};

export function countryDefaults(country: string | undefined): CountryDefaults | undefined {
  if (!country) return undefined;
  const k = country.trim().toLowerCase();
  return COUNTRIES[ALIASES[k] ?? ALIASES[country.trim()] ?? k];
}

export const SETUP_STEPS: SetupStep[] = [
  { key: "PROFILE_NAME", kind: "text", question: "What should I call you?" },
  { key: "PROFILE_COUNTRY", kind: "text", question: "Which country do you live in?", hint: "e.g. Egypt" },
  { key: "PROFILE_CITY", kind: "text", question: "Which city?", hint: "e.g. Cairo. Used for prayer times if you turn them on." },
  { key: "TIMEZONE", kind: "text", question: "Your timezone?", hint: "IANA name, e.g. Africa/Cairo",
    suggest: (a) => countryDefaults(a.PROFILE_COUNTRY)?.timezone },
  { key: "PROFILE_LANGUAGE", kind: "text", question: "Which language or dialect should I answer in?",
    hint: "e.g. Egyptian Arabic, English, French. Skip: I answer in the language you write in.",
    suggest: (a) => countryDefaults(a.PROFILE_COUNTRY)?.language },
  { key: "CURRENCY", kind: "text", question: "Which currency do you use?", hint: "e.g. EGP, USD, EUR",
    suggest: (a) => countryDefaults(a.PROFILE_COUNTRY)?.currency },
  { key: "PROFILE_WORK", kind: "text", question: "What do you do? Your job, field or expertise.",
    hint: "e.g. Accountant in a small firm, Nurse on night shifts, Student in medicine, Freelance designer" },
  { key: "PROFILE_GOALS", kind: "text", question: "Your main goals right now? One or two lines.",
    hint: "e.g. Pass my exams in June, save 20% of my salary, get 3 new clients" },
  { key: "FEATURE_PRAYER", kind: "bool", question: "Do you want prayer times, adhkar and Quran tracking, with your day planned around prayers?" },
  { key: "FEATURE_SHOP", kind: "bool", question: "Do you run a shop and want sales tracked from a WhatsApp group?",
    hint: "Also needs MYSHOP_GROUP_JIDS in .env. Most people answer No." },
  { key: "FEATURE_WHATSAPP", kind: "bool", question: "Connect your WhatsApp so Tokyo can read and help answer messages?",
    hint: "You pair it once by scanning a QR code from the dashboard." },
];

const YES = new Set(["y", "yes", "1", "on", "true", "نعم", "اه", "آه", "ايوه", "أيوه", "ايوا", "واخا", "oui"]);
const NO = new Set(["n", "no", "0", "off", "false", "لا", "لأ", "non"]);
const SKIP = new Set(["skip", "-", "تخطي", "/skip"]);

/**
 * Turns a raw answer into the stored value.
 * `skip` true: keep what is there. `error` set: ask again.
 */
export function parseAnswer(step: SetupStep, raw: string): { value?: string; skip?: boolean; error?: string } {
  const text = raw.trim();
  if (!text || SKIP.has(text.toLowerCase())) return { skip: true };
  if (step.kind === "bool") {
    const t = text.toLowerCase();
    if (YES.has(t)) return { value: "1" };
    if (NO.has(t)) return { value: "0" };
    return { error: "Please answer yes or no." };
  }
  if (text.length > 200) return { error: "Please keep it under 200 characters." };
  if (step.key === "TIMEZONE") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: text });
    } catch {
      return { error: "I don't know that timezone. Use a name like Africa/Cairo or Europe/Paris." };
    }
  }
  if (step.key === "CURRENCY") return { value: text.toUpperCase() };
  return { value: text };
}

/**
 * Sets KEY=value lines in a .env text, keeping every other line and comment.
 * Values with spaces, # or quotes are double-quoted.
 */
export function mergeEnv(text: string, values: Record<string, string>): string {
  const quote = (v: string) => (/[\s#"'\\]/.test(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v);
  const lines = text.split("\n");
  const done = new Set<string>();
  const out = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (!m || !(m[1] in values) || done.has(m[1])) return line;
    done.add(m[1]);
    return `${m[1]}=${quote(values[m[1]])}`;
  });
  const missing = Object.keys(values).filter((k) => !done.has(k));
  if (missing.length) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    for (const k of missing) out.push(`${k}=${quote(values[k])}`);
    out.push("");
  }
  return out.join("\n");
}
