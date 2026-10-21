# Allen cleaning checklist

Hostel inspection checklist with a small Vercel backend for submitting reports to management.

## Hosting and backend

Deployed on Vercel (static files plus `api/` functions) with a private Vercel Blob store. Inspectors sign in first (`INSPECTOR_ID` / `INSPECTOR_PASSWORD`); a signed 30-day token authorises uploads and submissions. They then tap **Submit to management**: photos/videos upload directly to Blob via `/api/upload`, then the report is posted to `/api/reports`. Managers open `/admin.html` and enter the password to view reports and attachments.

- Env vars (Vercel project): `INSPECTOR_ID`, `INSPECTOR_PASSWORD`, `ADMIN_PASSWORD` (management password; endpoints stay closed if unset) and `BLOB_READ_WRITE_TOKEN` (added by the Blob store).
- Deploy: `npx vercel deploy --prod`. Browser Blob client is bundled in `vendor/blob-client.js` (rebuild with `npx esbuild node_modules/@vercel/blob/dist/client.js --bundle --format=esm --minify --outfile=vendor/blob-client.js` after upgrading `@vercel/blob`).
- Submitting requires the inspector login; viewing requires the management password. Changing either inspector value signs everyone out.

## Deploying

The Vercel project `allen-cleaning-checklist` is connected to the GitHub fork `VEDANSHSHAH/Cleaning-Supervisor-V2`: every push to its `main` deploys to production automatically. (The AzzurroHotels repo itself is not connected, because Vercel could not install its GitHub app on another person's personal account.) Manual deploy still works with `npx vercel deploy --prod`. `.vercelignore` keeps `server/` and the tests off the public site.

## WhatsApp delivery (OpenClaw)

Every submitted report is queued (`outbox/` in Blob storage). A forwarder on the OpenClaw server (`server/`) asks `/api/outbox` every 30 seconds over HTTPS, downloads the generated PDF, posts it to the WhatsApp group with `openclaw message send --channel whatsapp --target <group> --media <pdf>`, then marks it delivered. Nothing needs to be opened on the server, and the OpenClaw gateway and its config are untouched.

- The PDF (`api/_report-pdf.js`) has the overview and per-floor totals, sign-off and handover, every failed item with location, notes and embedded photos, all area notes, and the full item-by-item checklist. Videos are listed with a link to the manager page.
- Vercel env var `OUTBOX_SECRET` must match `OUTBOX_SECRET` in `/etc/cleaning-report-forwarder.env` on the server, which also holds `OUTBOX_URL` and `WHATSAPP_GROUP` (the group's `...@g.us` ID).
- Server install: `forwarder.mjs` in `/opt/cleaning-report-forwarder/`, systemd units from `server/`. Enable with `systemctl enable --now cleaning-report-forwarder.timer`; logs with `journalctl -u cleaning-report-forwarder`.
- The forwarder keeps `/var/lib/cleaning-report-forwarder/sent.json` so a report is never posted twice, even if acknowledging it fails.

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
