# 013 — Setup for any user

## Why

Tokyo was written for one person: Moroccan time, dirhams, Darija, a family shop and prayer
times were hard-wired. Someone in Egypt, or anyone without a shop, should be able to install
it and get an assistant that fits their own country, language, money, work and routines.

## What

- **Profile settings** (settings table, then `.env`, then a neutral default): name, country,
  city, timezone (UTC), reply language or dialect (the user's own), currency (USD), work and
  expertise, goals. `src/profile.ts` builds the "who is the owner" prompt block from them,
  read on every call.
- **Feature switches**: `FEATURE_PRAYER`, `FEATURE_SHOP` (also needs a shop group JID),
  `FEATURE_WHATSAPP`. Off means gone: no reminders, no agent, no prompt lines, no summary lines.
- **`npm run setup`** (terminal): asks for the user's own keys and the profile, and writes
  `.env` with mode 600. A known country pre-fills timezone, currency, dialect and the prayer method.
- **`/setup`** (Telegram, owner only): the same profile questions, saved to the settings
  table. Never asks for keys.
- **Dashboard**: a Features section, and the configured currency on every amount.
- Daily jobs and prayer timers run on the user's timezone, not the server's.

## Not in scope

Project registry, deploy offers, laptop bridge and control layer (developer tooling, unchanged).
Database column defaults stay as they are; new rows get the configured currency.

## Done when

| # | Flow | Expected |
|---|------|----------|
| 1 | Fresh clone, `npm run setup`, country "Egypt" | Suggests Africa/Cairo, EGP, Egyptian Arabic; `.env` written, mode 600 |
| 2 | `/setup` in Telegram, prayer No, shop No | Saved; next `/start` and `/help` show no deen or shop lines |
| 3 | `/income 500 direct` with currency EGP | "Logged: 500 EGP from direct" |
| 4 | Morning brief with prayer off | No prayer times, no Quran/adhkar, no بسم الله |
| 5 | Prayer on, server in UTC, user in Africa/Cairo | Prayer reminders fire at Cairo prayer times |
| 6 | No `MYSHOP_GROUP_JIDS` | No shop lines in `/money`, reports or coaching |
| 7 | Settings → Profile → Currency changed on the dashboard | Amounts on Home, Finance and Money use it |
| 8 | A stranger sends `/setup` to the bot | Dropped by the owner guard |
