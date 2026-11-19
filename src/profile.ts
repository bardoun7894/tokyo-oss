import fs from "fs";
import { setting, settingOn } from "./settings";

/**
 * Who Tokyo works for. Nothing personal lives in the code: every value comes from
 * the settings table (dashboard or Telegram /setup), then .env, then a neutral default.
 * All getters read at call time, so a change from /setup applies to the next message.
 */

const DEFAULT_NAME = "The owner";

export function ownerName(): string {
  const name = setting("PROFILE_NAME")?.trim();
  if (name && name !== DEFAULT_NAME) return name;
  return process.env.OWNER_NAME?.trim() || "the owner";
}

/** ISO code or symbol shown next to amounts. */
export function currency(): string {
  return setting("CURRENCY")?.trim() || "USD";
}

export function replyLanguage(): string {
  return setting("PROFILE_LANGUAGE")?.trim() || "";
}

/** One prompt line on which language to answer in. */
export function languageRule(): string {
  const lang = replyLanguage();
  return lang
    ? `Answer in ${lang} unless the user writes in another language; then answer in theirs.`
    : "Answer in the language the user writes in.";
}

export function timezone(): string {
  return process.env.TIMEZONE?.trim() || "UTC";
}

export function prayerOn(): boolean {
  return settingOn("FEATURE_PRAYER");
}

export function whatsappOn(): boolean {
  return settingOn("FEATURE_WHATSAPP");
}

/** The shop switch is on AND a shop group is configured. A user without a shop never sees shop lines. */
export function shopOn(): boolean {
  const jids = (process.env.MYSHOP_GROUP_JIDS || process.env.MYSHOP_GROUP_JID || "").split(",").map((s) => s.trim()).filter(Boolean);
  return settingOn("FEATURE_SHOP") && jids.length > 0;
}

function extraProfile(): string {
  const file = process.env.OWNER_PROFILE_FILE;
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf-8").trim();
  } catch {
    return "";
  }
}

/** The "who is the owner" block for system prompts, built from the profile settings. */
export function ownerProfile(): string {
  const lines: string[] = [`## Who is the owner`, `- Name: ${ownerName()}`];
  const city = setting("PROFILE_CITY")?.trim();
  const country = setting("PROFILE_COUNTRY")?.trim();
  const place = [city, country].filter(Boolean).join(", ");
  lines.push(`- ${place ? `Lives in ${place}. ` : ""}Timezone: ${timezone()}.`);
  const work = setting("PROFILE_WORK")?.trim();
  if (work) lines.push(`- Work and expertise: ${work}. Plan, coach and give examples that fit this work.`);
  const goals = setting("PROFILE_GOALS")?.trim();
  if (goals) lines.push(`- Main goals: ${goals}`);
  const lang = replyLanguage();
  if (lang) lines.push(`- Preferred language: ${lang}.`);
  lines.push(`- Money is in ${currency()}.`);
  if (prayerOn()) {
    lines.push(`- Practising Muslim: schedule around the five daily prayers (Work Windows in context), keep Friday light, encourage Quran reading and adhkar.`);
  }
  if (shopOn()) lines.push(`- Runs a shop whose sales are logged from a WhatsApp group.`);
  const extra = extraProfile();
  return extra ? `${lines.join("\n")}\n\n${extra}` : lines.join("\n");
}
