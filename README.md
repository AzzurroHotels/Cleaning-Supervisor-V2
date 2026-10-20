# Allen Hostel — Cleaning Supervisor

A full-stack cleaning inspection app for Allen Hostel. Supervisors work through the room-by-room checklist, record failures with photo or video evidence, and complete a daily report. Managers get a live dashboard, searchable inspection history, and read-only reports.

## What is included

- Secure login with first-run account setup and server-side sessions.
- Two roles: **supervisor** (runs inspections) and **manager** (read-only dashboard, history and reports).
- The complete checklist: **54 areas, 366 checks** across 28 rooms, 17 shared facilities and all common areas.
- Autosave to the server after every check, date change and sign-off update.
- A local draft backup with a retry queue if the connection drops mid-inspection.
- Failure dialog with required location and notes, plus photo/video attachments stored on the server.
- Reinspection flow: passing a failed item asks for confirmation and keeps the original finding in the report.
- Copyable daily update, printable report and downloadable HTML report with embedded evidence.
- Manager dashboard with daily totals, seven-day trend, most-failed checks, floor breakdown and recent inspections.
- Inspection history with status, date and search filters, including drafts.
- Responsive redesign for phones, tablets and desktop.

## Stack

- **Backend:** Node.js 18+, Express, SQLite (`better-sqlite3`)
- **Frontend:** semantic HTML, modern CSS and vanilla ES modules — no build step
- **Media:** stored on local disk behind authenticated routes
- **Deployment:** Docker / Docker Compose

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`. The first visit shows a setup form that creates one supervisor and one manager account. After setup, the supervisor is signed in automatically.

For development with automatic server restarts:

```bash
npm run dev
```

Run the API test suite:

```bash
npm test
```

## First-run setup

1. Visit `/login`.
2. Create the supervisor and manager accounts. Passwords need at least 8 characters.
3. Sign in with either account.

Change your own password from the account menu in the top-right corner.

### Managing accounts from the server

The app ships with a small CLI for additional staff accounts, password resets and disabling access:

```bash
npm run users -- list
npm run users -- add "Second Supervisor" second.supervisor supervisor
npm run users -- password second.supervisor
npm run users -- disable second.supervisor
npm run users -- enable second.supervisor
```

The CLI uses `DB_PATH` when set; otherwise it uses `./data/allen-cleaning.db`. Password prompts are hidden in an interactive terminal.

With Docker Compose, run the same commands inside the container:

```bash
docker compose exec app node scripts/manage-users.js list
docker compose exec app node scripts/manage-users.js add "Second Supervisor" second.supervisor supervisor
```


## Docker deployment

1. Copy `.env.example` to `.env` and set at least the hostel timezone.
2. Build and start:

```bash
docker compose up -d --build
```

3. Open `http://SERVER_IP:3000`. Application data lives in the `allen-data` volume.

Compose variables:

```dotenv
TZ=UTC
TRUST_PROXY=0
SESSION_DAYS=7
```

- Set `TZ` to the hostel's local timezone so "today" and daily reports line up with the working day.
- Set `TRUST_PROXY=1` when running behind an HTTPS reverse proxy so secure session cookies are issued correctly.
- `SESSION_DAYS` controls how long a sign-in lasts.

### HTTPS reverse proxy

Put the container behind nginx, Caddy or Traefik. With nginx:

```nginx
server {
  listen 443 ssl;
  server_name inspections.example.com;

  client_max_body_size 25m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

Then set `TRUST_PROXY=1` in `.env` and restart the container. Use HTTPS in production; photos and inspection notes are private.

### Backups

Inspection data and evidence are both under `/app/data`:

- `allen-cleaning.db` (plus SQLite `-wal` and `-shm` files)
- `uploads/` with failure photos and videos

For a consistent backup, stop the container first, then copy or archive the `allen-data` volume. Test restores periodically.

```bash
docker compose stop
docker run --rm -v allen-cleaning-supervisor_allen-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/allen-data-backup.tar.gz -C /data .
docker compose start
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DB_PATH` | `./data/allen-cleaning.db` | SQLite database path |
| `UPLOAD_DIR` | `./data/uploads` | Evidence storage directory |
| `SESSION_DAYS` | `7` | Sign-in lifetime in days |
| `TRUST_PROXY` | `0` | Set to `1` behind a trusted reverse proxy |
| `TZ` | system default | Timezone used for "today" and daily totals |

## How the inspection flow works

- A supervisor starts an inspection for a chosen date. The checklist template is snapshotted into that inspection, so later template changes cannot alter history.
- Results save automatically. A network failure keeps changes in a local draft and shows an **Offline · saved locally** indicator with a retry action.
- Failed checks require a location and notes. Photos and videos are optional, limited to 20 MB per file and 60 MB per failure.
- A failure can be marked passed only after confirming it was corrected and reinspected. The original notes and media remain visible as the reinspection record.
- Completing an inspection locks it for editing. The supervisor can reopen it from the report page if something needs correcting.
- Managers can view all supervisors' inspections, but cannot edit them.
- The downloaded HTML report embeds available evidence. If an attachment is missing from storage, the report notes it rather than silently omitting it.

## Checklist coverage

- Rooms 1–3: ground floor
- Rooms 4–16: first floor
- Rooms 17–28: second floor
- Seven ensuite rooms (1, 2, 3, 6, 15, 19, 20) include bathroom checks
- Rooms 15 and 20 include an on-site bathroom arrangement confirmation
- Room 6 includes both connected sleeping sections
- Ground floor: entrance, toilets, kitchen/dining, laundry, courtyard, storage/garage
- First floor: corridors, rooms, seven shared bathrooms/toilets/showers, laundry
- Second floor: corridors, rooms, eight shared bathrooms/toilets/showers

## Project structure

```text
server/
  app.js                 Express app, security headers, routing
  auth.js                Password hashing, sessions, role middleware
  checklist.js           Checklist template (54 areas / 366 checks)
  db.js                  SQLite schema and connection
  inspection-data.js     Inspection serialization and attachment helpers
  routes/                Auth, inspections, stats, attachments
public/
  login.html, index.html
  css/                   Design system, auth and app styles
  js/                    API client, UI helpers, app router, views
  favicon.svg
scripts/manage-users.js  Account management CLI
tests/api.test.js        API integration tests
Dockerfile, docker-compose.yml
```

## Testing

`npm test` runs API integration tests against a temporary SQLite database. The suite covers:

- first-run setup and duplicate setup protection
- login, sessions and role restrictions
- full checklist creation
- pass/fail validation and reinspection history
- photo uploads, file authorization and MIME rejection
- sign-off fields, dashboard stats and history filters
- completion, locking, reopening and origin checks
- draft deletion and evidence cleanup

Before a production rollout, manually verify at 320, 375, 390, 768, 1024 and 1440 CSS-pixel widths, plus landscape phones, 200% zoom and keyboard-only navigation. On iOS Safari and Android Chrome, verify camera/file selection, video playback, upload over a weak connection, reload persistence and report downloads.

## Security notes

- Sessions use random server-side tokens in `HttpOnly`, `SameSite=Lax` cookies; only token hashes are stored in SQLite.
- Passwords are hashed with scrypt.
- Login attempts are rate limited per IP.
- State-changing requests are checked against the request origin in addition to `SameSite` cookies.
- Evidence is never served as a public static file; every attachment request is authorized.
- Uploaded files are limited by size, count and MIME type, and stored under random names.
- Security headers (CSP, HSTS, nosniff, frame denial) are applied with Helmet.
- There is no email password-reset flow. Use the account CLI on the server if a password is lost.

## Current limitations

- One property (Allen Hostel) per installation.
- Evidence uses local disk, not S3 or another cloud store.
- Offline mode backs up checklist text and results; pending attachment uploads require a connection.
- Account creation after setup is handled by the server CLI, not a browser admin screen.
- No scheduled analytics or automatic report delivery; managers view or download reports from the app.
- Records from the previous browser-only version (`allen-rooms-v2` in localStorage) are not imported automatically.
