#!/usr/bin/env node
require('dotenv').config({ quiet: true });

const path = require('node:path');
const readline = require('node:readline');
const { openDatabase, nowIso } = require('../server/db');
const { hashPassword } = require('../server/auth');

const dbPath =
  process.env.DB_PATH || path.join(process.cwd(), 'data', 'allen-cleaning.db');
const usernamePattern = /^[a-zA-Z0-9._-]{3,32}$/;

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

let pipeBuffer = '';
let pipeLines = [];
let pipeWaiters = [];
let pipeReady = false;

function readPipedLine(question) {
  if (!pipeReady) {
    pipeReady = true;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      pipeBuffer += chunk;
      let newline = pipeBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = pipeBuffer.slice(0, newline).replace(/\r$/, '');
        pipeBuffer = pipeBuffer.slice(newline + 1);
        const waiter = pipeWaiters.shift();
        if (waiter) waiter(line);
        else pipeLines.push(line);
        newline = pipeBuffer.indexOf('\n');
      }
    });
    process.stdin.on('end', () => {
      if (pipeBuffer) {
        const waiter = pipeWaiters.shift();
        if (waiter) waiter(pipeBuffer);
        else pipeLines.push(pipeBuffer);
        pipeBuffer = '';
      }
      while (pipeWaiters.length) pipeWaiters.shift()('');
    });
  }

  process.stdout.write(question);
  if (pipeLines.length) return Promise.resolve(pipeLines.shift());
  return new Promise((resolve) => pipeWaiters.push(resolve));
}

function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY) {
      readPipedLine(question).then(resolve);
      return;
    }

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };

    const onData = (character) => {
      if (character === '\u0003') {
        cleanup();
        stdout.write('\n');
        process.exit(1);
      }
      if (character === '\r' || character === '\n' || character === '\u0004') {
        cleanup();
        stdout.write('\n');
        resolve(value);
        return;
      }
      if (character === '\u007f' || character === '\b') {
        value = value.slice(0, -1);
        return;
      }
      value += character;
    };

    stdin.on('data', onData);
  });
}

async function readPassword(label) {
  const password = await askHidden(label);
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  const confirmation = await askHidden('Confirm password: ');
  if (password !== confirmation) throw new Error('Passwords do not match.');
  return password;
}

function printUsers(db) {
  const users = db
    .prepare('SELECT id, name, username, role, active, created_at FROM users ORDER BY role, name')
    .all();
  if (!users.length) {
    console.log('No users yet. Start the app and visit /login to create the first accounts.');
    return;
  }
  console.log('ID  ROLE        ACTIVE  USERNAME            NAME');
  for (const user of users) {
    console.log(
      String(user.id).padEnd(4) +
        user.role.padEnd(12) +
        (user.active ? 'yes' : 'no').padEnd(8) +
        user.username.padEnd(20) +
        user.name
    );
  }
}

async function addUser(db, name, username, role) {
  if (!name) throw new Error('Name is required.');
  if (!usernamePattern.test(username)) {
    throw new Error('Username must be 3–32 characters using letters, numbers, dots, dashes or underscores.');
  }
  if (!['supervisor', 'manager'].includes(role)) {
    throw new Error('Role must be "supervisor" or "manager".');
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) throw new Error('That username already exists.');

  const password = await readPassword('Password: ');
  const now = nowIso();
  db.prepare(
    'INSERT INTO users (name, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, username, hashPassword(password), role, now, now);
  console.log('Created ' + role + ' account "' + username + '".');
}

async function resetPassword(db, username) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) throw new Error('User not found.');
  const password = await readPassword('New password: ');
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(password), nowIso(), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  console.log('Password updated for "' + user.username + '". All sessions were signed out.');
}

function setActive(db, username, active) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) throw new Error('User not found.');
  db.prepare('UPDATE users SET active = ?, updated_at = ? WHERE id = ?')
    .run(active ? 1 : 0, nowIso(), user.id);
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  console.log(
    (active ? 'Enabled' : 'Disabled') + ' account "' + user.username + '".'
  );
}

function usage() {
  console.log(
    [
      'Allen Cleaning Supervisor — user management',
      '',
      'Usage:',
      '  node scripts/manage-users.js list',
      '  node scripts/manage-users.js add "Full Name" username supervisor',
      '  node scripts/manage-users.js add "Full Name" username manager',
      '  node scripts/manage-users.js password username',
      '  node scripts/manage-users.js disable username',
      '  node scripts/manage-users.js enable username',
      '',
      'Database: ' + dbPath,
      'Set DB_PATH when the database lives elsewhere.'
    ].join('\n')
  );
}

async function main() {
  const [, , command, ...args] = process.argv;
  const db = openDatabase(dbPath);

  try {
    if (command === 'list') {
      printUsers(db);
    } else if (command === 'add') {
      await addUser(db, args[0], args[1], args[2]);
    } else if (command === 'password') {
      if (!args[0]) throw new Error('Provide a username.');
      await resetPassword(db, args[0]);
    } else if (command === 'disable') {
      if (!args[0]) throw new Error('Provide a username.');
      setActive(db, args[0], false);
    } else if (command === 'enable') {
      if (!args[0]) throw new Error('Provide a username.');
      setActive(db, args[0], true);
    } else {
      usage();
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error('Error: ' + error.message);
  process.exitCode = 1;
});
