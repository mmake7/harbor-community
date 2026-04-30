// ===========================================================
// JWT 검증 helper — auth.js / posts.js / shop.js 공통 사용
//   readBearer(req)            → token 문자열 또는 null
//   hashToken(token)           → SHA-256 hex (sessions.token_hash 매칭)
//   verifyJwt(token)           → { uid, email, token } | null  (서명·만료만)
//   verifyTokenWithRevoke(req, pool) → 위 + sessions.revoked_at 체크
// ===========================================================
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

function readBearer(req) {
  const h = (req && req.headers &&
             (req.headers.authorization || req.headers.Authorization)) || '';
  if (!h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function verifyJwt(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return { uid: Number(payload.uid), email: payload.email, token };
  } catch {
    return null;
  }
}

// 서명/만료 + sessions.revoked_at 체크 (auth.js me 와 동일 보안 수준)
async function verifyTokenWithRevoke(req, pool) {
  const token = readBearer(req);
  const v = verifyJwt(token);
  if (!v) return null;
  const r = await pool.query(
    `SELECT revoked_at FROM app.auth_sessions WHERE token_hash = $1 LIMIT 1`,
    [hashToken(token)]
  );
  if (r.rows[0] && r.rows[0].revoked_at) return null;
  return v;
}

module.exports = {
  readBearer,
  hashToken,
  verifyJwt,
  verifyTokenWithRevoke,
};
