# Allen cleaning checklist

Frontend-only hostel inspection checklist. No build tools, backend, account, analytics, credentials, or external services are required.

## Run

Open `index.html` in a current browser, or serve this folder using a static web server. Keep `responsive.css` beside `index.html`. For deployment, publish these two files together. HTTPS hosting is recommended for consistent browser storage and clipboard support.

## Inspector flow

The checklist now has separate expandable sections for all 28 rooms, 17 shared facilities, and common areas, organised by floor. Seven rooms have ensuite checks based on the supplied sheet; rooms 15 and 20 include an on-site arrangement verification because the source is inconsistent. Room 6 includes both connected sleeping sections.

The room-by-room version uses a new local storage key (`allen-rooms-v2`). Previous general-checklist records are left untouched under the old key; blanket passes are not transferred to individual rooms.

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
