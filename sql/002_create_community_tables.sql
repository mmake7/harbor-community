-- ===========================================================
-- Q5 게시판 — posts / comments / reactions
-- 오늘(2026-05-01) 확정 스펙. 어제(04-30) 데모 스키마는 DROP 후 재생성.
-- ===========================================================

CREATE TABLE IF NOT EXISTS app.community_posts (
  id            BIGSERIAL    PRIMARY KEY,
  user_id       BIGINT       NOT NULL REFERENCES app.auth_users(id) ON DELETE CASCADE,
  title         VARCHAR(200) NOT NULL,
  content       TEXT         NOT NULL,
  view_count    INTEGER      DEFAULT 0,
  is_deleted    BOOLEAN      DEFAULT FALSE,
  created_at    TIMESTAMP    DEFAULT NOW(),
  updated_at    TIMESTAMP    DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_community_posts_user_id
  ON app.community_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_community_posts_created_at
  ON app.community_posts(created_at DESC);


CREATE TABLE IF NOT EXISTS app.community_comments (
  id            BIGSERIAL PRIMARY KEY,
  post_id       BIGINT    NOT NULL REFERENCES app.community_posts(id) ON DELETE CASCADE,
  user_id       BIGINT    NOT NULL REFERENCES app.auth_users(id)      ON DELETE CASCADE,
  content       TEXT      NOT NULL,
  is_deleted    BOOLEAN   DEFAULT FALSE,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_community_comments_post_id
  ON app.community_comments(post_id);


CREATE TABLE IF NOT EXISTS app.community_reactions (
  id            BIGSERIAL   PRIMARY KEY,
  post_id       BIGINT      NOT NULL REFERENCES app.community_posts(id) ON DELETE CASCADE,
  user_id       BIGINT      NOT NULL REFERENCES app.auth_users(id)      ON DELETE CASCADE,
  reaction_type VARCHAR(20) NOT NULL,
  created_at    TIMESTAMP   DEFAULT NOW(),
  UNIQUE (post_id, user_id, reaction_type)
);
CREATE INDEX IF NOT EXISTS idx_community_reactions_post_id
  ON app.community_reactions(post_id);
