# Tokyo

A personal AI assistant that runs your work and life from Telegram and WhatsApp, with a React dashboard.

Tokyo keeps tasks, habits, goals, journal, money, clients and projects in one SQLite database, reads your WhatsApp messages and drafts replies in your own voice, transcribes voice notes, plans your day around your work (and prayer times, if you want them), and can hand coding work to Claude Code agents on your server.

It is built for anyone: you tell it your name, country, language or dialect, currency and work during setup, and turn on only the parts you need.

Built by [Mohamed Bardouni](https://www.mbardouni.dev) ([GitHub](https://github.com/bardoun7894)).

## Features

- **Telegram bot** (grammY): tasks, habits, goals, journal, work sessions, income and expenses, clients, reminders, a morning brief and an evening review.
- **WhatsApp bridge** (Baileys): forwards messages to Telegram with a detected intent, drafts replies that match your tone and dialect, and can auto-reply per contact. It also turns client requests into tasks and keeps per-project transcripts.
- **Voice notes**: speech-to-text through a self-hosted Whisper endpoint, OpenRouter or Gemini.
- **Agents**: coaching, productivity, finance, research, DevOps and, optionally, deen (prayer times, Quran and adhkar tracking), each with its own prompt section and actions.
- **Missions and deploy offers**: run Claude Code on a registered project, then approve or decline a deploy from a Telegram card.
- **Control layer and dashboard** (Express + React/Vite): ops overview, incidents, services, agents, projects, finance, shop sales, WhatsApp, transcripts and settings.
- **Shop sales group** (optional): a seller posts sale amounts in a WhatsApp group, and Tokyo logs them and answers totals.
- **Social**: an AI-news-to-LinkedIn post pipeline and adapters for YouTube, TikTok and Facebook.

## Requirements

- Node.js 22+
- A Telegram bot token from @BotFather and your Telegram user ID
- An Anthropic API key, or an OpenRouter or Gemini key for the cheaper paths
- Optional: a WhatsApp account to link as a device, a Whisper endpoint, a Temporal server, and pm2 for production

## Setup

```bash
git clone <this repo> tokyo && cd tokyo
npm install
npm run setup     # asks for your own keys and your profile, writes .env (mode 600)
npm start         # then send /start to your bot
```

`npm run setup` asks for:

- **Your keys**: Telegram bot token, your Telegram user ID, Anthropic key, optional OpenRouter key. They are written to `.env` on your machine only. The repo ships with no keys, and Tokyo never asks for keys in chat.
- **Your profile**: name, country, city, timezone, reply language or dialect (for example Egyptian Arabic, Moroccan Darija, French or English), currency, your work or expertise, and your goals. For a known country it fills in the timezone, currency and dialect for you.
- **Features**: prayer times and worship tracking, a shop sales group, and the WhatsApp bridge. Each one can be turned on or off.

Change your profile later with `/setup` in Telegram (same questions, no keys) or on the dashboard Settings page. Values saved there take priority over `.env`.

Optional:

```bash
cp owner-profile.example.md owner-profile.md   # extra notes about you, appended to every prompt
cp projects.example.json projects.json         # your project list, for the coding/deploy features
```

Dashboard:

```bash
cd dashboard && npm install && npm run dev
```

Production:

```bash
npm run build && pm2 start ecosystem.config.example.js
```

Link WhatsApp from the dashboard's WhatsApp page by scanning the QR code. Session files are written to `whatsapp-auth/`, which is git-ignored.

## Make it yours

Nothing personal is hard-coded. Each value is read at runtime from the settings saved by `/setup` or the dashboard, then from `.env`, then from a neutral default:

| What | Setting / `.env` key | Default |
| --- | --- | --- |
| Your name | `PROFILE_NAME` | "the owner" |
| Country and city | `PROFILE_COUNTRY`, `PROFILE_CITY` | none |
| Timezone | `TIMEZONE` | UTC |
| Reply language or dialect | `PROFILE_LANGUAGE` | the language you write in |
| Currency | `CURRENCY` | USD |
| Your work and goals | `PROFILE_WORK`, `PROFILE_GOALS` | none |
| Prayer times, adhkar and Quran | `FEATURE_PRAYER`, `PRAYER_CITY`, `PRAYER_METHOD` | on; city falls back to yours |
| Shop sales group | `FEATURE_SHOP` + `MYSHOP_GROUP_JIDS` | on, but inactive until a group is set |
| WhatsApp bridge | `FEATURE_WHATSAPP` | on (pair from the dashboard) |
| Extra notes for the prompts | `OWNER_PROFILE_FILE` (markdown) | none |
| Your projects, for coding and deploys | `PROJECTS_FILE` (JSON) | an example list |

With prayer off, Tokyo drops the prayer reminders, the deen agent and every prayer mention in its prompts, and plans your day in plain blocks (09–13, 14–18, 19–22). With no shop group set, shop lines never appear in summaries. Daily jobs (morning brief, evening review) run on your timezone, not the server's.

Your data stays local. `*.db`, `.env`, `whatsapp-auth*/`, media, transcripts and logs are all git-ignored.

## Tests

```bash
npm test          # node:test through tsx
npx tsc --noEmit  # typecheck
```

## Layout

```
src/            bot, WhatsApp bridge, agents, control layer, dashboard API
src/control/    ops, incidents, services, agents, deploy and mission offers
src/agents/     per-domain agent prompts and actions
dashboard/      React + Vite dashboard
packages/ui/    shared UI kit (Geist tokens and primitives)
```

## License

MIT, see [LICENSE](LICENSE).
