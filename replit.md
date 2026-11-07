# DUMMYL BOT — Facebook Messenger Automation Platform

## Overview
Full-featured Facebook Messenger bot management dashboard with login/auth system, red/black pro design, collapsible sidebar, and multi-user support.

## Developer
- **Name:** Kyle Gaspari (cozy)
- **Admin Email:** kenzohaizen@gmail.com
- **Admin Password:** cozy24123
- **FB Developer ID:** 61585831139336
- **Bot Prefix:** `!`

## Login System
- Visit the site → redirected to login page
- Register new accounts or log in
- Admin account auto-created (kenzohaizen@gmail.com / cozy24123)
- Admin gets extra **Admin Panel** tab to manage users
- Sessions stored in memory; user records in `data/users.json`
- Passwords hashed with bcryptjs (never stored in plaintext)

## Dashboard Design (v2.2)
- **Branding:** DUMMYL BOT
- **Theme:** Red (#dc2626) + Black (#080808) + White
- **Layout:** Collapsible left sidebar (250px → 64px icon-only)
- **Sidebar tabs:**
  - DASHBOARD — all bot controls (7 inner tabs)
  - ACCOUNT STATUS — FB account info, stats, notifications
  - ABOUT — developer info (Kyle Gaspari)
  - ADMIN PANEL (admin only) — user management

## Dashboard Inner Tabs
1. **Overview** — hero stats, hourly message graph, thread registry, live console
2. **Loop Queue** — text and image pool management
3. **Threads** — thread manager, whitelist, loop controls
4. **Config** — full bot configuration (loop, auto-respond, TTS, security, etc.)
5. **Cookie** — fbstate.json slot manager with step-by-step guide
6. **Custom Cmds** — `!cmd` → reply builder
7. **Commands** — full command reference

## Bot Commands

### Loop
- `. (dot)` — toggle loop ON/OFF in any chat (group or PM)
- `. <uid/name>` — toggle PM loop with user
- `!stop`, `!looppm <uid>`, `!stoppm <uid>`
- `!schedule <sec> <msg>`

### Auto-Respond (groups only)
- `!on` / `!off` / `!mute` / `!unmute`
- `!broadcast <text>`

### Group Management
- `!nn <name>`, `!nn1 <uid> <name>`, `!clearnn`
- `!cg <name>`, `!uncg`, `!banner [url]`, `!unbanner`
- `!kick`, `!add`, `!promote`, `!demote <uid>`
- `!emoji`, `!color <name>`, `!freeze`, `!unfreeze`
- `!gmute`, `!gunmute <uid>`, `!perms <uid> <time>`, `!revoke`

### Voice & Music
- `!vm <text>` — TTS voice message (Google TTS)
- `!vmpm <uid> <text>` — TTS to a PM
- `!p <song name>` — Search YouTube and send song as audio attachment
- `!p <youtube url>` — Send YouTube audio directly

### Utilities
- `!say`, `!spam`, `!count`, `!react <emoji>`, `!seen`
- `!id`, `!myid`, `!info`, `!status`, `!lock`, `!members`
- `!forward <tid> <msg>`, `!gp [url/off]`, `!antirestrict`, `!test`, `!help`

### Fun
- `!flip`, `!roll [sides]`, `!8ball <q>`, `!pick a|b|c`
- `!reverse`, `!shout`, `!mock`, `!clap`, `!timer <sec>`, `!repeat <n> <text>`

## Data Files
- `data/users.json` — registered user accounts (auth)
- `data/fbstate.json` — primary bot cookie (slot 1)
- `data/fbstate2.json` — secondary (slot 2, optional)
- `data/fbstate3.json` — tertiary (slot 3, optional)
- `data/custom_replies.json` — loop message pool
- `data/image_replies.json` — loop image URLs
- `data/custom_commands.json` — custom `!cmd` → reply pairs
- `data/whitelist.json` — whitelist config
- `data/thread_config.json` — per-thread overrides
- `data/bot_config.json` — global bot settings

## API Endpoints
All endpoints require auth (dbl_sess cookie). Returns HTML or JSON.

### Auth
- `POST /api/auth/login` — login (form: email, password)
- `POST /api/auth/register` — register (form: username, email, password, confirm)
- `POST /api/auth/logout` — logout

### Bot
- `POST /api/replies/add` / `POST /api/replies/remove`
- `POST /api/images/add` / `POST /api/images/remove`
- `POST /api/config/save`
- `POST /api/cookie/slot`
- `POST /api/cmds/add` / `POST /api/cmds/remove`
- `POST /api/whitelist/toggle` / `add` / `remove`
- `POST /api/thread/config` / `startloop` / `stoploop` / `stopall`
- `GET /api/status` — bot status JSON
- `GET /api/hourly-stats` — 24-hour message count array
- `GET /api/alerts` — recent alert events

### Admin (admin only)
- `POST /admin/ban` — ban user (form: userId)
- `POST /admin/unban` — unban user
- `POST /admin/delete` — delete user account

## Tech Stack
- Node.js (plain JS, no frameworks)
- ws3-fca — Facebook Messenger API (MQTT-based)
- Multi-process: main index.js spawns bot-worker.js per fbstate file
- bcryptjs — password hashing
- @distube/ytdl-core — YouTube audio download for `!p` command
- youtube-search-api — YouTube search (no API key needed)
- Plain HTTP server (no Express)
- JSON file storage for auth

## Files
- `src/index.js` — main process, spawns workers, runs dashboard
- `src/dashboard.js` — full HTTP server + HTML dashboard (red/black theme)
- `src/auth.js` — user auth module (register, login, sessions)
- `src/bot-worker.js` — bot logic, all commands including `!p`
- `src/replies.js` — built-in reply pool and image URLs
- `data/` — persistent state and config

## Render Deployment
1. Push code to GitHub (`git push origin main`)
2. Go to https://dashboard.render.com → New → Web Service
3. Connect GitHub repo: `kurtxenthia-ship-it/cozybot`
4. Render auto-detects `render.yaml` and configures the service
5. Service name: `dummylbot`, port: 10000
6. Add environment variable if needed (none required)
7. Click Deploy

## User Preferences
- No emojis in code unless part of bot output
- Keep all bot logic in bot-worker.js
- Dashboard is a full rewrite every time (no partial HTML editing)
- Auth session cookie name: `dbl_sess`
