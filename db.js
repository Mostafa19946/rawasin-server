// db.js — simple JSON-file-backed data store. Pure JavaScript, zero native dependencies,
// so it builds reliably on any free-tier hosting platform (no C++ compilation step).
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'rawasin.json');

function loadRaw() {
  if (!fs.existsSync(DB_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')); }
  catch (e) { console.error('[db] failed to parse rawasin.json, starting fresh:', e.message); return null; }
}

function saveRaw(data) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf-8');
  fs.renameSync(tmp, DB_FILE);
}

let state = loadRaw();

if (!state) {
  console.log('[seed] No database file found — seeding default data...');
  const seedUnits = require('./seed-units.json').map(u => ({
    code: u.code, project: u.project, desc: u.desc || u.code,
    area: u.area || 0, garden_area: u.garden_area || 0,
    price: u.price || 0, garage: u.garage || 0, condition: u.condition || 'متاحة',
    has_floorplan: false,
  }));

  const defaultRoles = [
    { id: 'admin', name: 'مدير عام', perms: { 'plan.use': true, 'inventory.view': true, 'inventory.edit': true, 'inventory.add': true, 'inventory.delete': true, 'inventory.backup': true, 'users.manage': true } },
    { id: 'sales', name: 'مبيعات', perms: { 'plan.use': true, 'inventory.view': true, 'inventory.edit': false, 'inventory.add': false, 'inventory.delete': false, 'inventory.backup': false, 'users.manage': false } },
    { id: 'viewer', name: 'مشاهدة فقط', perms: { 'plan.use': true, 'inventory.view': true, 'inventory.edit': false, 'inventory.add': false, 'inventory.delete': false, 'inventory.backup': false, 'users.manage': false } },
  ];

  const defaultUsers = [
    { username: 'admin', password_hash: bcrypt.hashSync('admin123', 10), role: 'admin', display: 'مدير النظام' },
  ];

  state = { units: seedUnits, roles: defaultRoles, users: defaultUsers, floorplans: {} };
  saveRaw(state);
  console.log(`[seed] Inserted ${seedUnits.length} units, ${defaultRoles.length} roles, 1 admin user.`);
  console.log('[seed] Default login — username: admin / password: admin123 (CHANGE THIS after first login).');
}

function persist() { saveRaw(state); }

// ---------------- Units ----------------
function listUnits() {
  return state.units.map(u => ({ ...u, hasFloorPlan: !!u.has_floorplan }));
}
function findUnit(code) { return state.units.find(u => u.code === code); }
function insertUnit(u) {
  state.units.push({
    code: u.code, project: u.project, desc: u.desc || u.code,
    area: u.area || 0, garden_area: u.garden_area || 0,
    price: u.price || 0, garage: u.garage || 0, condition: u.condition || 'متاحة',
    has_floorplan: false,
  });
  persist();
}
function updateUnit(code, patch) {
  const u = findUnit(code);
  if (!u) return false;
  Object.assign(u, {
    project: patch.project ?? u.project, desc: patch.desc ?? u.desc,
    area: patch.area ?? u.area, garden_area: patch.garden_area ?? u.garden_area,
    price: patch.price ?? u.price, garage: patch.garage ?? u.garage,
    condition: patch.condition ?? u.condition,
  });
  persist();
  return true;
}
function deleteUnit(code) {
  const before = state.units.length;
  state.units = state.units.filter(u => u.code !== code);
  delete state.floorplans[code];
  persist();
  return state.units.length < before;
}
function bulkUpsertUnits(rows) {
  let created = 0, updated = 0;
  for (const u of rows) {
    const existing = findUnit(u.code);
    if (existing) { updateUnit(u.code, u); updated++; }
    else { insertUnit(u); created++; }
  }
  return { created, updated };
}

// ---------------- Floor plans (multiple images per unit) ----------------
const MAX_FLOORPLAN_IMAGES = 12;

function normalizeFloorplanEntry(entry) {
  // Backward compatibility: older data stored a single base64 string per unit.
  if (typeof entry === 'string') return [entry];
  if (Array.isArray(entry)) return entry;
  return [];
}
function getFloorplans(code) { return normalizeFloorplanEntry(state.floorplans[code]); }
function addFloorplan(code, imageBase64) {
  const list = getFloorplans(code);
  if (list.length >= MAX_FLOORPLAN_IMAGES) return { ok: false, error: `الحد الأقصى ${MAX_FLOORPLAN_IMAGES} صور لكل وحدة` };
  list.push(imageBase64);
  state.floorplans[code] = list;
  const u = findUnit(code);
  if (u) u.has_floorplan = true;
  persist();
  return { ok: true, count: list.length };
}
function deleteFloorplanImage(code, index) {
  const list = getFloorplans(code);
  if (index < 0 || index >= list.length) return false;
  list.splice(index, 1);
  state.floorplans[code] = list;
  const u = findUnit(code);
  if (u) u.has_floorplan = list.length > 0;
  persist();
  return true;
}
function deleteAllFloorplans(code) {
  delete state.floorplans[code];
  const u = findUnit(code);
  if (u) u.has_floorplan = false;
  persist();
}

// ---------------- Roles ----------------
function listRoles() { return state.roles; }
function findRole(id) { return state.roles.find(r => r.id === id); }
function upsertRole(role) {
  const existing = findRole(role.id);
  if (existing) { existing.name = role.name; existing.perms = role.perms; }
  else { state.roles.push({ id: role.id, name: role.name, perms: role.perms }); }
  persist();
}
function deleteRole(id) {
  state.roles = state.roles.filter(r => r.id !== id);
  persist();
}

// ---------------- Users ----------------
function listUsers() { return state.users.map(u => ({ username: u.username, role: u.role, display: u.display })); }
function findUser(username) { return state.users.find(u => u.username === username); }
function insertUser(u) {
  state.users.push({ username: u.username, password_hash: u.password_hash, role: u.role, display: u.display || '' });
  persist();
}
function updateUser(originalUsername, patch) {
  const u = findUser(originalUsername);
  if (!u) return false;
  if (patch.username) u.username = patch.username;
  if (patch.password_hash) u.password_hash = patch.password_hash;
  if (patch.role) u.role = patch.role;
  if (patch.display !== undefined) u.display = patch.display;
  persist();
  return true;
}
function deleteUser(username) {
  const before = state.users.length;
  state.users = state.users.filter(u => u.username !== username);
  persist();
  return state.users.length < before;
}

module.exports = {
  listUnits, findUnit, insertUnit, updateUnit, deleteUnit, bulkUpsertUnits,
  getFloorplans, addFloorplan, deleteFloorplanImage, deleteAllFloorplans,
  listRoles, findRole, upsertRole, deleteRole,
  listUsers, findUser, insertUser, updateUser, deleteUser,
};
