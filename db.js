// db.js — persistent data store backed by Airtable (server-side only).
//
// WHY AIRTABLE AND NOT A LOCAL FILE: Render's free web-service plan has an EPHEMERAL
// filesystem — any file written to disk is wiped whenever the container restarts, which
// happens automatically after ~15 minutes of inactivity (and on every redeploy). A local
// JSON file or SQLite database will silently lose all data on the free tier. Airtable is
// used purely as a persistent key-value store here; the Airtable token lives only in this
// server's environment variables and is never sent to the browser.
const bcrypt = require('bcryptjs');

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'KVStore';

if (!AIRTABLE_BASE_ID || !AIRTABLE_TOKEN) {
  console.error('[db] Missing AIRTABLE_BASE_ID / AIRTABLE_TOKEN environment variables — persistence will not work.');
}

const AT_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`;
const recordIdCache = {}; // key -> Airtable record id, once known

async function atGet(key) {
  const res = await fetch(AT_URL, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!res.ok) throw new Error(`Airtable GET failed: ${res.status}`);
  const data = await res.json();
  const rec = (data.records || []).find(r => r.fields && r.fields.key === key);
  if (rec) { recordIdCache[key] = rec.id; return rec.fields.value || null; }
  return null;
}

async function atSet(key, value) {
  if (recordIdCache[key]) {
    const res = await fetch(AT_URL, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ id: recordIdCache[key], fields: { value } }] }),
    });
    if (!res.ok) throw new Error(`Airtable PATCH failed: ${res.status}`);
  } else {
    const res = await fetch(AT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields: { key, value } }] }),
    });
    if (!res.ok) throw new Error(`Airtable POST failed: ${res.status}`);
    const data = await res.json();
    recordIdCache[key] = data.records[0].id;
  }
}

async function atDelete(key) {
  if (!recordIdCache[key]) {
    // make sure we know the record id before trying to delete it
    await atGet(key);
    if (!recordIdCache[key]) return;
  }
  const res = await fetch(`${AT_URL}/${recordIdCache[key]}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });
  if (res.ok) delete recordIdCache[key];
}

// ---------------- In-memory cache (fast reads; Airtable is the durable copy) ----------------
let units = [];
let roles = [];
let users = [];
let ready = false;

async function init() {
  const [uJson, rJson, usJson] = await Promise.all([
    atGet('rawasin_units_v1').catch(() => null),
    atGet('rawasin_roles_v1').catch(() => null),
    atGet('rawasin_users_v1').catch(() => null),
  ]);

  if (uJson) {
    units = JSON.parse(uJson);
  } else {
    console.log('[seed] No units found in Airtable — seeding default inventory...');
    units = require('./seed-units.json').map(u => ({
      code: u.code, project: u.project, desc: u.desc || u.code,
      area: u.area || 0, garden_area: u.garden_area || 0,
      price: u.price || 0, garage: u.garage || 0, condition: u.condition || 'متاحة',
      has_floorplan: false,
    }));
    await atSet('rawasin_units_v1', JSON.stringify(units));
  }

  if (rJson) {
    roles = JSON.parse(rJson);
  } else {
    console.log('[seed] No roles found in Airtable — seeding default roles...');
    roles = [
      { id: 'admin', name: 'مدير عام', perms: { 'plan.use': true, 'inventory.view': true, 'inventory.edit': true, 'inventory.add': true, 'inventory.delete': true, 'inventory.backup': true, 'users.manage': true } },
      { id: 'sales', name: 'مبيعات', perms: { 'plan.use': true, 'inventory.view': true, 'inventory.edit': false, 'inventory.add': false, 'inventory.delete': false, 'inventory.backup': false, 'users.manage': false } },
      { id: 'viewer', name: 'مشاهدة فقط', perms: { 'plan.use': true, 'inventory.view': true, 'inventory.edit': false, 'inventory.add': false, 'inventory.delete': false, 'inventory.backup': false, 'users.manage': false } },
    ];
    await atSet('rawasin_roles_v1', JSON.stringify(roles));
  }

  if (usJson) {
    users = JSON.parse(usJson);
  } else {
    console.log('[seed] No users found in Airtable — creating default admin account...');
    users = [{ username: 'admin', password_hash: bcrypt.hashSync('admin123', 10), role: 'admin', display: 'مدير النظام' }];
    await atSet('rawasin_users_v1', JSON.stringify(users));
    console.log('[seed] Default login — username: admin / password: admin123 (CHANGE THIS after first login).');
  }

  ready = true;
  console.log(`[db] Loaded from Airtable — ${units.length} units, ${roles.length} roles, ${users.length} users.`);
}
const initPromise = init().catch(err => {
  console.error('[db] FAILED TO INITIALIZE FROM AIRTABLE:', err.message);
  console.error('[db] Check AIRTABLE_BASE_ID / AIRTABLE_TOKEN / AIRTABLE_TABLE environment variables.');
});

async function whenReady() { await initPromise; return ready; }

function persistUnits() { return atSet('rawasin_units_v1', JSON.stringify(units)); }
function persistRoles() { return atSet('rawasin_roles_v1', JSON.stringify(roles)); }
function persistUsers() { return atSet('rawasin_users_v1', JSON.stringify(users)); }

// ---------------- Units ----------------
function listUnits() { return units.map(u => ({ ...u, hasFloorPlan: !!u.has_floorplan })); }
function findUnit(code) { return units.find(u => u.code === code); }
async function insertUnit(u) {
  units.push({
    code: u.code, project: u.project, desc: u.desc || u.code,
    area: u.area || 0, garden_area: u.garden_area || 0,
    price: u.price || 0, garage: u.garage || 0, condition: u.condition || 'متاحة',
    has_floorplan: false,
  });
  await persistUnits();
}
async function updateUnit(code, patch) {
  const u = findUnit(code);
  if (!u) return false;
  Object.assign(u, {
    project: patch.project ?? u.project, desc: patch.desc ?? u.desc,
    area: patch.area ?? u.area, garden_area: patch.garden_area ?? u.garden_area,
    price: patch.price ?? u.price, garage: patch.garage ?? u.garage,
    condition: patch.condition ?? u.condition,
  });
  await persistUnits();
  return true;
}
async function deleteUnit(code) {
  const before = units.length;
  units = units.filter(u => u.code !== code);
  await persistUnits();
  await atDelete('floorplan_' + code).catch(() => {});
  return units.length < before;
}
async function bulkUpsertUnits(rows) {
  let created = 0, updated = 0;
  for (const u of rows) {
    const existing = findUnit(u.code);
    if (existing) {
      Object.assign(existing, {
        project: u.project ?? existing.project, desc: u.desc ?? existing.desc,
        area: u.area ?? existing.area, garden_area: u.garden_area ?? existing.garden_area,
        price: u.price ?? existing.price, garage: u.garage ?? existing.garage,
        condition: u.condition ?? existing.condition,
      });
      updated++;
    } else {
      units.push({
        code: u.code, project: u.project || 'كمبوند رواسين', desc: u.desc || u.code,
        area: u.area || 0, garden_area: u.garden_area || 0,
        price: u.price || 0, garage: u.garage || 0, condition: u.condition || 'متاحة',
        has_floorplan: false,
      });
      created++;
    }
  }
  await persistUnits();
  return { created, updated };
}

// ---------------- Floor plans (multiple images per unit; each image is its own Airtable row
// so a unit with several images never risks exceeding Airtable's per-cell text size limit) ----------------
const MAX_FLOORPLAN_IMAGES = 12;

async function listFloorplanRows(code) {
  const res = await fetch(AT_URL, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!res.ok) throw new Error(`Airtable GET failed: ${res.status}`);
  const data = await res.json();
  const prefix = `floorplan_${code}_`;
  const matches = (data.records || []).filter(r => r.fields && typeof r.fields.key === 'string' && r.fields.key.startsWith(prefix));
  matches.forEach(r => { recordIdCache[r.fields.key] = r.id; });
  matches.sort((a, b) => a.fields.key.localeCompare(b.fields.key)); // suffix is a timestamp, so this is chronological
  return matches.map(r => ({ key: r.fields.key, value: r.fields.value }));
}

async function getFloorplans(code) {
  const rows = await listFloorplanRows(code);
  return rows.map(r => r.value);
}
async function addFloorplan(code, imageBase64) {
  const rows = await listFloorplanRows(code);
  if (rows.length >= MAX_FLOORPLAN_IMAGES) return { ok: false, error: `الحد الأقصى ${MAX_FLOORPLAN_IMAGES} صور لكل وحدة` };
  const key = `floorplan_${code}_${Date.now()}`;
  await atSet(key, imageBase64);
  const u = findUnit(code);
  if (u) { u.has_floorplan = true; await persistUnits(); }
  return { ok: true, count: rows.length + 1 };
}
async function deleteFloorplanImage(code, index) {
  const rows = await listFloorplanRows(code);
  if (index < 0 || index >= rows.length) return false;
  await atDelete(rows[index].key);
  const u = findUnit(code);
  if (u) { u.has_floorplan = rows.length - 1 > 0; await persistUnits(); }
  return true;
}
async function deleteAllFloorplans(code) {
  const rows = await listFloorplanRows(code);
  for (const row of rows) await atDelete(row.key);
  const u = findUnit(code);
  if (u) { u.has_floorplan = false; await persistUnits(); }
}

// ---------------- Roles ----------------
function listRoles() { return roles; }
function findRole(id) { return roles.find(r => r.id === id); }
async function upsertRole(role) {
  const existing = findRole(role.id);
  if (existing) { existing.name = role.name; existing.perms = role.perms; }
  else { roles.push({ id: role.id, name: role.name, perms: role.perms }); }
  await persistRoles();
}
async function deleteRole(id) {
  roles = roles.filter(r => r.id !== id);
  await persistRoles();
}

// ---------------- Users ----------------
function listUsers() { return users.map(u => ({ username: u.username, role: u.role, display: u.display })); }
function findUser(username) { return users.find(u => u.username === username); }
async function insertUser(u) {
  users.push({ username: u.username, password_hash: u.password_hash, role: u.role, display: u.display || '' });
  await persistUsers();
}
async function updateUser(originalUsername, patch) {
  const u = findUser(originalUsername);
  if (!u) return false;
  if (patch.username) u.username = patch.username;
  if (patch.password_hash) u.password_hash = patch.password_hash;
  if (patch.role) u.role = patch.role;
  if (patch.display !== undefined) u.display = patch.display;
  await persistUsers();
  return true;
}
async function deleteUser(username) {
  const before = users.length;
  users = users.filter(u => u.username !== username);
  await persistUsers();
  return users.length < before;
}

module.exports = {
  whenReady,
  listUnits, findUnit, insertUnit, updateUnit, deleteUnit, bulkUpsertUnits,
  getFloorplans, addFloorplan, deleteFloorplanImage, deleteAllFloorplans,
  listRoles, findRole, upsertRole, deleteRole,
  listUsers, findUser, insertUser, updateUser, deleteUser,
};
