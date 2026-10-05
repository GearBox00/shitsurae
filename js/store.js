// 端末内の保存（デモ用）。本番ではサーバーのデータベースに置き換える。
const KEY_ORDERS = 'shitsurae_orders';
const KEY_SAVED = 'shitsurae_saved';

function read(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}
function write(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); return true; } catch { return false; }
}

export const store = {
  orders: () => read(KEY_ORDERS),
  addOrder(order) { const l = read(KEY_ORDERS); l.unshift(order); return write(KEY_ORDERS, l); },
  updateOrder(no, patch) {
    const l = read(KEY_ORDERS).map(o => (o.no === no ? { ...o, ...patch } : o));
    return write(KEY_ORDERS, l);
  },
  clearOrders: () => write(KEY_ORDERS, []),
  saved: product => read(KEY_SAVED).filter(s => s.product === product),
  addSaved(item) {
    const l = read(KEY_SAVED); l.unshift(item);
    // 画像を含むので件数を絞る
    return write(KEY_SAVED, l.slice(0, 12));
  },
  removeSaved(id) { return write(KEY_SAVED, read(KEY_SAVED).filter(s => s.id !== id)); },
};

export const yen = n => '¥' + Number(n || 0).toLocaleString('ja-JP');

// 保存領域は同じドメインのほかのページとも共有されるため、画像はこのシミュレーターが作った形式だけ通す
export const safeImg = s => (typeof s === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s) ? s : '');

export function newOrderNo() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `SR-${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
}
