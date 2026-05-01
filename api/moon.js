// ===========================================================
// /api/moon — 문카페 (Moon Cafe) Q7+Q8 통합
//   ?view=me        — 내 활동 요약 (DB fetch)        [Phase 1]
//   ?view=weather   — 날씨 (Open-Meteo)              [Phase 2]
//   ?view=news      — 뉴스 (공공뉴스 API)            [Phase 2]
//   ?view=briefing  — AI 브리핑 (Claude + Context)   [Phase 3]
// ===========================================================
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { verifyTokenWithRevoke } = require('../lib/auth-helper');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const TZ = 'Asia/Seoul';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

// WMO weather code → 한글 라벨 (Open-Meteo)
const WMO_LABELS = {
  0: '맑음', 1: '대체로 맑음', 2: '구름 조금', 3: '흐림',
  45: '안개', 48: '안개',
  51: '이슬비', 53: '이슬비', 55: '이슬비',
  61: '비',   63: '비',   65: '비',
  71: '눈',   73: '눈',   75: '눈',
  80: '소나기', 81: '소나기', 82: '소나기',
  95: '뇌우', 96: '뇌우', 99: '뇌우',
};
const wmoLabel = (code) => WMO_LABELS[code] || '기타';

async function fetchWithTimeout(url, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}

module.exports = async (req, res) => {
  const view = req.query.view;

  try {
    switch (view) {
      case 'me':       return await viewMe(req, res);
      case 'weather':  return await viewWeather(req, res);
      case 'news':     return await viewNews(req, res);
      case 'briefing': return await viewBriefing(req, res);
      default:
        return res.status(400).json({ error: 'view 파라미터 필요', timezone: TZ });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: '서버 오류', detail: e.message, timezone: TZ });
  }
};

// 내 활동 요약: auth_users + community_posts/comments/reactions + shop_cart_items/orders
async function getMeData(uid) {
  const sql = `
    WITH
    u AS (
      SELECT id, display_name, email, created_at,
             (CURRENT_DATE - created_at::date)::int AS days_since_join
        FROM app.auth_users WHERE id = $1
    ),
    c AS (
      SELECT
        COUNT(*) FILTER (WHERE NOT p.is_deleted)::int AS posts_total,
        COUNT(*) FILTER (WHERE NOT p.is_deleted AND p.created_at > NOW() - INTERVAL '7 days')::int AS posts_last_7d
        FROM app.community_posts p WHERE p.user_id = $1
    ),
    cm AS (
      SELECT COUNT(*) FILTER (WHERE NOT is_deleted)::int AS comments_total
        FROM app.community_comments WHERE user_id = $1
    ),
    rr AS (
      SELECT COUNT(*)::int AS reactions_received
        FROM app.community_reactions r
        JOIN app.community_posts p ON p.id = r.post_id
       WHERE p.user_id = $1 AND NOT p.is_deleted
    ),
    rg AS (
      SELECT COUNT(*)::int AS reactions_given
        FROM app.community_reactions WHERE user_id = $1
    ),
    ct AS (
      SELECT
        COUNT(*)::int AS cart_items,
        COALESCE(SUM(ci.quantity * p.price), 0)::int AS cart_total_amount
        FROM app.shop_cart_items ci
        JOIN app.shop_products p ON p.id = ci.product_id
       WHERE ci.user_id = $1
    ),
    o AS (
      SELECT
        COUNT(*)::int AS orders_total,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS orders_last_30d,
        MAX(created_at)::date AS last_order_date,
        COALESCE(SUM(total_amount), 0)::int AS total_spent
        FROM app.shop_orders WHERE user_id = $1
    )
    SELECT json_build_object(
      'user', json_build_object(
        'id', u.id,
        'display_name', u.display_name,
        'email', u.email,
        'member_since', u.created_at::date,
        'days_since_join', u.days_since_join
      ),
      'community', json_build_object(
        'posts_total', c.posts_total,
        'posts_last_7d', c.posts_last_7d,
        'comments_total', cm.comments_total,
        'reactions_received', rr.reactions_received,
        'reactions_given', rg.reactions_given
      ),
      'shop', json_build_object(
        'cart_items', ct.cart_items,
        'cart_total_amount', ct.cart_total_amount,
        'orders_total', o.orders_total,
        'orders_last_30d', o.orders_last_30d,
        'last_order_date', o.last_order_date,
        'total_spent', o.total_spent
      )
    ) AS result
    FROM u, c, cm, rr, rg, ct, o
  `;
  const r = await pool.query(sql, [uid]);
  return r.rows[0] ? r.rows[0].result : null;
}

async function viewMe(req, res) {
  const user = await verifyTokenWithRevoke(req, pool);
  if (!user) return res.status(401).json({ error: '인증 필요', timezone: TZ });
  const data = await getMeData(user.uid);
  if (!data) return res.status(404).json({ error: '사용자 정보 없음', timezone: TZ });
  return res.status(200).json({ data, timezone: TZ });
}

// 서울 종로구 — Open-Meteo 현재 + 오늘 요약
async function getWeatherData() {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=37.5665&longitude=126.9780'
    + '&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m'
    + '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code'
    + '&timezone=Asia%2FSeoul&forecast_days=1';

  try {
    const r = await fetchWithTimeout(url, 5000);
    if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
    const j = await r.json();
    const c = j.current || {};
    const d = j.daily || {};
    return {
      location: '서울 종로구',
      current: {
        temperature: c.temperature_2m,
        humidity: c.relative_humidity_2m,
        wind_speed: c.wind_speed_10m,
        weather_code: c.weather_code,
        weather_label: wmoLabel(c.weather_code),
      },
      today: {
        temp_max: d.temperature_2m_max && d.temperature_2m_max[0],
        temp_min: d.temperature_2m_min && d.temperature_2m_min[0],
        precipitation_sum: d.precipitation_sum && d.precipitation_sum[0],
        weather_label: wmoLabel(d.weather_code && d.weather_code[0]),
      },
    };
  } catch (e) {
    console.error('[weather]', e.message);
    return null;
  }
}

async function viewWeather(req, res) {
  const data = await getWeatherData();
  if (data) return res.status(200).json({ data, timezone: TZ });
  return res.status(200).json({ data: null, warning: '날씨 정보를 가져올 수 없어요', timezone: TZ });
}

// Google News RSS — 한국 / 최대 5건
async function getNewsData() {
  const url = 'https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko';
  try {
    const r = await fetchWithTimeout(url, 5000);
    if (!r.ok) throw new Error(`Google News ${r.status}`);
    const xml = await r.text();
    const items = (xml.match(/<item[\s\S]*?<\/item>/g) || []).slice(0, 5).map((it) => ({
      title:    (it.match(/<title>(?:<!\[CDATA\[)?([^\]<]+)/) || [])[1] || '',
      link:     (it.match(/<link>([^<]+)/) || [])[1] || '',
      pub_date: (it.match(/<pubDate>([^<]+)/) || [])[1] || '',
    }));
    return { source: 'Google News (한국)', items };
  } catch (e) {
    console.error('[news]', e.message);
    return null;
  }
}

async function viewNews(req, res) {
  const data = await getNewsData();
  if (data) return res.status(200).json({ data, timezone: TZ });
  return res.status(200).json({ data: null, warning: '뉴스 정보를 가져올 수 없어요', timezone: TZ });
}

// ─────────── Phase 3: AI 브리핑 (카페지기 + 달지기 듀오) ───────────

const SYSTEM_BASE = `당신은 '문카페'라는 야간 카페에서 일하는 두 명의 캐릭터입니다.
손님 한 명에게 동시에 두 관점의 브리핑을 들려줍니다.

# 캐릭터 1: ☕ 카페지기
- 역할: 카페 운영·실용 관점 어드바이저
- 톤: 차분하고 실용적, 짧고 핵심적
- 관심사: 매출, 손님, 메뉴, 사장 건강, 운영 효율
- 말투: "오늘 비 와요. 손님 줄 수 있으니 차 메뉴 하나 더 어때요?"

# 캐릭터 2: ✦ 달지기
- 역할: 개인 삶·감성 관점 어드바이저
- 톤: 시적이고 은유적, 동양적 비유 좋아함
- 관심사: 그림, 차, 음악, 야경, 마음 상태
- 말투: "비 오는 밤, 작업실 창밖 풍경 좋을 거예요. 보이차 한 잔, 빌 에반스 한 곡."`;

const FORMAT_RULES_WITH = `# 응답 형식 — 반드시 이 형식 정확히 지켜
[카페지기]
(2~4 문장, 카페지기 톤, 손님 호칭은 "올빼미 아저씨" 또는 "아저씨")

[달지기]
(2~4 문장, 달지기 톤, 호칭 동일)

# 절대 규칙
- 두 캐릭터의 톤을 명확히 구분 (카페지기=실용, 달지기=감성)
- 손님 정보의 제약사항·취향을 반영해서 답변
- 마크다운 사용 X (대괄호 [] 외에 다른 마크업 X)
- 영어/한자 사용 X (한글만)
- 호칭 절대 X: "님", "당신", "사용자", "고객"`;

const FORMAT_RULES_WITHOUT = `# 응답 형식 — 반드시 이 형식 정확히 지켜
[카페지기]
(2~4 문장)

[달지기]
(2~4 문장)

# 절대 규칙
- 마크다운 사용 X
- 한글만`;

function buildSystemPrompt(owlContext) {
  return `${SYSTEM_BASE}

# 손님 핵심 정보 (반드시 답변에 반영할 것)
${owlContext}

⚠️ 답변 작성 절대 규칙:
1. 호칭: 첫 마디에 '올빼미 아저씨', 그 다음부터 '아저씨' 사용 (필수)
2. 손님의 직업(카페 사장), 제약사항(위염), 목표(전시회 D-92) 중 최소 2개 이상 명시적으로 언급
3. 손님 취향(보이차, 재즈, 그림, 야경) 중 최소 1개 자연스럽게 녹이기
4. 일반론적 답변 금지 — 이 손님에게만 의미 있는 답변일 것

[예시 — 카페지기]
'올빼미 아저씨, 오늘 비가 와요. 카페 단골들 발길 줄 수 있어요.
 위염 신경 써서 본인은 보이차로 하시고, 매장에 따뜻한 차 메뉴 하나 더 어때요?'

[예시 — 달지기]
'아저씨, 비 오는 밤은 작업실 창가가 좋아요.
 전시회까지 92일, 오늘 한 점만 그려도 충분해요.
 LP는 빌 에반스 정도가 어울리겠어요.'

${FORMAT_RULES_WITH}`;
}

function buildSystemPromptNoContext() {
  return `${SYSTEM_BASE}

# 손님 정보
손님에 대한 별도 정보가 없습니다. 일반적인 답변을 해주세요.

${FORMAT_RULES_WITHOUT}`;
}

function buildUserMessage(me, weather, newsTitles) {
  const lines = [
    '오늘의 활동 요약, 날씨, 뉴스를 보고 짧은 브리핑을 해주세요.',
    '',
    '[활동 요약]',
    `- 게시판 글: 총 ${me.community.posts_total}개 (최근 7일 ${me.community.posts_last_7d}개)`,
    `- 댓글: ${me.community.comments_total}개`,
    `- 받은 반응: ${me.community.reactions_received}개 / 누른 반응: ${me.community.reactions_given}개`,
    `- 카트: ${me.shop.cart_items}개 (${me.shop.cart_total_amount}원)`,
    `- 주문: 총 ${me.shop.orders_total}회 (누적 ${me.shop.total_spent}원)`,
    `- 가입: ${me.user.member_since} (${me.user.days_since_join}일 전)`,
    '',
  ];
  if (weather) {
    lines.push('[오늘 날씨 — 서울 종로구]');
    lines.push(`- 현재: ${weather.current.weather_label}, ${weather.current.temperature}°C, 습도 ${weather.current.humidity}%`);
    lines.push(`- 오늘 최고/최저: ${weather.today.temp_max}°C / ${weather.today.temp_min}°C`);
    lines.push(`- 강수: ${weather.today.precipitation_sum}mm`);
  } else {
    lines.push('[오늘 날씨] 정보를 가져올 수 없었습니다.');
  }
  lines.push('');
  if (newsTitles.length) {
    lines.push('[오늘 뉴스 헤드라인]');
    newsTitles.slice(0, 5).forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  } else {
    lines.push('[오늘 뉴스] 정보를 가져올 수 없었습니다.');
  }
  return lines.join('\n');
}

async function callClaude(systemPrompt, userMessage) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Claude ${r.status}: ${errText.slice(0, 300)}`);
    }
    const j = await r.json();
    return (j.content && j.content[0] && j.content[0].text) || '';
  } finally {
    clearTimeout(t);
  }
}

function parseBriefing(text) {
  const cafe = ((text.match(/\[카페지기\]([\s\S]*?)(?=\[달지기\]|$)/) || [])[1] || '').trim();
  const moon = ((text.match(/\[달지기\]([\s\S]*?)$/) || [])[1] || '').trim();
  if (!cafe || !moon) {
    console.warn('[briefing] 파싱 실패, raw text:', text);
    return {
      cafe_keeper: cafe || '브리핑 생성 실패 (재시도 부탁드려요)',
      moon_keeper: moon || '브리핑 생성 실패 (재시도 부탁드려요)',
    };
  }
  return { cafe_keeper: cafe, moon_keeper: moon };
}

async function viewBriefing(req, res) {
  const user = await verifyTokenWithRevoke(req, pool);
  if (!user) return res.status(401).json({ error: '인증 필요', timezone: TZ });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API 키 설정 필요', timezone: TZ });
  }

  let me, weather, news;
  try {
    [me, weather, news] = await Promise.all([
      getMeData(user.uid),
      getWeatherData(),
      getNewsData(),
    ]);
  } catch (e) {
    console.error('[briefing] data fetch:', e);
    return res.status(500).json({ error: '데이터 수집 실패', detail: e.message, timezone: TZ });
  }
  if (!me) return res.status(404).json({ error: '사용자 정보 없음', timezone: TZ });

  let owlContext = '';
  try {
    owlContext = fs.readFileSync(path.join(__dirname, '../lib/owl-context.md'), 'utf8');
  } catch (e) {
    console.error('[briefing] owl-context.md 읽기 실패:', e.message);
    owlContext = '(손님 정보 없음)';
  }

  const newsTitles = (news && news.items ? news.items.map((i) => i.title).filter(Boolean) : []);
  const userMessage = buildUserMessage(me, weather, newsTitles);

  let textWith, textWithout;
  try {
    [textWith, textWithout] = await Promise.all([
      callClaude(buildSystemPrompt(owlContext), userMessage),
      callClaude(buildSystemPromptNoContext(), userMessage),
    ]);
  } catch (e) {
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: '응답 지연', timezone: TZ });
    }
    console.error('[briefing] Claude 호출 실패:', e.message);
    return res.status(503).json({ error: 'AI 응답 실패, 잠시 후 다시', detail: e.message, timezone: TZ });
  }

  return res.status(200).json({
    data: {
      with_context: parseBriefing(textWith),
      without_context: parseBriefing(textWithout),
      raw_data_used: {
        user_summary: me,
        weather: weather,
        news_titles: newsTitles,
      },
    },
    timezone: TZ,
  });
}
