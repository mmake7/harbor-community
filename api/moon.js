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
const { verifyToken } = require('../lib/auth-helper');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const TZ = 'Asia/Seoul';

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

// Phase 1에서 채울 것
async function viewMe(req, res) {
  return res.status(501).json({ error: 'Phase 1 미구현', timezone: TZ });
}

// Phase 2에서 채울 것
async function viewWeather(req, res) {
  return res.status(501).json({ error: 'Phase 2 미구현', timezone: TZ });
}

async function viewNews(req, res) {
  return res.status(501).json({ error: 'Phase 2 미구현', timezone: TZ });
}

// Phase 3에서 채울 것 (★ 핵심)
async function viewBriefing(req, res) {
  return res.status(501).json({ error: 'Phase 3 미구현', timezone: TZ });
}
