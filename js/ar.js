// AR で部屋に置いて見る。いま画面で選んでいる配色の3Dを、その場で glb に書き出し、model-viewer で表示する。
// 画面の3Dは部位ごとの色を描く瞬間に塗る特別な描き方なので、書き出す前に色・つや・金属らしさを画像に焼き付ける。
// 書き出したファイルはこの端末の中だけで使い、どこにも送信しない。
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const MV_URL = 'https://cdn.jsdelivr.net/npm/@google/model-viewer@4.0.0/dist/model-viewer.min.js';
const MV_SRI = 'sha384-sr9b4Ux0WhAUGclJ0ym0FSY2zSOMmNSn0bP/SA0e6bNCrpn/5W3QL8mm+LdlQMKw';
const BAKE = 2048;

// ---------- 焼き付け ----------
// 形を UV の位置に広げて描き（gl_Position = UV）、画面の3Dと同じ式で色を求める
const BAKE_VS = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0); }`;
function bakeFS(MAX, pass) {
  return `
precision highp float;
varying vec2 vUv;
uniform sampler2D uParts; uniform sampler2D uDetail; uniform float uScale;
uniform vec3 uColors[${MAX}]; uniform float uRough[${MAX}]; uniform float uDetailAmt[${MAX}]; uniform float uMetal[${MAX}];
uniform vec3 uUnder[${MAX}]; uniform vec3 uAged[${MAX}];
uniform sampler2D uWearMap; uniform float uWearOn; uniform float uAge;
uniform sampler2D uCover; uniform float uCoverOn;
vec3 partTop(int i) { return mix(uColors[i], uAged[i], uAge * uWearOn); }
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec4 pv = texture2D(uParts, vUv);
  int ip = clamp(int(floor(pv.r * 255.0 / uScale + 0.5)), 0, ${MAX - 1});
  float seamC = 0.0, chipC = 0.0;
  if (uCoverOn > 0.5) {
    ip = clamp(int(floor(pv.g * 255.0 / uScale + 0.5)), 0, ${MAX - 1});
    vec4 cv = texture2D(uCover, vUv);
    seamC = cv.r; chipC = cv.g;
  }
  float dAmt = mix(mix(uDetailAmt[ip], uDetailAmt[3], seamC), uDetailAmt[4], chipC);
  float pr = mix(mix(uRough[ip], uRough[3], seamC), uRough[4], chipC);
  float pm = mix(mix(uMetal[ip], uMetal[3], seamC), uMetal[4], chipC);
  float dt = mix(1.0, texture2D(uDetail, vUv).r * 2.0, dAmt);
  float wv = texture2D(uWearMap, vUv).r;
  float th = 1.03 - uAge * 0.62;
  float worn = uWearOn * smoothstep(th, th + 0.07, wv);
  vec3 topCol = mix(mix(partTop(ip), partTop(3), seamC), partTop(4), chipC);
  vec3 col = clamp(mix(topCol, uUnder[ip], worn) * dt, 0.0, 1.0);
  float rough = clamp(pr, 0.05, 1.0) * mix(1.0, 0.55, uAge * uWearOn);
  rough = mix(rough, 0.55, worn);
  ${pass === 'color'
    ? 'gl_FragColor = vec4(toSRGB(col), 1.0);'
    : 'gl_FragColor = vec4(1.0, rough, pm, 1.0);   // glTF の決まり：G＝ざらつき、B＝金属らしさ'}
}`;
}

// 描かれなかった所（UV の島のすき間）を、隣の色で数画素ぶん埋める（縁に黒い線が出ないように）
function dilate(data, W, H, times) {
  for (let t = 0; t < times; t++) {
    const src = new Uint8ClampedArray(data);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (src[i + 3]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = (ny * W + nx) * 4;
        if (!src[j + 3]) continue;
        data[i] = src[j]; data[i + 1] = src[j + 1]; data[i + 2] = src[j + 2]; data[i + 3] = 255;
        break;
      }
    }
  }
}

function bakePass(viewer, pass) {
  const r = viewer.renderer, MAX = viewer.uniforms.uColors.value.length;
  const rt = new THREE.WebGLRenderTarget(BAKE, BAKE, { type: THREE.UnsignedByteType });
  const mat = new THREE.ShaderMaterial({ vertexShader: BAKE_VS, fragmentShader: bakeFS(MAX, pass), uniforms: viewer.uniforms, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(viewer.mesh.geometry, mat);
  const scene = new THREE.Scene(); scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const prevRT = r.getRenderTarget(), prevClear = r.getClearAlpha(), prevColor = r.getClearColor(new THREE.Color());
  r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear(); r.render(scene, cam);
  const px = new Uint8Array(BAKE * BAKE * 4);
  r.readRenderTargetPixels(rt, 0, 0, BAKE, BAKE, px);
  r.setRenderTarget(prevRT); r.setClearColor(prevColor, prevClear);
  rt.dispose(); mat.dispose();
  const data = new Uint8ClampedArray(px.buffer);
  dilate(data, BAKE, BAKE, 6);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  // 読み出した画素は下の行から並ぶ。キャンバスの1行目＝UV の v=0 になるので、flipY なしでそのまま貼れる
  const c = document.createElement('canvas'); c.width = c.height = BAKE;
  c.getContext('2d').putImageData(new ImageData(data, BAKE, BAKE), 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.colorSpace = pass === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.userData.mimeType = 'image/jpeg';
  return tex;
}

// ---------- 書き出す形を組み立てる ----------
// 画面の3Dは大きさをそろえて表示しているので、商品の arScale（元の形の1単位が何メートルか）で実物大に戻す
function buildExportScene(viewer, product) {
  const scene = new THREE.Scene();
  const group = new THREE.Group(); scene.add(group);
  const mw = viewer.mesh.matrixWorld;
  const worldScale = Math.hypot(mw.elements[0], mw.elements[1], mw.elements[2]);
  const k = (product.arScale || 0.01) / worldScale;     // 画面の座標 → メートル
  const toMeters = g => { g.applyMatrix4(new THREE.Matrix4().makeScale(k, k, k)); return g; };

  // 本体（透明な石の部位は除く）
  let geo = viewer.mesh.geometry.clone().applyMatrix4(mw);
  const gemPart = viewer.uniforms.uGemPart?.value ?? -1;
  if (gemPart >= 0 && geo.index) {
    const idx = geo.index.array, uv = geo.attributes.uv, keep = [], U = new THREE.Vector2();
    for (let i = 0; i < idx.length; i += 3) {
      U.set(0, 0);
      for (let j = 0; j < 3; j++) { U.x += uv.getX(idx[i + j]) / 3; U.y += uv.getY(idx[i + j]) / 3; }
      if (viewer.partAtUv(U) !== gemPart) keep.push(idx[i], idx[i + 1], idx[i + 2]);
    }
    geo.setIndex(keep);
  }
  geo = toMeters(geo);
  const body = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: bakePass(viewer, 'color'), roughnessMap: null, metalnessMap: null, roughness: 1, metalness: 1,
  }));
  const mr = bakePass(viewer, 'mr');
  body.material.roughnessMap = mr; body.material.metalnessMap = mr;
  if (viewer.mesh.material.normalMap) { body.material.normalMap = viewer.mesh.material.normalMap; body.material.normalScale.copy(viewer.mesh.material.normalScale); }
  body.material.side = THREE.DoubleSide;
  group.add(body);

  // 透明な石
  if (viewer.gemMesh) {
    const gm = viewer.gemMesh.material;
    const g = toMeters(viewer.gemMesh.geometry.clone().applyMatrix4(viewer.gemMesh.matrixWorld));
    group.add(new THREE.Mesh(g, new THREE.MeshPhysicalMaterial({
      color: gm.attenuationColor.clone().lerp(new THREE.Color(1, 1, 1), 0.25), roughness: 0.02, metalness: 0,
      transmission: 1, ior: gm.ior, thickness: 0.002, transparent: true, opacity: 0.85,
    })));
  }
  // 文字（刺しゅう・刻印・銘）
  if (viewer.decal) {
    const dm = viewer.decal.material;
    const g = toMeters(viewer.decal.geometry.clone().applyMatrix4(viewer.decal.matrixWorld));
    const t = dm.map; t.userData.mimeType = 'image/png';
    group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: dm.roughness, metalness: dm.metalness, alphaTest: 0.05 })));
  }
  // 床に置けるよう、いちばん下を高さ0に、真ん中を原点にする
  const box = new THREE.Box3().setFromObject(group);
  const c = box.getCenter(new THREE.Vector3());
  group.position.set(-c.x, -box.min.y, -c.z);
  return scene;
}

export async function exportGlb(viewer, product) {
  const scene = buildExportScene(viewer, product);
  const glb = await new GLTFExporter().parseAsync(scene, { binary: true, maxTextureSize: BAKE });
  scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); } });
  return new Blob([glb], { type: 'model/gltf-binary' });
}

// ---------- 表示 ----------
let mvLoaded = null;
function loadModelViewer() {
  if (customElements.get('model-viewer')) return Promise.resolve();
  mvLoaded ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.type = 'module'; s.src = MV_URL; s.integrity = MV_SRI; s.crossOrigin = 'anonymous';
    s.onload = () => customElements.whenDefined('model-viewer').then(resolve);
    s.onerror = () => { mvLoaded = null; reject(new Error('model-viewer')); };
    document.head.appendChild(s);
  });
  return mvLoaded;
}

let lastUrl = null;
export async function openAR(viewer, product, { onError } = {}) {
  const dlg = document.getElementById('arDlg'), stage = document.getElementById('arStage');
  const status = document.getElementById('arStatus');
  dlg.showModal();
  stage.innerHTML = '';
  status.textContent = 'ARのファイルを作っています（数秒かかります）';
  document.body.dataset.arReady = '';
  try {
    const [blob] = await Promise.all([exportGlb(viewer, product), loadModelViewer()]);
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    const mv = document.createElement('model-viewer');
    mv.setAttribute('src', lastUrl);
    mv.setAttribute('alt', `${product.name}の3D`);
    mv.setAttribute('ar', '');
    // scene-viewer（Android の別アプリ）は公開された URL しか読めないため、ブラウザの中の webxr と iPhone の quick-look を使う
    mv.setAttribute('ar-modes', 'webxr quick-look');
    mv.setAttribute('ar-scale', 'fixed');          // 実物大のまま置く（指でつまんでも大きさは変わらない）
    mv.setAttribute('camera-controls', '');
    mv.setAttribute('shadow-intensity', '1');
    mv.setAttribute('environment-image', 'neutral');
    mv.innerHTML = '<button slot="ar-button" class="btn primary ar-go" type="button">カメラで部屋に置く</button>';
    stage.appendChild(mv);
    mv.addEventListener('load', () => {
      document.body.dataset.arReady = '1';
      document.body.dataset.arSize = String(blob.size);
      status.textContent = mv.canActivateAR
        ? '「カメラで部屋に置く」を押すと、実物大で床や机の上に置けます。'
        : 'この端末ではARを使えません。スマホ（iPhone の Safari、Android の Chrome）で同じリンクを開くと、カメラ越しに実物大で置けます。';
    }, { once: true });
    mv.addEventListener('error', () => { status.textContent = '3Dを表示できませんでした。もう一度お試しください。'; }, { once: true });
  } catch (e) {
    console.error(e);
    status.textContent = e.message === 'model-viewer'
      ? 'ARの部品を読み込めませんでした。通信の状態を確かめて、もう一度お試しください。'
      : 'ARのファイルを作れませんでした。もう一度お試しください。';
    onError?.(e);
  }
}
