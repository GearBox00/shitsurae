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

  if (mode === 'kintsugi') return { geometry, ...kintsugiMaps(shape, { rowKind, rowR, rowY, S, total }) };

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
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 割れの線：口縁から下へ、なめらかに蛇行する（揺れの「速さ」をゆっくり変える）
function crackLine(rand, t0, y0, y1, drift, n) {
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
  const pts = [];
  let vel = 0, acc = 0;
  for (let i = 0; i < n; i++) {
    const q = i / (n - 1);
    pts.push([t0 + drift * q + acc, y0 + (y1 - y0) * q]);
    vel = vel * 0.88 + gauss() * 0.006;
    acc += vel;
  }
  return pts;
}

function kintsugiMaps(shape, { rowKind, rowR, rowY, S, total }) {
  const W = S;   // 横（回転角）も細かく持つ（割れは角度で変わるため）
  const H = shape.h, R = shape.rim / 2;
  const floorY = Math.min(shape.hf + 0.5, H - 0.4);
  const yLow = Math.min(H - 0.3, Math.max(floorY + 0.45, shape.hf + 0.3, H * 0.22));
  const rand = mulberry32(7);
  // 茶碗の見本と同じ並び：長い割れ・反対側の短い割れ・枝分かれ（高さは器に合わせる）
  const a = crackLine(rand, 0.55, H + 0.3, yLow, 0.45, 70);
  const b = crackLine(rand, 3.55, H + 0.3, Math.max(yLow, H * 0.5), -0.35, 70);
  const at = a[26];
  const c = [at, ...crackLine(rand, at[0], at[1], Math.min(at[1] - 0.2, Math.max(yLow, H * 0.38)), 0.75, 40).slice(1)];
  const lines = [a, b, c];

  const SEAM_W = 0.055;
  const dist = new Float32Array(W * S).fill(99);
  const wob = (th, y) => 1 + 0.25 * Math.sin(th * 37 + y * 5.1) * Math.sin(y * 13 + th * 3);
  for (const pts of lines) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [t0, y0] = pts[i], [t1, y1] = pts[i + 1];
      const lo = Math.min(y0, y1) - 0.3, hi = Math.max(y0, y1) + 0.3;
      for (let row = 0; row < S; row++) {
        const Y = rowY[row];
        if (Y < lo || Y > hi) continue;
        const rr = Math.max(rowR[row], 0.3);
        const span = 0.35 / rr + Math.abs(t1 - t0);          // 調べる角度の幅（線の近くだけ）
        const c0 = Math.floor(((t0 - span) / (2 * Math.PI)) * W), c1 = Math.ceil(((t0 + span) / (2 * Math.PI)) * W);
        const db = ((t1 - t0 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        const qx = db * rr, qy = y1 - y0, L = qx * qx + qy * qy + 1e-9;
        for (let col = c0; col <= c1; col++) {
          const cc = ((col % W) + W) % W;
          const th = ((cc + 0.5) / W) * 2 * Math.PI;
          const da = ((th - t0 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
          const px = da * rr, py = Y - y0;
          const k = Math.max(0, Math.min(1, (px * qx + py * qy) / L));
          const d = Math.hypot(px - k * qx, py - k * qy);
          const o = row * W + cc;
          if (d < dist[o]) dist[o] = d;
        }
      }
    }
  }

  // 部位・質感・凹凸を1画素ずつ決める
  const parts = document.createElement('canvas'); parts.width = W; parts.height = S;
  const detail = document.createElement('canvas'); detail.width = W; detail.height = S;
  const pImg = parts.getContext('2d').createImageData(W, S);
  const dImg = detail.getContext('2d').createImageData(W, S);
  const height = new Float32Array(W * S);
  const nGlaze = makeNoise(1), nClay = makeNoise(2), nGold = makeNoise(3);
  const CH_T = 2.05, CH_W = Math.min(0.75, R * 0.14), CH_D = Math.min(0.55, H * 0.12);
  const PART = { outer: 0, rim: 0, inner: 1, foot: 2 };
  for (let row = 0; row < S; row++) {
    const kind = rowKind[row], Y = rowY[row], rr = Math.max(rowR[row], 0.3);
    for (let col = 0; col < W; col++) {
      const o = row * W + col, th = ((col + 0.5) / W) * 2 * Math.PI;
      let part = PART[kind];
      const w = SEAM_W * wob(th, Y);
      if (dist[o] < w) part = 3;
      const da = ((th - CH_T + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      const cx = da * rr;
      const edge = CH_D * (1 - (cx / CH_W) ** 2) * (1 + 0.18 * Math.sin(cx * 9));
      const chip = kind !== 'foot' && Math.abs(cx) < CH_W && Y > H - edge;
      if (chip) part = 4;
      pImg.data[o * 4] = part * 30; pImg.data[o * 4 + 3] = 255;
      // 質感：釉薬は下のほうで溜まって少し濃く、高台の土はざらつき、金はわずかなむら
      let dv = 1;
      const u = col / W, v = row / S;
      if (part <= 1) dv += (fbm(nGlaze, u * 10, v * 10, 4) - 0.5) * 0.14 - (kind === 'outer' ? Math.max(0, Math.min(1, (shape.hf + 1.5 - Y) / 1.5)) * 0.22 : 0);
      else if (part === 2) dv += (fbm(nClay, u * 60, v * 60, 3) - 0.5) * 0.5;
      else dv += (fbm(nGold, u * 120, v * 120, 2) - 0.5) * 0.12;
      const dvb = Math.max(0, Math.min(255, Math.round(dv * 128)));
      dImg.data[o * 4] = dImg.data[o * 4 + 1] = dImg.data[o * 4 + 2] = dvb; dImg.data[o * 4 + 3] = 255;
      // 盛り上がり：継ぎ目は細い尾根、欠けの埋めは平らに少し高い
      let h = Math.pow(Math.max(0, 1 - dist[o] / (w * 1.25)), 0.6);
      if (chip) h = Math.max(h, 0.55);
      height[o] = h;
    }
  }
  parts.getContext('2d').putImageData(pImg, 0, 0);
  detail.getContext('2d').putImageData(dImg, 0, 0);

  // 盛り上がりから凹凸の画像（法線）を作る
  const normal = document.createElement('canvas'); normal.width = W; normal.height = S;
  const nImg = normal.getContext('2d').createImageData(W, S);
  const pxV = total / S;
  for (let row = 0; row < S; row++) {
    const pxU = (2 * Math.PI * Math.max(rowR[row], 0.3)) / W;
    for (let col = 0; col < W; col++) {
      const o = row * W + col;
      const hx = height[row * W + ((col + 1) % W)] - height[row * W + ((col - 1 + W) % W)];
      const hy = height[Math.min(S - 1, row + 1) * W + col] - height[Math.max(0, row - 1) * W + col];
      let nx = (-hx / 2 / pxU) * 0.012, ny = (-hy / 2 / pxV) * 0.012, nz = 1;
      const L = Math.hypot(nx, ny, nz); nx /= L; ny /= L; nz /= L;
      nImg.data[o * 4] = (nx * 0.5 + 0.5) * 255; nImg.data[o * 4 + 1] = (ny * 0.5 + 0.5) * 255;
      nImg.data[o * 4 + 2] = (nz * 0.5 + 0.5) * 255; nImg.data[o * 4 + 3] = 255;
    }
  }
  normal.getContext('2d').putImageData(nImg, 0, 0);
  return { parts, detail, normal, wear: null };
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
