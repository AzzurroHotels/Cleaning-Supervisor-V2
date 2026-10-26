# Allen cleaning checklist

Hostel inspection checklist with a small Vercel backend for submitting reports to management.

## How it works

- **Website** (Vercel, project `allen-cleaning-checklist`): the checklist, the inspector login (`/api/login`) and the manager page (`/admin.html`). It stores nothing itself.
- **Report server** (the OpenClaw machine, `server/`): saves every submitted report in a SQLite database and every photo on disk, builds the detailed PDF, and posts it to each configured WhatsApp group with `openclaw message send --channel whatsapp --target <group> --media <pdf>`. Every attempt gets a unique marker in the PDF filename. When OpenClaw reports a failure, the server checks the group's OpenClaw transcript for that marker: if it is not there, the send is retried; if it cannot be verified, the group is marked failed for a manual check. Before any retry, the previous attempt is checked again, so a late-arriving send is never posted twice.
- **Link between them:** the website calls the server through nginx at `http://<server>/cleaning-report/`. Every request and response is encrypted (AES-256-GCM) and signed (HMAC) with the shared `SERVER_SECRET` (`lib/seal.js`), because that hop is plain HTTP. Replays and stale requests are rejected.
- Inspectors sign in first (`INSPECTOR_ID` / `INSPECTOR_PASSWORD`, a signed 30-day token). Each photo is shrunk on the phone to a JPEG and uploaded on its own (Vercel limits a request to 4.5 MB), then the report is submitted. Videos are not sent.
- The PDF (`server/report-pdf.mjs`) has the overview and per-floor totals, sign-off and handover, every failed item with location, notes and embedded photos, all area notes, and the full item-by-item checklist.

### Settings

- Vercel env vars: `INSPECTOR_ID`, `INSPECTOR_PASSWORD`, `ADMIN_PASSWORD` (manager page), `SERVER_URL` (e.g. `http://<server-ip>/cleaning-report`), `SERVER_SECRET` (must equal the one on the server).
- On the server, `/etc/cleaning-report-service.env` holds `SERVER_SECRET`, `WHATSAPP_GROUP` (one group's `...@g.us` ID), `PORT`, `DATA_DIR` and `SITE_URL`. By default every report also goes to the Cleaning Inspection group (`120363429178555205@g.us`). Set `WHATSAPP_GROUPS` (comma-separated, existing group first) to override the full list. A bare long group ID is accepted and becomes `...@g.us`. To find another group's ID, make the OpenClaw WhatsApp account a member first, then check `openclaw config get channels.whatsapp.groups` or `grep -rhoE '[0-9]{10,}@g[.]us' ~/.openclaw | sort -u`. Code is in `/opt/cleaning-report-service/`, data in `/var/lib/cleaning-report-service/` (`reports.db`, `photos/`; back this folder up). Service: `systemctl status cleaning-report-service`, logs: `journalctl -u cleaning-report-service`.
- To rebuild the server bundle: `sh server/bundle.sh dist-server`, copy it to `/opt/cleaning-report-service/`, run `npm install --omit=dev` there and restart the service. Tests: `npm test` (starts the real server with a stand-in for `openclaw`).

## Deploying

The Vercel project is connected to the GitHub fork `VEDANSHSHAH/Cleaning-Supervisor-V2`: every push to its `main` deploys to production automatically. (The AzzurroHotels repo itself is not connected, because Vercel could not install its GitHub app on another person's personal account.) Manual deploy still works with `npx vercel deploy --prod`. `.vercelignore` keeps `server/` and the tests off the public site.

The notes below describe the original front-end behaviour.

## Run

Open `index.html` in a current browser, or serve this folder using a static web server. Keep `responsive.css` beside `index.html`. For deployment, publish these two files together. HTTPS hosting is recommended for consistent browser storage and clipboard support.

## Inspector flow

The checklist now has separate expandable sections for all 28 rooms, 17 shared facilities, and common areas, organised by floor. Seven rooms have ensuite checks based on the supplied sheet; rooms 15 and 20 include an on-site arrangement verification because the source is inconsistent. Room 6 includes both connected sleeping sections.

The room-by-room version uses a new local storage key (`allen-rooms-v2`). Previous general-checklist records are left untouched under the old key; blanket passes are not transferred to individual rooms.

- Use the Ground / First / Second floor tabs to show one floor at a time (each tab shows its progress and failure count; the chosen tab is remembered).
- Every room, bathroom, toilet and common area has a **Notes** box for any comment. Notes appear in the daily update, the saved report, the submitted report and the manager page.
- Enter name and date, then choose Pass or Fail within each room or facility checklist.
- Fail opens an accessible dialog. Location and notes are required; photos and videos are optional.
- Attachments accept image/video files up to 20 MB each and 60 MB per failure. Playback depends on the browser's supported codecs; MP4 video and JPG/PNG photos are practical choices.
- Pass on an existing failure requires confirmation of correction and reinspection. The original finding remains in the report.
- Cancel or Escape asks before discarding unsaved dialog edits.
- Copy the daily text update or download an HTML report containing the media. Send reports manually to management.
- Save the report before starting a new checklist. This version retains only the current checklist in its interface.

## Local data

Checklist metadata is stored in localStorage and attachments in IndexedDB. Nothing automatically syncs between devices. Browser data deletion removes local records. Private browsing, storage quotas and browser restrictions can prevent persistence; visible error messages report failures. Cancelled or replaced attachments may remain in IndexedDB; developers should add a lifecycle cleanup policy when implementing persistent reporting.

## Checks

Run `node verify.cjs` (or `npm test`). No dependency installation is needed. The suite checks initial rendering, migration, invalid storage, required failure fields, failure save/reopen, cancellation, reinspection, save failures, photo/video metadata and previews, upload validation and errors, report escaping/media embedding, missing attachments, clipboard fallback and new-checklist reset.

These are frontend logic tests with a simulated DOM and storage. They do not prove real browser rendering, actual IndexedDB persistence or camera/file-picker behavior. Browser automation was blocked for the local-file URL in the authoring environment; it was not bypassed.

Before release, manually verify at 320, 375, 390, 768, 1024 and 1440 CSS-pixel widths, landscape phones, 200% zoom, keyboard-only navigation and screen-reader labels. On iOS Safari, Android Chrome and desktop browsers, verify actual photo/video selection, playback, reload persistence, download and sharing. Responsive CSS includes wrapping, touch targets, safe areas and a scrollable dialog with dynamic viewport height.

## Developer handoff

The app is a static UX/UI implementation. Backend storage, authentication, roles, shared management reporting, durable inspection history and deployment are intentionally not implemented. No property passwords or door codes are included.
