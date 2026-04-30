-- ===========================================================
-- Q6 쇼핑 — products / cart_items / orders / order_items
-- 오늘(2026-05-01) 확정 스펙. 어제(04-30) 데모 스키마는 DROP 후 재생성.
-- order_items 별도 분리 + 가격·이름 스냅샷 + status 5종.
-- ===========================================================

CREATE TABLE IF NOT EXISTS app.shop_products (
  id            BIGSERIAL    PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  description   TEXT,
  price         INTEGER      NOT NULL,
  stock         INTEGER      DEFAULT 0,
  image_url     VARCHAR(500),
  is_active     BOOLEAN      DEFAULT TRUE,
  created_at    TIMESTAMP    DEFAULT NOW(),
  updated_at    TIMESTAMP    DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shop_products_is_active
  ON app.shop_products(is_active);


CREATE TABLE IF NOT EXISTS app.shop_cart_items (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT    NOT NULL REFERENCES app.auth_users(id)    ON DELETE CASCADE,
  product_id    BIGINT    NOT NULL REFERENCES app.shop_products(id) ON DELETE CASCADE,
  quantity      INTEGER   NOT NULL DEFAULT 1,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_shop_cart_items_user_id
  ON app.shop_cart_items(user_id);


CREATE TABLE IF NOT EXISTS app.shop_orders (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       BIGINT      NOT NULL REFERENCES app.auth_users(id) ON DELETE CASCADE,
  total_amount  INTEGER     NOT NULL,
  status        VARCHAR(30) DEFAULT 'pending',
  created_at    TIMESTAMP   DEFAULT NOW(),
  updated_at    TIMESTAMP   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shop_orders_user_id
  ON app.shop_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_shop_orders_status
  ON app.shop_orders(status);


CREATE TABLE IF NOT EXISTS app.shop_order_items (
  id              BIGSERIAL    PRIMARY KEY,
  order_id        BIGINT       NOT NULL REFERENCES app.shop_orders(id) ON DELETE CASCADE,
  product_id      BIGINT       NOT NULL REFERENCES app.shop_products(id),
  product_name    VARCHAR(200) NOT NULL,
  product_price   INTEGER      NOT NULL,
  quantity        INTEGER      NOT NULL,
  subtotal        INTEGER      NOT NULL,
  created_at      TIMESTAMP    DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shop_order_items_order_id
  ON app.shop_order_items(order_id);
