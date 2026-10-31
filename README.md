# senaribot

Self-hosted personal automation daemon over WhatsApp Multi-Device.

Senaribot runs on your machine as a persistent WhatsApp Multi-Device client, accessible via commands sent through private messages. Built on Baileys, Better-SQLite3, and worker threads for async media processing.

## Overview

Senaribot bridges the gap between personal productivity workflows and WhatsApp. Instead of learning a new app or API, send commands as normal messages. The daemon stores data locally in SQLite, processes media in worker threads, and responds in real-time. No cloud dependency, no API keys, no rate limits beyond your own rate-limiting settings.

Modules available:
- Ledger: Natural language expense tracking with category tagging and monthly summaries.
- Reminders: Persistent reminders with finite state machine nagging and snooze tracking.
- Vault: Second-brain note archiver with SQLite FTS5 BM25 full-text search over content and tags.
- Media: Worker-thread pool for image resizing, sticker conversion, and video thumbnail generation.
- System: Runtime diagnostics, memory inspection, and help.
- AI Assistant: Conversational assistant with multi-turn context using APInex (OpenAI-compatible).
- Summarizer: Text and document summarization with chunking for long content.
- Todo: Task manager with categories, priorities, deadlines linked to Reminders, and optional natural-language control through the AI assistant.
- Habit Tracker: Daily/weekly habit tracking with streaks, completion rate, and automatic reminders.
- Web Search: Web search with AI analysis, supports Brave Search API and SerpAPI.
- Weather: Current weather and 3-day forecast with optional AI analysis powered by WeatherAPI.com.
- Currency Converter: Real-time currency conversion with exchange rates from ExchangeRate-API.com.

## Architecture Notes

### Socket Layer

The Baileys WASocket wraps the WhatsApp Multi-Device protocol. Senaribot uses 8-digit pairing codes instead of QR codes, appropriate for headless environments. After initial pairing, authentication credentials are stored in SQLite using custom SignalKeyStore and AuthenticationCreds adapters.

Socket reconnection uses exponential backoff with a configurable retry limit. Presence updates and typing indicators are debounced to reduce local database churn and prevent socket saturation.

### Database

Better-SQLite3 with WAL mode provides safe concurrent reads and writes without external server overhead. The schema includes:
- auth_keys: Pre-keys and session state keyed by (type, id) for signal protocol.
- auth_credentials: Serialized Baileys AuthenticationCreds.
- ledger_entries: Timestamped expense entries with category and description.
- reminders: Finite state machine state for reminder lifecycle (pending, sent, snoozed, completed, cancelled).
- vault_notes: User notes with tags, indexed by rowid.
- vault_fts: FTS5 virtual table for BM25 full-text search.
- vault_media: Media attachments linked to notes.
- todo_tasks: To-do items per WhatsApp JID with category, priority (low, medium, high), optional deadline, status (pending, done), and reminder_id pointing to the row in reminders that was created for the deadline.

All tables include created_at and updated_at timestamps. Foreign keys are enforced.

### Traffic Shaping

The TrafficShaper class maintains a message queue per conversation and sends one message per tick (100ms default). Typing indicators include simulated jitter (300-2000ms) to avoid triggering WhatsApp's bot detection heuristics.

### Dispatcher and Middlewares

Commands are parsed using a configurable prefix (default: `.`). The Dispatcher matches message text against registered commands and runs per-command middlewares in order: ACL guard (owner check), sliding-window rate limiting (5 commands per 60s by default).

### Media Worker Pool

Sharp and FFmpeg operations run off the main thread via Node.js Worker threads. Each job includes a timeout (120s default) and queues behind available workers. The pool size is configurable; default is 2 workers.

## Prerequisites

- Node.js 20.0.0 or later (strict mode, ESM modules)
- FFmpeg (for video/audio sticker generation)
- Build tools for better-sqlite3 (Python 3, C++ compiler)
- Free disk space for SQLite database and temporary media buffers

### macOS

```
brew install node@20 ffmpeg
xcode-select --install
```

### Ubuntu / Debian

```
sudo apt-get install nodejs npm ffmpeg build-essential python3
```

### Windows

Install Node.js 20+ from https://nodejs.org/ and FFmpeg from https://ffmpeg.org/download.html. Ensure both are in PATH.

## Installation

1. Clone or download senaribot.

```
git clone https://github.com/nakulaze/senaribot.git
cd senaribot
```

2. Install dependencies.

```
npm install
```

3. Copy .env.example to .env and configure:

```
cp .env.example .env
```

4. Edit .env with your settings:

```
SENARIBOT_PHONE_NUMBER=+62812345678
SENARIBOT_OWNER_JIDS=62812345678@s.whatsapp.net
SENARIBOT_DB_PATH=./data/senaribot.db
SENARIBOT_LOG_LEVEL=info
SENARIBOT_PREFIX=.
SENARIBOT_RATE_LIMIT_BURST=5
SENARIBOT_WORKER_THREADS=2
```

SENARIBOT_OWNER_JIDS is comma-separated list of full WhatsApp JIDs (with @s.whatsapp.net suffix). Only these JIDs can execute commands.

5. Build TypeScript:

```
npm run build
```

6. Start the daemon:

```
npm start
```

On first run, senaribot will request an 8-digit pairing code. See next section.

## Pairing Code Setup

WhatsApp Multi-Device supports linking without QR codes via 8-digit pairing codes. This is ideal for headless or remote environments.

1. Start senaribot for the first time:

```
npm start
```

2. The console will display:

```
Pairing code for +62812345678: 12345678 (expires in 60 seconds)
```

3. On your WhatsApp phone (must be the main account):
   - Open Settings > Linked Devices > Link a Device
   - Enter the 8-digit code shown in the terminal

4. Once linked, senaribot will save authentication credentials to the SQLite database. Subsequent runs will reconnect automatically without requiring a pairing code.

To unlink, delete the data directory or remove auth state from the database. The next run will request a new pairing code.

## Module Reference

### Ledger

Track expenses with natural language amounts and categories.

```
.spend 50000 food lunch at restaurant
.s 12.5 transport grab to office
.expense 150 utility electricity bill

.summary        (current month)
.summary 9      (September)
.ledger

.expenses       (list all this month)
.expenses food  (by category)
.list 20        (show 20 most recent)
```

All amounts are stored in IDR. Parser accepts common formats: 1000, 1.5K, 50000. Expense categories are user-defined. Monthly summary shows total per category and percentage breakdown.

### Reminders

Schedule persistent reminders with optional recurrence.

```
.remind tomorrow 9am submit report
.r in 2 hours check oven
.reminder next Monday 10am team meeting

.reminders      (list all)
.rlist

.cancel ABC123  (cancel reminder by ID)
```

Reminders use Chrono-node for natural language time parsing. Supported formats: "tomorrow 9am", "in 3 hours", "next Monday", "2026-10-25 15:30". The bot polls every 30s and sends a message when trigger time passes. Snooze tracking records how many times a reminder was deferred.

### Vault

Archive notes with tags and full-text search.

```
.save budget planning | Planning notes for Q4 budget review
.memo ideas | Brainstorm ideas for project X
.note project-alpha | High-level design for module rewrite

.search budget       (search content and tags)
.find project
.query alpha

.vault              (list recent notes)
.notes
.list 20            (show 20 most recent)

.get ABC123         (retrieve a note)
.read ABC123

.delete ABC123      (delete a note)
.rm ABC123
```

Notes are stored with creation date, tags, and full content. FTS5 index provides BM25 relevance ranking. Search returns snippets with query terms highlighted.

### Media

Convert images to stickers and resize media.

```
.sticker            (stub: media worker pool loaded)
```

Media processing runs in worker threads. Sticker conversion resizes to 512x512 and optimizes JPEG quality. Timeouts are enforced per job (120s default).

### System

Runtime information and help.

```
.status             (memory, uptime, environment)
.stat
.info

.help               (command reference)
.h
.commands

.ping               (measure latency)
.p
```

Status shows heap memory usage, process uptime, and log level. Help displays all available commands grouped by module.

### AI Assistant

Conversational assistant using an OpenAI-compatible Chat Completions API (default provider: APInex, model `free/gpt-6-luna`). Owner-only.

```
.ask <question>   (ask the AI, multi-turn)
.ai <question>    (alias of .ask)
.resetai          (clear your conversation history)
```

Behavior:
- Conversation history is stored in SQLite (`ai_messages`) per WhatsApp JID and only the latest `AI_MAX_HISTORY` messages are sent as context.
- A "processing" message is sent while the AI works. Long answers are split into several WhatsApp messages (about 3500 characters each).
- Only one AI request per user runs at a time, and an identical question sent again within 10 seconds is ignored.
- HTTP 429 and 5xx responses are retried up to 2 times with backoff (honoring `Retry-After`). Timeouts, auth failures and network errors return a friendly message in Indonesian.
- The assistant replies in the language of the question (Indonesian or English).
- The API key is read only from `.env`, is redacted in logs, and is never sent to the AI. Only your question and the stored conversation are sent.

The AI client lives in `src/core/ai-service.ts` as a single shared `aiService` instance, so other features can reuse it with `aiService.chat(messages, options)`. `options` (`systemPrompt`, `maxTokens`, `temperature`) are optional and apply to that call only, so `.ask` behaves exactly as before.

### AI Summarizer

Summarizes long text, PDF and TXT documents through the shared `aiService` (model comes from `APINEX_MODEL`, never hardcoded in the command). Owner-only.

```
.summarize <text>              (detailed summary, default)
.sum <text>                    (alias of .summarize)
.summarize short <text>        (Short Summary)
.summarize detailed <text>     (Detailed Summary)
.summarize bullets <text>      (Bullet Points)
.summarize executive <text>    (Executive Summary)
```

Input sources, checked in this order:
1. Text written after the command.
2. A PDF/TXT document attached with `.summarize` as its caption, or a PDF/TXT message that you reply to with `.summarize`.
3. The text of a message you reply to with `.summarize`.

Output always follows the same structure: `JUDUL`, `RINGKASAN UTAMA`, `POIN PENTING`, `KESIMPULAN`. The summary is written in the language of the source.

Behavior:
- The prompt tells the model to use only information present in the source, keep numbers, names and dates as written, say "Tidak disebutkan dalam dokumen" when something is absent, and ignore instructions embedded in the source text. This reduces, but cannot fully eliminate, hallucination, so check important details against the original.
- A "processing" message is sent first, and the work runs asynchronously so other messages are not blocked. Only one summary per user runs at a time; at most `SUM_MAX_CONCURRENT` summaries run across all users, and the rest wait in a queue.
- Input longer than `SUM_MAX_INPUT_CHARS` is cut and you are told. Text shorter than 200 characters is rejected. Output is capped by `SUM_MAX_OUTPUT_TOKENS`.
- Text that does not fit in one request (`SUM_CHUNK_CHARS`) is split at paragraph, line or sentence boundaries. Each chunk is condensed into short notes (sequentially, to avoid rate limits), and the notes are merged into the final summary. Only the chunks and notes needed are sent, never the whole document in one request.
- Identical text and style are served from an in-memory cache for `SUM_CACHE_TTL_MS` (set 0 to disable), and identical requests that are already running share one API call. Failed requests are never cached.
- Rate limits and 5xx errors reuse the retry and backoff logic of `aiService` (up to 2 retries, honoring `Retry-After`); other failures return a friendly message.
- If a document cannot be read, you get a specific reason: unsupported format (only PDF and TXT), file larger than `SUM_MAX_FILE_BYTES`, download failure, unreadable or password-protected PDF, or a scanned PDF with no extractable text (OCR is not supported).

Code lives in `src/modules/summarizer/` (`args.ts`, `chunker.ts`, `prompts.ts`, `extractor.ts`, `summarizer.ts`, `index.ts`). PDF text extraction uses the `unpdf` package.

### Todo List

Task manager stored in the SQLite table `todo_tasks`, scoped per WhatsApp JID. Owner-only.

```
.todo add <task> [--cat <category>] [--prio low|medium|high] [--due <time>]
.todo list [pending|done|<category>|<priority>]
.todo done <id>
.todo delete <id>
.todo edit <id> <new task> [--cat X] [--prio high] [--due <time>]
.todo clear [done]
.todo stats
.todo yes | .todo no       (confirm or cancel a pending action)
.tugas ...                 (alias of .todo)
```

Example: `.todo add Belajar Python --cat Kuliah --prio high --due besok jam 7 malam`

Options:
- `--cat` (alias `--kategori`): category, max 30 characters.
- `--prio` (alias `--prioritas`): `low`, `medium` (default) or `high`. Indonesian aliases `rendah`, `sedang`, `tinggi` also work.
- `--due` (alias `--deadline`): deadline. Accepts Indonesian and English phrases (`besok jam 7 malam`, `lusa`, `minggu depan`, `senin depan`, `3 hari lagi`, `tomorrow 9am`) and ISO dates (`2026-11-05`). A date without a time is set to 23:59. A deadline in the past or one that cannot be parsed is rejected.
- Titles are limited to 200 characters.

Sorting: pending tasks come first, then the nearest deadline (tasks without a deadline last), then priority High > Medium > Low, then id.

Stats show total, done (with percentage), pending, overdue, and pending tasks per priority.

`.todo clear` and `.todo clear done` never delete immediately. The bot shows how many tasks would be removed and waits for `.todo yes` within 60 seconds; `.todo no` cancels.

#### Reminders integration

A task with a deadline creates a row in the existing `reminders` table through `ReminderRepository`, so the existing reminder poller delivers it. No second reminder system exists. The link is stored in `todo_tasks.reminder_id`. The reminder is cancelled when the task is marked done, deleted, cleared, or when its deadline or title is edited (a new reminder is created for the new deadline).

#### Natural language (AI)

Text after `.todo` that does not start with a known subcommand is interpreted by the shared `aiService` (model from `APINEX_MODEL`, default `free/gpt-6-luna`).

```
.todo Belajar Python besok jam 7 malam
.todo Tambahkan tugas membuat portfolio minggu depan
.todo Apa saja tugas yang belum selesai?
.todo Prioritaskan tugasku hari ini
```

Safety design:
- The AI only returns one JSON object with an action from a closed list (`add`, `list`, `done`, `delete`, `edit`, `prioritize`, `unknown`). The prompt forbids SQL, and the AI never has database access.
- The JSON is validated with a zod schema (types, lengths, positive integer ids, enum priorities). Anything else, including SQL or unknown actions, is rejected and the database is not touched.
- The bot itself executes the validated action through `TodoRepository` prepared statements, always filtered by your JID, so ids belonging to other users are reported as not found.
- Deleting tasks, marking several tasks done, and changing the priority of several tasks require confirmation: the bot summarizes the change and waits for `.todo yes` (60 seconds). `.todo no` cancels.
- Only your instruction and a snapshot of your own tasks (max 100) are sent to the AI. The API key is never sent.
- If AI is not configured or fails, you get a friendly message and the regular subcommands keep working.
- Indonesian words such as `hapus`, `selesai`, `ubah` followed by an id run the regular subcommand; without an id they are treated as natural language.

Code lives in `src/modules/todo/` (`args.ts`, `date.ts`, `nl.ts`, `format.ts`, `index.ts`) and `src/database/repositories/todo.repo.ts`. Tests: `tests/todo-pure.test.ts` and `tests/todo-command.test.ts`.

### Habit Tracker

Track daily or weekly habits with streaks, completion rate and automatic reminders. Owner-only. Alias: `.kebiasaan`.

```
.habit add <name> [--freq daily|weekly] [--remind 07:30]
.habit list                 (status of the current period)
.habit done <name>          (log completion for the current period)
.habit stats <name>         (streaks, completion rate, weekly and monthly stats)
.habit history <name>       (all logged periods)
.habit delete <name>        (asks for confirmation)
```

Indonesian subcommand aliases also work: `tambah`, `selesai`, `statistik`, `riwayat`, `hapus`.

Natural language (uses the shared `aiService`, model from `APINEX_MODEL`):

```
.habit Tambahkan membaca buku setiap hari
.habit Analisis konsistensi belajarku
.habit Rekomendasikan jadwal olahraga
```

Behavior:
- Data is stored in SQLite tables `habits` and `habit_logs`. `habit_logs` has a UNIQUE constraint on `(habit_id, period_key)`, so a habit cannot be logged twice in the same period. Deleting a habit cascades to its logs.
- A period is the local date (daily) or the local Monday of the week (weekly), computed in `SENARIBOT_TIMEZONE` (default `Asia/Jakarta`). Date math uses UTC calendar days, so it is not affected by DST.
- Current streak counts consecutive periods backwards from now; an unfilled current period does not break the streak while the previous one is filled. Longest streak is the longest consecutive run in the history. Completion rate is logged periods divided by periods since the habit was created, capped at 100%.
- Reminders: with `--remind HH:MM`, the bot checks every 60 seconds and sends one reminder per period once the time has passed, unless the habit is already logged. Failed deliveries are retried on the next check.
- AI only plans actions as validated JSON (never SQL). It reads summarized statistics (streaks, rates, counts), not raw history dates. Actions that change data (`done`, `delete`) require confirmation: reply `.habit yes` within 60 seconds, or `.habit no` to cancel.
- Each user only sees their own habits. Limits: habit name length and habits per user are capped.

Code lives in `src/modules/habit/` and `src/database/repositories/habit.repo.ts`.

### Web Search

Search the web with AI analysis. Owner-only. Aliases: `.searchweb`, `.google`.

```
.web <query>
.searchweb best laptop 2026
.google ibu kota Indonesia
```

Behavior:
- Sends query to configured search provider (Brave Search API or SerpAPI)
- Returns up to 5 relevant results with title, domain, snippet, and URL
- If AI is configured, analyzes results and provides a summary with source references
- AI distinguishes facts from opinions, prioritizes trusted sources (.edu, .gov), and includes reference numbers [1], [2] for important claims
- Falls back to raw results if AI fails or is not configured
- Rate limits and errors return friendly messages
- Only one search per user at a time

Providers:
- **Brave Search API** (recommended): Free tier available, no credit card required. Get API key from https://api.search.brave.com/register
- **SerpAPI**: Requires paid plan or free trial. Get API key from https://serpapi.com/

Security:
- Web content treated as untrusted data
- Search results never execute code or follow embedded instructions
- API key read only from .env, never logged

Code lives in `src/modules/websearch/`.

## Weather

Weather information powered by WeatherAPI.com (free tier: 1M calls/month).

Commands:
- `.weather <city>`: Current weather
- `.weather today <city>`: Current weather (alias)
- `.forecast <city>`: Current + 3-day forecast

Features:
- Temperature in Celsius (actual + feels-like)
- Condition (sunny, cloudy, rainy, etc.)
- Humidity percentage
- Wind speed in km/h
- Timezone-aware timestamps
- 3-day forecast with min/max temps and rain chance
- 10-minute cache to reduce API calls
- Optional AI analysis: natural language summary + activity suggestions

If AI is configured (APINEX_API_KEY set), weather data gets analyzed and summarized in Indonesian. AI provides general activity recommendations but never invents weather data.

Examples:
```
.weather Jakarta
→ Current temp, condition, humidity, wind

.forecast Bandung
→ Current weather + next 3 days forecast

.weather today Surabaya
→ Current weather (same as .weather)
```

Response format:
```
🌤 Cuaca Jakarta, Indonesia

Suhu: 28°C (terasa 30°C)
Kondisi: Partly cloudy
Kelembapan: 70%
Angin: 15 km/jam

Waktu: 31 Okt 2026, 09.55
```

With AI (if enabled):
```
💬 Ringkasan:
Cuaca Jakarta saat ini cukup panas dengan suhu 28°C...
[AI-generated summary with activity suggestions]

📊 Detail:
[raw weather data as above]
```

Security:
- API key read from .env only, never logged
- City name validated (max 100 chars)
- One request per user+city at a time
- WeatherAPI.com responses treated as untrusted data
- Handles "city not found" gracefully with friendly message

Configuration:
- WEATHER_API_KEY: Get free key from https://www.weatherapi.com/ (1M calls/month)
- WEATHER_TIMEOUT_MS: Request timeout in milliseconds (default: 15000)

Code lives in `src/modules/weather/`.

## Currency Converter

Real-time currency conversion using ExchangeRate-API.com (free tier: 1500 requests/month, no auth required).

Commands:
- `.convert <amount> <from> <to>`: Convert currency
- `.rate <from> <to>`: Show exchange rate

Features:
- ISO 4217 currency codes (USD, EUR, IDR, GBP, JPY, etc.)
- Real-time exchange rates
- Accurate calculation (JavaScript native, not AI-generated)
- Locale-aware formatting (Indonesian)
- Timestamp showing when rate was last updated
- 1-hour cache to reduce API calls
- Optional AI analysis: context and insights about the conversion

If AI is configured (APINEX_API_KEY set), provides context about the conversion (e.g., large/small amounts, economic context) but never fabricates exchange rates. All calculations done in code.

Examples:
```
.convert 100 USD IDR
→ Converts 100 US Dollars to Indonesian Rupiah

.convert 500000 IDR USD
→ Converts 500,000 Rupiah to US Dollars

.rate USD EUR
→ Shows current USD/EUR exchange rate (both directions)
```

Response format:
```
💱 Konversi Mata Uang

USD 100.00 =
IDR 1,575,000.00

Kurs: 1 USD = 15,750.00 IDR
Diperbarui: 31 Okt 2026, 10.30
```

With AI (if enabled):
```
💬 Ringkasan:
Konversi 100 USD ke IDR menghasilkan sekitar 1.5 juta rupiah...
[AI-generated context with general insights]

📊 Detail:
[raw conversion data as above]
```

Supported currencies (subset):
- Major: USD, EUR, GBP, JPY, CNY, AUD, CAD, CHF
- Asian: IDR, SGD, MYR, THB, PHP, VND, INR, KRW
- Middle East: AED, SAR, QAR, KWD
- Others: BRL, MXN, ZAR, RUB, TRY, and more

See ISO 4217 for full list. Invalid codes rejected before API call.

Security:
- No API key required (ExchangeRate-API.com free tier)
- Input validated (amount > 0, max 1 quadrillion)
- One request per user at a time
- Comma separator parsed correctly (1,000,000 → 1000000)
- Exchange rates treated as untrusted data

Configuration:
- CURRENCY_TIMEOUT_MS: Request timeout in milliseconds (default: 10000)
- No API key needed for ExchangeRate-API.com free tier

Code lives in `src/modules/currency/`.

## Calendar

Personal schedule manager with conflict detection and natural language date parsing.

Commands:
- `.calendar today`: Today's events
- `.calendar tomorrow`: Tomorrow's events
- `.calendar week`: This week's events
- `.calendar add <title> <date> <time>`: Add event
- `.calendar add! <title> <date> <time>`: Force add (ignore conflicts)
- `.calendar delete <id>`: Delete event
- `.calendar detail <id>`: Show event details

Features:
- Natural language dates: "today", "tomorrow", or DD/MM/YYYY
- Time format: HH:MM (24-hour)
- Conflict detection (warns about overlapping events)
- Events stored per user (isolated by WhatsApp JID)
- Timezone-aware (uses SENARIBOT_TIMEZONE)

Examples:
```
.calendar add Meeting 31/10/2026 14:00
.calendar add Belajar tomorrow 19:00
.calendar add Olahraga today 07:00

.calendar today
→ Lists all events scheduled for today

.calendar week
→ Lists all events for next 7 days

.calendar delete 5
→ Deletes event with ID 5

.calendar detail 3
→ Shows full details for event ID 3
```

Conflict handling:
```
.calendar add Meeting 31/10/2026 14:00
→ ⚠️ Bentrok dengan agenda lain:
   "Other Meeting" pada 31/10/2026 14:00
   
   Tetap simpan? Ketik: .calendar add! Meeting 31/10/2026 14:00
```

Code lives in `src/modules/calendar/`.

## GitHub Integration

GitHub repository and user information powered by GitHub API v3.

Commands:
- `.github repo <owner/repo>`: Repository info
- `.github user <username>`: User profile
- `.github issues <owner/repo>`: Recent issues
- `.github commits <owner/repo>`: Recent commits
- `.github releases <owner/repo>`: Latest releases

Features:
- Repository stats (stars, forks, watchers, open issues)
- User profile with bio, public repos, followers
- Recent issues with state and labels
- Recent commits with author and message
- Latest releases with version tags and notes
- 10-minute cache to reduce API calls
- Optional GitHub token for higher rate limits (60/hour → 5000/hour)
- One request per user at a time

Examples:
```
.github repo microsoft/typescript
→ TypeScript repo stats, description, language, license

.github user torvalds
→ Linus Torvalds profile, bio, repos count, followers

.github issues facebook/react
→ Last 5 open issues with numbers and titles

.github commits vercel/next.js
→ Last 5 commits with authors and messages

.github releases nodejs/node
→ Latest 3 releases with version tags
```

Configuration:
- GITHUB_TOKEN: Optional personal access token for higher rate limits (get from https://github.com/settings/tokens)
- GITHUB_TIMEOUT_MS: Request timeout in milliseconds (default: 10000)

Security:
- API responses treated as untrusted data
- Token read from .env only, never logged or exposed
- Repository names validated (max 100 chars, alphanumeric + slash/dash/underscore)

Code lives in `src/modules/github/`.

## YouTube Summarizer

YouTube video summarizer with transcript extraction and AI-powered summaries.

Commands:
- `.youtube <url>`: Summarize video
- `.yt <url>`: Alias for youtube

Features:
- Extracts transcript using youtube-transcript library
- Supports auto-generated and manual transcripts
- Multiple language support (prioritizes Indonesian, English)
- AI-powered summary with key points
- Video metadata (title, author, duration)
- 10-minute cache per video
- Handles long transcripts (splits into chunks if needed)
- One video per user at a time

Examples:
```
.youtube https://www.youtube.com/watch?v=dQw4w9WgXcQ
→ Video title, author, duration
   AI summary of transcript content
   Key points extracted

.yt youtu.be/dQw4w9WgXcQ
→ Short URL format also supported
```

Supported URL formats:
- https://www.youtube.com/watch?v=VIDEO_ID
- https://youtu.be/VIDEO_ID
- https://m.youtube.com/watch?v=VIDEO_ID
- https://youtube.com/shorts/VIDEO_ID

Limitations:
- Video must have available transcript (auto-generated or manual)
- Videos without transcripts return error message
- Requires APINEX_API_KEY for AI summaries

Configuration:
- YOUTUBE_TIMEOUT_MS: Request timeout in milliseconds (default: 30000)
- Uses centralized AI service (APINEX_BASE_URL, APINEX_MODEL)

Security:
- YouTube URLs validated and sanitized
- Transcript content treated as untrusted data
- No video downloads (transcript-only extraction)

Code lives in `src/modules/youtube/`.

## Configuration

All settings are read from .env at startup. Changes require restart.

- SENARIBOT_PHONE_NUMBER: Your WhatsApp phone number (used for pairing code generation).
- SENARIBOT_OWNER_JIDS: Comma-separated list of JIDs allowed to execute commands (e.g., 62812345678@s.whatsapp.net).
- SENARIBOT_DB_PATH: Path to SQLite database file. Creates ./data/ if missing.
- SENARIBOT_LOG_LEVEL: debug, info, warn, or error.
- SENARIBOT_PREFIX: Command prefix (default: `.`).
- SENARIBOT_TIMEZONE: IANA timezone used for habit periods, streaks and reminders (default: Asia/Jakarta). Invalid values are rejected at startup.
- SENARIBOT_RATE_LIMIT_BURST: Maximum commands per minute per user (default: 5).
- SENARIBOT_WORKER_THREADS: Worker thread pool size for media processing (default: 2).
- SEARCH_PROVIDER: Web search provider, either `brave` or `serpapi` (default: brave).
- SEARCH_API_KEY: API key for the search provider. Leave empty to disable web search commands.
- SEARCH_TIMEOUT_MS: Search request timeout in milliseconds (default: 30000).
- WEATHER_API_KEY: API key for WeatherAPI.com. Get free key from https://www.weatherapi.com/ (1M calls/month). Leave empty to disable weather commands.
- WEATHER_TIMEOUT_MS: Weather request timeout in milliseconds (default: 15000).
- CURRENCY_TIMEOUT_MS: Currency conversion request timeout in milliseconds (default: 10000). Uses free ExchangeRate-API.com, no key required.
- APAI_PROVIDER: AI provider name (default: apinex).
- APINEX_API_KEY: API key for the AI provider. Read only from .env, never logged. Leave empty to disable AI commands.
- APINEX_BASE_URL: OpenAI-compatible base URL (default: https://api.apinex.bond/v1).
- APINEX_MODEL: Model name (default: free/gpt-6-luna).
- AI_MAX_HISTORY: Number of recent messages kept as context per user (default: 10).
- AI_MAX_OUTPUT_TOKENS: Max tokens per AI answer (default: 4096).
- AI_TEMPERATURE: Sampling temperature 0-2 (default: 0.7).
- AI_TIMEOUT_MS: Request timeout in milliseconds (default: 60000).
- AI_SYSTEM_PROMPT: Optional custom system prompt, overrides the built-in default.
- SUM_MAX_INPUT_CHARS: Max characters of source text accepted by the summarizer; the rest is cut (default: 60000).
- SUM_CHUNK_CHARS: Max characters per chunk when a long text is split for summarizing (default: 8000).
- SUM_MAX_OUTPUT_TOKENS: Max tokens of the final summary (default: 1024).
- SUM_MAX_FILE_BYTES: Max size of a PDF/TXT document to download and read (default: 5242880, i.e. 5 MB).
- SUM_CACHE_TTL_MS: How long identical summaries are cached in memory, 0 disables the cache (default: 600000).
- SUM_MAX_CONCURRENT: Max summaries processed at the same time across all users (default: 2).
- NODE_ENV: development or production (affects log output and error verbosity).
- SENARIBOT_BACKUP_RETENTION: Number of daily backups to keep (default: 7, range: 1-30). Older backups are automatically deleted.

## Backup & Recovery

Senaribot automatically creates daily SQLite backups using VACUUM INTO. Backups are consistent, integrity-checked, and stored in `<db_path>/backups/`.

### Automatic Backups

Daily backups run at midnight in your configured timezone. Each backup:
- Uses VACUUM INTO for consistency with WAL mode
- Verifies SQLite integrity before accepting
- Named with timestamp: `senaribot.backup.2026-10-31_12-00-00.db`
- Enforces retention limit (default: 7 days)

No configuration needed beyond `SENARIBOT_BACKUP_RETENTION`. Backups run automatically after startup.

### Manual Backup

```javascript
import { createBackup } from './dist/core/backup.js';
const result = createBackup();
console.log(result.success ? `Backup: ${result.path}` : `Error: ${result.error}`);
```

Or use Node.js CLI:

```bash
node -e "import('./dist/core/backup.js').then(m => console.log(m.createBackup()))"
```

### Restore from Backup

Stop senaribot before restoring.

```bash
# List backups
ls ./data/backups/

# Restore specific backup
node -e "import('./dist/core/backup.js').then(m => console.log(m.restoreBackup('./data/backups/senaribot.backup.2026-10-31_12-00-00.db')))"

# Restore latest
node -e "import('./dist/core/backup.js').then(m => console.log(m.restoreLatestBackup()))"
```

After restore, restart senaribot. The restored database includes auth credentials and all user data.

### Backup Location

Backups are stored in `<SENARIBOT_DB_PATH directory>/backups/`. For `./data/senaribot.db`, backups go to `./data/backups/`.

### Integrity Checks

Every backup validates:
- SQLite file header magic bytes
- Page size and page count consistency
- File size matches expected (page_size × page_count)
- SQLite integrity_check passes

Corrupted backups are rejected and deleted automatically.

## Graceful Shutdown

Senaribot handles SIGINT (Ctrl+C) and SIGTERM gracefully:

1. Stop accepting new messages
2. Clear scheduled timers (daily backups, reminders)
3. Drain message queue (wait for pending sends)
4. Close WhatsApp socket connection
5. Run module teardowns (close files, cancel jobs)
6. Close database connection
7. Exit with code 0

Shutdown timeout: 30 seconds. If cleanup exceeds this, senaribot force-exits with code 1.

To trigger shutdown:
```bash
# Ctrl+C in foreground
^C

# Send signal to background process
kill -TERM <pid>
```

Process managers (systemd, pm2, Docker) should send SIGTERM for clean shutdown.

## WhatsApp Session Recovery

Senaribot persists WhatsApp authentication in SQLite (auth_keys, auth_credentials tables). After restart or network interruption, it reconnects automatically without re-pairing.

### Reconnection Behavior

- **Normal restart**: Loads credentials from database, reconnects immediately
- **Network loss**: Exponential backoff (1s, 2s, 4s, 8s...) up to 10 retries
- **Bad session**: Clears auth state, requests new pairing code
- **Logged out**: Stops reconnection, requires manual intervention

### Recovery Scenarios

**Temporary network disconnection**: Senaribot reconnects automatically with backoff. No action needed.

**Process crash**: On restart, loads auth state and reconnects. Message queue is lost (messages sent while offline are not retried).

**Corrupted auth state**: If SQLite auth tables are corrupted, delete `./data/senaribot.db` or clear auth rows manually. Next run requests new pairing code.

**Expired session**: WhatsApp expires sessions after ~30 days of inactivity. Senaribot detects `loggedOut` and stops. Re-run to pair again.

### Session Backup

Auth credentials are included in daily backups. Restoring a backup restores the WhatsApp session. No need to re-pair after database restore.

### Duplicate Message Prevention

Senaribot tracks message IDs in memory to prevent duplicate processing after reconnect. Duplicates are logged and ignored.

## Development

Build:
```
npm run build
```

Type check:
```
npm run typecheck
```

Dev mode with hot reload:
```
npm run dev
```

The project uses strict TypeScript mode. All types are explicit. No implicit any.

## Troubleshooting

Pairing code expired: The code is valid for 60 seconds. If it expires, restart and get a new code.

Database locked: Ensure only one instance is running. SQLite WAL mode handles concurrent reads, but multiple processes on the same database will deadlock.

Worker thread errors: Verify FFmpeg is installed and in PATH. Check file permissions on temporary media directories.

Reconnection loops: Check internet connectivity and WhatsApp server status. Enable debug logging to inspect socket errors.

## License

MIT
