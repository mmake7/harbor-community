// ===========================================================
// /api/shop — Q6 쇼핑 (Vercel serverless)
//   ?view= 분기
//     - GET    ?view=products[&limit=N&offset=M]
//     - GET    ?view=product&id=N
//     - GET    ?view=cart                       (인증 필수)
//     - POST   ?view=cart_add                   (인증, body: {product_id, quantity?})
//     - PUT    ?view=cart_update                (인증, body: {cart_item_id, quantity})
//     - DELETE ?view=cart_clear                 (인증)
//     - POST   ?view=order_create               (인증, 트랜잭션)
//     - GET    ?view=orders[&limit=N&offset=M]  (인증)
//     - GET    ?view=order&id=N                 (인증·소유자)
//
// 트랜잭션 + FOR UPDATE 락 (cart_add / cart_update / order_create)
// ===========================================================
const { Pool } = require('pg');
const { verifyTokenWithRevoke } = require('../lib/auth-helper');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const TZ = 'Asia/Seoul';

// ──────────── helpers ────────────

function ok(data, meta) {
  return { status: 200, body: meta ? { data, meta, timezone: TZ } : { data, timezone: TZ } };
}
function err(status, msg, detail) {
  return { status, body: detail ? { error: msg, detail, timezone: TZ } : { error: msg, timezone: TZ } };
}
function intArg(v, fb) {
  const n = parseInt(v);
  return Number.isInteger(n) ? n : fb;
}

async function safeRollback(client) {
  try { await client.query('ROLLBACK'); } catch {}
}

// ──────────── handlers — public ────────────

async function productsGet(req) {
  const limit = Math.min(Math.max(intArg(req.query.limit, 20), 1), 100);
  const offset = Math.max(intArg(req.query.offset, 0), 0);

  const items = await pool.query(
    `SELECT id, name, description, price, stock, image_url, created_at
       FROM app.shop_products
      WHERE is_active = TRUE
      ORDER BY id ASC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const tot = await pool.query(
    `SELECT COUNT(*)::int AS n FROM app.shop_products WHERE is_active = TRUE`
  );
  return ok(
    items.rows.map(r => ({
      id: Number(r.id),
      name: r.name,
      description: r.description,
      price: r.price,
      stock: r.stock,
      image_url: r.image_url,
      created_at: r.created_at,
    })),
    { limit, offset, total: tot.rows[0].n }
  );
}

async function productGet(req) {
  const id = intArg(req.query.id, NaN);
  if (!Number.isInteger(id) || id <= 0) return err(400, 'id 필수');

  const r = await pool.query(
    `SELECT id, name, description, price, stock, image_url
       FROM app.shop_products
      WHERE id = $1 AND is_active = TRUE`,
    [id]
  );
  if (r.rowCount === 0) return err(404, '상품 없음');
  const p = r.rows[0];
  return ok({
    id: Number(p.id), name: p.name, description: p.description,
    price: p.price, stock: p.stock, image_url: p.image_url,
  });
}

// ──────────── handlers — cart ────────────

async function cartGet(req) {
  const user = await verifyTokenWithRevoke(req, pool);
  if (!user) return err(401, '인증 필요');

  const r = await pool.query(
    `SELECT c.id AS cart_item_id, c.quantity,
            p.id AS product_id, p.name, p.price, p.stock, p.image_url
       FROM app.shop_cart_items c
       JOIN app.shop_products p ON p.id = c.product_id
      WHERE c.user_id = $1
      ORDER BY c.created_at DESC`,
    [user.uid]
  );

  let totalQty = 0, totalAmt = 0;
  const items = r.rows.map(row => {
    const q = row.quantity;
    totalQty += q;
    totalAmt += row.price * q;
    return {
      cart_item_id: Number(row.cart_item_id),
      quantity: q,
      product: {
        id: Number(row.product_id),
        name: row.name,
        price: row.price,
        stock: row.stock,
        image_url: row.image_url,
      },
    };
  });

  return ok({
    items,
    summary: {
      item_count: items.length,
      total_quantity: totalQty,
      total_amount: totalAmt,
    },
  });
}

async function cartAdd(req) {
  const user = await verifyTokenWithRevoke(req, pool);
  if (!user) return err(401, '인증 필요');

  const { product_id, quantity = 1 } = req.body || {};
  const pid = intArg(product_id, NaN);
  const qty = intArg(quantity, NaN);
  if (!Number.isInteger(pid) || pid <= 0)         return err(400, 'product_id 필수');
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) return err(400, 'quantity 1~99');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const p = await client.query(
      `SELECT id, name, stock FROM app.shop_products
        WHERE id = $1 AND is_active = TRUE
        FOR UPDATE`,
      [pid]
    );
    if (p.rowCount === 0) {
      await safeRollback(client);
      return err(404, '상품 없음');
    }

    const existing = await client.query(
      `SELECT quantity FROM app.shop_cart_items
        WHERE user_id = $1 AND product_id = $2`,
      [user.uid, pid]
    );
    const existingQty = existing.rowCount > 0 ? existing.rows[0].quantity : 0;
    const finalQty = existingQty + qty;

    if (finalQty > p.rows[0].stock) {
      await safeRollback(client);
      return err(400, '재고 부족', {
        product_id: pid, name: p.rows[0].name,
        requested: finalQty, available: p.rows[0].stock,
      });
    }

    const up = await client.query(
      `INSERT INTO app.shop_cart_items (user_id, product_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, product_id)
       DO UPDATE SET quantity = shop_cart_items.quantity + EXCLUDED.quantity,
                     updated_at = NOW()
       RETURNING id, quantity`,
      [user.uid, pid, qty]
    );

    await client.query('COMMIT');
    return ok({ cart_item_id: Number(up.rows[0].id), quantity: up.rows[0].quantity });
  } catch (e) {
    await safeRollback(client);
    throw e;
  } finally {
    client.release();
  }
}

async function cartUpdate(req) {
  const user = await verifyTokenWithRevoke(req, pool);
  if (!user) return err(401, '인증 필요');

  const { cart_item_id, quantity } = req.body || {};
  const cid = intArg(cart_item_id, NaN);
  const qty = intArg(quantity, NaN);
  if (!Number.isInteger(cid) || cid <= 0)         return err(400, 'cart_item_id 필수');
  if (!Number.isInteger(qty) || qty < 0 || qty > 99) return err(400, 'quantity 0~99');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const item = await client.query(
      `SELECT c.id, c.user_id, c.product_id, p.stock, p.name
         FROM app.shop_cart_items c
         JOIN app.shop_products p ON p.id = c.product_id
        WHERE c.id = $1
        FOR UPDATE OF c, p`,
      [cid]
    );
    if (item.rowCount === 0) {
      await safeRollback(client);
      return err(404, '카트 항목 없음');
    }
    if (Number(item.rows[0].user_id) !== user.uid) {
      await safeRollback(client);
      return err(403, '본인 카트만 수정 가능');
    }

    if (qty === 0) {
      await client.query(`DELETE FROM app.shop_cart_items WHERE id = $1`, [cid]);
      await client.query('COMMIT');
      return ok({ cart_item_id: cid, quantity: 0, deleted: true });
    }

    if (qty > item.rows[0].stock) {
      await safeRollback(client);
      return err(400, '재고 부족', {
        product_id: Number(item.rows[0].product_id),
        name: item.rows[0].name,
        requested: qty, available: item.rows[0].stock,
      });
    }

    await client.query(
      `UPDATE app.shop_cart_items
          SET quantity = $1, updated_at = NOW()
        WHERE id = $2`,
      [qty, cid]
    );
    await client.query('COMMIT');
    return ok({ cart_item_id: cid, quantity: qty, deleted: false });
  } catch (e) {
    await safeRollback(client);
    throw e;
  } finally {
    client.release();
  }
}

async function cartClear(req) {
  const user = await verifyTokenWithRevoke(req, pool);
  if (!user) return err(401, '인증 필요');
  const r = await pool.query(
    `DELETE FROM app.shop_cart_items WHERE user_id = $1`,
    [user.uid]
  );
  return ok({ deleted_count: r.rowCount });
}

// ──────────── handlers — order ────────────

async function orderCreate(req) {
  const user = await verifyTokenWithRevoke(req, pool);
  if (!user) return err(401, '인증 필요');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) 카트 + 락 (deadlock 방지: product_id ASC)
    const cart = await client.query(
      `SELECT c.product_id, c.quantity, p.name, p.price, p.stock
         FROM app.shop_cart_items c
         JOIN app.shop_products p ON p.id = c.product_id
        WHERE c.user_id = $1
        ORDER BY c.product_id
        FOR UPDATE OF c, p`,
      [user.uid]
    );

    // 2) 카트 비어있으면
    if (cart.rowCount === 0) {
      await safeRollback(client);
      return err(400, '카트가 비어있습니다');
    }

    // 3) 재고 검증 (한 건이라도 부족하면)
    for (const row of cart.rows) {
      if (row.quantity > row.stock) {
        await safeRollback(client);
        return err(409, '재고 부족', {
          product_id: Number(row.product_id),
          name: row.name,
          requested: row.quantity,
          available: row.stock,
        });
      }
    }

    // 4) 합계
    const total = cart.rows.reduce((s, r) => s + r.price * r.quantity, 0);

    // 5) 주문 생성
    const ord = await client.query(
      `INSERT INTO app.shop_orders (user_id, total_amount, status)
       VALUES ($1, $2, 'pending')
       RETURNING id`,
      [user.uid, total]
    );
    const orderId = ord.rows[0].id;

    // 6) 주문 항목 (스냅샷)
    for (const row of cart.rows) {
      await client.query(
        `INSERT INTO app.shop_order_items
           (order_id, product_id, product_name, product_price, quantity, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orderId, row.product_id, row.name, row.price, row.quantity, row.price * row.quantity]
      );
    }

    // 7) 재고 차감
    for (const row of cart.rows) {
      await client.query(
        `UPDATE app.shop_products
            SET stock = stock - $1, updated_at = NOW()
          WHERE id = $2`,
        [row.quantity, row.product_id]
      );
    }

    // 8) 카트 비우기
    await client.query(
      `DELETE FROM app.shop_cart_items WHERE user_id = $1`,
      [user.uid]
    );

    await client.query('COMMIT');

    return ok({
      order_id: Number(orderId),
      total_amount: total,
      item_count: cart.rows.length,
      status: 'pending',
      items: cart.rows.map(r => ({
        product_id: Number(r.product_id),
        name: r.name,
        price: r.price,
        quantity: r.quantity,
        subtotal: r.price * r.quantity,
      })),
    });
  } catch (e) {
    await safeRollback(client);
    throw e;
  } finally {
    client.release();
  }
}

async function ordersGet(req) {
  const user = await verifyTokenWithRevoke(req, pool);
  if (!user) return err(401, '인증 필요');

  const limit = Math.min(Math.max(intArg(req.query.limit, 20), 1), 100);
  const offset = Math.max(intArg(req.query.offset, 0), 0);

  const items = await pool.query(
    `SELECT o.id, o.total_amount, o.status, o.created_at,
            (SELECT COUNT(*)::int FROM app.shop_order_items WHERE order_id = o.id) AS item_count
       FROM app.shop_orders o
      WHERE o.user_id = $1
      ORDER BY o.created_at DESC
      LIMIT $2 OFFSET $3`,
    [user.uid, limit, offset]
  );
  const tot = await pool.query(
    `SELECT COUNT(*)::int AS n FROM app.shop_orders WHERE user_id = $1`,
    [user.uid]
  );

  return ok(
    items.rows.map(r => ({
      id: Number(r.id),
      total_amount: r.total_amount,
      status: r.status,
      created_at: r.created_at,
      item_count: r.item_count,
    })),
    { limit, offset, total: tot.rows[0].n }
  );
}

async function orderGet(req) {
  const user = await verifyTokenWithRevoke(req, pool);
  if (!user) return err(401, '인증 필요');

  const id = intArg(req.query.id, NaN);
  if (!Number.isInteger(id) || id <= 0) return err(400, 'id 필수');

  const order = await pool.query(
    `SELECT id, user_id, total_amount, status, created_at
       FROM app.shop_orders
      WHERE id = $1`,
    [id]
  );
  if (order.rowCount === 0) return err(404, '주문 없음');
  if (Number(order.rows[0].user_id) !== user.uid) return err(403, '본인 주문만 조회 가능');

  const items = await pool.query(
    `SELECT id, product_id, product_name, product_price, quantity, subtotal
       FROM app.shop_order_items
      WHERE order_id = $1
      ORDER BY id`,
    [id]
  );

  return ok({
    order: {
      id: Number(order.rows[0].id),
      total_amount: order.rows[0].total_amount,
      status: order.rows[0].status,
      created_at: order.rows[0].created_at,
    },
    items: items.rows.map(r => ({
      id: Number(r.id),
      product_id: Number(r.product_id),
      product_name: r.product_name,
      product_price: r.product_price,
      quantity: r.quantity,
      subtotal: r.subtotal,
    })),
  });
}

// ──────────── main handler ────────────

module.exports = async (req, res) => {
  try {
    const view = (req.query && req.query.view) || '';
    const m = req.method;
    let r;
    if      (m === 'GET'    && view === 'products')     r = await productsGet(req);
    else if (m === 'GET'    && view === 'product')      r = await productGet(req);
    else if (m === 'GET'    && view === 'cart')         r = await cartGet(req);
    else if (m === 'POST'   && view === 'cart_add')     r = await cartAdd(req);
    else if (m === 'PUT'    && view === 'cart_update')  r = await cartUpdate(req);
    else if (m === 'DELETE' && view === 'cart_clear')   r = await cartClear(req);
    else if (m === 'POST'   && view === 'order_create') r = await orderCreate(req);
    else if (m === 'GET'    && view === 'orders')       r = await ordersGet(req);
    else if (m === 'GET'    && view === 'order')        r = await orderGet(req);
    else return res.status(400).json({
      error: 'view= products | product | cart | cart_add | cart_update | cart_clear | order_create | orders | order',
      timezone: TZ,
    });
    return res.status(r.status).json(r.body);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: '서버 오류', detail: e.message, timezone: TZ });
  }
};
