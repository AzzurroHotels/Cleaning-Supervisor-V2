const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const { createApp } = require('../server/app');
const { hashPassword } = require('../server/auth');
const { nowIso } = require('../server/db');

class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }

  async request(pathname, { method = 'GET', body, formData, headers = {}, redirect = 'follow' } = {}) {
    const requestHeaders = { ...headers };
    if (this.cookie) requestHeaders.cookie = this.cookie;
    let payload;
    if (formData) {
      payload = formData;
    } else if (body !== undefined) {
      requestHeaders['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const response = await fetch(this.base + pathname, {
      method,
      headers: requestHeaders,
      body: payload,
      redirect
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      this.cookie = setCookie.split(';')[0];
    }
    let data = null;
    const contentType = response.headers.get('content-type') || '';
    if (response.status !== 204 && contentType.includes('application/json')) {
      data = await response.json().catch(() => null);
    }
    return { response, data };
  }

  get(pathname, options) {
    return this.request(pathname, { ...options, method: 'GET' });
  }

  post(pathname, body, options) {
    return this.request(pathname, { ...options, method: 'POST', body });
  }

  put(pathname, body, options) {
    return this.request(pathname, { ...options, method: 'PUT', body });
  }

  patch(pathname, body, options) {
    return this.request(pathname, { ...options, method: 'PATCH', body });
  }

  delete(pathname, options) {
    return this.request(pathname, { ...options, method: 'DELETE' });
  }

  async login(username, password) {
    const result = await this.post('/api/auth/login', { username, password });
    assert.equal(result.response.status, 200, 'login should succeed for ' + username);
    return result.data.user;
  }
}

async function startServer() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'allen-api-test-'));
  const instance = createApp({
    dbPath: path.join(directory, 'test.db'),
    uploadDir: path.join(directory, 'uploads'),
    sessionDays: 7,
    loginRateLimit: false
  });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    base,
    server,
    instance,
    directory,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      instance.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

describe('Allen Cleaning Supervisor API', () => {
  let ctx;
  let supervisor;
  let manager;
  let otherSupervisor;
  let inspectionId;
  let groupKey;
  let attachmentId;

  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  before(async () => {
    ctx = await startServer();
    supervisor = new Client(ctx.base);
    manager = new Client(ctx.base);
    otherSupervisor = new Client(ctx.base);
  });

  after(async () => {
    await ctx.close();
  });

  it('redirects unauthenticated app visits to the login page', async () => {
    const root = await fetch(ctx.base + '/', { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/login');
    const loginPage = await fetch(ctx.base + '/login');
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /Allen Hostel/);
  });

  it('handles first-run setup, status and duplicate setup protection', async () => {
    const status = await supervisor.get('/api/auth/status');
    assert.equal(status.data.needsSetup, true);
    assert.equal(status.data.user, null);

    const setup = await supervisor.post('/api/auth/setup', {
      supervisorName: 'Alvin Mensah',
      supervisorUsername: 'supervisor',
      supervisorPassword: 'password123',
      managerName: 'Maria Allen',
      managerUsername: 'manager',
      managerPassword: 'password456'
    });
    assert.equal(setup.response.status, 201);
    assert.equal(setup.data.ok, true);

    const afterSetup = await supervisor.get('/api/auth/status');
    assert.equal(afterSetup.data.needsSetup, false);

    const duplicate = await supervisor.post('/api/auth/setup', {
      supervisorName: 'Another',
      supervisorUsername: 'another',
      supervisorPassword: 'password123',
      managerName: 'Another Manager',
      managerUsername: 'anothermanager',
      managerPassword: 'password456'
    });
    assert.equal(duplicate.response.status, 409);
  });

  it('logs users in and out and enforces sessions', async () => {
    const anonymous = new Client(ctx.base);
    const unauthorized = await anonymous.get('/api/inspections');
    assert.equal(unauthorized.response.status, 401);

    const wrong = await anonymous.post('/api/auth/login', {
      username: 'supervisor',
      password: 'wrong-password'
    });
    assert.equal(wrong.response.status, 401);

    const user = await supervisor.login('supervisor', 'password123');
    assert.equal(user.role, 'supervisor');
    assert.equal(user.name, 'Alvin Mensah');

    const me = await supervisor.get('/api/auth/me');
    assert.equal(me.response.status, 200);
    assert.equal(me.data.user.username, 'supervisor');

    const managerUser = await manager.login('manager', 'password456');
    assert.equal(managerUser.role, 'manager');

    const now = nowIso();
    ctx.instance.db
      .prepare(
        'INSERT INTO users (name, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        'Other Supervisor',
        'other',
        hashPassword('password789'),
        'supervisor',
        now,
        now
      );
    const otherUser = await otherSupervisor.login('other', 'password789');
    assert.equal(otherUser.role, 'supervisor');
  });

  it('restricts manager writes and cross-supervisor access', async () => {
    const forbidden = await manager.post('/api/inspections', {});
    assert.equal(forbidden.response.status, 403);

    const created = await otherSupervisor.post('/api/inspections', {});
    assert.equal(created.response.status, 201);
    const otherId = created.data.inspection.id;

    const hidden = await supervisor.get('/api/inspections/' + otherId);
    assert.equal(hidden.response.status, 403);

    const managerView = await manager.get('/api/inspections/' + otherId);
    assert.equal(managerView.response.status, 200);

    const managerEdit = await manager.patch('/api/inspections/' + otherId, { handover: 'No' });
    assert.equal(managerEdit.response.status, 403);

    await otherSupervisor.delete('/api/inspections/' + otherId);
  });

  it('creates the full 54-section, 366-item checklist', async () => {
    const created = await supervisor.post('/api/inspections', { date: '2026-10-20' });
    assert.equal(created.response.status, 201);
    const inspection = created.data.inspection;
    inspectionId = inspection.id;
    groupKey = inspection.groups[0].id;

    assert.equal(inspection.groups.length, 54);
    assert.equal(inspection.stats.total, 366);
    assert.equal(inspection.status, 'draft');
    assert.equal(inspection.inspector.name, 'Alvin Mensah');
    assert.equal(inspection.groups.filter((group) => group.kind === 'room').length, 28);
    assert.equal(inspection.groups.filter((group) => group.floor === 'Second floor').length, 21);
  });

  it('validates and saves checklist results with reinspection history', async () => {
    const pass = await supervisor.put(
      '/api/inspections/' + inspectionId + '/results/' + groupKey + '/0',
      { result: 'pass' }
    );
    assert.equal(pass.response.status, 200);
    assert.equal(pass.data.result.result, 'pass');

    const invalid = await supervisor.put(
      '/api/inspections/' + inspectionId + '/results/' + groupKey + '/1',
      { result: 'fail' }
    );
    assert.equal(invalid.response.status, 400);

    const fail = await supervisor.put(
      '/api/inspections/' + inspectionId + '/results/' + groupKey + '/1',
      {
        result: 'fail',
        location: 'Entrance glass door',
        notes: 'Fingerprints on the glass beside the keypad.'
      }
    );
    assert.equal(fail.response.status, 200);
    assert.equal(fail.data.result.result, 'fail');
    assert.ok(fail.data.result.recorded_at);

    const rechecked = await supervisor.put(
      '/api/inspections/' + inspectionId + '/results/' + groupKey + '/1',
      { result: 'pass' }
    );
    assert.equal(rechecked.response.status, 200);
    assert.equal(rechecked.data.result.result, 'pass');
    assert.ok(rechecked.data.result.rechecked_at);
    assert.equal(rechecked.data.result.location, 'Entrance glass door');
    assert.equal(rechecked.data.result.notes, 'Fingerprints on the glass beside the keypad.');

    const detail = await supervisor.get('/api/inspections/' + inspectionId);
    assert.equal(detail.data.inspection.stats.pass, 2);
    assert.equal(detail.data.inspection.stats.checkedGroups, 0);
    assert.equal(detail.data.inspection.groups[0].items[0].result, 'pass');
    assert.equal(detail.data.inspection.groups[0].items[1].failure.recheckedAt !== null, true);
  });

  it('uploads evidence only for current failures and protects the files', async () => {
    const failed = await supervisor.put(
      '/api/inspections/' + inspectionId + '/results/' + groupKey + '/2',
      {
        result: 'fail',
        location: 'Reception screen',
        notes: 'Dust on the screen and camera housing.'
      }
    );
    assert.equal(failed.response.status, 200);

    const form = new FormData();
    form.append('files', new Blob([pngBytes], { type: 'image/png' }), 'evidence.png');
    const upload = await supervisor.request(
      '/api/inspections/' +
        inspectionId +
        '/attachments?groupKey=' +
        encodeURIComponent(groupKey) +
        '&itemIndex=2',
      { method: 'POST', formData: form }
    );
    assert.equal(upload.response.status, 201);
    assert.equal(upload.data.attachments.length, 1);
    attachmentId = upload.data.attachments[0].id;

    const image = await supervisor.get('/api/attachments/' + attachmentId);
    assert.equal(image.response.status, 200);
    assert.equal(image.response.headers.get('content-type'), 'image/png');
    assert.match(image.response.headers.get('content-disposition'), /evidence\.png/);

    const managerImage = await manager.get('/api/attachments/' + attachmentId);
    assert.equal(managerImage.response.status, 200);

    const otherImage = await otherSupervisor.get('/api/attachments/' + attachmentId);
    assert.equal(otherImage.response.status, 403);

    const uploaded = fs.readdirSync(path.join(ctx.directory, 'uploads'));
    assert.equal(uploaded.length, 1);

    const badForm = new FormData();
    badForm.append('files', new Blob(['<html></html>'], { type: 'text/html' }), 'evil.html');
    const badUpload = await supervisor.request(
      '/api/inspections/' +
        inspectionId +
        '/attachments?groupKey=' +
        encodeURIComponent(groupKey) +
        '&itemIndex=2',
      { method: 'POST', formData: badForm }
    );
    assert.equal(badUpload.response.status, 400);

    const detail = await supervisor.get('/api/inspections/' + inspectionId);
    assert.equal(detail.data.inspection.groups[0].items[2].failure.attachments.length, 1);
  });

  it('saves sign-off fields, lists inspections and serves dashboard statistics', async () => {
    const patch = await supervisor.patch('/api/inspections/' + inspectionId, {
      date: '2026-10-20',
      handover: 'Entrance screen needs a second clean before 10am.',
      correctionsRechecked: true,
      handoverDone: true
    });
    assert.equal(patch.response.status, 200);
    assert.equal(patch.data.inspection.handoverDone, true);
    assert.equal(patch.data.inspection.correctionsRechecked, true);

    const list = await manager.get('/api/inspections?status=draft&from=2026-10-01&to=2026-10-31');
    assert.equal(list.response.status, 200);
    assert.equal(list.data.total, 1);
    assert.equal(list.data.items[0].id, inspectionId);

    const filtered = await manager.get('/api/inspections?q=Alvin');
    assert.equal(filtered.data.total, 1);

    const stats = await supervisor.get('/api/stats');
    assert.equal(stats.response.status, 200);
    assert.equal(stats.data.scope, 'mine');
    assert.equal(stats.data.today.inspections, 1);
    assert.equal(stats.data.today.fail, 1);
    assert.equal(stats.data.today.pass, 2);
    assert.equal(stats.data.week.trend.length, 7);
    assert.equal(stats.data.floors.length, 3);
    assert.equal(stats.data.topFailures.length, 1);
    assert.equal(stats.data.activeDraft.id, inspectionId);

    const managerStats = await manager.get('/api/stats');
    assert.equal(managerStats.data.scope, 'all');
    assert.equal(managerStats.data.inspectors.length, 2);
  });

  it('completes, locks, reopens and enforces origin checks', async () => {
    const complete = await supervisor.post(
      '/api/inspections/' + inspectionId + '/complete'
    );
    assert.equal(complete.response.status, 200);
    assert.equal(complete.data.inspection.status, 'completed');

    const locked = await supervisor.put(
      '/api/inspections/' + inspectionId + '/results/' + groupKey + '/3',
      { result: 'pass' }
    );
    assert.equal(locked.response.status, 409);

    const reopen = await supervisor.post('/api/inspections/' + inspectionId + '/reopen');
    assert.equal(reopen.response.status, 200);
    assert.equal(reopen.data.inspection.status, 'draft');

    const badOrigin = await supervisor.request('/api/inspections', {
      method: 'POST',
      body: {},
      headers: { origin: 'http://evil.example' }
    });
    assert.equal(badOrigin.response.status, 403);
  });

  it('validates dates and deletes drafts with their evidence files', async () => {
    const invalidDate = await supervisor.post('/api/inspections', { date: '2026-02-31' });
    assert.equal(invalidDate.response.status, 400);

    const noResults = await supervisor.post('/api/inspections', {});
    assert.equal(noResults.response.status, 201);
    const emptyComplete = await supervisor.post(
      '/api/inspections/' + noResults.data.inspection.id + '/complete'
    );
    assert.equal(emptyComplete.response.status, 400);
    await supervisor.delete('/api/inspections/' + noResults.data.inspection.id);

    const remove = await supervisor.delete('/api/inspections/' + inspectionId);
    assert.equal(remove.response.status, 204);
    assert.equal(fs.readdirSync(path.join(ctx.directory, 'uploads')).length, 0);

    const missing = await supervisor.get('/api/inspections/' + inspectionId);
    assert.equal(missing.response.status, 404);
  });
});
