// 操作の回数を記録する（営業デモで、開かれたか・どこまで触られたかを知るため）。
// 送るのは「どの出来事が・どのページで・どの訪問で」だけ。氏名・メールアドレス・入力した文字・写真は送らない。
// 訪問の識別子はブラウザを閉じると消える（sessionStorage）。
// 手元の確認用サーバー（localhost）や確認用の ?debug では送らない（確認作業の操作が記録に混ざらないように）。
const EP = 'https://gearbox-app-origin.net/shitsurae-api/track.php';
const params = new URLSearchParams(location.search);
const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === 'file:';
const enabled = params.has('track') || (!local && !params.has('debug'));

function rand() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
let sid = '';
try {
  sid = sessionStorage.getItem('shitsurae_sid') || '';
  if (!sid) { sid = rand(); sessionStorage.setItem('shitsurae_sid', sid); }
} catch { sid = rand(); }

const once = new Set();
export const sentLog = [];   // 確認用に、送った（送るはずだった）内容を控える

// ev：出来事の種類、page：ページ（top か商品の id）、extra：補足（英数字と _ . - だけ、40文字まで）
export function track(ev, page, extra = '', { onlyOnce = false } = {}) {
  extra = String(extra).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
  if (onlyOnce) {
    const k = `${ev}|${page}|${extra}`;
    if (once.has(k)) return;
    once.add(k);
  }
  sentLog.push({ ev, page, extra });
  if (!enabled) return;
  try {
    // Content-Type を text/plain にすると、ブラウザが事前確認（preflight）を送らずに済む
    fetch(EP, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ ev, page, sid, extra }),
      keepalive: true, mode: 'cors', credentials: 'omit',
    }).catch(() => {});
  } catch { /* 記録できなくても画面の動きには影響させない */ }
}
if (params.has('debug')) window.__trackLog = sentLog;
