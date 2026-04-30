// ===========================================================
// KST (Asia/Seoul) 일관 처리 헬퍼
//   서버 TZ에 의존하지 않도록 UTC + 9h 직접 계산
// ===========================================================

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function kstNow() {
  return new Date(Date.now() + KST_OFFSET_MS);
}

// 'YYYY-MM-DD'
function kstToday() {
  return kstNow().toISOString().slice(0, 10);
}

// 'YYYY-MM'
function kstThisMonth() {
  return kstToday().slice(0, 7);
}

// 'YYYY-MM-01'
function kstThisMonthStart() {
  return kstThisMonth() + '-01';
}

// 'YYYY-MM-DD' (해당 월의 마지막 날)
function kstThisMonthEnd() {
  return kstMonthEnd(kstThisMonth());
}

// 임의 월(YYYY-MM)의 첫 날 / 마지막 날
function kstMonthStart(yyyymm) {
  return `${yyyymm}-01`;
}

function kstMonthEnd(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  // Date.UTC(y, m, 0) = (m+1)월 0일 = m월 마지막 날
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${yyyymm}-${String(lastDay).padStart(2, '0')}`;
}

// 'YYYY-MM' 에서 N개월 뺀 'YYYY-MM'
function kstMonthMinus(yyyymm, n) {
  const [y, m] = yyyymm.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return d.toISOString().slice(0, 7);
}

module.exports = {
  kstNow,
  kstToday,
  kstThisMonth,
  kstThisMonthStart,
  kstThisMonthEnd,
  kstMonthStart,
  kstMonthEnd,
  kstMonthMinus,
};
