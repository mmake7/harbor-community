# Q5 + Q6 — PRIME / Community + Market

> 공개 회원제 커뮤니티(Q5 게시판) + 마켓(Q6 쇼핑)을 한 사이트로 통합 운영.
> Q3·Q4(개인용 가계부)와는 **별도 Vercel 프로젝트** — 도메인·인증 인프라 분리.

## 라이브

- 배포 URL: https://harbor-community.vercel.app/
- 라이브 검증: 회원가입 → 게시판 글/댓글/반응 → 쇼핑 카트/주문 모두 정상 (2026-05-01)

## 미션 매핑

| 항목 | Q5 게시판 | Q6 마켓 |
|---|---|---|
| 핵심 자원 | `community_posts` / `community_comments` / `community_reactions` | `shop_products` / `shop_cart_items` / `shop_orders` / `shop_order_items` |
| 라우트 | `#/board` 목록 · `#/board-new` · `#/board-detail/:id` · `#/board-edit/:id` | `#/shop` · `#/shop-product/:id` · `#/shop-cart` · `#/shop-orders` · `#/shop-order/:id` |
| API | `/api/posts?view=list/get/create/update/delete/comment/react` (7) | `/api/shop?view=products/product/cart/cart_add/cart_update/cart_clear/order_create/orders/order` (9) |
| 인증 | 작성·댓글·반응 = 회원 | 카트·주문 = 회원, 상품 조회 = 공개 |
| 운영 패턴 | 소프트 삭제(`is_deleted`) · `view_count` 증가 · 반응 토글 | 스냅샷(`product_name`/`product_price` 저장) · `FOR UPDATE` 락 · 재고 차감 트랜잭션 |

## 기술 스택

- **Backend** — Vercel Serverless (Node 18) + `?view=` 분기로 함수 12개 한도 충족
- **DB** — PostgreSQL (Supabase pooler), `pg` 직접 연결 (Supabase JS SDK 금지 — 5주차 룰)
- **Auth** — bcrypt 10 rounds + JWT 7d + `auth_sessions.token_hash` (SHA-256) revoke 검증
- **Frontend** — React 18 + Babel Standalone (CDN, 빌드 없음) · Pretendard Variable · Hash routing
- **Local Dev** — `dev-server.js` (Express, Vercel-like routing, port 3002)

## 폴더 구조

```
quest5-community/
├── api/
│   ├── auth.js                Phase 1 (4 view: register/login/me/logout)
│   ├── posts.js               Phase 2 (7 view)
│   └── shop.js                Phase 3 (9 view)
├── lib/
│   ├── auth-helper.js         Bearer/JWT/revoke 검증 (posts·shop 공용)
│   └── datetime.js            KST 헬퍼
├── public/
│   └── index.html             SPA (React 18 CDN, 1 file)
├── sql/
│   ├── 001_create_auth_tables.sql
│   ├── 002_create_community_tables.sql
│   ├── 003_create_shop_tables.sql
│   └── 004_seed_shop_products.sql      데모 상품 10건 (NOT EXISTS 멱등)
├── scripts/
│   └── apply.js               SQL 적용 + SELECT 검증
├── screenshots/               B1(3) + Q5(4) + Q6(4) = 11
├── dev-server.js              로컬 dev wrapper (배포 시 미사용)
├── package.json
├── vercel.json                rewrites + functions config
├── .env.local.example
└── .gitignore
```

## API 설계

### `/api/auth` (Phase 1)

| Method | View | 설명 |
|---|---|---|
| POST | `register` | `{email, password, display_name}` → JWT 발급 + sessions row |
| POST | `login` | `{email, password}` → JWT 발급, 이메일 열거 방어 |
| GET | `me` | `Authorization: Bearer <JWT>` → 사용자 정보 + revoke 검증 |
| POST | `logout` | `sessions.revoked_at` 기록 (멱등) |

### `/api/posts` (Phase 2)

| Method | View | 설명 |
|---|---|---|
| GET | `list` | `limit`/`offset`, `comment_count` 서브쿼리 포함 |
| GET | `get` | `view_count` 트랜잭션 증가, 옵셔널 인증으로 `my_reactions` |
| POST | `create` | 회원 전용 |
| PUT | `update` | 작성자만, `COALESCE` 부분 업데이트 |
| DELETE | `delete` | 소프트 삭제 (`is_deleted = TRUE`) |
| POST | `comment` | 댓글 작성 |
| POST | `react` | `FOR UPDATE` 락 + 토글 (👍/❤️/🔥) |

### `/api/shop` (Phase 3)

| Method | View | 설명 |
|---|---|---|
| GET | `products` | 활성 상품 목록 |
| GET | `product` | 상품 상세 |
| GET | `cart` | 장바구니 (회원) |
| POST | `cart_add` | UPSERT(`ON CONFLICT DO UPDATE`) 수량 증가 |
| PUT | `cart_update` | 수량 변경, 0이면 자동 삭제 |
| DELETE | `cart_clear` | 장바구니 비움 |
| POST | `order_create` | **트랜잭션**: 카트 `FOR UPDATE` + `ORDER BY product_id ASC`(데드락 방지) → 재고 검증 → 주문 INSERT → `order_items` 스냅샷 → 재고 차감 → 카트 삭제 |
| GET | `orders` | 본인 주문 목록 |
| GET | `order` | 주문 상세 (비소유자 403) |

## 보안 결정

- **bcrypt 10 rounds** — 비번 해싱 (PPT 약속)
- **JWT 7d 만료** + sessions revoke로 즉시 무효화 (`me` 호출 시 검증)
- **이메일 열거 방어** — login 실패 메시지 통일 ("이메일 또는 비밀번호 오류")
- **비밀번호 정책** — 8자 이상 + 영/숫/특수문자 중 2종 이상
- **소유자 검증** — 글 수정/삭제, 주문 상세 모두 `user_id` 일치 검사 후 403

## 로컬 실행

```bash
cd week5/quest5-community
npm install
# .env.local 작성 (.env.local.example 참조)
node scripts/apply.js          # 001~004 일괄 적용
node dev-server.js             # http://localhost:3002
```

## 환경 변수

| 키 | 용도 |
|---|---|
| `DATABASE_URL` | Supabase pooler (포트 6543, transaction pool) |
| `JWT_SECRET` | JWT HS256 시크릿 (32자 이상 권장) |

## 배포

Vercel 별도 프로젝트로 배포. `vercel.json`에서 SPA rewrites와 함수 maxDuration을 정의한다. 환경 변수 2종은 Vercel 대시보드 Settings → Environment Variables에 등록.

## 검증

- **Phase 1** — curl 10 시나리오 PASS (register/login/me/logout 정상·예외 모두)
- **Phase 2 게시판** — 작성·수정·삭제·댓글·반응 SS 4장
- **Phase 3 마켓** — 상품 목록·상세·카트·주문 SS 4장
- **공통** — 로그인 후 카트 아이콘 노출, 비로그인 시 회원 가드 동작

## 스크린샷

### Phase 1 — 인증 (B1)

| 게스트 홈 | 회원가입 검증 | 로그인 후 |
|---|---|---|
| ![](screenshots/B1/01-guest-home.png) | ![](screenshots/B1/02-register-validation.png) | ![](screenshots/B1/03-logged-in.png) |

### Q5 — 게시판

| 글 목록 | 글 작성 |
|---|---|
| ![](screenshots/Q5/s1%20%EA%B8%80%EB%AA%A9%EB%A1%9D.png) | ![](screenshots/Q5/s2%20%EA%B8%80%EC%9E%91%EC%84%B1.png) |

| 글 상세 + 댓글 + 반응 | 글 수정/삭제 |
|---|---|
| ![](screenshots/Q5/s3%20%EA%B8%80%EC%83%81%EC%84%B8%EB%8C%93%EA%B8%80%EB%B0%98%EC%9D%91%20.png) | ![](screenshots/Q5/s4%20%EA%B8%80%EC%88%98%EC%A0%95%20%EC%82%AD%EC%A0%9C%20.png) |

### Q6 — 쇼핑

| 상품 목록 | 상품 상세 |
|---|---|
| ![](screenshots/Q6/s1%20%EC%83%81%ED%92%88%EB%AA%A9%EB%A1%9D.png) | ![](screenshots/Q6/s2%20%EC%83%81%ED%92%88%EC%83%81%EC%84%B8.png) |

| 카트 화면 | 주문 상세 |
|---|---|
| ![](screenshots/Q6/s3%20%EC%B9%B4%ED%8A%B8%ED%99%94%EB%A9%B4.png) | ![](screenshots/Q6/s4%20%EC%A3%BC%EB%AC%B8%EC%83%81%EC%84%B8.png) |
