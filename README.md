# Tokyo

A personal AI assistant that runs your work and life from Telegram and WhatsApp, with a React dashboard.

Tokyo keeps tasks, habits, goals, journal, money, clients and projects in one SQLite database, reads your WhatsApp messages and drafts replies in your own voice, transcribes voice notes, schedules work around fixed routines such as prayer times, and can hand coding work to Claude Code agents on your server.

Built by [Mohamed Bardouni](https://www.mbardouni.dev) ([GitHub](https://github.com/bardoun7894)).

## Features

- **Telegram bot** (grammY): tasks, habits, goals, journal, work sessions, income and expenses, clients, reminders, a morning brief and an evening review.
- **WhatsApp bridge** (Baileys): forwards messages to Telegram with a detected intent, drafts replies that match your tone and dialect, and can auto-reply per contact. It also turns client requests into tasks and keeps per-project transcripts.
- **Voice notes**: speech-to-text through a self-hosted Whisper endpoint, OpenRouter or Gemini.
- **Agents**: coaching, productivity, finance, research, DevOps and deen (prayer times, Quran and adhkar tracking), each with its own prompt section and actions.
- **Missions and deploy offers**: run Claude Code on a registered project, then approve or decline a deploy from a Telegram card.
- **Control layer and dashboard** (Express + React/Vite): ops overview, incidents, services, agents, projects, finance, shop sales, WhatsApp, transcripts and settings.
- **Shop sales group**: a seller posts sale amounts in a WhatsApp group, and Tokyo logs them and answers totals.
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
cp .env.example .env                       # fill in the values you use
cp owner-profile.example.md owner-profile.md   # describe yourself; read by every prompt
cp projects.example.json projects.json     # optional: your project list
npm run dev
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

Nothing personal is hard-coded. Tokyo reads it at runtime from:

| What | Where |
| --- | --- |
| Your name | `OWNER_NAME` |
| Who you are, your roles, routines and languages | `OWNER_PROFILE_FILE` (markdown, see `owner-profile.example.md`) |
| Your projects, paths, aliases and deploy notes | `PROJECTS_FILE` (JSON, see `projects.example.json`) |
| Timezone and prayer city | `TIMEZONE`, `PRAYER_CITY`, `PRAYER_COUNTRY` |
| Shop sales group | `MYSHOP_GROUP_JIDS` |

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
