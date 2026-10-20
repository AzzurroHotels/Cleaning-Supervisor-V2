const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('supervisor', 'manager')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS inspections (
  id TEXT PRIMARY KEY,
  inspector_id INTEGER NOT NULL REFERENCES users(id),
  inspector_name TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
  handover TEXT NOT NULL DEFAULT '',
  corrections_rechecked INTEGER NOT NULL DEFAULT 0,
  handover_done INTEGER NOT NULL DEFAULT 0,
  checklist_json TEXT NOT NULL,
  total_items INTEGER NOT NULL,
  pass_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_inspections_date ON inspections(date);
CREATE INDEX IF NOT EXISTS idx_inspections_inspector ON inspections(inspector_id, date);
CREATE INDEX IF NOT EXISTS idx_inspections_status ON inspections(status);

CREATE TABLE IF NOT EXISTS results (
  inspection_id TEXT NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  group_key TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  group_name TEXT NOT NULL,
  floor TEXT NOT NULL,
  item_text TEXT NOT NULL,
  kind TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('pass', 'fail')),
  location TEXT,
  notes TEXT,
  recorded_at TEXT,
  rechecked_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (inspection_id, group_key, item_index)
);
CREATE INDEX IF NOT EXISTS idx_results_result ON results(result);
CREATE INDEX IF NOT EXISTS idx_results_group ON results(inspection_id, group_key);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  group_key TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  stored_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_inspection ON attachments(inspection_id);
CREATE INDEX IF NOT EXISTS idx_attachments_result ON attachments(inspection_id, group_key, item_index);
`;

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = { openDatabase, nowIso };
