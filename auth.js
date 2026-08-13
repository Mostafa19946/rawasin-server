// auth.js — JWT verification and role-permission middleware.
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_THIS_SECRET_IN_PRODUCTION_ENV_VAR';
const TOKEN_TTL = '12h';

function signToken(user) {
  return jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { username, role }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'الجلسة منتهية، سجّل الدخول مرة أخرى' });
  }
}

function requirePermission(capability) {
  return (req, res, next) => {
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.user.role);
    if (!role) return res.status(403).json({ error: 'دور غير معروف' });
    const perms = JSON.parse(role.perms_json);
    if (!perms[capability]) return res.status(403).json({ error: 'ليس لديك صلاحية لهذا الإجراء' });
    next();
  };
}

// Hard restriction: only the built-in "admin" role account may manage user credentials,
// mirroring the rule from the original client-side app (independent of custom role permissions).
function requireAdminRole(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'هذا الإجراء متاح للمدير العام فقط' });
  next();
}

module.exports = { signToken, requireAuth, requirePermission, requireAdminRole, JWT_SECRET };
