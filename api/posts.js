// ===========================================================
// /api/posts — Q5 게시판 (Vercel serverless)
//   ?view= 분기 (5주차 컨벤션)
//     - GET    ?view=list[&limit=N&offset=M]
//     - GET    ?view=get&id=N            (옵셔널 인증, my_reactions 채움용)
//     - POST   ?view=create              본인 글 작성 (인증 필수)
//     - PUT    ?view=update&id=N         본인 글 수정 (인증·소유자 검증)
//     - DELETE ?view=delete&id=N         soft delete (인증·소유자 검증)
//     - POST   ?view=comment             댓글 (인증 필수)
//     - POST   ?view=react               toggle 반응 (인증 필수)
// ===========================================================
const { Pool } = require('pg');
const {
  readBearer, verifyJwt, verifyTokenWithRevoke,
} = require('../lib/auth-helper');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const TZ = 'Asia/Seoul';
const VALID_REACTIONS = new Set(['like', 'heart', 'fire']);

// ──────────── helpers ────────────

function ok(data, meta) {
  return { status: 200, body: meta ? { data, meta, timezone: TZ } : { data, timezone: TZ } };
}
function err(status, msg, detail) {
  return { status, body: detail ? { error: msg, detail, timezone: TZ } : { error: msg, timezone: TZ } };
}
function intArg(v, fallback) {
  const n = parseInt(v);
  return Number.isInteger(n) ? n : fallback;
}

// ──────────── handlers ────────────

async function listGet(req) {
  const limit = Math.min(Math.max(intArg(req.query.limit, 20), 1), 100);
  const offset = Math.max(intArg(req.query.offset, 0), 0);

  const items = await pool.query(
    `SELECT p.id, p.title, p.view_count, p.created_at,
            u.id AS user_id, u.display_name,
            (SELECT COUNT(*)::int FROM app.community_comments c
              WHERE c.post_id = p.id AND NOT c.is_deleted) AS comment_count
       FROM app.community_posts p
       JOIN app.auth_users u ON u.id = p.user_id
      WHERE NOT p.is_deleted
      ORDER BY p.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const tot = await pool.query(
    `SELECT COUNT(*)::int AS n FROM app.community_posts WHERE NOT is_deleted`
  );

  const data = items.rows.map(r => ({
    id: Number(r.id),
    title: r.title,
    view_count: r.view_count,
    created_at: r.created_at,
    user: { id: Number(r.user_id), display_name: r.display_name },
    comment_count: r.comment_count,
  }));
  return ok(data, { limit, offset, total: tot.rows[0].n });
}

async function getOne(req) {
  const id = intArg(req.query.id, NaN);
  if (!Number.isInteger(id) || id <= 0) return err(400, 'id 필수');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // view_count +1 (없거나 삭제면 0행)
    const upd = await client.query(
      `UPDATE app.community_posts
          SET view_count = view_count + 1
        WHERE id = $1 AND NOT is_deleted
        RETURNING id`,
      [id]
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return err(404, '게시글 없음');
    }

    const post = await client.query(
      `SELECT p.id, p.title, p.content, p.view_count, p.created_at,
              u.id AS user_id, u.display_name
         FROM app.community_posts p
         JOIN app.auth_users u ON u.id = p.user_id
        WHERE p.id = $1`,
      [id]
    );

    const comments = await client.query(
      `SELECT c.id, c.content, c.created_at,
              u.id AS user_id, u.display_name
         FROM app.community_comments c
         JOIN app.auth_users u ON u.id = c.user_id
        WHERE c.post_id = $1 AND NOT c.is_deleted
        ORDER BY c.created_at ASC`,
      [id]
    );

    const reactionGroups = await client.query(
      `SELECT reaction_type, COUNT(*)::int AS n
         FROM app.community_reactions
        WHERE post_id = $1
        GROUP BY reaction_type`,
      [id]
    );
    const reactions = {};
    reactionGroups.rows.forEach(r => { reactions[r.reaction_type] = r.n; });

    // 옵셔널 인증 — 토큰 있으면 my_reactions 채움
    let myReactions = [];
    const token = readBearer(req);
    if (token) {
      const v = verifyJwt(token);
      if (v) {
        const my = await client.query(
          `SELECT reaction_type FROM app.community_reactions
            WHERE post_id = $1 AND user_id = $2`,
          [id, v.uid]
        );
        myReactions = my.rows.map(r => r.reaction_type);
      }
    }

    await client.query('COMMIT');

    const p = post.rows[0];
    return ok({
      post: {
        id: Number(p.id),
        title: p.title,
        content: p.content,
        view_count: p.view_count,
        created_at: p.created_at,
        user: { id: Number(p.user_id), display_name: p.display_name },
      },
      comments: comments.rows.map(r => ({
        id: Number(r.id),
        content: r.content,
        created_at: r.created_at,
        user: { id: Number(r.user_id), display_name: r.display_name },
      })),
      reactions,
      my_reactions: myReactions,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function createPost(req) {
  const user = await verifyTokenWithRevoke(req, pool);
  if (!user) return err(401, '인증 필요');

  const { title, content } = req.body || {};
  const t = (typeof title === 'string') ? title.trim() : '';
  const cnt = (typeof content === 'string') ? content : '';
  if (!t)               return err(400, 'title 필수');
  if (t.length > 200)   return err(400, 'title 200자 이내');
  if (cnt.length === 0) return err(400, 'content 필수');

  const r = await pool.query(
    `INSERT INTO app.community_posts (user_id, title, content)
     VALUES ($1, $2, $3)
     RETURNING id, title, created_at`,
    [user.uid, t, cnt]
  );
  const row = r.rows[0];
  return ok({ id: Number(row.id), title: row.title, created_at: row.created_at });
}

async function updatePost(req) {
  const user = await verifyTokenWithRevoke(req, pool);
  if (!user) return err(401, '인증 필요');

  const id = intArg(req.query.id, NaN);
  if (!Number.isInteger(id) || id <= 0) return err(400, 'id 필수');

  const { title, content } = req.body || {};
  if (title === undefined && content === undefined)
    return err(400, '변경 필드 없음');

  let newTitle = null, newContent = null;
  if (title !== undefined) {
    if (typeof title !== 'string') return err(400, 'title 문자열');
    const t = title.trim();
    if (!t || t.length > 200)      return err(400, 'title 1~200자');
    newTitle = t;
  }
  if (content !== undefined) {
    if (typeof content !== 'string' || content.length === 0)
      return err(400, 'content 비어있음');
    newContent = content;
  }

  const owner = await pool.query(
    `SELECT user_id, is_deleted FROM app.community_posts WHERE id = $1`,
    [id]
  );
  if (owner.rowCount === 0 || owner.rows[0].is_deleted)
    return err(404, '게시글 없음');
  if (Number(owner.rows[0].user_id) !== user.uid)
    return err(403, '본인 글만 수정 가능');

  const r = await pool.query(
    `UPDATE app.community_posts
        SET title      = COALESCE($1, title),
            content    = COALESCE($2, content),
            updated_at = NOW()
      WHERE id = $3
      RETURNING id, updated_at`,
    [newTitle, newContent, id]
  );
  return ok({ id: Number(r.rows[0].id), updated_at: r.rows[0].updated_at });
}

async function deletePost(req) {
  const user = await verifyTokenWithRevoke(req, pool);
  if (!user) return err(401, '인증 필요');

  const id = intArg(req.query.id, NaN);
  if (!Number.isInteger(id) || id <= 0) return err(400, 'id 필수');

  const owner = await pool.query(
    `SELECT user_id, is_deleted FROM app.community_posts WHERE id = $1`,
    [id]
  );
  if (owner.rowCount === 0 || owner.rows[0].is_deleted)
    return err(404, '게시글 없음');
  if (Number(owner.rows[0].user_id) !== user.uid)
    return err(403, '본인 글만 삭제 가능');

  await pool.query(
    `UPDATE app.community_posts
        SET is_deleted = TRUE, updated_at = NOW()
      WHERE id = $1`,
    [id]
  );
  return ok({ id, deleted: true });
}

async function commentPost(req) {
  const user = await verifyTokenWithRevoke(req, pool);
  if (!user) return err(401, '인증 필요');

  const { post_id, content } = req.body || {};
  const pid = intArg(post_id, NaN);
  if (!Number.isInteger(pid) || pid <= 0) return err(400, 'post_id 필수');
  if (typeof content !== 'string')        return err(400, 'content 필수');
  const c = content.trim();
  if (c.length === 0)     return err(400, 'content 비어있음');
  if (c.length > 2000)    return err(400, 'content 2000자 이내');

  const post = await pool.query(
    `SELECT id FROM app.community_posts WHERE id = $1 AND NOT is_deleted`,
    [pid]
  );
  if (post.rowCount === 0) return err(404, '게시글 없음');

  const r = await pool.query(
    `INSERT INTO app.community_comments (post_id, user_id, content)
     VALUES ($1, $2, $3)
     RETURNING id, post_id, created_at`,
    [pid, user.uid, c]
  );
  const row = r.rows[0];
  return ok({ id: Number(row.id), post_id: Number(row.post_id), created_at: row.created_at });
}

async function reactPost(req) {
  const user = await verifyTokenWithRevoke(req, pool);
  if (!user) return err(401, '인증 필요');

  const { post_id, reaction_type } = req.body || {};
  const pid = intArg(post_id, NaN);
  if (!Number.isInteger(pid) || pid <= 0)         return err(400, 'post_id 필수');
  if (!VALID_REACTIONS.has(reaction_type))
    return err(400, "reaction_type ∈ ['like','heart','fire']");

  const post = await pool.query(
    `SELECT id FROM app.community_posts WHERE id = $1 AND NOT is_deleted`,
    [pid]
  );
  if (post.rowCount === 0) return err(404, '게시글 없음');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exist = await client.query(
      `SELECT id FROM app.community_reactions
        WHERE post_id = $1 AND user_id = $2 AND reaction_type = $3
        FOR UPDATE`,
      [pid, user.uid, reaction_type]
    );
    let toggled;
    if (exist.rowCount > 0) {
      await client.query(
        `DELETE FROM app.community_reactions
          WHERE post_id = $1 AND user_id = $2 AND reaction_type = $3`,
        [pid, user.uid, reaction_type]
      );
      toggled = 'removed';
    } else {
      await client.query(
        `INSERT INTO app.community_reactions (post_id, user_id, reaction_type)
         VALUES ($1, $2, $3)`,
        [pid, user.uid, reaction_type]
      );
      toggled = 'added';
    }
    await client.query('COMMIT');
    return ok({ post_id: pid, reaction_type, toggled });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ──────────── main handler ────────────

module.exports = async (req, res) => {
  try {
    const view = (req.query && req.query.view) || '';
    const m = req.method;
    let r;
    if      (m === 'GET'    && view === 'list')    r = await listGet(req);
    else if (m === 'GET'    && view === 'get')     r = await getOne(req);
    else if (m === 'POST'   && view === 'create')  r = await createPost(req);
    else if (m === 'PUT'    && view === 'update')  r = await updatePost(req);
    else if (m === 'DELETE' && view === 'delete')  r = await deletePost(req);
    else if (m === 'POST'   && view === 'comment') r = await commentPost(req);
    else if (m === 'POST'   && view === 'react')   r = await reactPost(req);
    else return res.status(400).json({
      error: 'view= list | get | create | update | delete | comment | react',
      timezone: TZ,
    });
    return res.status(r.status).json(r.body);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: '서버 오류', detail: e.message, timezone: TZ });
  }
};
