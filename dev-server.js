// ===========================================================
// Q5+Q6 통합 dev 서버 — Vercel-like routing
//   $ node dev-server.js
//   /api/auth?view=...   (register/login/me/logout)
//   /api/posts?view=...  (list/get/create/update/delete/comment/react)
//   /api/shop?view=...   (products/product/cart/cart_*/order_create/orders/order)
// ===========================================================
require('dotenv').config({ path: __dirname + '/.env.local' });
const express = require('express');
const path = require('path');
const authHandler  = require('./api/auth.js');
const postsHandler = require('./api/posts.js');
const shopHandler  = require('./api/shop.js');

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.all('/api/auth',  (req, res) => authHandler(req, res));
app.all('/api/posts', (req, res) => postsHandler(req, res));
app.all('/api/shop',  (req, res) => shopHandler(req, res));

const PORT = Number(process.env.PORT || 3002);
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
