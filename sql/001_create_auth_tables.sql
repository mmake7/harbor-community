-- ===========================================================
-- Q5+Q6 / Phase 1 — Auth 인프라
--   app.auth_users     사용자 마스터
--   app.auth_sessions  토큰 추적 (JWT는 stateless, 하지만 무효화 위해 옵셔널)
-- ===========================================================

CREATE TABLE IF NOT EXISTS app.auth_users (
  id            BIGSERIAL    PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name  VARCHAR(50)  NOT NULL,
  is_active     BOOLEAN      DEFAULT TRUE,
  created_at    TIMESTAMP    DEFAULT NOW(),
  updated_at    TIMESTAMP    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_users_email
  ON app.auth_users (email);


CREATE TABLE IF NOT EXISTS app.auth_sessions (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     BIGINT       NOT NULL REFERENCES app.auth_users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) NOT NULL,
  expires_at  TIMESTAMP    NOT NULL,
  created_at  TIMESTAMP    DEFAULT NOW(),
  revoked_at  TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id
  ON app.auth_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash
  ON app.auth_sessions (token_hash);

COMMENT ON TABLE  app.auth_users    IS 'Q5+Q6 통합 인증 사용자';
COMMENT ON TABLE  app.auth_sessions IS 'JWT 토큰 추적 (revoke 용도, 옵셔널)';
COMMENT ON COLUMN app.auth_sessions.token_hash IS 'SHA-256(token) — 원본 JWT는 저장 안 함';
