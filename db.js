// db.js — SQLite database setup, schema, and first-run seed data.
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'rawasin.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS units (
  code TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  desc TEXT,
  area REAL DEFAULT 0,
  garden_area REAL DEFAULT 0,
  price REAL DEFAULT 0,
  garage REAL DEFAULT 0,
  condition TEXT DEFAULT 'متاحة',
  has_floorplan INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS floorplans (
  code TEXT PRIMARY KEY,
  image_base64 TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (code) REFERENCES units(code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  perms_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  display TEXT,
  FOREIGN KEY (role) REFERENCES roles(id)
);
`);

// ---------------- First-run seed ----------------
const unitCount = db.prepare('SELECT COUNT(*) AS c FROM units').get().c;
if (unitCount === 0) {
  console.log('[seed] Empty database detected — seeding default data...');

  const seedUnits = require('./seed-units.json');
  const insertUnit = db.prepare(`
    INSERT INTO units (code, project, desc, area, garden_area, price, garage, condition)
    VALUES (@code, @project, @desc, @area, @garden_area, @price, @garage, @condition)
  `);
  const insertUnits = db.transaction((rows) => {
    for (const u of rows) insertUnit.run(u);
  });
  insertUnits(seedUnits);
  console.log(`[seed] Inserted ${seedUnits.length} units.`);

  const defaultRoles = [
    { id: 'admin', name: 'مدير عام', perms: { 'plan.use': true, 'inventory.view': true, 'inventory.edit': true, 'inventory.add': true, 'inventory.delete': true, 'inventory.backup': true, 'users.manage': true } },
    { id: 'sales', name: 'مبيعات', perms: { 'plan.use': true, 'inventory.view': true, 'inventory.edit': false, 'inventory.add': false, 'inventory.delete': false, 'inventory.backup': false, 'users.manage': false } },
    { id: 'viewer', name: 'مشاهدة فقط', perms: { 'plan.use': true, 'inventory.view': true, 'inventory.edit': false, 'inventory.add': false, 'inventory.delete': false, 'inventory.backup': false, 'users.manage': false } },
  ];
  const insertRole = db.prepare('INSERT INTO roles (id, name, perms_json) VALUES (?, ?, ?)');
  for (const r of defaultRoles) insertRole.run(r.id, r.name, JSON.stringify(r.perms));
  console.log('[seed] Inserted default roles.');

  const defaultPasswordHash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password_hash, role, display) VALUES (?, ?, ?, ?)')
    .run('admin', defaultPasswordHash, 'admin', 'مدير النظام');
  console.log('[seed] Created default admin user (username: admin / password: admin123 — CHANGE THIS after first login).');
}

module.exports = db;
