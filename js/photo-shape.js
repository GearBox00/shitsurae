// 写真から器の形を作る画面。写真はこの端末の中だけで使い、どこにも送信しない。
import { shapeFromMarks, silhouetteRows } from './vessel.js';

const $ = id => document.getElementById(id);
const MARKS = [
  { id: 'L', label: '口の左端' },
  { id: 'R', label: '口の右端' },
  { id: 'T', label: '口の奥（いちばん上）' },
  { id: 'F', label: '高台の下の角（右）' },
  { id: 'F2', label: '高台の上の角（右）' },
  { id: 'S', label: '胴のふくらみ（右の輪郭）' },
];
const MAX_BYTES = 20 * 1024 * 1024;

let img = null, marks = null, scale = 1, dragging = null, fit = null, onApplyCb = null;

// ---------- 自動で印を置く（器と背景の明るさの差で輪郭を探す。合わなければ手で直してもらう） ----------
function autoMarks(image) {
  const W = 400, k = W / image.naturalWidth, H = Math.round(image.naturalHeight * k);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(image, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  // 大津の方法で明暗の境目を決める（lo〜hi の範囲の明るさだけを使う）
  const otsu = (lo, hi) => {
    const hist = new Array(256).fill(0);
    let total = 0;
    lum.forEach(v => { const b = Math.min(255, v | 0); if (b >= lo && b <= hi) { hist[b]++; total++; } });
    let sum = 0; hist.forEach((h, i) => { sum += i * h; });
    let sB = 0, wB = 0, best = -1, thr = (lo + hi) >> 1;
    for (let t = lo; t <= hi; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sB += t * hist[t];
      const v = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
      if (v > best) { best = v; thr = t; }
    }
    return thr;
  };
  // 中央付近と縁の明るさを比べて、器が暗いのか明るいのかを決める
  let centerSum = 0, cn = 0, edgeSum = 0, en = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = lum[y * W + x];
    if (Math.abs(x - W / 2) < W * 0.15 && Math.abs(y - H / 2) < H * 0.15) { centerSum += v; cn++; }
    if (x < 6 || y < 6 || x >= W - 6) { edgeSum += v; en++; }
  }
  const dark = centerSum / cn < edgeSum / en;

  // 塊に分けて、中央に近くて大きい塊を選ぶ。
  // 布の織り目などの細いつながりで背景とくっつかないよう、一度削ってから選び、あとで元の太さに戻す
  const morph = (src, grow) => {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = src[i];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        const n = nx < 0 || ny < 0 || nx >= W || ny >= H ? 0 : src[ny * W + nx];
        v = grow ? (v | n) : (v & n);
      }
      out[i] = v;
    }
    return out;
  };
  function pick(thr) {
    const on = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) on[i] = dark ? lum[i] < thr : lum[i] > thr;
    let core = on;
    for (let k = 0; k < 3; k++) core = morph(core, false);
    const lab = new Int32Array(W * H).fill(-1);
    let bestId = -1, bestScore = -1, bestTouch = false, id = 0;
    const stack = [];
    for (let i = 0; i < W * H; i++) {
      if (!core[i] || lab[i] >= 0) continue;
      let n = 0, sx = 0, sy = 0, touch = false;
      stack.push(i); lab[i] = id;
      while (stack.length) {
        const j = stack.pop(); n++;
        const x = j % W, y = (j / W) | 0; sx += x; sy += y;
        if (x <= 3 || x >= W - 4) touch = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (core[q] && lab[q] < 0) { lab[q] = id; stack.push(q); }
        }
      }
      const distC = Math.hypot(sx / n - W / 2, sy / n - H / 2) / W;
      const score = n * (1 - Math.min(0.9, distC));
      if (score > bestScore) { bestScore = score; bestId = id; bestTouch = touch; }
      id++;
    }
    let mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) mask[i] = lab[i] === bestId ? 1 : 0;
    for (let k = 0; k < 4; k++) mask = morph(mask, true);
    for (let i = 0; i < W * H; i++) mask[i] &= on[i];
    return { mask, touch: bestTouch };
  }
  // 選んだ塊が写真の左右の端まで届いていたら、背景（机や布）も混ざっている。
  // 器の側だけの明るさで、もう一度分け直す
  let lo = 0, hi = 255, thr = otsu(lo, hi), res = pick(thr);
  for (let i = 0; i < 3 && res.touch; i++) {
    if (dark) hi = thr; else lo = thr;
    thr = otsu(lo, hi);
    res = pick(thr);
  }
  const left = new Array(H).fill(-1), right = new Array(H).fill(-1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!res.mask[y * W + x]) continue;
    if (left[y] < 0) left[y] = x;
    right[y] = x;
  }
  const rows = [...Array(H).keys()].filter(y => left[y] >= 0);
  if (rows.length < 10) return null;
  const top = rows[0], bottom = rows[rows.length - 1];
  const width = y => right[y] - left[y];
  const widest = rows.reduce((a, y) => (width(y) > width(a) + 1 ? y : a), rows[0]);
  const cx = (left[widest] + right[widest]) / 2;
  // 高台：側面は写真の上でほぼ垂直なので、右端の位置がほとんど変わらない行が続く所を高台の側面とみなす。
  // その上端が「高台の上の角」、下端が「高台の下の角」
  let footTop = -1, footRow = -1;
  const lowest = widest + (bottom - widest) * 0.45;
  for (let y = bottom - 1; y > lowest; y--) {
    let top = y;
    while (top - 1 > lowest && Math.abs(right[top - 1] - right[top]) <= 1 && Math.abs(right[top - 1] - right[y]) <= 2) top--;
    if (y - top >= 3) { footTop = top; footRow = y; break; }
  }
  if (footTop < 0) { footRow = bottom - Math.round((bottom - top) * 0.03); footTop = footRow - Math.round((bottom - top) * 0.08); }
  const footX = right[footRow];
  const sRow = Math.round((widest + footTop) / 2);
  const P = (x, y) => ({ x: x / k, y: y / k });
  const m = {
    L: P(left[widest], widest), R: P(right[widest], widest), T: P(cx, top),
    F: P(footX, footRow), F2: P(right[footTop], footTop), S: P(right[sRow], sRow),
  };
  // 高台や胴が形として成り立たない位置になったら、口の大きさから見た標準的な位置に置き直す
  if (shapeFromMarks(m, 12).error) {
    const A = (m.R.x - m.L.x) / 2, mx = (m.L.x + m.R.x) / 2, my = (m.L.y + m.R.y) / 2;
    const by = bottom / k - (bottom - top) / k * 0.03;
    m.F = { x: mx + A * 0.42, y: by };
    m.F2 = { x: mx + A * 0.42, y: by - (by - my) * 0.22 };
    m.S = { x: mx + A * 0.85, y: my + (m.F2.y - my) * 0.45 };
  }
  return m;
}

// ---------- 描画 ----------
function draw() {
  const cv = $('photoCanvas');
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  g.drawImage(img, 0, 0, cv.width, cv.height);
  const rim = +$('rimInput').value;
  const res = rim >= 6 && rim <= 40 ? shapeFromMarks(marks, rim) : { error: '口径は 6〜40cm の範囲で入れてください。' };
  fit = res.error ? null : res;
  $('photoErr').textContent = res.error || '';
  $('applyShape').disabled = !!res.error;
  $('shapeNums').textContent = res.error ? '' :
    `高さ ${res.shape.h.toFixed(1)}cm・高台の直径 ${(res.shape.rf * 2).toFixed(1)}cm・見下ろす角度 ${(res.phi * 180 / Math.PI).toFixed(0)}°`;
  // 3Dにしたときの輪郭（写真と同じ角度から見た外形）を重ねる
  if (fit) {
    const { rows, cx } = silhouetteRows(fit.shape, fit);
    g.fillStyle = '#e8b931';
    rows.forEach((half, row) => {
      for (const x of [cx - half, cx + half]) g.fillRect(x * scale - 1.5, row * scale - 1.5, 3, 3);
    });
  }
  // 口の楕円
  const cxr = (marks.L.x + marks.R.x) / 2, cyr = (marks.L.y + marks.R.y) / 2;
  const A = Math.hypot(marks.R.x - marks.L.x, marks.R.y - marks.L.y) / 2, B = Math.max(1, cyr - marks.T.y);
  g.strokeStyle = 'rgba(127,214,255,.9)'; g.lineWidth = 2;
  g.beginPath(); g.ellipse(cxr * scale, cyr * scale, A * scale, B * scale, 0, 0, Math.PI * 2); g.stroke();
  // 印
  MARKS.forEach((m, i) => {
    const p = marks[m.id], x = p.x * scale, y = p.y * scale;
    g.beginPath(); g.arc(x, y, dragging === m.id ? 13 : 10, 0, Math.PI * 2);
    g.fillStyle = '#1c2321'; g.fill();
    g.lineWidth = 2.5; g.strokeStyle = '#e8b931'; g.stroke();
    g.fillStyle = '#e8b931'; g.font = '700 12px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(i + 1), x, y + 0.5);
  });
}

function layout() {
  const wrap = $('photoStage');
  const maxW = wrap.clientWidth, maxH = Math.min(window.innerHeight * 0.55, 620);
  scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
  const cv = $('photoCanvas');
  cv.width = Math.round(img.naturalWidth * scale);
  cv.height = Math.round(img.naturalHeight * scale);
  draw();
}

function pointerPos(e) {
  const r = $('photoCanvas').getBoundingClientRect();
  return { x: (e.clientX - r.left) * ($('photoCanvas').width / r.width) / scale, y: (e.clientY - r.top) * ($('photoCanvas').height / r.height) / scale };
}

function bind() {
  const cv = $('photoCanvas');
  cv.addEventListener('pointerdown', e => {
    const p = pointerPos(e);
    let best = null, bd = 40 / scale;   // 指でもつかみやすいよう、印のまわり 40px まで反応させる
    MARKS.forEach(m => { const d = Math.hypot(marks[m.id].x - p.x, marks[m.id].y - p.y); if (d < bd) { bd = d; best = m.id; } });
    if (!best) return;
    dragging = best; cv.setPointerCapture(e.pointerId); e.preventDefault(); draw();
  });
  cv.addEventListener('pointermove', e => {
    if (!dragging) return;
    const p = pointerPos(e);
    marks[dragging] = { x: Math.max(0, Math.min(img.naturalWidth, p.x)), y: Math.max(0, Math.min(img.naturalHeight, p.y)) };
    draw();
  });
  const end = () => { if (dragging) { dragging = null; draw(); } };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  $('rimInput').addEventListener('input', () => img && draw());
  $('autoBtn').addEventListener('click', () => { const m = autoMarks(img); if (m) { marks = m; draw(); } });
  $('applyShape').addEventListener('click', () => {
    if (!fit) return;
    onApplyCb?.(fit.shape);
    $('photoDlg').close();
  });
  window.addEventListener('resize', () => { if ($('photoDlg').open && img) layout(); });
  $('photoLegend').innerHTML = '';
  MARKS.forEach((m, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<b class="mono">${i + 1}</b>`;
    li.append(document.createTextNode(m.label));
    $('photoLegend').appendChild(li);
  });
}

let bound = false;
export function openPhotoShape(file, { rim = 12, onApply, onError }) {
  if (!bound) { bind(); bound = true; }
  onApplyCb = onApply;
  if (!file) return;
  if (!/^image\//.test(file.type)) return onError('画像ファイル（JPEG・PNG など）を選んでください。');
  if (file.size > MAX_BYTES) return onError('20MB 以下の写真を選んでください。');
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    img = image;
    marks = autoMarks(image) || {
      L: { x: image.naturalWidth * 0.2, y: image.naturalHeight * 0.45 }, R: { x: image.naturalWidth * 0.8, y: image.naturalHeight * 0.45 },
      T: { x: image.naturalWidth * 0.5, y: image.naturalHeight * 0.35 }, F: { x: image.naturalWidth * 0.62, y: image.naturalHeight * 0.75 },
      F2: { x: image.naturalWidth * 0.62, y: image.naturalHeight * 0.7 }, S: { x: image.naturalWidth * 0.75, y: image.naturalHeight * 0.58 },
    };
    $('rimInput').value = rim;
    $('photoDlg').showModal();
    layout();
    document.body.dataset.photoReady = '1';
  };
  image.onerror = () => { URL.revokeObjectURL(url); onError('写真を読み込めませんでした。別の写真でお試しください。'); };
  image.src = url;
}

// 確認用（開発時だけ使う）
export const _debug = { getMarks: () => marks, setMarks: m => { marks = m; draw(); }, getFit: () => fit };
