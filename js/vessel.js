// 器の形（6つの数値）から、3Dの形・部位の画像・擦れやすさの地図をブラウザの中で組み立てる。
// ろくろと同じく、断面を軸のまわりに回して作る。tools/build_vessels.py の owan と同じ考え方。
import * as THREE from 'three';

// 形を表す数値（単位 cm）
//   rim: 口径  h: 高さ  rf: 高台の半径  hf: 高台の高さ  a: 胴の付け根の半径  p: 胴の開き方（大きいほど早く開く）
export const SHAPE_LIMITS = {
  rim: [6, 40], h: [1.5, 30], rf: [0.8, 15], hf: [0.2, 4], a: [0.8, 20], p: [1, 6],
};

export function sanitizeShape(s) {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(SHAPE_LIMITS)) {
    const v = s[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return null;
    out[k] = Math.round(v * 1000) / 1000;
  }
  // 形として成り立つかどうか
  if (out.rf >= out.rim / 2 || out.a >= out.rim / 2 || out.a < out.rf * 0.8 || out.hf >= out.h * 0.5) return null;
  return out;
}

const T = 0.45; // 器の厚み（cm）

// 内側の底の高さ
export const floorOf = s => s.floorY ?? Math.min(s.hf + 0.5, s.h - 0.4);

function profileSegments(s) {
  const t = s.t ?? T;
  const seg = [];
  const fi = s.footIn ?? Math.max(s.rf - 0.45, 0.3), rc = s.recess ?? 0.3;
  seg.push(['foot', [[0, rc], [fi, rc]]]);
  seg.push(['foot', [[fi, rc], [fi, 0]]]);
  seg.push(['foot', [[fi, 0], [s.rf, 0]]]);
  seg.push(['foot', [[s.rf, 0], [s.rf, s.hf]]]);
  // 外側：点の並びがあればそれを使い、無ければ式（口に向かって素直に開く曲線）で作る
  let outer;
  if (s.outer) outer = s.outer.map(p => p.slice());
  else {
    const R = s.rim / 2;
    outer = [[s.rf, s.hf]];
    for (let i = 1; i <= 90; i++) {
      const q = i / 90;
      outer.push([s.a + (R - s.a) * (1 - Math.pow(1 - q, s.p)), s.hf + (s.h - s.hf) * q]);
    }
  }
  seg.push(['outer', outer]);
  const Rl = outer[outer.length - 1][0], bulge = s.rimBulge ?? 0.8;
  const rim = [];
  for (let i = 0; i < 16; i++) {
    const ang = (Math.PI * i) / 15;
    rim.push([Rl - t / 2 + (t / 2) * Math.cos(ang), s.h + (t / 2) * Math.sin(ang) * bulge]);
  }
  seg.push(['rim', rim]);
  let inner;
  if (s.inner) inner = s.inner.map(p => p.slice());
  else {
    const floorY = floorOf(s);
    inner = outer.slice().reverse().map(([r, y]) => [Math.max(r - t, 0), Math.max(y, floorY)]);
    const r0 = inner[inner.length - 1][0];
    for (let k = 1; k < 12; k++) {
      const q = k / 11;
      inner.push([r0 * (1 - q), floorY - 0.08 * Math.sin((q * Math.PI) / 2)]);
    }
  }
  seg.push(['inner', inner]);
  return seg;
}

// 0〜1 のなめらかなむら（値ノイズ）
function makeNoise(seed) {
  const hash = (x, y) => {
    let n = x * 374761393 + y * 668265263 + seed * 1442695;
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const sm = t => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
}
function fbm(n, x, y, oct) {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { v += amp * n(x * f, y * f); f *= 2; amp /= 2; }
  return v / (1 - Math.pow(0.5, oct));
}

// mode: 'lacquer'（漆：外・内・高台・縁、擦れやすさの地図つき）か 'kintsugi'（金継ぎ：外・内・高台・継ぎ目・欠け）
export function buildVessel(shape, { mode = 'lacquer', texSize = 1024 } = {}) {
  const segs = profileSegments(shape);
  // 断面の長さから v を決める
  let total = 0;
  const prof = segs.map(([kind, pts]) => {
    const out = pts.map(([r, y], i) => {
      if (i) total += Math.hypot(r - pts[i - 1][0], y - pts[i - 1][1]);
      return [r, y, total];
    });
    return [kind, out];
  });
  prof.forEach(([, pts]) => pts.forEach(p => { p[2] /= total; }));

  // 回して頂点を作る
  const NU = 160;
  const pos = [], nor = [], uv = [], idx = [];
  for (const [, pts] of prof) {
    const m = pts.length, base = pos.length / 3;
    const n2 = pts.map((p, i) => {
      const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, m - 1)];
      const dr = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dr, dy) || 1;
      return [dy / L, -dr / L];
    });
    for (let j = 0; j <= NU; j++) {
      const th = (2 * Math.PI * j) / NU, c = Math.cos(th), s = Math.sin(th);
      const F = planAt(shape.plan?.f, th, 1);   // 丸くない器：真上の写真から取った、向きごとの半径の倍率
      pts.forEach(([r, y, v], i) => {
        pos.push(r * F * c, y, r * F * s);
        nor.push(n2[i][0] * c, n2[i][1], n2[i][0] * s);
        uv.push(j / NU, v);
      });
    }
    for (let j = 0; j < NU; j++) {
      for (let i = 0; i < m - 1; i++) {
        const a = base + j * m + i, b = base + (j + 1) * m + i;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }
  // 面の向きを法線にそろえる
  for (let t = 0; t < idx.length; t += 3) {
    const [i0, i1, i2] = [idx[t], idx[t + 1], idx[t + 2]];
    const ax = pos[i1 * 3] - pos[i0 * 3], ay = pos[i1 * 3 + 1] - pos[i0 * 3 + 1], az = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
    const bx = pos[i2 * 3] - pos[i0 * 3], by = pos[i2 * 3 + 1] - pos[i0 * 3 + 1], bz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
    const fx = ay * bz - az * by, fy = az * bx - ax * bz, fz = ax * by - ay * bx;
    if (fx * nor[i0 * 3] + fy * nor[i0 * 3 + 1] + fz * nor[i0 * 3 + 2] < 0) { idx[t + 1] = i2; idx[t + 2] = i1; }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(idx);
  if (shape.plan?.f) {
    // 伸び縮みさせた器は、面の向きを形から計算し直す。一周の始まりと終わりは同じ場所なので、向きをそろえる
    geometry.computeVertexNormals();
    const n = geometry.attributes.normal.array;
    let base = 0;
    for (const [, pts] of prof) {
      const m = pts.length;
      for (let i = 0; i < m; i++) {
        const a = (base + i) * 3, b = (base + NU * m + i) * 3;
        for (let k = 0; k < 3; k++) { const v = (n[a + k] + n[b + k]) / 2; n[a + k] = v; n[b + k] = v; }
      }
      base += (NU + 1) * m;
    }
  }

  // 画像の各行（v）が断面のどこにあたるか
  const S = texSize;
  const rowKind = new Array(S), rowR = new Float32Array(S), rowY = new Float32Array(S);
  const flat = [];
  prof.forEach(([kind, pts]) => pts.forEach(p => flat.push([p[2], p[0], p[1], kind])));
  flat.sort((a, b) => a[0] - b[0]);
  let k = 0;
  for (let row = 0; row < S; row++) {
    const v = (row + 0.5) / S;
    while (k < flat.length - 2 && flat[k + 1][0] < v) k++;
    const a = flat[k], b = flat[k + 1];
    const q = Math.min(1, Math.max(0, (v - a[0]) / ((b[0] - a[0]) || 1)));
    rowR[row] = a[1] + (b[1] - a[1]) * q;
    rowY[row] = a[2] + (b[2] - a[2]) * q;
    rowKind[row] = b[3];
  }

  // 3D上の点を、伸び縮みさせる前の位置に戻すための倍率（タップした位置を断面の上の位置にする）
  const planScale = shape.plan?.f ? th => planAt(shape.plan.f, th, 1) : null;
  if (mode === 'kintsugi') return { geometry, planScale, ...kintsugiMaps(shape, { rowKind, rowR, rowY, S, total }) };

  // 部位：外側0・内側1・高台2・縁3（縁の近くも縁にする）
  const parts = document.createElement('canvas');
  parts.width = 4; parts.height = S;   // 部位は角度によらないので、横は細くてよい
  const pg = parts.getContext('2d');
  const PART = { outer: 0, inner: 1, foot: 2, rim: 3 };
  for (let row = 0; row < S; row++) {
    let id = PART[rowKind[row]];
    if ((rowKind[row] === 'outer' || rowKind[row] === 'inner') && rowY[row] > shape.h - 0.18) id = 3;
    pg.fillStyle = `rgb(${id * 30},0,0)`;
    pg.fillRect(0, row, 4, 1);
  }

  // 質感：ごく弱いむら
  const detail = document.createElement('canvas');
  detail.width = detail.height = 256;
  const dg = detail.getContext('2d');
  const dimg = dg.createImageData(256, 256), dn = makeNoise(21);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const v = Math.round(128 * (1 + (fbm(dn, x / 18, y / 18, 3) - 0.5) * 0.05));
    const o = (y * 256 + x) * 4;
    dimg.data[o] = dimg.data[o + 1] = dimg.data[o + 2] = v; dimg.data[o + 3] = 255;
  }
  dg.putImageData(dimg, 0, 0);

  // 擦れやすさ：縁（唇）、畳付き（置くたび）、高台の角、持つ胴、見込みの底（箸・匙）
  const W = S / 2;
  const wear = document.createElement('canvas');
  wear.width = W; wear.height = S;
  const wg = wear.getContext('2d');
  const wimg = wg.createImageData(W, S);
  const nRim = makeNoise(33), nPatch = makeNoise(31), nSpeck = makeNoise(32);
  const H = shape.h, hf = shape.hf, rf = shape.rf;
  for (let row = 0; row < S; row++) {
    const kind = rowKind[row], Y = rowY[row], Rr = rowR[row];
    for (let x = 0; x < W; x++) {
      const u = x / W, th = u * Math.PI * 2;
      let w = 0;
      if (kind !== 'foot') w = Math.max(w, Math.exp(-Math.max(H - Y, 0) / 0.22) * (0.35 + 0.75 * fbm(nRim, u * 6, 0.5, 3)));
      if (kind === 'foot' && Y < 0.06) w = Math.max(w, 1);
      if (kind === 'foot' && Rr > rf - 0.05) w = Math.max(w, Math.exp(-Y / 0.35) * 0.85);
      if (kind === 'outer') w = Math.max(w, Math.exp(-(((Y - H * 0.55) / (H * 0.2)) ** 2)) * 0.66 * (0.75 + 0.25 * Math.cos(th * 2 + 0.6)));
      if (kind === 'inner' && Y < hf + 0.8) w = Math.max(w, Math.exp(-((Rr / 2.2) ** 2)) * 0.62);
      const patch = fbm(nPatch, u * 9, row / S * 9, 4);
      const speck = fbm(nSpeck, u * 90, row / S * 90, 2);
      w = w * (0.55 + 0.6 * patch) + (w > 0.15 ? (speck - 0.5) * 0.18 : 0);
      const o = (row * W + x) * 4;
      wimg.data[o] = wimg.data[o + 1] = wimg.data[o + 2] = Math.max(0, Math.min(255, Math.round(w * 255)));
      wimg.data[o + 3] = 255;
    }
  }
  wg.putImageData(wimg, 0, 0);

  return { geometry, parts, detail, wear };
}

// ---------- 金継ぎ用：割れ・欠け・継ぎ目の盛り上がり ----------
// 割れは点の並び [回転角θ, 高さy, 半径r]（単位 cm）。器を貫く扱いなので、外側でなぞれば内側にも出る。
// 欠けは口縁の回転角θ。どちらも、器の形を作り直さずに描き直せる（paint）。
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 外形の値（角度 -π から一周を等分した並び。値は各区間の中央）を角度で引く。
// 曲線（Catmull-Rom）でつなぐので、値の間で角ばらない。一周つながる
function planAt(arr, th, dflt) {
  if (!arr) return dflt;
  const n = arr.length, x = ((((th + Math.PI) / (2 * Math.PI)) * n - 0.5) % n + n) % n, i = Math.floor(x), t = x - i;
  const p0 = arr[(i + n - 1) % n], p1 = arr[i], p2 = arr[(i + 1) % n], p3 = arr[(i + 2) % n];
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
}
const wrapPi = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

// 器の外側の、高さ y での半径
export function outerRadiusAt(shape, y) {
  if (shape.outer) {
    const o = shape.outer;
    if (y >= o[o.length - 1][1]) return o[o.length - 1][0];
    if (y <= o[0][1]) return o[0][0];
    for (let i = 1; i < o.length; i++) {
      if (o[i][1] >= y) { const q = (y - o[i - 1][1]) / ((o[i][1] - o[i - 1][1]) || 1); return o[i - 1][0] + (o[i][0] - o[i - 1][0]) * q; }
    }
  }
  const R = shape.rim / 2;
  if (y >= shape.h) return R;
  if (y <= shape.hf) return shape.rf;
  const t = (y - shape.hf) / (shape.h - shape.hf);
  return shape.a + (R - shape.a) * (1 - Math.pow(1 - t, shape.p));
}

// 内側（上の面）の、半径 r での高さ（平皿の真上から見た割れに使う）
function innerHeightAt(shape, r) {
  const inner = profileSegments(shape).find(([k]) => k === 'inner')[1];   // 口縁から中心へ
  if (r >= inner[0][0]) return shape.h;
  for (let i = 1; i < inner.length; i++) {
    const [ra, ya] = inner[i - 1], [rb, yb] = inner[i];
    if ((ra - r) * (rb - r) <= 0) { const q = (r - ra) / ((rb - ra) || 1); return ya + (yb - ya) * q; }
  }
  return inner[inner.length - 1][1];
}

// 見本の割れと欠け。器の設定に sample があればその並び、無ければ茶碗の並びを器の高さと大きさに合わせる。
// 点は [回転角θ, 高さy, 半径r, 貫く向き]。貫く向き 0 = 横（壁の内と外）、1 = 縦（平らな面の上と下）
export function sampleDefects(shape) {
  if (shape.sample || shape.cracks) return designedSample(shape);
  const H = shape.h;
  const floorY = Math.min(shape.hf + 0.5, H - 0.4);
  const yLow = Math.min(H - 0.3, Math.max(floorY + 0.45, shape.hf + 0.3, H * 0.22));
  const rand = mulberry32(7);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
  const line = (t0, y0, y1, drift, n) => {
    const pts = [];
    let vel = 0, acc = 0;
    for (let i = 0; i < n; i++) {
      const q = i / (n - 1), y = y0 + (y1 - y0) * q;
      pts.push([t0 + drift * q + acc, y, outerRadiusAt(shape, y), 0]);
      vel = vel * 0.88 + gauss() * 0.006;
      acc += vel;
    }
    return pts;
  };
  const a = line(0.55, H + 0.3, yLow, 0.45, 70);
  const b = line(3.55, H + 0.3, Math.max(yLow, H * 0.5), -0.35, 70);
  const at = a[26];
  const c = [at, ...line(at[0], at[1], Math.min(at[1] - 0.2, Math.max(yLow, H * 0.38)), 0.75, 40).slice(1)];
  return { cracks: [a, b, c], chips: [2.05] };
}

function designedSample(shape) {
  const H = shape.h;
  const rand = mulberry32(shape.seed ?? 7);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
  const walk = (n, wobble) => {
    const out = []; let vel = 0, acc = 0;
    for (let i = 0; i < n; i++) { out.push(acc); vel = vel * 0.88 + gauss() * wobble; acc += vel; }
    return out;
  };
  const cyl = (t0, y0, y1, drift, n) => {
    const w = walk(n, 0.006);
    return Array.from({ length: n }, (_, i) => {
      const q = i / (n - 1), y = y0 + (y1 - y0) * q;
      return [t0 + drift * q + w[i], y, outerRadiusAt(shape, y), 0];
    });
  };
  // 真上から見た直線を、上の面の点に変える
  const plan = (a, b, n) => {
    const w = walk(n, 0.012);
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    const px = -dz / L, pz = dx / L;
    return Array.from({ length: n }, (_, i) => {
      const q = i / (n - 1), x = a[0] + dx * q + px * w[i], z = a[1] + dz * q + pz * w[i];
      let th = Math.atan2(z, x); if (th < 0) th += 2 * Math.PI;
      const r = Math.min(Math.hypot(x, z), shape.rim / 2);
      return [th, innerHeightAt(shape, r), r, 1];
    });
  };
  const toXZ = p => [p[2] * Math.cos(p[0]), p[2] * Math.sin(p[0])];
  const lines = [];
  for (const c of shape.cracks || []) {
    if (c.type === 'cyl') lines.push(cyl(c.t0, H + 0.3, c.y1, c.drift, c.n));
    else if (c.type === 'branch') { const at = lines[c.of][c.at]; lines.push([at, ...cyl(at[0], at[1], c.y1, c.drift, c.n).slice(1)]); }
    else if (c.type === 'plan') lines.push(plan(c.a, c.b, c.n));
    else if (c.type === 'planbranch') { const at = lines[c.of][c.at]; lines.push([at, ...plan(toXZ(at), c.b, c.n).slice(1)]); }
  }
  return { cracks: lines, chips: (shape.chips || [2.05]).slice() };
}

// 点の貫く向きに応じて、器の厚みの分の差を数えない距離。
// 平らな面（上下に貫く）は、平皿の裏の高台の内側まで届くよう 1cm まで許す
const THRU_V = 1.0;

// ---------- 丸くない器の外形（真上の写真から） ----------
// f：向きごとの半径の倍率（平均が1）、notch：向きごとの欠けの深さ（平均の半径に対する割合）。角度 -π から5°ずつ72個
export const PLAN_N = 72;
export function sanitizePlan(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.f) || !Array.isArray(p.notch)) return null;
  if (p.f.length !== PLAN_N || p.notch.length !== PLAN_N) return null;
  const ok = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (!p.f.every(v => ok(v, 0.4, 1.8)) || !p.notch.every(v => ok(v, 0, 0.6))) return null;
  return { f: p.f.slice(), notch: p.notch.slice() };
}
// 欠けの数（深さが平均の半径の3%を超えるひと続きの所）
export function planChipCount(p) {
  if (!p) return 0;
  const on = p.notch.map(v => v > 0.03);
  if (on.every(Boolean)) return 1;
  let n = 0;
  on.forEach((v, i) => { if (v && !on[(i + PLAN_N - 1) % PLAN_N]) n++; });
  return n;
}
// いちばん長い所と短い所（中心を通る差し渡し）。半径が R のときの cm
export function planSpan(p, R) {
  let L = 0, Wd = Infinity;
  for (let i = 0; i < PLAN_N / 2; i++) {
    const d = (p.f[i] + p.f[i + PLAN_N / 2]) * R;
    L = Math.max(L, d); Wd = Math.min(Wd, d);
  }
  return { length: L, width: Wd };
}

// 欠けの大きさ：0=小・1=中（見本と同じ）・2=大。[幅の倍率, 深さの倍率]
export const CHIP_SCALE = [[0.6, 0.6], [1, 1], [2.4, 2]];
// 古いリンクの欠けは角度だけなので「中」として読む
export const chipOf = c => (Array.isArray(c) ? [c[0], c[1]] : [c, 1]);

// 点と線分の距離。X＝回転方向、Y＝高さ、Z＝半径方向（どれも線分の始点からの差）
//   axis 0（壁）：高さも含めて測り、半径方向は器の厚みの分を数えない
//   axis 1（平らな面）：真上から見た位置（X と Z）だけで測る。高さの差が THRU_V 以内なら上の面も裏の面も同じ扱い
//   （皿の口縁近くは上と裏が斜めにずれるので、高さを測りに入れると裏の割れが点線になる）
function segDist(X, Py, Pz, Xb, Qy, Qz, axis, tol = T * 1.15) {
  if (axis === 1) {
    const L = Xb * Xb + Qz * Qz + 1e-9;
    const k = Math.max(0, Math.min(1, (X * Xb + Pz * Qz) / L));
    if (Math.abs(Py - k * Qy) > THRU_V) return 99;
    return Math.hypot(X - k * Xb, Pz - k * Qz);
  }
  // 線のどこに近いかは、回る向きと高さだけで決める。半径の差（内外）も含めると、内側の面では
  // 近い位置が線の折れ目に引き寄せられ、割れが点線になる。半径の差は、そのあと厚みの分を引いて数える
  const L = Xb * Xb + Qy * Qy + 1e-9;
  const k = Math.max(0, Math.min(1, (X * Xb + Py * Qy) / L));
  return Math.hypot(X - k * Xb, Py - k * Qy, Math.max(0, Math.abs(Pz - k * Qz) - tol));
}

// 割れの長さ（cm）
export function crackLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    const [t0, y0, r0] = pts[i - 1], [t1, y1, r1] = pts[i];
    const rr = Math.max((r0 + r1) / 2, 0.3);
    L += Math.hypot(wrapPi(t1 - t0) * rr, y1 - y0, r1 - r0);
  }
  return L;
}

// 点 (θ, y, r) と割れの線との距離（器の厚みの分の内外の差は数えない＝器を貫く）
export function distToCrack(pts, t, y, r) {
  let best = 99;
  const rr = Math.max(r, 0.3);
  for (let i = 0; i < pts.length - 1; i++) {
    const [ta, ya, ra, ax = 0] = pts[i], [tb, yb, rb] = pts[i + 1];
    const X = wrapPi(t - ta) * rr, Xb = wrapPi(tb - ta) * rr;
    const Py = y - ya, Qy = yb - ya, Pz = r - ra, Qz = rb - ra;
    const d = segDist(X, Py, Pz, Xb, Qy, Qz, ax);
    if (d < best) best = d;
  }
  return best;
}

// 小さな乱数の画像（拡大して描くと、なめらかなむらになる）
function noiseCanvas(seed, n) {
  const c = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d'), img = g.createImageData(n, n), rand = mulberry32(seed);
  for (let i = 0; i < n * n; i++) {
    const v = Math.round(rand() * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function kintsugiMaps(shape, { rowKind, rowR, rowY, S, total }) {
  const W = S;
  const H = shape.h, R = shape.rim / 2;
  const PART = { outer: 0, rim: 0, inner: 1, foot: 2 };

  // ---- 部位の土台（行ごとに決まる）と、平らな凹凸 ----
  const parts = document.createElement('canvas'); parts.width = W; parts.height = S;
  const pctx = parts.getContext('2d', { willReadFrequently: true });
  let run = 0;
  for (let row = 1; row <= S; row++) {
    if (row === S || PART[rowKind[row]] !== PART[rowKind[run]]) {
      // 赤＝部位（継ぎ目・欠けを含む。タップで部位を選ぶのに使う）、緑＝継ぎ目を除いた地の部位（塗るのに使う）
      pctx.fillStyle = `rgb(${PART[rowKind[run]] * 30},${PART[rowKind[run]] * 30},0)`;
      pctx.fillRect(0, run, W, row - run);
      run = row;
    }
  }
  const baseParts = pctx.getImageData(0, 0, W, S);
  const normal = document.createElement('canvas'); normal.width = W; normal.height = S;
  const nctx = normal.getContext('2d', { willReadFrequently: true });
  // 継ぎ目（赤）と欠け（緑）の割合 0〜255。滑らかに混ぜるための画像
  const cover = document.createElement('canvas'); cover.width = W; cover.height = S;
  const cctx = cover.getContext('2d', { willReadFrequently: true });
  const blankCover = cctx.createImageData(W, S);
  for (let i = 3; i < blankCover.data.length; i += 4) blankCover.data[i] = 255;
  nctx.fillStyle = 'rgb(128,128,255)'; nctx.fillRect(0, 0, W, S);
  const baseNormal = nctx.getImageData(0, 0, W, S);

  // ---- 質感（拡大した乱数の画像を重ねて作る。1画素ずつ計算しないので速い） ----
  const detail = document.createElement('canvas'); detail.width = 512; detail.height = 512;
  const dctx = detail.getContext('2d');
  dctx.fillStyle = 'rgb(128,128,128)'; dctx.fillRect(0, 0, 512, 512);
  dctx.imageSmoothingEnabled = true; dctx.imageSmoothingQuality = 'high';
  [[10, 0.07, 1], [20, 0.04, 2], [40, 0.025, 3]].forEach(([n, a, sd]) => { dctx.globalAlpha = a; dctx.drawImage(noiseCanvas(sd, n), 0, 0, 512, 512); });
  // 高台の土はざらつきを強く
  const footRows = [];
  for (let row = 0; row < S; row++) if (rowKind[row] === 'foot') footRows.push(row);
  if (footRows.length) {
    const y0 = (footRows[0] / S) * 512, y1 = ((footRows[footRows.length - 1] + 1) / S) * 512;
    dctx.save(); dctx.beginPath(); dctx.rect(0, y0, 512, y1 - y0); dctx.clip();
    [[64, 0.3, 11], [128, 0.15, 12]].forEach(([n, a, sd]) => { dctx.globalAlpha = a; dctx.drawImage(noiseCanvas(sd, n), 0, 0, 512, 512); });
    dctx.restore();
  }
  // 釉薬は外側の下のほうで溜まって少し濃くなる
  for (let row = 0; row < S; row++) {
    if (rowKind[row] !== 'outer') continue;
    const f = Math.max(0, Math.min(1, (shape.hf + 1.5 - rowY[row]) / 1.5));
    if (f <= 0) continue;
    dctx.globalAlpha = f * 0.22; dctx.fillStyle = '#000';
    dctx.fillRect(0, (row / S) * 512, 512, Math.max(1, 512 / S) + 0.5);
  }
  dctx.globalAlpha = 1;

  // ---- 割れと欠けを描く（描き直しのたびに呼ぶ） ----
  const SEAM_W = 0.055;
  const CH_W = shape.chip?.w ?? Math.min(0.75, R * 0.14), CH_D = shape.chip?.d ?? Math.min(0.55, H * 0.12);
  const wob = (th, y) => 1 + 0.25 * Math.sin(th * 37 + y * 5.1) * Math.sin(y * 13 + th * 3);
  const dist = new Float32Array(W * S);
  const height = new Float32Array(W * S);
  const touched = new Uint8Array(W * S);

  // 横に貫く割れで「器の厚みの分」として数えない半径の差。壁が寝ているほど、同じ高さで見た内と外の差は
  // 厚み÷(壁の傾きの縦の割合) に広がるので、行ごとの傾きから決める（寝すぎた所は厚みの6倍まで）
  const rowTol = new Float32Array(S);
  for (let row = 0; row < S; row++) {
    const a = Math.max(0, row - 2), b = Math.min(S - 1, row + 2);
    const dr = rowR[b] - rowR[a], dy = rowY[b] - rowY[a], L = Math.hypot(dr, dy);
    rowTol[row] = T * 1.15 * (L > 1e-6 ? Math.min(6, L / Math.max(Math.abs(dy), L / 6)) : 1);
  }

  function paint(defs) {
    const pImg = new ImageData(new Uint8ClampedArray(baseParts.data), W, S);
    const nImg = new ImageData(new Uint8ClampedArray(baseNormal.data), W, S);
    const cImg = new ImageData(new Uint8ClampedArray(blankCover.data), W, S);
    const pxV = total / S;
    dist.fill(99); height.fill(0); touched.fill(0);
    const list = [];
    const touch = o => { if (!touched[o]) { touched[o] = 1; list.push(o); } };

    // 割れ：線の近くの画素だけ距離を測る
    for (const pts of defs.cracks || []) {
      for (let i = 0; i < pts.length - 1; i++) {
        const [ta, ya, ra, ax = 0] = pts[i], [tb, yb, rb] = pts[i + 1];
        const lo = Math.min(ya, yb) - 0.35 - (ax === 1 ? THRU_V : 0), hi = Math.max(ya, yb) + 0.35 + (ax === 1 ? THRU_V : 0);
        const dTheta = wrapPi(tb - ta);
        for (let row = 0; row < S; row++) {
          const Y = rowY[row];
          if (Y < lo || Y > hi) continue;
          const Rp = rowR[row], rr = Math.max(Rp, 0.3), tol = ax === 1 ? 0 : rowTol[row];
          if (Math.abs(Rp - ra) > Math.abs(rb - ra) + tol + 0.4 && Math.abs(Rp - rb) > tol + 0.4) continue;
          // 線の点が器の外（半径の外）にはみ出している所は、その器の外側の半径で考える
          const span = 0.4 / rr + Math.abs(dTheta);
          const tMid = ta + dTheta / 2;
          const c0 = Math.floor(((tMid - span) / (2 * Math.PI)) * W), c1 = Math.ceil(((tMid + span) / (2 * Math.PI)) * W);
          const Xb = dTheta * rr, Qy = yb - ya, Qz = rb - ra;
          for (let col = c0; col <= c1; col++) {
            const cc = ((col % W) + W) % W, th = ((cc + 0.5) / W) * 2 * Math.PI;
            const X = wrapPi(th - ta) * rr, Py = Y - ya, Pz = Rp - ra;
            const d = segDist(X, Py, Pz, Xb, Qy, Qz, ax, rowTol[row]);
            const o = row * W + cc;
            if (d < 0.2) { if (d < dist[o]) dist[o] = d; touch(o); }
          }
        }
      }
    }
    // 欠け：口縁の近くの画素。欠けは角度だけ（中）か、[角度, 大きさ 0=小 1=中 2=大]
    for (const c of defs.chips || []) {
      const [ct, size] = chipOf(c);
      const cw = CH_W * CHIP_SCALE[size][0], cd = Math.min(CH_D * CHIP_SCALE[size][1], H * 0.45);
      for (let row = 0; row < S; row++) {
        const Y = rowY[row];
        if (rowKind[row] === 'foot' || Y < H - cd * 1.2) continue;
        const rr = Math.max(rowR[row], 0.3), span = (cw * 1.2) / rr;
        const c0 = Math.floor(((ct - span) / (2 * Math.PI)) * W), c1 = Math.ceil(((ct + span) / (2 * Math.PI)) * W);
        for (let col = c0; col <= c1; col++) {
          const cc = ((col % W) + W) % W, th = ((cc + 0.5) / W) * 2 * Math.PI;
          const cx = wrapPi(th - ct) * rr;
          const edge = cd * (1 - (cx / cw) ** 2) * (1 + 0.18 * Math.sin(cx * 9 / CHIP_SCALE[size][0]));
          // 欠けの縁までの距離から、その画素のうち何割が欠けかを決める（縁を滑らかにする）
          const px = Math.max((2 * Math.PI * rr) / W, pxV);
          const inside = Math.min(cw - Math.abs(cx), Y - (H - edge));
          const cov = Math.max(0, Math.min(1, 0.5 + inside / px));
          if (cov > 0) {
            const o = row * W + cc;
            if (cov >= 0.5) pImg.data[o * 4] = 4 * 30;
            cImg.data[o * 4 + 1] = Math.max(cImg.data[o * 4 + 1], Math.round(cov * 255));
            height[o] = Math.max(height[o], 0.55 * cov);
            touch(o);
          }
        }
      }
    }
    // 真上の写真から取った欠け：外形より内側に入り込んだ所。器の厚み全体が欠けているので、内・外・縁を同じ線で塗る。
    // 欠けの深さは平均の半径に対する割合なので、その向きの倍率で割って断面の上の長さにする
    if (shape.plan?.notch) {
      const R0 = shape.rim / 2, px = Math.max((2 * Math.PI * R0) / W, pxV);
      for (let cc = 0; cc < W; cc++) {
        const th = ((cc + 0.5) / W) * 2 * Math.PI, nd = planAt(shape.plan.notch, th, 0);
        if (nd <= 0.005) continue;
        const edgeAt = t => R0 * (1 - Math.max(0, planAt(shape.plan.notch, t, 0)) / planAt(shape.plan.f, t, 1));
        const edge = edgeAt(th), dt = 0.004;
        // 縁が回転の向きに斜めに走る所は、縁に直角な距離でぼかす（ぎざぎざを防ぐ）
        const slope = (edgeAt(th + dt) - edgeAt(th - dt)) / (2 * dt * Math.max(edge, 0.3));
        const k = Math.sqrt(1 + slope * slope);
        for (let row = 0; row < S; row++) {
          if (rowKind[row] === 'foot') continue;
          const cov = Math.max(0, Math.min(1, 0.5 + (rowR[row] - edge) / (px * k)));
          if (cov > 0) {
            const o = row * W + cc;
            if (cov >= 0.5) pImg.data[o * 4] = 4 * 30;
            cImg.data[o * 4 + 1] = Math.max(cImg.data[o * 4 + 1], Math.round(cov * 255));
            height[o] = Math.max(height[o], 0.55 * cov);
            touch(o);
          }
        }
      }
    }
    // 継ぎ目の部位と盛り上がり
    for (const o of list) {
      if (dist[o] >= 99) continue;
      const row = (o / W) | 0, th = (((o % W) + 0.5) / W) * 2 * Math.PI;
      const w = SEAM_W * wob(th, rowY[row]);
      if (dist[o] < w && pImg.data[o * 4] !== 120) pImg.data[o * 4] = 3 * 30;
      // 継ぎ目の縁までの距離を画素の大きさで割って、その画素のうち何割が継ぎ目かにする
      const px = Math.max((2 * Math.PI * Math.max(rowR[row], 0.3)) / W, pxV) * 0.7;
      const cov = Math.max(0, Math.min(1, 0.5 + (w - dist[o]) / px));
      cImg.data[o * 4] = Math.max(cImg.data[o * 4], Math.round(cov * 255));
      height[o] = Math.max(height[o], Math.pow(Math.max(0, 1 - dist[o] / (w * 1.25)), 0.6));
    }
    // 盛り上がりから凹凸（法線）を作る：変わった画素とそのまわりだけ
    const done = new Uint8Array(W * S);
    for (const o0 of list) {
      const r0 = (o0 / W) | 0, c0 = o0 % W;
      for (const [dr, dc] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const row = r0 + dr; if (row < 0 || row >= S) continue;
        const col = (c0 + dc + W) % W, o = row * W + col;
        if (done[o]) continue; done[o] = 1;
        const pxU = (2 * Math.PI * Math.max(rowR[row], 0.3)) / W;
        const hx = height[row * W + ((col + 1) % W)] - height[row * W + ((col - 1 + W) % W)];
        const hy = height[Math.min(S - 1, row + 1) * W + col] - height[Math.max(0, row - 1) * W + col];
        let nx = (-hx / 2 / pxU) * 0.012, ny = (-hy / 2 / pxV) * 0.012, nz = 1;
        const Ln = Math.hypot(nx, ny, nz); nx /= Ln; ny /= Ln; nz /= Ln;
        nImg.data[o * 4] = (nx * 0.5 + 0.5) * 255; nImg.data[o * 4 + 1] = (ny * 0.5 + 0.5) * 255; nImg.data[o * 4 + 2] = (nz * 0.5 + 0.5) * 255;
      }
    }
    pctx.putImageData(pImg, 0, 0);
    nctx.putImageData(nImg, 0, 0);
    cctx.putImageData(cImg, 0, 0);
  }

  paint(sampleDefects(shape));
  return { parts, detail, normal, cover, wear: null, paint, kintsugi: true };
}

// 写真の上の印（ピクセル座標）から、形の数値を求める
//   L, R: 口の左右の端  T: 口の奥の縁（楕円のいちばん上）
//   F: 高台の下の右の角  F2: 高台の上の右の角  S: 胴の右の輪郭の1点
export function shapeFromMarks(m, rimCm) {
  const cx = (m.L.x + m.R.x) / 2, cy = (m.L.y + m.R.y) / 2;
  const A = Math.hypot(m.R.x - m.L.x, m.R.y - m.L.y) / 2;
  const B = cy - m.T.y;
  if (!(A > 10) || !(B > 0) || B >= A) return { error: '口の印の位置を確かめてください。「口の奥」は左右の端を結ぶ線より上に置きます。' };
  const phi = Math.asin(B / A);
  const s = A / (rimCm / 2);                  // 1cm あたりのピクセル数
  const k = Math.cos(phi) * s;                // 高さ1cmが写真の上で何ピクセルになるか
  const H = (m.F.y - cy) / k;
  const rf = (m.F.x - cx) / s;
  const hf = (m.F.y - m.F2.y) / k;
  if (!(H > 0.5)) return { error: '高台の印は、口より下に置いてください。' };
  if (!(rf > 0.3) || rf >= rimCm / 2) return { error: '「高台の下の角」を、器の右側の高台の角に置いてください。' };
  if (!(hf > 0.05) || hf >= H * 0.5) return { error: '「高台の上の角」を、高台と胴の境目に置いてください。' };
  // 胴の点から開き方 p を求める（付け根の半径 a は高台より少し外）
  const a = Math.min(rf * 1.12, rimCm / 2 * 0.95);
  const yS = H - (m.S.y - cy) / k;            // 胴の点の高さ（輪切りの楕円の横の端は中心の行に写る）
  const rS = (m.S.x - cx) / s;
  const t = (yS - hf) / (H - hf);
  const R = rimCm / 2;
  let p = 2.2;
  if (t > 0.02 && t < 0.98 && rS > a && rS < R) {
    // a + (R - a)(1 - (1 - t)^p) = rS を p について解く
    p = Math.log(1 - (rS - a) / (R - a)) / Math.log(1 - t);
  }
  p = Math.min(6, Math.max(1, p));
  const shape = sanitizeShape({ rim: rimCm, h: H, rf, hf, a, p });
  if (!shape) return { error: '形として成り立たない組み合わせになりました。印の位置を見直してください。' };
  return { shape, phi, cx, cy, s };
}

// 確かめ用：その形を写真と同じ角度から見たときの、左右の輪郭（行ごとの半幅）
export function silhouetteRows(shape, fit) {
  const { phi, cx, cy, s } = fit;
  const rows = new Map();
  const R = shape.rim / 2;
  const radiusAt = y => {
    if (y <= shape.hf) return shape.rf;
    const t = (y - shape.hf) / (shape.h - shape.hf);
    return shape.a + (R - shape.a) * (1 - Math.pow(1 - t, shape.p));
  };
  for (let i = 0; i <= 120; i++) {
    const y = (shape.h * i) / 120, r = radiusAt(y);
    const crow = cy + (shape.h - y) * Math.cos(phi) * s;
    const a = r * s, b = r * Math.sin(phi) * s;
    for (let row = Math.floor(crow - b); row <= Math.ceil(crow + b); row++) {
      const q = (row - crow) / Math.max(b, 1e-6);
      if (Math.abs(q) > 1) continue;
      const half = a * Math.sqrt(1 - q * q);
      rows.set(row, Math.max(rows.get(row) || 0, half));
    }
  }
  return { rows, cx };
}
