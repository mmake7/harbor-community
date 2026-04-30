-- ===========================================================
-- Q6 데모 상품 10건
-- 멱등: shop_products(name)에 unique 없으므로 NOT EXISTS 패턴
-- (DROP/TRUNCATE/ALTER 없이도 재실행 안전)
-- ===========================================================

INSERT INTO app.shop_products (name, description, price, stock, image_url, is_active)
SELECT v.name, v.description, v.price, v.stock, v.image_url::varchar(500), v.is_active
  FROM (VALUES
    ('하버스쿨 머그컵',                  '주말반 기념 머그컵. 350ml, 도자기.',                12000,  50, NULL, TRUE),
    ('항해 노트 (A5)',                   '160페이지 양장 노트. 격자/도트 혼합.',              18000,  30, NULL, TRUE),
    ('AI 학습용 후드티 (M)',             '코튼 80% 폴리 20%. 검정.',                          45000,  20, NULL, TRUE),
    ('AI 학습용 후드티 (L)',             '코튼 80% 폴리 20%. 검정.',                          45000,  15, NULL, TRUE),
    ('Claude Code 스티커 팩',            '비닐 스티커 5장 세트.',                              5000, 100, NULL, TRUE),
    ('한국형 키보드 단축키 포스터 (A2)', '맥/윈도/Claude Code 단축키 모음.',                  15000,  25, NULL, TRUE),
    ('Vercel 굿즈 텀블러',               '450ml 진공 보온.',                                  28000,  18, NULL, TRUE),
    ('Supabase 굿즈 우산',               '경량 5단 우산.',                                    22000,  12, NULL, TRUE),
    ('Git 커맨드 머그 (블랙)',            'git push --force 가 그려진 머그.',                  14000,  40, NULL, TRUE),
    ('밤샘코딩 야식세트 (가상)',          '실제 발송 X — 데모용 상품.',                         9900,   8, NULL, TRUE)
  ) AS v(name, description, price, stock, image_url, is_active)
 WHERE NOT EXISTS (
   SELECT 1 FROM app.shop_products p WHERE p.name = v.name
 );
