// 傘・指輪・トートバッグの3Dを、ブラウザの中で組み立てる（3Dファイルは使わない）。
// 器（vessel.js）と同じく、形と「部位の画像」「質感の画像」を返す。viewer.js はこれをそのまま表示する。
//
// 部位の画像の作り方：画像を縦に12本の帯に分け、部位 i の面は i 番目の帯に UV を割り当てる。
// 帯の中は部位番号×30 の色で塗るので、どの面がどの部位かが画像から分かる（靴の部位の画像と同じ決まり）。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const BANDS = 12, TEX = 1024, MARGIN = 0.06;

// ---------- 組み立ての道具 ----------
// UV を部位の帯に移す（u はそのまま。v を帯の中に縮める）
function toBand(geo, part) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const v = Math.min(1, Math.max(0, uv.getY(i)));
    uv.setXY(i, uv.getX(i), (part + MARGIN + v * (1 - 2 * MARGIN)) / BANDS);
  }
  return geo;
}
// 位置・法線・UV だけの、番号付きの形にそろえる（まとめるときに属性がそろっている必要がある）
function clean(geo) {
  const g = geo.index ? geo : (() => { const n = geo.attributes.position.count; geo.setIndex([...Array(n).keys()]); return geo; })();
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  return g;
}
// (u, v) から点を返す関数で面を作る。flip で表と裏を入れ替える
function surface(fn, nu, nv, part, { flip = false, uScale = 1 } = {}) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const p = fn(i / nu, j / nv);
    pos.push(p[0], p[1], p[2]);
    uv.push((i / nu) * uScale, j / nv);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    if (flip) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return toBand(g, part);
}
// 宝石のように、面ごとに向きの違う（角の立った）形。三角形の並びから作る
function faceted(tris, part) {
  const pos = [], nor = [], uv = [], idx = [];
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3();
  tris.forEach(([a, b, c], t) => {
    A.set(...a); B.set(...b); C.set(...c);
    N.subVectors(C, B).cross(new THREE.Vector3().subVectors(A, B)).normalize();
    for (const P of [A, B, C]) { pos.push(P.x, P.y, P.z); nor.push(N.x, N.y, N.z); }
    uv.push(0.2, 0.2, 0.8, 0.2, 0.5, 0.8);
    idx.push(t * 3, t * 3 + 1, t * 3 + 2);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return toBand(g, part);
}
const ofPart = (geo, part) => toBand(clean(geo), part);
// 面の表を、輪の軸（Z軸）から外向き（out=true）か内向きにそろえる。断面の点の順番で表裏が変わるため、計算で確かめる
function faceRadial(geo, out) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  let s = 0;
  for (let i = 0; i < p.count; i++) s += p.getX(i) * n.getX(i) + p.getY(i) * n.getY(i);
  if ((s > 0) === out) return geo;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  const idx = geo.index;
  for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, a); }
  return geo;
}

// ---------- 部位の画像と質感の画像 ----------
function partsCanvas() {
  const c = document.createElement('canvas'); c.width = 4; c.height = TEX;
  const g = c.getContext('2d');
  for (let i = 0; i < BANDS; i++) {
    g.fillStyle = `rgb(${i * 30},${i * 30},0)`;
    g.fillRect(0, Math.floor((i / BANDS) * TEX), 4, Math.ceil(TEX / BANDS) + 1);
  }
  return c;
}
function rand32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// 部位ごとの質感（灰色128が「変化なし」）。kinds[i] は部位 i の質感の種類
function detailCanvas(kinds) {
  const W = 512, c = document.createElement('canvas'); c.width = W; c.height = TEX;
  const g = c.getContext('2d'), img = g.createImageData(W, TEX), d = img.data, rnd = rand32(7);
  const noise = new Float32Array(W * TEX).map(() => rnd() - 0.5);
  // ぼかした乱数（革のしぼ・槌目のような、なだらかなむら）
  const blur = (src, r) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < TEX; y++) for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) { s += src[y * W + ((x + k + W) % W)]; n++; }
      out[y * W + x] = s / n;
    }
    const out2 = new Float32Array(src.length);
    for (let y = 0; y < TEX; y++) for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) { const yy = y + k; if (yy < 0 || yy >= TEX) continue; s += out[yy * W + x]; n++; }
      out2[y * W + x] = s / n;
    }
    return out2;
  };
  const soft = blur(noise, 3), softer = blur(noise, 7);
  for (let y = 0; y < TEX; y++) {
    const kind = kinds[Math.floor((y / TEX) * BANDS)] || 'smooth';
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = 0;
      if (kind === 'weave') v = ((x >> 1) + (y >> 1)) % 2 ? 0.1 : -0.1;                       // 細かい織り目（傘の生地）
      else if (kind === 'canvas') v = soft[i] * 1.2 + noise[i] * 0.22 + ((x >> 1) % 2 ? 0.03 : -0.03);   // 帆布のむらと粗い糸
      else if (kind === 'grain') v = soft[i] * 2.2 + noise[i] * 0.08;                         // 革・木のむら
      else if (kind === 'wood') v = Math.sin(x * 0.05 + softer[i] * 30) * 0.12 + noise[i] * 0.05;
      else if (kind === 'hammer') v = softer[i] * 5;                                           // 槌目（金属のなだらかなへこみ）
      else if (kind === 'fine') v = noise[i] * 0.06;
      const o = i * 4, val = Math.max(0, Math.min(255, 128 + v * 128));
      d[o] = d[o + 1] = d[o + 2] = val; d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function finish(pieces, kinds) {
  const geometry = mergeGeometries(pieces.map(clean), false);
  pieces.forEach(p => p.dispose());
  return { geometry, parts: partsCanvas(), detail: detailCanvas(kinds), normal: null, wear: null, item: true };
}

// ---------- 長傘 ----------
// 部位：0 生地A（1枚おき）・1 生地B・2 骨と中棒・3 手元・4 石突と露先
function buildUmbrella({ ribs = 12, radius = 50, drop = 20 } = {}) {
  const pieces = [];
  const phiMax = 2 * Math.atan(drop / radius);               // 球の一部として張る
  const Rs = radius / Math.sin(phiMax);
  const rib = (s, th) => { const ph = s * phiMax; return [Rs * Math.sin(ph) * Math.cos(th), Rs * (Math.cos(ph) - 1), Rs * Math.sin(ph) * Math.sin(th)]; };
  const dTh = (2 * Math.PI) / ribs;
  for (let k = 0; k < ribs; k++) {
    const t0 = k * dTh, t1 = (k + 1) * dTh, part = k % 2;
    // 骨と骨の間はまっすぐ張り、縁は骨の間で少し持ち上がる（傘の縁の波）
    const canopy = (u, s, inset) => {
      const a = rib(s, t0), b = rib(s, t1);
      const p = a.map((v, i) => v * (1 - u) + b[i] * u);
      const bow = Math.sin(Math.PI * u);
      p[1] += bow * (radius * 0.035) * s ** 3 - inset;
      const r = Math.hypot(p[0], p[2]) || 1;
      const out = 1 + bow * 0.012 * s;                         // 生地の張りで少しふくらむ
      p[0] *= out; p[2] *= out;
      return p;
    };
    pieces.push(surface((u, s) => canopy(u, s, 0), 10, 24, part, { flip: true }));
    pieces.push(surface((u, s) => canopy(u, s, 0.35), 10, 24, part));   // 内側の面
    // 骨（生地の下に沿わせる）
    const pts = [];
    for (let i = 0; i <= 24; i++) { const p = rib(i / 24, t0); pts.push(new THREE.Vector3(p[0] * 0.995, p[1] - 0.7, p[2] * 0.995)); }
    pieces.push(ofPart(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.28, 6, false), 2));
    // 受け骨（中棒の下はじきから骨の中ほどへ）
    const mid = rib(0.45, t0);
    const st = new THREE.CatmullRomCurve3([new THREE.Vector3(0, -radius * 0.42, 0), new THREE.Vector3(mid[0] * 0.98, mid[1] - 0.8, mid[2] * 0.98)]);
    pieces.push(ofPart(new THREE.TubeGeometry(st, 4, 0.2, 6, false), 2));
    // 露先（骨の先の玉）
    const tip = rib(1, t0);
    pieces.push(ofPart(new THREE.SphereGeometry(0.7, 10, 8).translate(tip[0], tip[1] - 0.5, tip[2]), 4));
  }
  const L = radius * 1.7;                                        // 中棒の長さ
  pieces.push(ofPart(new THREE.CylinderGeometry(0.55, 0.55, L, 12).translate(0, -L / 2 + 1, 0), 2));
  pieces.push(ofPart(new THREE.CylinderGeometry(1.4, 1.4, 3, 16).translate(0, -radius * 0.42, 0), 2)); // 下はじき
  // 石突（てっぺん）
  pieces.push(ofPart(new THREE.CylinderGeometry(0.25, 0.9, 7, 12).translate(0, 4.5, 0), 4));
  pieces.push(ofPart(new THREE.SphereGeometry(1.4, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.6, 0), 4));
  // 手元（まっすぐな握りと、J字の曲がり）
  const y0 = -L + 1;
  pieces.push(ofPart(new THREE.CylinderGeometry(1.5, 1.6, 12, 20).translate(0, y0 - 5, 0), 3));
  const hook = new THREE.TorusGeometry(5.2, 1.5, 14, 28, Math.PI).rotateZ(Math.PI).translate(5.2, y0 - 11, 0);
  pieces.push(ofPart(hook, 3));
  pieces.push(ofPart(new THREE.SphereGeometry(1.5, 16, 12).translate(10.4, y0 - 11, 0), 3));
  return finish(pieces, ['weave', 'weave', 'fine', 'wood', 'fine']);
}

// ---------- 指輪 ----------
// 部位：0 地金（外側）・1 内側・2 石・3 爪と石座
// 向き：輪は XY 平面に立て、穴は Z 方向。石は上（+Y）
function brilliant(rg, cx, cy, cz, part) {
  // ラウンドブリリアントを簡単にした形（テーブル・クラウン・ガードル・パビリオン）
  const n = 16, tris = [];
  const ht = rg * 0.32, rt = rg * 0.55, hp = rg * 0.86;
  const P = (r, a, y) => [cx + r * Math.cos(a), cy + y, cz + r * Math.sin(a)];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
    tris.push([P(0, 0, ht), P(rt, a0, ht), P(rt, a1, ht)].reverse());          // テーブル
    tris.push([P(rt, a0, ht), P(rg, a0, 0), P(rg, am, ht * 0.25)].reverse());  // クラウン
    tris.push([P(rt, a0, ht), P(rg, am, ht * 0.25), P(rt, a1, ht)].reverse());
    tris.push([P(rt, a1, ht), P(rg, am, ht * 0.25), P(rg, a1, 0)].reverse());
    tris.push([P(rg, a0, 0), P(rg, a1, 0), P(0, 0, -hp)].reverse());           // パビリオン
  }
  return faceted(tris, part);
}
function buildRing({ style = 'solitaire', inner = 8.6, width = 2.4, thick = 1.6, stone = 2.6 } = {}) {
  const pieces = [];
  // 甲丸（外は丸く、内はほぼ平ら）の断面を、Y軸のまわりに回してから立てる
  const outerProf = [], innerProf = [], m = 18;
  for (let i = 0; i <= m; i++) {
    const t = Math.PI * (i / m - 0.5);                       // -90°〜90°
    outerProf.push(new THREE.Vector2(inner + 0.15 + thick * Math.cos(t) * 0.92, (width / 2) * Math.sin(t)));
  }
  for (let i = 0; i <= 8; i++) {
    const z = width / 2 - (width * i) / 8;
    innerProf.push(new THREE.Vector2(inner + 0.15 * (Math.abs(z) / (width / 2)) ** 4, z));   // 縁だけ少し丸める
  }
  const lathe = (prof, part, out) => ofPart(faceRadial(new THREE.LatheGeometry(prof, 96).rotateX(Math.PI / 2), out), part);
  pieces.push(lathe(outerProf, 0, true));     // 外側は軸から外向き
  pieces.push(lathe(innerProf, 1, false));    // 内側は軸へ向く（指に触れる面）
  const top = inner + 0.15 + thick * 0.92;                   // 地金のいちばん外側
  const setStone = (rg, angle, withProngs) => {
    // angle：石を置く位置（輪の上が 90°）。石は輪の外向きに立てる
    const a = (angle * Math.PI) / 180, R = top + rg * 0.55;
    const cx = R * Math.cos(a), cy = R * Math.sin(a);
    const g = brilliant(rg, 0, 0, 0, 2);
    // 石の上（+Y）を輪の外向きにそろえる
    g.applyMatrix4(new THREE.Matrix4().makeRotationZ(a - Math.PI / 2)).translate(cx, cy, 0);
    pieces.push(g);
    if (!withProngs) return;
    // 石座（石の下の輪）と4本の爪
    const seat = new THREE.TorusGeometry(rg * 0.78, rg * 0.12, 8, 24).rotateX(Math.PI / 2).translate(0, -rg * 0.35, 0);
    seat.applyMatrix4(new THREE.Matrix4().makeRotationZ(a - Math.PI / 2)).translate(cx, cy, 0);
    pieces.push(ofPart(seat, 3));
    for (let k = 0; k < 4; k++) {
      const b = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(Math.cos(b) * rg * 0.5, -rg * 1.25, Math.sin(b) * rg * 0.5),
        new THREE.Vector3(Math.cos(b) * rg * 0.95, -rg * 0.2, Math.sin(b) * rg * 0.95),
        new THREE.Vector3(Math.cos(b) * rg * 1.02, rg * 0.18, Math.sin(b) * rg * 1.02),
        new THREE.Vector3(Math.cos(b) * rg * 0.88, rg * 0.36, Math.sin(b) * rg * 0.88),
      ]);
      const prong = new THREE.TubeGeometry(curve, 10, rg * 0.11, 6, false);
      prong.applyMatrix4(new THREE.Matrix4().makeRotationZ(a - Math.PI / 2)).translate(cx, cy, 0);
      pieces.push(ofPart(prong, 3));
      pieces.push(ofPart(new THREE.SphereGeometry(rg * 0.11, 8, 6).translate(Math.cos(b) * rg * 0.88, rg * 0.36, Math.sin(b) * rg * 0.88)
        .applyMatrix4(new THREE.Matrix4().makeRotationZ(a - Math.PI / 2)).translate(cx, cy, 0), 3));
    }
  };
  if (style === 'solitaire') setStone(stone, 90, true);
  else if (style === 'trilogy') { setStone(stone * 0.9, 90, true); setStone(stone * 0.6, 90 - 17, true); setStone(stone * 0.6, 90 + 17, true); }
  else if (style === 'eternity') {
    // 半周に小さな石を並べ、両側を地金の細い縁で留める
    const n = 11, rg = 0.95;
    for (let i = 0; i < n; i++) {
      const ang = 90 + (i - (n - 1) / 2) * 9.5, a = (ang * Math.PI) / 180;
      const R = top - rg * 0.15, cx = R * Math.cos(a), cy = R * Math.sin(a);
      const g = brilliant(rg, 0, 0, 0, 2);
      g.applyMatrix4(new THREE.Matrix4().makeRotationZ(a - Math.PI / 2)).translate(cx, cy, 0);
      pieces.push(g);
    }
    for (const z of [-1, 1]) {
      const rail = new THREE.TorusGeometry(top - 0.1, 0.22, 8, 64, (110 * Math.PI) / 180).rotateZ((35 * Math.PI) / 180).translate(0, 0, z * rg * 1.05);
      pieces.push(ofPart(rail, 3));
    }
  }
  return finish(pieces, ['hammer', 'hammer', 'smooth', 'fine']);
}

// ---------- トートバッグ ----------
// 部位：0 本体・1 底布・2 持ち手・3 ポケット・4 内布・5 口の縁
function buildTote({ w = 36, h = 38, d = 12, band = 9, pocket = true } = {}) {
  const pieces = [];
  const bulge = (u, v) => Math.sin(Math.PI * u) * Math.sin(Math.PI * Math.min(1, v * 1.15)) * 0.9;
  const rim = 2.2;                                           // 口の縁（別布）の幅
  // 前後の面（z>0 が前）。y の範囲ごとに部位を分ける。
  // surface() は u・v の順に並べると (v方向)×(u方向) の向きが表になるので、外を向くように flip で合わせる
  const face = (sign, y0, y1, part, inset, flip) => surface((u, v) => {
    const x = (u - 0.5) * w, y = y0 + (y1 - y0) * v;
    const z = sign * (d / 2 + bulge(u, y / h) - inset);
    return [x, y, z];
  }, 24, Math.max(4, Math.round((y1 - y0) / 1.5)), part, { flip: sign > 0 ? !flip : flip, uScale: w / 12 });
  const side = (sign, y0, y1, part, inset, flip) => surface((u, v) => {
    const z = (u - 0.5) * (d + 0.2), y = y0 + (y1 - y0) * v;
    const pinch = Math.sin(Math.PI * Math.min(1, y / h)) * 0.6;   // 横の面は少し内へくぼむ
    return [sign * (w / 2 - pinch - inset), y, z];
  }, 8, Math.max(4, Math.round((y1 - y0) / 1.5)), part, { flip: sign > 0 ? flip : !flip, uScale: d / 12 });
  for (const s of [1, -1]) {
    pieces.push(face(s, 0, band, 1, 0, false), face(s, band, h - rim, 0, 0, false), face(s, h - rim, h, 5, 0, false));
    pieces.push(face(s, 0.4, h, 4, 0.35, true));
    pieces.push(side(s, 0, band, 1, 0, false), side(s, band, h - rim, 0, 0, false), side(s, h - rim, h, 5, 0, false));
    pieces.push(side(s, 0.4, h, 4, 0.35, true));
  }
  // 底（外は底布、内は内布）
  pieces.push(surface((u, v) => [(u - 0.5) * w, 0, (v - 0.5) * d], 12, 4, 1, { flip: true, uScale: w / 12 }));
  pieces.push(surface((u, v) => [(u - 0.5) * (w - 0.7), 0.4, (v - 0.5) * (d - 0.7)], 12, 4, 4, { uScale: w / 12 }));
  // 口の縁の上面（外と内をつなぐ細い帯）
  const ring = (u, inset) => {
    const per = 2 * (w + d), s = u * per;
    if (s < w) return [s - w / 2, d / 2 - inset];
    if (s < w + d) return [w / 2 - inset, d / 2 - (s - w)];
    if (s < 2 * w + d) return [w / 2 - (s - w - d), -d / 2 + inset];
    return [-w / 2 + inset, -d / 2 + (s - 2 * w - d)];
  };
  pieces.push(surface((u, v) => { const [x, z] = ring(u, v * 0.35); return [x, h, z]; }, 96, 1, 5, { uScale: 8 }));
  // ポケット（前の面に重ねる）
  if (pocket) {
    const px = [0.24, 0.76], py = [band + 3, band + 3 + h * 0.36];
    pieces.push(surface((u, v) => {
      const uu = px[0] + (px[1] - px[0]) * u, y = py[0] + (py[1] - py[0]) * v;
      return [(uu - 0.5) * w, y, d / 2 + bulge(uu, y / h) + 0.28];
    }, 12, 8, 3, { flip: true, uScale: 2 }));
  }
  // 持ち手（前と後ろに1本ずつ。平たいテープ）
  for (const s of [1, -1]) {
    const z0 = s * (d / 2 + 0.55), x0 = w * 0.22;
    const ah = Math.min(19, h * 0.5);                         // 持ち手の立ち上がりは本体の高さに合わせる
    const pts = [[-x0, h - 7], [-x0, h], [-x0 * 0.85, h + ah * 0.68], [0, h + ah], [x0 * 0.85, h + ah * 0.68], [x0, h], [x0, h - 7]]
      .map(([x, y]) => new THREE.Vector3(x, y, z0));
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 1.05, 12, false);
    const p = tube.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, z0 + (p.getZ(i) - z0) * 0.28);   // 平たいテープにつぶす
    tube.computeVertexNormals();
    pieces.push(ofPart(tube, 2));
  }
  return finish(pieces, ['canvas', 'canvas', 'grain', 'canvas', 'fine', 'canvas']);
}

const BUILDERS = { umbrella: buildUmbrella, ring: buildRing, tote: buildTote };
export function buildItem(kind, opts = {}) {
  const fn = BUILDERS[kind];
  if (!fn) throw new Error('unknown item: ' + kind);
  return fn(opts);
}
