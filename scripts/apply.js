// ===========================================================
// sql/ 디렉토리 안 .sql 파일을 사전순 적용 + 검증
//   $ node scripts/apply.js
// ===========================================================
require('dotenv').config({ path: __dirname + '/../.env.local' });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const SQL_DIR = path.join(ROOT, 'sql');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('❌ DATABASE_URL 없음'); process.exit(1); }

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log('✅ DB 연결됨');

  try {
    const files = fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) {
      const sql = fs.readFileSync(path.join(SQL_DIR, f), 'utf8');
      await client.query(sql);
      console.log(`✅ ${f} 적용 완료`);
    }

    console.log('\n──────── 검증 ────────');

    // 1. auth_users 테이블 존재
    const u = await client.query(`SELECT to_regclass('app.auth_users') AS t`);
    console.log(`[1] app.auth_users      : ${u.rows[0].t ? '✅ ' + u.rows[0].t : '❌'}`);

    // 2. auth_sessions 테이블 존재
    const s = await client.query(`SELECT to_regclass('app.auth_sessions') AS t`);
    console.log(`[2] app.auth_sessions   : ${s.rows[0].t ? '✅ ' + s.rows[0].t : '❌'}`);

    // 3. auth_users 컬럼 검증
    const cols = await client.query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema='app' AND table_name='auth_users'
        ORDER BY ordinal_position`
    );
    console.log(`\n[3] auth_users 컬럼 (${cols.rows.length}개):`);
    cols.rows.forEach(c => console.log(`    ${c.column_name.padEnd(15)} ${c.data_type}`));

    // 4. 인덱스
    const idx = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname='app' AND tablename IN ('auth_users','auth_sessions')
        ORDER BY tablename, indexname`
    );
    console.log(`\n[4] 인덱스 (${idx.rows.length}개):`);
    idx.rows.forEach(i => console.log(`    ${i.indexname}`));

    // 5. 기존 사용자 수 (멱등성 확인용)
    const cnt = await client.query(`SELECT count(*)::int AS n FROM app.auth_users`);
    console.log(`\n[5] 현재 auth_users 레코드: ${cnt.rows[0].n}건`);

    console.log('\n──────── 완료 ────────\n');
  } catch (e) {
    console.error('❌ 적용 실패:', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
})();
