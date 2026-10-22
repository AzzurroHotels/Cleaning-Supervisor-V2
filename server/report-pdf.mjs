import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const A4 = [595.28, 841.89];
const M = 42;
const RIGHT = A4[0] - M;
const GREEN = rgb(0.216, 0.396, 0.275);
const RED = rgb(0.66, 0.247, 0.196);
const INK = rgb(0.153, 0.243, 0.188);
const SOFT = rgb(0.36, 0.41, 0.36);
const LINE = rgb(0.86, 0.88, 0.84);
const AMBER = rgb(0.71, 0.47, 0.26);
const FLOORS = ['Ground floor', 'First floor', 'Second floor'];

// Standard PDF fonts only cover Latin text, so anything else becomes "?".
const safe = s => String(s ?? '').replace(/\t/g, ' ').replace(/\r/g, '')
  .replace(/[^\n\x20-\x7E\xA0-\xFF–—‘’“”•…€]/g, '?');

const when = iso => {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' });
};

export function reportStats(report) {
  const blank = () => ({ total: 0, pass: 0, fail: 0, unchecked: 0 });
  const all = blank(), byFloor = Object.fromEntries(FLOORS.map(f => [f, blank()]));
  for (const area of report.areas || []) for (const item of area.items) {
    for (const bucket of [all, byFloor[area.floor] || (byFloor[area.floor] = blank())]) {
      bucket.total++;
      bucket[item.status]++;
    }
  }
  return { all, byFloor };
}

class Writer {
  constructor(pdf, fonts) { this.pdf = pdf; this.f = fonts; this.newPage(); }
  newPage() { this.page = this.pdf.addPage(A4); this.y = A4[1] - M - 8; }
  need(h) { if (this.y - h < M + 14) this.newPage(); }
  wrap(str, font, size, width) {
    const out = [];
    for (const para of safe(str).split('\n')) {
      let line = '';
      for (let word of para.split(/ +/)) {
        while (font.widthOfTextAtSize(word, size) > width) {      // break very long words
          let cut = word.length;
          while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > width) cut--;
          if (line) { out.push(line); line = ''; }
          out.push(word.slice(0, cut));
          word = word.slice(cut);
        }
        const next = line ? line + ' ' + word : word;
        if (line && font.widthOfTextAtSize(next, size) > width) { out.push(line); line = word; } else line = next;
      }
      out.push(line);
    }
    return out;
  }
  text(str, { size = 10, bold = false, color = INK, x = M, width = RIGHT - x, gap = 3 } = {}) {
    const font = bold ? this.f.bold : this.f.reg;
    for (const line of this.wrap(str, font, size, width)) {
      this.need(size * 1.35);
      this.page.drawText(line, { x, y: this.y - size, size, font, color });
      this.y -= size * 1.35;
    }
    this.y -= gap;
  }
  heading(str, { size = 14, color = GREEN, before = 14 } = {}) {
    this.need(size * 3 + before + 60);   // keep the heading with the start of its content
    this.y -= before;
    this.text(str, { size, bold: true, color, gap: 2 });
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: RIGHT, y: this.y }, thickness: 0.7, color: LINE });
    this.y -= 6;
  }
  // "LABEL   text" row where the text wraps in its own column.
  row(label, labelColor, str, { size = 9.5, indent = 8, col = 78 } = {}) {
    const lines = this.wrap(str, this.f.reg, size, RIGHT - M - col);
    this.need(lines.length * size * 1.35 + 2);
    this.page.drawText(safe(label), { x: M + indent, y: this.y - size, size: 8, font: this.f.bold, color: labelColor });
    for (const line of lines) {
      this.page.drawText(line, { x: M + col, y: this.y - size, size, font: this.f.reg, color: INK });
      this.y -= size * 1.35;
    }
    this.y -= 2;
  }
  table(rows, widths, { header = true } = {}) {
    rows.forEach((cells, r) => {
      this.need(18);
      const head = header && r === 0;
      if (head) this.page.drawRectangle({ x: M, y: this.y - 15, width: RIGHT - M, height: 17, color: rgb(0.89, 0.92, 0.87) });
      let x = M + 6;
      cells.forEach((cell, c) => {
        this.page.drawText(safe(cell), { x, y: this.y - 11, size: 9.5, font: head || c === 0 ? this.f.bold : this.f.reg, color: INK });
        x += widths[c];
      });
      this.y -= 18;
      this.page.drawLine({ start: { x: M, y: this.y + 1 }, end: { x: RIGHT, y: this.y + 1 }, thickness: 0.4, color: LINE });
    });
    this.y -= 6;
  }
}

async function embed(pdf, bytes) {
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return pdf.embedJpg(bytes);
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return pdf.embedPng(bytes);
  return null;
}

// loadMedia(photoId) -> Uint8Array | null. Photos are embedded; videos are listed.
export async function buildReportPdf(report, { loadMedia = async () => null, adminUrl = '' } = {}) {
  const pdf = await PDFDocument.create();
  const fonts = { reg: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
  const w = new Writer(pdf, fonts);
  const { all, byFloor } = reportStats(report);
  const open = report.failures.filter(f => f.status === 'fail');
  const fixed = report.failures.filter(f => f.status === 'pass');
  const attachments = report.failures.reduce((n, f) => n + f.media.length, 0);

  // Title
  w.text('ALLEN HOSTEL', { size: 10, bold: true, color: GREEN, gap: 0 });
  w.text('Cleaning inspection report', { size: 24, bold: true, gap: 6 });
  w.text(`Inspection date: ${report.date}`, { size: 11, bold: true, gap: 1 });
  w.text(`Submitted: ${when(report.submittedAt)} (Sydney time)   |   By: ${report.name}`, { size: 10, color: SOFT, gap: 1 });
  w.text(`Report ID: ${report.id}`, { size: 8, color: SOFT, gap: 8 });

  // Overview
  const pct = all.total ? Math.round(((all.pass + all.fail) / all.total) * 100) : 0;
  w.heading('Overview');
  w.table([
    ['Result', 'Items'],
    ['Items in checklist', String(all.total)],
    ['Passed', String(all.pass)],
    ['Failed', String(all.fail)],
    ['Not checked', String(all.unchecked)],
    ['Checked', `${pct}%`],
  ], [200, 100]);
  w.text(`Failures recorded: ${report.failures.length} (${open.length} still failing, ${fixed.length} passed after recheck)   |   Photos/videos attached: ${attachments}   |   Area notes: ${(report.areas || []).filter(a => a.note).length}`, { size: 9.5, color: SOFT });
  w.table([['Floor', 'Items', 'Passed', 'Failed', 'Not checked'], ...FLOORS.map(f => {
    const b = byFloor[f]; return [f, b.total, b.pass, b.fail, b.unchecked].map(String);
  })], [150, 70, 70, 70, 90]);

  // Sign-off
  w.heading('Sign-off and handover');
  w.row('RECHECK', report.recheck ? GREEN : AMBER, report.recheck ? 'Missed cleaning has been corrected and checked again.' : 'Not confirmed: missed cleaning has not been confirmed as corrected and rechecked.');
  w.row('HANDOVER', report.handoverDone ? GREEN : AMBER, report.handoverDone ? 'Outstanding cleaning, maintenance and safety issues have been passed to management.' : 'Not confirmed: outstanding issues have not been confirmed as passed to management.');
  w.row('OUTSTANDING', INK, report.handover || 'None recorded.');

  // Failures
  w.heading(`Failed items (${report.failures.length})`, { color: report.failures.length ? RED : GREEN });
  if (!report.failures.length) w.text('No failures were recorded.', { color: SOFT });
  for (const f of FLOORS.flatMap(fl => report.failures.filter(x => x.floor === fl)).concat(report.failures.filter(x => !FLOORS.includes(x.floor)))) {
    w.need(70);
    w.text(`${f.floor}  /  ${f.area}`, { size: 10, bold: true, color: SOFT, gap: 1 });
    w.text(f.item, { size: 11, bold: true, gap: 2 });
    w.row('STATUS', f.status === 'fail' ? RED : GREEN, f.status === 'fail' ? 'FAILED - still to be fixed' : `Passed after recheck${f.recheckedAt ? ' (' + when(f.recheckedAt) + ')' : ''}`);
    w.row('LOCATION', INK, f.location);
    w.row('NOTES', INK, f.notes);
    let x = M, rowH = 0;
    const videos = [];
    for (const m of f.media) {
      if (!m.type.startsWith('image/')) { videos.push(m); continue; }
      let img = null;
      try { img = await embed(pdf, await loadMedia(m.id)); } catch { /* listed below instead */ }
      if (!img) { videos.push(m); continue; }
      const s = Math.min(250 / img.width, 190 / img.height, 1), iw = img.width * s, ih = img.height * s;
      if (x + iw > RIGHT) { x = M; w.y -= rowH + 6; rowH = 0; }
      if (w.y - ih < M + 14) { w.newPage(); x = M; rowH = 0; }
      w.page.drawImage(img, { x, y: w.y - ih, width: iw, height: ih });
      w.page.drawRectangle({ x, y: w.y - ih, width: iw, height: ih, borderColor: LINE, borderWidth: 0.6 });
      x += iw + 10; rowH = Math.max(rowH, ih);
    }
    if (rowH) w.y -= rowH + 8;
    for (const m of videos) w.row(m.type.startsWith('video/') ? 'VIDEO' : 'FILE', SOFT, `${m.name || 'attachment'} - view in the manager page${adminUrl ? ': ' + adminUrl : ''}`);
    w.y -= 6;
    w.page.drawLine({ start: { x: M, y: w.y }, end: { x: RIGHT, y: w.y }, thickness: 0.4, color: LINE });
    w.y -= 8;
  }

  // Area notes
  const noted = (report.areas || []).filter(a => a.note);
  w.heading(`Area notes (${noted.length})`);
  if (!noted.length) w.text('No area notes were added.', { color: SOFT });
  for (const a of noted) {
    w.need(40);
    w.text(`${a.floor}  /  ${a.name}`, { size: 10, bold: true, gap: 1 });
    w.text(a.note, { size: 10, x: M + 8, gap: 6 });
  }

  // Full checklist
  w.heading('Full checklist', { before: 22, size: 16 });
  for (const floor of FLOORS) {
    const areas = (report.areas || []).filter(a => a.floor === floor);
    if (!areas.length) continue;
    const b = byFloor[floor];
    w.heading(`${floor}  -  ${b.pass}/${b.total} passed, ${b.fail} failed, ${b.unchecked} not checked`, { size: 12, color: INK, before: 12 });
    for (const a of areas) {
      const p = a.items.filter(i => i.status === 'pass').length, fl = a.items.filter(i => i.status === 'fail').length;
      w.need(60);
      w.text(`${a.name}   (${p}/${a.items.length} passed${fl ? ', ' + fl + ' failed' : ''})`, { size: 10.5, bold: true, color: fl ? RED : GREEN, gap: 2 });
      for (const i of a.items) {
        const ok = i.status === 'pass', bad = i.status === 'fail';
        w.row(ok ? 'PASS' : bad ? 'FAIL' : 'NOT CHECKED', ok ? GREEN : bad ? RED : SOFT, i.text, { size: 9 });
      }
      if (a.note) w.row('NOTE', AMBER, a.note, { size: 9 });
      w.y -= 6;
    }
  }

  // Footer on every page
  const pages = pdf.getPages();
  pages.forEach((p, n) => p.drawText(safe(`Allen Hostel cleaning report  |  ${report.date}  |  Page ${n + 1} of ${pages.length}`), { x: M, y: 22, size: 8, font: fonts.reg, color: SOFT }));
  return pdf.save();
}

export const reportFilename = report => `Allen-cleaning-report-${report.date}.pdf`;

export function captionFor(report) {
  const { all } = reportStats(report);
  const open = report.failures.filter(f => f.status === 'fail');
  const lines = [
    '*Allen Hostel - cleaning inspection report*',
    `Date: ${report.date}`,
    `Passed ${all.pass} | Failed ${all.fail} | Not checked ${all.unchecked}`,
  ];
  if (open.length) {
    lines.push('', `*Failed items (${open.length}):*`);
    for (const f of open.slice(0, 6)) lines.push(`- ${f.floor} / ${f.area}: ${f.item}${f.location ? ' (' + f.location + ')' : ''}`);
    if (open.length > 6) lines.push(`...and ${open.length - 6} more`);
  } else {
    lines.push('', 'No failed items.');
  }
  lines.push('', 'Full detail, notes and photos are in the attached PDF.');
  let text = lines.join('\n');
  if (text.length > 950) text = text.slice(0, 940).replace(/\n[^\n]*$/, '') + '\n...';
  return text;
}
