# 004 - Research notes: life gateway table (T0.4)

Date 2026-10-17. Source: dashboard route files read in the worktree (`src/dashboard/*.ts`, same code as live `3f6bf3e`); routes listed with `grep` over `router.<verb>(` and checked against `dashboard/src` usage. Gateway path = `/control/api/v1/life/api<path>` (dashboard `/api<path>`).

**Life operation count: 99** (41 reads, 58 writes), plus L0 manifest = 100. Confirm sheet (CS) rows: 24. Paid rows: 5.

Legend: cap `life:read` for GET, `life:write` otherwise. Confirm class `none` or `CS` (FR6). Rate class `R` = global 120/min; `W` = writes 30/min; `P` = paid, 5 per 10 min; `B` = byte upload (W plus the size cap). Body limit: gateway JSON limit 64k unless a raw cap is named.

## Frozen table

| Row | Method | Path pattern | Cap | Confirm | Paid | Body | Rate | Note |
|---|---|---|---|---|---|---|---|---|
| L1 | GET | `/overview` | life:read | none | no | - | R | Home, Tasks, Finance |
| L2 | GET | `/goals` | life:read | none | no | - | R | Goals |
| L3 | GET | `/obligations` | life:read | none | no | - | R | Money |
| L4 | GET | `/tasks-bulk/suggestions` | life:read | none | no | - | R | Tasks; reads the audit JSON on disk |
| L5 | GET | `/habits/history` | life:read | none | no | - | R | Habits; query days |
| L6 | GET | `/calendar` | life:read | none | no | - | R | Schedule; query start, end (default current month) |
| L7 | GET | `/calendar/:date` | life:read | none | no | - | R | Schedule day detail; media keys only |
| L8 | GET | `/media/:filename` | life:read | none | no | - | R | BYTES: gallery image or thumb; query w; size-capped stream |
| L9 | GET | `/projects` | life:read | none | no | - | R | Work |
| L10 | GET | `/work/log` | life:read | none | no | - | R | Work |
| L11 | GET | `/weekly-trends` | life:read | none | no | - | R | Finance, Trends |
| L12 | GET | `/adhkar/history` | life:read | none | no | - | R | Deen |
| L13 | GET | `/quran/history` | life:read | none | no | - | R | Deen |
| L14 | GET | `/journal` | life:read | none | no | - | R | Journal |
| L15 | GET | `/shop` | life:read | none | no | - | R | Shop |
| L16 | GET | `/products` | life:read | none | no | - | R | Products |
| L17 | GET | `/products/stats` | life:read | none | no | - | R | Products |
| L18 | GET | `/products/batches` | life:read | none | no | - | R | Products |
| L19 | GET | `/products/batches/:batchId` | life:read | none | no | - | R | Products |
| L20 | GET | `/products/forward-targets` | life:read | none | no | - | R | Products; chat names |
| L21 | GET | `/project-repos` | life:read | none | no | - | R | Projects (Tokyo repos) |
| L22 | GET | `/content/platforms` | life:read | none | no | - | R | Content |
| L23 | GET | `/content/items` | life:read | none | no | - | R | Content |
| L24 | GET | `/content/items/:id` | life:read | none | no | - | R | Content |
| L25 | GET | `/content/calendar` | life:read | none | no | - | R | Content |
| L26 | GET | `/whatsapp/media/chats` | life:read | none | no | - | R | Media |
| L27 | GET | `/whatsapp/media` | life:read | none | no | - | R | Media; query type, jid, limit, before |
| L28 | GET | `/instagram` | life:read | none | no | - | R | Instagram |
| L29 | GET | `/instagram/rules` | life:read | none | no | - | R | Instagram |
| L30 | GET | `/whatsapp/status` | life:read | none | no | - | R | WhatsApp |
| L31 | GET | `/whatsapp/chats` | life:read | none | no | - | R | WhatsApp |
| L32 | GET | `/whatsapp/messages/:jid` | life:read | none | no | - | R | WhatsApp; query limit |
| L33 | GET | `/conversations` | life:read | none | no | - | R | Chat; query limit |
| L34 | GET | `/chat-analyzer/sentiment` | life:read | none | no | - | R | ChatAnalytics; query period |
| L35 | GET | `/chat-analyzer/habits` | life:read | none | no | - | R | ChatAnalytics |
| L36 | GET | `/transcripts` | life:read | none | no | - | R | Transcripts |
| L37 | GET | `/transcripts/pending` | life:read | none | no | - | R | Transcripts |
| L38 | GET | `/server` | life:read | none | no | - | R | Server |
| L39 | GET | `/settings` | life:read | none | no | - | R | Settings |
| L40 | GET | `/settings/auto-transcribe` | life:read | none | no | - | R | Settings |
| L41 | GET | `/settings/model` | life:read | none | no | - | R | Settings |
| L42 | POST | `/tasks` | life:write | none | no | 64k | W | Tasks |
| L43 | POST | `/tasks/:id/complete` | life:write | none | no | 64k | W | Tasks |
| L44 | POST | `/tasks/:id/edit` | life:write | none | no | 64k | W | Tasks |
| L45 | POST | `/tasks/:id/start` | life:write | none | no | 64k | W | Tasks |
| L46 | DELETE | `/tasks/:id` | life:write | CS | no | 64k | W | Tasks; deletes subtasks too |
| L47 | POST | `/tasks/:id/subtasks` | life:write | none | no | 64k | W | NEW in T4.3 (F1) |
| L48 | POST | `/tasks/:id/subtasks/:sid/complete` | life:write | none | no | 64k | W | NEW in T4.3 (F1) |
| L49 | POST | `/tasks-bulk/complete` | life:write | CS | no | 64k | W | bulk, ids <= 500 |
| L50 | POST | `/tasks-bulk/delete` | life:write | CS | no | 64k | W | bulk, ids <= 500 |
| L51 | POST | `/habits/:id/check` | life:write | none | no | 64k | W | Habits |
| L52 | POST | `/habits` | life:write | none | no | 64k | W | Habits |
| L53 | DELETE | `/habits/:id` | life:write | CS | no | 64k | W | Habits |
| L54 | POST | `/goals` | life:write | none | no | 64k | W | Goals |
| L55 | POST | `/goals/:id/update` | life:write | none | no | 64k | W | Goals |
| L56 | DELETE | `/goals/:id` | life:write | CS | no | 64k | W | Goals |
| L57 | POST | `/work/start` | life:write | none | no | 64k | W | Work |
| L58 | POST | `/work/stop` | life:write | none | no | 64k | W | Work |
| L59 | POST | `/work/break` | life:write | none | no | 64k | W | Work |
| L60 | POST | `/obligations` | life:write | none | no | 64k | W | Money |
| L61 | POST | `/obligations/:id/pay` | life:write | none | no | 64k | W | Money; proof path must start whatsapp-media/ |
| L62 | PATCH | `/obligations/:id` | life:write | none | no | 64k | W | Money |
| L63 | POST | `/obligations/:id/archive` | life:write | none | no | 64k | W | Money |
| L64 | DELETE | `/obligations/payments/:id` | life:write | CS | no | 64k | W | Money; undo payment |
| L65 | DELETE | `/obligations/:id` | life:write | CS | no | 64k | W | Money |
| L66 | POST | `/adhkar/:type` | life:write | none | no | 64k | W | Deen |
| L67 | POST | `/quran` | life:write | none | no | 64k | W | Deen |
| L68 | POST | `/journal` | life:write | none | no | 64k | W | Journal; one small Jev area call, no LLM spend |
| L69 | POST | `/products/sync` | life:write | CS | no | 64k | W | exec: syncs the catalogue from the shop host |
| L70 | PATCH | `/products/:id` | life:write | none | no | 64k | W | Products; price, title |
| L71 | POST | `/products/batches/:batchId/assign` | life:write | none | no | 64k | W | Products |
| L72 | POST | `/products/forward` | life:write | CS | no | 64k | W | send as the owner; confirm:true only after the sheet |
| L73 | POST | `/project-repos/sync` | life:write | CS | no | 64k | W | exec: ssh git scan of server and Mac |
| L74 | POST | `/project-repos/:id` | life:write | none | no | 64k | W | Projects; repo fields |
| L75 | POST | `/content/items` | life:write | none | no | 64k | W | Content |
| L76 | POST | `/content/items/:id` | life:write | none | no | 64k | W | Content |
| L77 | DELETE | `/content/items/:id` | life:write | CS | no | 64k | W | Content |
| L78 | POST | `/content/items/:id/captions` | life:write | none | no | 64k | W | Content |
| L79 | POST | `/content/items/:id/captions/draft` | life:write | CS | yes | 64k | P | paid: LLM caption draft |
| L80 | POST | `/content/items/:id/upload` | life:write | none | no | raw 4096 MB (CONTENT_UPLOAD_MAX_MB); needs the Z4 nginx upload location | B | disk: octet-stream body to UPLOAD_DIR |
| L81 | DELETE | `/content/items/:id/video` | life:write | CS | no | 64k | W | Content; deletes the file |
| L82 | POST | `/content/items/:id/preflight` | life:write | none | no | 64k | W | Content |
| L83 | POST | `/content/items/:id/publish` | life:write | CS | no | 64k | W | send: publishes now (confirm:true) |
| L84 | POST | `/content/items/:id/schedule` | life:write | CS | no | 64k | W | send: schedules a publish |
| L85 | POST | `/content/items/:id/unschedule` | life:write | none | no | 64k | W | Content |
| L86 | POST | `/whatsapp/media/delete` | life:write | CS | no | 64k | W | disk: unlinks files, ids <= 500 |
| L87 | POST | `/instagram/settings` | life:write | CS | no | 64k | W | CS only when the body changes transport (applyTransport starts or stops the live transport); other keys none |
| L88 | POST | `/instagram/surface` | life:write | none | no | 64k | W | Instagram |
| L89 | POST | `/instagram/rules` | life:write | none | no | 64k | W | Instagram |
| L90 | POST | `/instagram/rules/:id/toggle` | life:write | none | no | 64k | W | Instagram |
| L91 | DELETE | `/instagram/rules/:id` | life:write | CS | no | 64k | W | Instagram |
| L92 | POST | `/instagram/test` | life:write | CS | yes | 64k | P | dry run; calls aiCall + Jev when strategy is ai or hybrid (paid), free for rules |
| L93 | POST | `/whatsapp/send` | life:write | CS | no | 64k | W | send as the owner |
| L94 | POST | `/chat-analyzer/classify` | life:write | CS | yes | 64k | P | paid: LLM over up to 10000 messages; 409 while one runs |
| L95 | POST | `/transcripts/:id/transcribe` | life:write | CS | yes | 64k | P | paid: STT |
| L96 | POST | `/transcripts/upload` | life:write | CS | yes | raw 25 MB; needs the Z4 nginx upload location | P | paid: STT; disk |
| L97 | POST | `/settings` | life:write | none | no | 64k | W | key allowlist (research-life.md); CS for the CS-class keys |
| L98 | POST | `/settings/auto-transcribe` | life:write | none | no | 64k | W | Settings |
| L99 | POST | `/settings/model` | life:write | CS | no | 64k | W | Settings; changes the AI model (spend) |

## Excluded routes

| Method | Path | Reason |
|---|---|---|
| POST | `/settings/kie-key` | writes the server env file (a credential) |
| POST | `/auth/password` | changes the dashboard password and revokes every control device |
| POST | `/auth/login` | dashboard login; the app has its own bearer |
| POST | `/whatsapp/connect` | starts WhatsApp pairing |
| POST | `/groupchat/open` | returns a one-time host link (secret) |
| GET | `/clients` | no page uses it |
| GET | `/report/latest` | no page uses it |
| GET | `/progress/:period` | no page uses it |
| GET | `/journals` | no page uses it |
| GET | `/shop/ai-context` | model prompt context blob, no page uses it |
| * | `/internal/*` | service-to-service routes (action offers, deploy, feed, triage, status) |
| * | `/login, /, /favicon.ico, /{*splat}` | dashboard HTML shell |

## `POST /settings` key allowlist (live keys = `SETTINGS` in `src/settings.ts`, 33 keys)

- Safe, no sheet (26): PROFILE_NAME, PRAYER_CITY, PRAYER_COUNTRY, PRAYER_METHOD, JEV_ENABLED, AREAS_ENABLED, JOBHUNT_MIN_SCORE, and the 19 `MODULE_*` switches.
- Safe with confirm sheet (4): TRANSCRIBE_ENABLED, WA_AUTO_REPLIES, SHOP_AI_REPLIES, SHOP_PRICE_MULTIPLIER (each changes what Tokyo sends or spends).
- Excluded (3): JOBHUNT_DRY_RUN (turning it off sends real emails to employers); JOBHUNT_DAILY_CAP (raises the number of real application emails per day); JOBHUNT_AUTOSEND_SCORE (lowering it sends applications without review).
- The gateway checks `key` against these lists before the request reaches the handler; `validateSetting` (`src/settings.ts:115`) still runs behind it. `value: null` (reset) follows the same key rule.


## Verdicts and checks

- **Instagram `/test`**: `POST /api/instagram/test` calls `dryRun` (`src/instagram/engine.ts:187`), which runs the configured strategy. Strategies `ai` and `hybrid` call `aiCall` and `jevNoul` (`src/instagram/strategies/ai.ts:14-15`), so the call spends LLM money; `rules` does not. The row is paid (rate class P, confirm sheet).
- **F10 re-check**: `git diff --stat feat/jev-run-model 011-dashboard-restyle -- src/dashboard` is empty (0 lines, 2026-10-17); the route inventory holds for both branches.
- **Route list**: 124 route registrations under `src/dashboard` were listed with grep; 12 groups are excluded above (internal service routes, dashboard shell, auth, four secret or pairing routes, five unused GETs). New in 004: the two subtask routes (T4.3, F1) are rows with note NEW.
- **Differences from research section 1** (T4.1 follows this file): content captions draft is `POST /content/items/:id/captions/draft`, content upload is `/content/items/:id/upload`, preflight, publish, schedule and unschedule are per item (`/content/items/:id/...`), not the shorter paths listed there; `GET /products/batches/:batchId` is keyed `batchId`.

## Samples (captured 2026-10-17, option O2)

All 41 GETs were called once and saved anonymised as `test-fixtures/life/L1.json` .. `L41.json` (and as `sample` per row in the app copy `contract-examples-life.json`). The live login answered 401 earlier (a password hash set from Settings overrides the env value), so the live Tokyo was not used: `life.db` was copied with a read-only `.backup` to a temp dir, one dashboard session was inserted in the COPY only, and the worktree dashboard (`tools/serve_life_copy.ts`) ran on loopback 127.0.0.1:39417 against the copy (`tools/mk_copy_session.py`, `tools/fetch_life.py` with `LIFE_TOKEN_FILE`). The copy, the token and the process are deleted; the live `dashboard_sessions` table and the live service were not touched. The grep script `tools/check_fixtures.py` over the fixtures and the app JSON exits 0 (42 files, 0 failures).

Data caveats (shapes still correct, values empty or staged in the copy):
- L31 `/whatsapp/chats` and L32 `/whatsapp/messages/:jid` read the in-process Baileys store (`src/whatsapp.ts:753,760`), empty in a process that is not connected: the samples are `[]`. The row shapes come from the code (`chats` map and `messageStore`), T4.1 and A4.1 must not infer them from the sample.
- L8 bytes route: one real media file was copied into the temp media dir so the route answered 200; only the content type is stored. L23 and L24: one content item with a fake title was created in the copy through the route.
- L30 `/whatsapp/status` shows the disconnected state of that process. The gateway drops `qrDataUrl` and `pairingCode` from the reply (connecting is out of scope; a pairing code never leaves the server). L4 `/tasks-bulk/suggestions` reads the live audit file (read only).
- Anonymiser leak report: 20 kept strings, all enum-like keys (month, price source, platform names, area, category) or the fake hook text; no name, number, path or token.
