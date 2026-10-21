import { Readable } from 'node:stream';
import { del, get, list, put } from '@vercel/blob';
import { isOutbox } from './_auth.js';
import { buildReportPdf, reportFilename, reportStats } from './_report-pdf.js';

// Queue of submitted reports waiting to be sent to WhatsApp. The OpenClaw server polls this:
//   GET  /api/outbox          -> pending reports with their file name and WhatsApp caption
//   GET  /api/outbox?id=<id>  -> the PDF for one report
//   POST /api/outbox {id}     -> mark it delivered (removes it from the queue)
const readJson = async pathname => {
  const blob = await get(pathname, { access: 'private', useCache: false });
  if (!blob || blob.statusCode !== 200) return null;
  return JSON.parse(await new Response(blob.stream).text());
};

const loadMedia = async pathname => {
  const blob = await get(pathname, { access: 'private' });
  if (!blob || blob.statusCode !== 200) return null;
  return new Uint8Array(await new Response(blob.stream).arrayBuffer());
};

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

async function pending() {
  const { blobs } = await list({ prefix: 'outbox/' });
  return blobs.sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt)).slice(0, 10);
}

export default async function handler(req, res) {
  if (!isOutbox(req)) return res.status(401).json({ error: 'Not allowed' });
  try {
    if (req.method === 'GET' && req.query.id) {
      const id = String(req.query.id);
      if (!/^[\w-]{8,64}$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
      const marker = await readJson(`outbox/${id}.json`);
      const report = marker && await readJson(marker.reportPath);
      if (!report) return res.status(404).json({ error: 'Not found' });
      const bytes = await buildReportPdf(report, { loadMedia, adminUrl: `https://${req.headers.host}/admin.html` });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${reportFilename(report)}"`);
      res.status(200);
      return Readable.from([Buffer.from(bytes)]).pipe(res);   // streamed: not subject to the 4.5 MB buffered limit
    }
    if (req.method === 'GET') {
      const items = [];
      for (const blob of await pending()) {
        const marker = await readJson(blob.pathname);
        const report = marker && await readJson(marker.reportPath);
        if (report) items.push({ id: marker.id, filename: reportFilename(report), caption: captionFor(report) });
      }
      return res.status(200).json({ pending: items });
    }
    if (req.method === 'POST') {
      const id = String(req.body?.id || '');
      if (!/^[\w-]{8,64}$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
      await put(`outbox-sent/${id}.json`, JSON.stringify({ id, sentAt: new Date().toISOString() }), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
      await del(`outbox/${id}.json`);
      return res.status(200).json({ ok: true });
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
