// ===========================================================
// /api/auth — Vercel serverless function (Q5+Q6 통합 인증)
//   ?view= 분기 (5주차 컨벤션)
//     - POST ?view=register   { email, password, display_name }
//     - POST ?view=login      { email, password }
//     - GET  ?view=me         Authorization: Bearer <JWT>
//     - POST ?view=logout     Authorization: Bearer <JWT>
//
// 응답 메타: timezone: "Asia/Seoul"
// 에러 응답: { error, detail? }
// ===========================================================
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { readBearer, hashToken } = require('../lib/auth-helper');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const TZ = 'Asia/Seoul';
const BCRYPT_ROUNDS = 10;
const JWT_EXPIRES_IN = '7d';
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET 미설정 — .env.local 또는 Vercel env에 추가 필요');
}

// ──────────── helpers ────────────

function err(status, msg, detail) {
  return { status, body: detail ? { error: msg, detail } : { error: msg } };
}
function ok(body, status = 200) {
  return { status, body };
}

function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 255;
}

// password 8+ chars + 영문/숫자/특수문자 중 2종 이상
function validatePassword(p) {
  if (typeof p !== 'string') return '비밀번호 필수';
  if (p.length < 8) return '비밀번호 8자 이상';
  if (p.length > 100) return '비밀번호 100자 이내';
  let kinds = 0;
  if (/[a-zA-Z]/.test(p)) kinds++;
  if (/\d/.test(p))       kinds++;
  if (/[^a-zA-Z0-9]/.test(p)) kinds++;
  if (kinds < 2) return '비밀번호 영문/숫자/특수문자 중 2종 이상 조합';
  return null;
}

function isDisplayName(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  return t.length >= 2 && t.length <= 20;
}

function signToken(user) {
  return jwt.sign(
    { uid: Number(user.id), email: user.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// JWT 7일 후 만료시각 (ms)
function expiresAt7d() {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

function publicUser(row) {
  return {
    id: Number(row.id),
    email: row.email,
    display_name: row.display_name,
    created_at: row.created_at,
  };
}


// ──────────── handlers ────────────

async function registerPost(body) {
  const { email, password, display_name } = body || {};
  if (!isEmail(email))         return err(400, 'email 형식 오류');
  const pwErr = validatePassword(password);
  if (pwErr)                   return err(400, pwErr);
  if (!isDisplayName(display_name))
                               return err(400, 'display_name 2~20자');

  // duplicate check
  const dup = await pool.query(
    `SELECT 1 FROM app.auth_users WHERE lower(email) = lower($1)`,
    [email]
  );
  if (dup.rowCount > 0)        return err(409, '이미 가입된 이메일');

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const ins = await pool.query(
    `INSERT INTO app.auth_users (email, password_hash, display_name)
     VALUES ($1, $2, $3)
     RETURNING id, email, display_name, is_active, created_at`,
    [email, hash, display_name.trim()]
  );
  const user = ins.rows[0];

  const token = signToken(user);
  await pool.query(
    `INSERT INTO app.auth_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, hashToken(token), expiresAt7d()]
  );

  return ok({ timezone: TZ, user: publicUser(user), token }, 201);
}

async function loginPost(body) {
  const { email, password } = body || {};
  if (!isEmail(email) || typeof password !== 'string')
    return err(400, '입력값 오류');

  const r = await pool.query(
    `SELECT id, email, password_hash, display_name, is_active, created_at
       FROM app.auth_users
      WHERE lower(email) = lower($1)`,
    [email]
  );
  const user = r.rows[0];
  // 항상 같은 메시지 (사용자 존재 여부 노출 방지)
  const GENERIC = '이메일 또는 비밀번호 오류';
  if (!user)             return err(401, GENERIC);
  if (!user.is_active)   return err(401, GENERIC);

  const ok2 = await bcrypt.compare(password, user.password_hash);
  if (!ok2)              return err(401, GENERIC);

  const token = signToken(user);
  await pool.query(
    `INSERT INTO app.auth_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, hashToken(token), expiresAt7d()]
  );

  return ok({ timezone: TZ, user: publicUser(user), token });
}

async function meGet(req) {
  const token = readBearer(req);
  if (!token) return err(401, '인증 필요');

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return err(401, '토큰 무효', e.message);
  }

  // 세션 revoke 체크 (옵셔널 추적)
  const tHash = hashToken(token);
  const s = await pool.query(
    `SELECT revoked_at, expires_at FROM app.auth_sessions
      WHERE token_hash = $1
      LIMIT 1`,
    [tHash]
  );
  if (s.rows[0] && s.rows[0].revoked_at) return err(401, '로그아웃된 토큰');

  const u = await pool.query(
    `SELECT id, email, display_name, is_active, created_at
       FROM app.auth_users
      WHERE id = $1`,
    [payload.uid]
  );
  if (!u.rows[0])              return err(401, '사용자 없음');
  if (!u.rows[0].is_active)    return err(401, '비활성 사용자');

  return ok({ timezone: TZ, user: publicUser(u.rows[0]) });
}

async function logoutPost(req) {
  const token = readBearer(req);
  if (!token) return err(401, '인증 필요');

  // 토큰 검증 자체는 실패해도 멱등 — 그냥 OK 반환
  let payload = null;
  try { payload = jwt.verify(token, JWT_SECRET); } catch {}

  const tHash = hashToken(token);
  await pool.query(
    `UPDATE app.auth_sessions
        SET revoked_at = NOW()
      WHERE token_hash = $1
        AND revoked_at IS NULL`,
    [tHash]
  );

  return ok({ timezone: TZ, ok: true, uid: payload ? Number(payload.uid) : null });
}


// ──────────── main handler ────────────

module.exports = async (req, res) => {
  try {
    const view = (req.query && req.query.view) || '';
    const method = req.method;

    let r;
    if      (method === 'POST' && view === 'register') r = await registerPost(req.body);
    else if (method === 'POST' && view === 'login')    r = await loginPost(req.body);
    else if (method === 'GET'  && view === 'me')       r = await meGet(req);
    else if (method === 'POST' && view === 'logout')   r = await logoutPost(req);
    else return res.status(400).json({ error: 'view= register | login | me | logout' });

    return res.status(r.status).json(r.body);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: '서버 오류', detail: e.message });
  }
};
