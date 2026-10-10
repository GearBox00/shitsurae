// 真上から撮った写真で、丸くない器の外形と欠けを決める画面。写真はこの端末の中だけで使い、どこにも送信しない。
import { PLAN_N } from './vessel.js';

const $ = id => document.getElementById(id);
const MAX_BYTES = 20 * 1024 * 1024;
const NA = 360;          // 外形を測る向きの数（1°ごと）
const HANDLES = 24;      // 手直し用の印の数（15°ごと）
const STEP = NA / HANDLES;

let img = null, scale = 1, auto = null, rFull = null, dragging = -1, onApplyCb = null;

// ---------- 自動で外形を取る ----------
// 1. 写真の縁の色を背景とみなし、背景との色の差で器を切り出す
// 2. 器の中心から向きごとに、いちばん遠い器の点までの距離（実際の外形）を測る
// 3. へこみ（凸包からの差が大きい所）を欠けとみなし、欠けていない所になだらかな曲線を当てはめて元の外形を補う
function autoPlan(image) {
  const W = 400, k = W / image.naturalWidth, H = Math.round(image.naturalHeight * k);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(image, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  // 3×3 でならした色
  const rgb = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, gg = 0, b = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = (ny * W + nx) * 4; r += d[j]; gg += d[j + 1]; b += d[j + 2]; n++;
    }
    const i = (y * W + x) * 3; rgb[i] = r / n; rgb[i + 1] = gg / n; rgb[i + 2] = b / n;
  }
  // 背景の色 = 縁の色の中央値
  const border = [[], [], []];
  for (let x = 0; x < W; x++) for (const y of [0, 1, 2, H - 3, H - 2, H - 1]) for (let ch = 0; ch < 3; ch++) border[ch].push(rgb[(y * W + x) * 3 + ch]);
  for (let y = 0; y < H; y++) for (const x of [0, 1, 2, W - 3, W - 2, W - 1]) for (let ch = 0; ch < 3; ch++) border[ch].push(rgb[(y * W + x) * 3 + ch]);
  const bg = border.map(a => a.sort((p, q) => p - q)[a.length >> 1]);
  const dist = new Float32Array(W * H);
  let dmax = 1;
  for (let i = 0; i < W * H; i++) {
    dist[i] = Math.hypot(rgb[i * 3] - bg[0], rgb[i * 3 + 1] - bg[1], rgb[i * 3 + 2] - bg[2]);
    if (dist[i] > dmax) dmax = dist[i];
  }
  // 大津の方法で、背景との差の境目を決める
  const hist = new Array(256).fill(0);
  for (let i = 0; i < W * H; i++) hist[Math.min(255, (dist[i] / dmax) * 255) | 0]++;
  let sum = 0; hist.forEach((h, i) => { sum += i * h; });
  let sB = 0, wB = 0, best = -1, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = W * H - wB; if (!wF) break;
    sB += t * hist[t];
    const v = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
    if (v > best) { best = v; thr = t; }
  }
  let on = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) on[i] = (dist[i] / dmax) * 255 > thr ? 1 : 0;
  // 細かい点を消す（削ってから戻す）
  const morph = (src, grow) => {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = src[y * W + x];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        const n = nx < 0 || ny < 0 || nx >= W || ny >= H ? 0 : src[ny * W + nx];
        v = grow ? (v | n) : (v & n);
      }
      out[y * W + x] = v;
    }
    return out;
  };
  for (let i = 0; i < 2; i++) on = morph(on, false);
  for (let i = 0; i < 2; i++) on = morph(on, true);
  // 中央に近くて大きい塊を器とみなす
  const lab = new Int32Array(W * H).fill(-1);
  let bestId = -1, bestScore = 0, bestN = 0, id = 0;
  const stack = [];
  for (let i = 0; i < W * H; i++) {
    if (!on[i] || lab[i] >= 0) continue;
    let n = 0, sx = 0, sy = 0;
    stack.push(i); lab[i] = id;
    while (stack.length) {
      const j = stack.pop(); n++;
      const x = j % W, y = (j / W) | 0; sx += x; sy += y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (on[q] && lab[q] < 0) { lab[q] = id; stack.push(q); }
      }
    }
    const score = n * (1 - Math.min(0.9, Math.hypot(sx / n - W / 2, sy / n - H / 2) / W));
    if (score > bestScore) { bestScore = score; bestId = id; bestN = n; }
    id++;
  }
  if (bestId < 0 || bestN < W * H * 0.03) return null;
  // 行ごとの左右の端から凸包を作る
  const pts = [];
  for (let y = 0; y < H; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < W; x++) if (lab[y * W + x] === bestId) { if (l < 0) l = x; r = x; }
    if (l >= 0) { pts.push([l, y]); if (r !== l) pts.push([r + 1, y]); }
  }
  const hull = convexHull(pts);
  // 凸包の重心を器の中心にする（欠けがあっても中心がずれにくい）
  let A = 0, cx = 0, cy = 0;
  hull.forEach((p, i) => {
    const q = hull[(i + 1) % hull.length], cr = p[0] * q[1] - q[0] * p[1];
    A += cr; cx += (p[0] + q[0]) * cr; cy += (p[1] + q[1]) * cr;
  });
  A /= 2; cx /= 6 * A; cy /= 6 * A;
  // 実際の外形：向きごとに、いちばん遠い器の点までの距離
  const real = new Float32Array(NA).fill(NaN);
  for (let i = 0; i < W * H; i++) {
    if (lab[i] !== bestId) continue;
    const x = (i % W) + 0.5 - cx, y = ((i / W) | 0) + 0.5 - cy;
    const b = binOf(Math.atan2(y, x)), r = Math.hypot(x, y) + 0.5;
    if (!(real[b] >= r)) real[b] = r;
  }
  fillGaps(real);
  // 凸包の外形：向きごとの光線と凸包の辺の交点
  const hullR = new Float32Array(NA);
  for (let b = 0; b < NA; b++) {
    const t = angOf(b), dx = Math.cos(t), dy = Math.sin(t);
    let far = 0;
    hull.forEach((p, i) => {
      const q = hull[(i + 1) % hull.length];
      const ex = q[0] - p[0], ey = q[1] - p[1], den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) return;
      const s = ((p[0] - cx) * ey - (p[1] - cy) * ex) / den, u = ((p[0] - cx) * dy - (p[1] - cy) * dx) / den;
      if (s > 0 && u >= -1e-6 && u <= 1 + 1e-6) far = Math.max(far, s);
    });
    hullR[b] = far || real[b];
  }
  let mean0 = 0; hullR.forEach(v => { mean0 += v / NA; });
  // へこみ（凸包から平均半径の3%以上内側）を欠けの候補にし、前後2°ずつ広げる
  const dent = Array.from(real, (v, b) => (hullR[b] - v) / mean0 > 0.03);
  const inside = dent.map((_, b) => [-2, -1, 0, 1, 2].some(o => dent[(b + o + NA) % NA]));
  // 欠けていない所の半径に、なめらかな周期の曲線（3次までのフーリエ級数）を当てはめ、欠けの所だけ置き換える
  const coef = fitFourier(real, inside, 3);
  const full = new Float32Array(NA);
  for (let b = 0; b < NA; b++) full[b] = inside[b] ? Math.max(real[b], evalFourier(coef, angOf(b))) : real[b];
  // 写真の座標に戻す
  return { cx: cx / k, cy: cy / k, real: Array.from(real, v => v / k), full: Array.from(full, v => v / k) };
}

const angOf = b => -Math.PI + (2 * Math.PI * (b + 0.5)) / NA;
const binOf = t => Math.min(NA - 1, Math.max(0, Math.floor(((t + Math.PI) / (2 * Math.PI)) * NA)));

function fillGaps(a) {
  const ok = []; a.forEach((v, i) => { if (v === v) ok.push(i); });
  if (!ok.length) return;
  for (let i = 0; i < NA; i++) {
    if (a[i] === a[i]) continue;
    let p = ok[0], q = ok[0];
    for (const j of ok) { if (j < i) p = j; if (j > i) { q = j; break; } }
    if (q < i) q = ok[0] + NA;
    if (p > i) p = ok[ok.length - 1] - NA;
    const t = (i - p) / ((q - p) || 1);
    a[i] = a[(p + NA) % NA] * (1 - t) + a[q % NA] * t;
  }
}

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

// 最小二乗法：r(θ) ≈ a0 + Σ (ak cos kθ + bk sin kθ)
function fitFourier(r, skip, K) {
  const n = 1 + 2 * K, M = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (let b = 0; b < NA; b++) {
    if (skip[b]) continue;
    const row = basis(angOf(b), K);
    for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) M[i][j] += row[i] * row[j]; M[i][n] += row[i] * r[b]; }
  }
  // ガウスの消去法
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[piv][i])) piv = j;
    [M[i], M[piv]] = [M[piv], M[i]];
    if (Math.abs(M[i][i]) < 1e-9) return [r.reduce((a, v) => a + v, 0) / NA, ...new Array(n - 1).fill(0)];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const f = M[j][i] / M[i][i];
      for (let k = i; k <= n; k++) M[j][k] -= f * M[i][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
const basis = (t, K) => { const a = [1]; for (let k = 1; k <= K; k++) a.push(Math.cos(k * t), Math.sin(k * t)); return a; };
const evalFourier = (c, t) => basis(t, (c.length - 1) / 2).reduce((a, v, i) => a + v * c[i], 0);

// ---------- 外形と欠けの値（3Dに渡す形）----------
function result() {
  let mean = 0; rFull.forEach(v => { mean += v / NA; });
  const chipOn = $('planChipOn').checked;
  const f = [], notch = [];
  const per = NA / PLAN_N;
  for (let i = 0; i < PLAN_N; i++) {
    let sf = 0, sn = 0;
    for (let j = 0; j < per; j++) {
      const b = i * per + j;
      sf += rFull[b] / mean;
      sn += Math.max(0, rFull[b] - auto.real[b]) / mean;
    }
    f.push(Math.round(Math.min(1.8, Math.max(0.4, sf / per)) * 1000) / 1000);
    // 縁のぎざぎざや影による小さな差は欠けにしない
    const nd = sn / per;
    notch.push(chipOn && nd > 0.015 ? Math.round(Math.min(0.6, nd) * 1000) / 1000 : 0);
  }
  return { f, notch };
}

// ---------- 描画 ----------
function draw() {
  const cv = $('planCanvas'), g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  g.drawImage(img, 0, 0, cv.width, cv.height);
  const P = (b, r) => [(auto.cx + r * Math.cos(angOf(b))) * scale, (auto.cy + r * Math.sin(angOf(b))) * scale];
  const path = arr => { g.beginPath(); for (let b = 0; b <= NA; b++) { const [x, y] = P(b % NA, arr[b % NA]); b ? g.lineTo(x, y) : g.moveTo(x, y); } g.closePath(); };
  // 欠けの所（元の外形と実際の外形の間）を塗る
  if ($('planChipOn').checked) {
    g.fillStyle = 'rgba(127,214,255,.55)';
    for (let b = 0; b < NA; b++) {
      if (rFull[b] - auto.real[b] < 1.5 / scale) continue;
      const [x0, y0] = P(b, auto.real[b]), [x1, y1] = P(b, rFull[b]), [x2, y2] = P((b + 1) % NA, rFull[(b + 1) % NA]), [x3, y3] = P((b + 1) % NA, auto.real[(b + 1) % NA]);
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineTo(x2, y2); g.lineTo(x3, y3); g.closePath(); g.fill();
    }
  }
  path(rFull);
  g.strokeStyle = '#e8b931'; g.lineWidth = 3; g.stroke();
  // 手直し用の印
  // 小さな画面では印を小さく描く（つかめる範囲は変えない）
  const hr = Math.max(4.5, Math.min(8, cv.width / 60));
  for (let h = 0; h < HANDLES; h++) {
    const b = h * STEP, [x, y] = P(b, rFull[b]);
    g.beginPath(); g.arc(x, y, dragging === h ? hr + 3 : hr, 0, Math.PI * 2);
    g.fillStyle = '#1c2321'; g.fill(); g.lineWidth = 2.5; g.strokeStyle = '#e8b931'; g.stroke();
  }
  const [cx, cy] = [auto.cx * scale, auto.cy * scale];
  g.fillStyle = '#e8b931'; g.beginPath(); g.arc(cx, cy, 4, 0, Math.PI * 2); g.fill();
  // 数字
  const res = result();
  let L = 0, Wd = Infinity;
  for (let i = 0; i < PLAN_N / 2; i++) { const dd = res.f[i] + res.f[i + PLAN_N / 2]; L = Math.max(L, dd); Wd = Math.min(Wd, dd); }
  const on = res.notch.map(v => v > 0.03);
  let chips = on.every(Boolean) ? 1 : 0;
  on.forEach((v, i) => { if (v && !on[(i + PLAN_N - 1) % PLAN_N]) chips++; });
  $('planNums').textContent = `長さと幅の比 ${(L / Wd).toFixed(2)}・欠け ${chips}か所`;
}

function layout() {
  const wrap = $('planStage');
  const maxW = wrap.clientWidth, maxH = Math.min(window.innerHeight * 0.55, 620);
  scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
  const cv = $('planCanvas');
  cv.width = Math.round(img.naturalWidth * scale);
  cv.height = Math.round(img.naturalHeight * scale);
  draw();
}

function pointerPos(e) {
  const cv = $('planCanvas'), r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (cv.width / r.width) / scale, y: (e.clientY - r.top) * (cv.height / r.height) / scale };
}

// 印を動かすと、その印の前後15°の外形をなだらかに動かす（隣の印との間は滑らかにつながる）
function moveHandle(h, p) {
  const b0 = h * STEP, t = angOf(b0);
  const want = Math.max(5, (p.x - auto.cx) * Math.cos(t) + (p.y - auto.cy) * Math.sin(t));
  const delta = want - rFull[b0];
  for (let o = -STEP; o <= STEP; o++) {
    const b = (b0 + o + NA) % NA, w = Math.cos((Math.PI / 2) * (o / STEP)) ** 2;
    rFull[b] = Math.max(auto.real[b] * 0.5, rFull[b] + delta * w);
  }
}

function bind() {
  const cv = $('planCanvas');
  cv.addEventListener('pointerdown', e => {
    const p = pointerPos(e);
    let best = -1, bd = 40 / scale;   // 指でもつかみやすいよう、印のまわり 40px まで反応させる
    for (let h = 0; h < HANDLES; h++) {
      const b = h * STEP, x = auto.cx + rFull[b] * Math.cos(angOf(b)), y = auto.cy + rFull[b] * Math.sin(angOf(b));
      const dd = Math.hypot(x - p.x, y - p.y);
      if (dd < bd) { bd = dd; best = h; }
    }
    if (best < 0) return;
    dragging = best; cv.setPointerCapture(e.pointerId); e.preventDefault(); draw();
  });
  cv.addEventListener('pointermove', e => {
    if (dragging < 0) return;
    moveHandle(dragging, pointerPos(e));
    draw();
  });
  const end = () => { if (dragging >= 0) { dragging = -1; draw(); } };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  $('planChipOn').addEventListener('change', () => img && draw());
  $('planAuto').addEventListener('click', () => { rFull = auto.full.slice(); draw(); });
  $('planApply').addEventListener('click', () => {
    onApplyCb?.(result());
    $('planDlg').close();
  });
  window.addEventListener('resize', () => { if ($('planDlg').open && img) layout(); });
}

let bound = false;
export function openPlanShape(file, { onApply, onError }) {
  if (!bound) { bind(); bound = true; }
  onApplyCb = onApply;
  if (!file) return;
  if (!/^image\//.test(file.type)) return onError('画像ファイル（JPEG・PNG など）を選んでください。');
  if (file.size > MAX_BYTES) return onError('20MB 以下の写真を選んでください。');
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    URL.revokeObjectURL(url);   // 読み込み終わった写真の一時URLは捨てる（画像そのものは手元に残る）
    const a = autoPlan(image);
    if (!a) return onError('器の外形が見つかりませんでした。器と違う色の紙や布の上に置き、真上から器全体が入るように撮ってください。');
    img = image; auto = a; rFull = a.full.slice();
    $('planChipOn').checked = true;
    $('planDlg').showModal();
    layout();
    document.body.dataset.planReady = '1';
  };
  image.onerror = () => { URL.revokeObjectURL(url); onError('写真を読み込めませんでした。別の写真でお試しください。'); };
  image.src = url;
}

// 確認用（開発時だけ使う）
export const _debug = { result: () => result(), handle: h => { const b = h * STEP; return { x: auto.cx + rFull[b] * Math.cos(angOf(b)), y: auto.cy + rFull[b] * Math.sin(angOf(b)) }; }, scale: () => scale };
