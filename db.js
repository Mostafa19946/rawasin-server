// db.js — persistent data store backed by MongoDB Atlas (server-side only, free-forever tier).
//
// WHY A REAL DATABASE AND NOT A LOCAL FILE: Render's free web-service plan has an EPHEMERAL
// filesystem — any file written to disk is wiped whenever the container restarts, which
// happens automatically after ~15 minutes of inactivity (and on every redeploy). MongoDB Atlas
// is used as the durable store; the connection string lives only in this server's environment
// variables and is never sent to the browser. Units/roles/users are also kept in an in-memory
// cache for fast, synchronous reads (several call sites — e.g. permission checks — are not
// async), refreshed at startup and kept in sync on every write.
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('[db] Missing MONGO_URI environment variable — persistence will not work.');
}

const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
let mdb = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------- In-memory cache (fast reads; MongoDB is the durable copy) ----------------
let units = [];
let roles = [];
let users = [];
let ready = false;

async function connect() {
  await client.connect();
  mdb = client.db('rawasin');

  const unitDocs = await mdb.collection('units').find({}).toArray();
  if (unitDocs.length) {
    units = unitDocs.map(d => ({
      code: d.code, project: d.project, desc: d.desc, area: d.area || 0,
      garden_area: d.garden_area || 0, price: d.price || 0, garage: d.garage || 0,
      condition: d.condition || 'متاحة', has_floorplan: !!d.has_floorplan,
    }));
  } else {
    console.log('[seed] No units found in MongoDB — seeding default inventory...');
    units = require('./seed-units.json').map(u => ({
      code: u.code, project: u.project, desc: u.desc || u.code,
      area: u.area || 0, garden_area: u.garden_area || 0,
      price: u.price || 0, garage: u.garage || 0, condition: u.condition || 'متاحة',
      has_floorplan: false,
    }));
    if (units.length) await mdb.collection('units').insertMany(units.map(u => ({ _id: u.code, ...u })));
  }

  const roleDocs = await mdb.collection('roles').find({}).toArray();
  if (roleDocs.length) {
    roles = roleDocs.map(d => ({ id: d._id, name: d.name, perms: d.perms }));
  } else {
    console.log('[seed] No roles found in MongoDB — seeding default roles...');
    roles = [
      { id: 'admin', name: 'مدير عام', perms: { 'plan.use': true, 'inventory.view': true, 'inventory.edit': true, 'inventory.add': true, 'inventory.delete': true, 'inventory.backup': true, 'users.manage': true } },
      { id: 'sales', name: 'مبيعات', perms: { 'plan.use': true, 'inventory.view': true, 'inventory.edit': false, 'inventory.add': false, 'inventory.delete': false, 'inventory.backup': false, 'users.manage': false } },
      { id: 'viewer', name: 'مشاهدة فقط', perms: { 'plan.use': true, 'inventory.view': true, 'inventory.edit': false, 'inventory.add': false, 'inventory.delete': false, 'inventory.backup': false, 'users.manage': false } },
    ];
    await mdb.collection('roles').insertMany(roles.map(r => ({ _id: r.id, name: r.name, perms: r.perms })));
  }

  const userDocs = await mdb.collection('users').find({}).toArray();
  if (userDocs.length) {
    users = userDocs.map(d => ({ username: d._id, password_hash: d.password_hash, role: d.role, display: d.display }));
  } else {
    console.log('[seed] No users found in MongoDB — creating default admin account...');
    const defaultUser = { username: 'admin', password_hash: bcrypt.hashSync('admin123', 10), role: 'admin', display: 'مدير النظام' };
    users = [defaultUser];
    await mdb.collection('users').insertOne({ _id: defaultUser.username, ...defaultUser });
    console.log('[seed] Default login — username: admin / password: admin123 (CHANGE THIS after first login).');
  }

  ready = true;
  console.log(`[db] Connected to MongoDB — ${units.length} units, ${roles.length} roles, ${users.length} users.`);
}

async function connectWithRetry(retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { await connect(); return; }
    catch (err) {
      console.error(`[db] connect attempt ${attempt + 1}/${retries + 1} failed:`, err.message);
      if (attempt < retries) await sleep(1000 * Math.pow(2, attempt));
      else throw err;
    }
  }
}

let connectPromise = connectWithRetry();
// Attach a handler immediately so a failed startup never crashes the whole Node process with
// an "unhandled promise rejection" — real error handling/retry happens inside whenReady().
connectPromise.catch(err => {
  console.error('[db] FAILED TO CONNECT TO MONGODB after retries:', err.message);
  console.error('[db] Check the MONGO_URI environment variable.');
});

async function whenReady() {
  try {
    await connectPromise;
    return true;
  } catch (e) {
    if (!ready) {
      connectPromise = connectWithRetry(1).catch(err => { throw err; });
      await connectPromise;
    }
    return ready;
  }
}

function persistUnits() {
  if (!units.length) return Promise.resolve();
  const ops = units.map(u => ({
    replaceOne: { filter: { _id: u.code }, replacement: { _id: u.code, ...u }, upsert: true },
  }));
  return mdb.collection('units').bulkWrite(ops);
}
function persistRoles() {
  if (!roles.length) return Promise.resolve();
  const ops = roles.map(r => ({
    replaceOne: { filter: { _id: r.id }, replacement: { _id: r.id, name: r.name, perms: r.perms }, upsert: true },
  }));
  return mdb.collection('roles').bulkWrite(ops);
}
function persistUsers() {
  if (!users.length) return Promise.resolve();
  const ops = users.map(u => ({
    replaceOne: {
      filter: { _id: u.username },
      replacement: { _id: u.username, username: u.username, password_hash: u.password_hash, role: u.role, display: u.display },
      upsert: true,
    },
  }));
  return mdb.collection('users').bulkWrite(ops);
}

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
  await mdb.collection('units').deleteOne({ _id: code });
  await mdb.collection('floorplans').deleteMany({ code }).catch(() => {});
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

// ---------------- Floor plans (multiple images per unit; one MongoDB document per image) ----------------
const MAX_FLOORPLAN_IMAGES = 12;

async function getFloorplans(code) {
  const docs = await mdb.collection('floorplans').find({ code }).sort({ createdAt: 1 }).toArray();
  return docs.map(d => d.image);
}
async function addFloorplan(code, imageBase64) {
  const count = await mdb.collection('floorplans').countDocuments({ code });
  if (count >= MAX_FLOORPLAN_IMAGES) return { ok: false, error: `الحد الأقصى ${MAX_FLOORPLAN_IMAGES} صور لكل وحدة` };
  await mdb.collection('floorplans').insertOne({ code, image: imageBase64, createdAt: new Date() });
  const u = findUnit(code);
  if (u) { u.has_floorplan = true; await persistUnits(); }
  return { ok: true, count: count + 1 };
}
async function deleteFloorplanImage(code, index) {
  const docs = await mdb.collection('floorplans').find({ code }).sort({ createdAt: 1 }).toArray();
  if (index < 0 || index >= docs.length) return false;
  await mdb.collection('floorplans').deleteOne({ _id: docs[index]._id });
  const u = findUnit(code);
  if (u) { u.has_floorplan = (docs.length - 1) > 0; await persistUnits(); }
  return true;
}
async function deleteAllFloorplans(code) {
  await mdb.collection('floorplans').deleteMany({ code });
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
  await mdb.collection('roles').deleteOne({ _id: id });
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
  const usernameChanged = patch.username && patch.username !== originalUsername;
  if (patch.username) u.username = patch.username;
  if (patch.password_hash) u.password_hash = patch.password_hash;
  if (patch.role) u.role = patch.role;
  if (patch.display !== undefined) u.display = patch.display;
  if (usernameChanged) await mdb.collection('users').deleteOne({ _id: originalUsername });
  await persistUsers();
  return true;
}
async function deleteUser(username) {
  const before = users.length;
  users = users.filter(u => u.username !== username);
  await mdb.collection('users').deleteOne({ _id: username });
  return users.length < before;
}

module.exports = {
  whenReady,
  listUnits, findUnit, insertUnit, updateUnit, deleteUnit, bulkUpsertUnits,
  getFloorplans, addFloorplan, deleteFloorplanImage, deleteAllFloorplans,
  listRoles, findRole, upsertRole, deleteRole,
  listUsers, findUser, insertUser, updateUser, deleteUser,
};
