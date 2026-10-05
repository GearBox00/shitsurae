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

function profileSegments(s) {
  const R = s.rim / 2;
  const seg = [];
  const fi = Math.max(s.rf - 0.45, 0.3);
  seg.push(['foot', [[0, 0.3], [fi, 0.3]]]);
  seg.push(['foot', [[fi, 0.3], [fi, 0]]]);
  seg.push(['foot', [[fi, 0], [s.rf, 0]]]);
  seg.push(['foot', [[s.rf, 0], [s.rf, s.hf]]]);
  const outer = [[s.rf, s.hf]];
  for (let i = 1; i <= 90; i++) {
    const t = i / 90;
    outer.push([s.a + (R - s.a) * (1 - Math.pow(1 - t, s.p)), s.hf + (s.h - s.hf) * t]);
  }
  seg.push(['outer', outer]);
  const rim = [];
  for (let i = 0; i < 16; i++) {
    const ang = (Math.PI * i) / 15;
    rim.push([R - T / 2 + (T / 2) * Math.cos(ang), s.h + (T / 2) * Math.sin(ang) * 0.8]);
  }
  seg.push(['rim', rim]);
  const floorY = Math.min(s.hf + 0.5, s.h - 0.4);
  const inner = outer.slice().reverse().map(([r, y]) => [Math.max(r - T, 0), Math.max(y, floorY)]);
  const r0 = inner[inner.length - 1][0];
  for (let k = 1; k < 12; k++) {
    const q = k / 11;
    inner.push([r0 * (1 - q), floorY - 0.08 * Math.sin((q * Math.PI) / 2)]);
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

export function buildVessel(shape, texSize = 1024) {
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
      pts.forEach(([r, y, v], i) => {
        pos.push(r * c, y, r * s);
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
