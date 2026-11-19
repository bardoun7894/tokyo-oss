/**
 * npm run setup — first-time setup in the terminal.
 * Asks for your own API keys and your profile, then writes .env (mode 600).
 * Keys never leave this machine and are never asked in Telegram.
 */
import fs from "fs";
import path from "path";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { SETUP_STEPS, parseAnswer, mergeEnv, countryDefaults } from "../src/setup-steps";

const ROOT = path.join(__dirname, "..");
const ENV = path.join(ROOT, ".env");
const EXAMPLE = path.join(ROOT, ".env.example");

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

const mask = (v: string) => (v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)}` : "set");

const KEYS: { key: string; question: string; required: boolean; check?: (v: string) => string | null }[] = [
  { key: "TELEGRAM_BOT_TOKEN", question: "Telegram bot token (create a bot with @BotFather)", required: true,
    check: (v) => (/^\d+:[\w-]{20,}$/.test(v) ? null : "That doesn't look like a bot token (123456:ABC...).") },
  { key: "TELEGRAM_USER_ID", question: "Your numeric Telegram user id (ask @userinfobot)", required: true,
    check: (v) => (/^\d+$/.test(v) ? null : "Digits only.") },
  { key: "ANTHROPIC_API_KEY", question: "Anthropic API key", required: true },
  { key: "OPENROUTER_API_KEY", question: "OpenRouter API key (optional: voice notes and the free model)", required: false },
];

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q: string) => (await rl.question(q)).trim();

  console.log("\nTokyo setup. Press Enter to keep the value in [brackets], type - to leave it empty.\n");

  let base = "";
  if (fs.existsSync(ENV)) {
    const ok = (await ask(".env already exists. Update it? Lines you don't answer stay as they are. [Y/n] ")).toLowerCase();
    if (ok === "n" || ok === "no") { rl.close(); return; }
    base = fs.readFileSync(ENV, "utf-8");
  } else if (fs.existsSync(EXAMPLE)) {
    base = fs.readFileSync(EXAMPLE, "utf-8");
  }
  const existing = parseEnv(base);
  const values: Record<string, string> = {};

  console.log("— Your keys (stay in .env on this machine) —");
  for (const k of KEYS) {
    const now = existing[k.key];
    for (;;) {
      const a = await ask(`${k.question}${now ? ` [${mask(now)}]` : ""}: `);
      if (!a) {
        if (now || !k.required) break;
        console.log("  Required.");
        continue;
      }
      if (a === "-") { values[k.key] = ""; break; }
      const err = k.check?.(a);
      if (err) { console.log(`  ${err}`); continue; }
      values[k.key] = a;
      break;
    }
  }

  console.log("\n— About you —");
  const answers: Record<string, string> = {};
  for (const step of SETUP_STEPS) {
    const now = existing[step.key];
    const suggestion = step.suggest?.({ ...existing, ...answers });
    const fallback = now || suggestion || (step.kind === "bool" ? "1" : "");
    const shown = step.kind === "bool" ? (fallback === "0" ? "y/N" : "Y/n") : fallback;
    if (step.hint) console.log(`  (${step.hint})`);
    for (;;) {
      const a = await ask(`${step.question}${shown ? ` [${shown}]` : ""}: `);
      if (a === "-") { values[step.key] = ""; break; }
      const parsed = parseAnswer(step, a || (step.kind === "bool" ? (fallback === "0" ? "no" : "yes") : fallback));
      if (parsed.error) { console.log(`  ${parsed.error}`); continue; }
      if (parsed.value !== undefined) { values[step.key] = parsed.value; answers[step.key] = parsed.value; }
      break;
    }
  }

  // A known country also picks the prayer calculation method.
  if (values.FEATURE_PRAYER === "1") {
    const method = countryDefaults(answers.PROFILE_COUNTRY ?? existing.PROFILE_COUNTRY)?.prayerMethod;
    if (method && !existing.PRAYER_METHOD) values.PRAYER_METHOD = method;
  }

  fs.writeFileSync(ENV, mergeEnv(base, values), { mode: 0o600 });
  fs.chmodSync(ENV, 0o600);
  rl.close();

  console.log(`
Saved ${ENV} (readable only by you).

Next:
  npm start             start Tokyo, then send /start to your bot
  /setup in Telegram    change your profile any time (keys are never asked there)

Note: profile values saved later from Telegram /setup or the dashboard Settings page
win over .env. To go back to the .env value, reset that setting on the dashboard.
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
