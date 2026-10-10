// 3D表示の本体。商品ごとの違いは products/*.json に書き、ここは共通にする。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

const MAX_PARTS = 12;

function loadImageData(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      resolve({ data: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height });
    };
    img.onerror = () => reject(new Error('画像を読み込めませんでした: ' + url));
    img.src = url;
  });
}

export class Viewer {
  constructor(container, product) {
    this.container = container;
    this.product = product;
    this.listeners = {};
    this.selected = -1;
    this.idleSince = performance.now();
  }

  on(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name, v) { (this.listeners[name] || []).forEach(fn => fn(v)); }

  async init() {
    const p = this.product;
    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    this.container.appendChild(renderer.domElement);

    const scene = this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(2, 4, 3);
    scene.add(key);

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
    this.camera.position.set(...p.views.side);
    const controls = this.controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 1.6;
    controls.maxDistance = 5;
    controls.autoRotateSpeed = 1.2;
    controls.addEventListener('start', () => { this.idleSince = Infinity; controls.autoRotate = false; this.flyTo = null; });
    controls.addEventListener('end', () => { this.idleSince = performance.now(); });

    this.uniforms = {
      uParts: { value: null },
      uDetail: { value: null },
      uScale: { value: p.partsMapScale },
      uColors: { value: Array.from({ length: MAX_PARTS }, () => new THREE.Color(1, 1, 1)) },
      uRough: { value: new Array(MAX_PARTS).fill(0.8) },
      uDetailAmt: { value: new Array(MAX_PARTS).fill(1) },
      uMetal: { value: new Array(MAX_PARTS).fill(0) },
      uUnder: { value: Array.from({ length: MAX_PARTS }, () => new THREE.Color(1, 1, 1)) },
      uAged: { value: Array.from({ length: MAX_PARTS }, () => new THREE.Color(1, 1, 1)) },
      uWearMap: { value: null },
      uWearOn: { value: 0 },
      uAge: { value: 0 },
      uCover: { value: null },
      uCoverOn: { value: 0 },
      uSel: { value: -1 },
      uPulse: { value: 0 },
    };
    await this.loadModel(p);

    this.raycaster = new THREE.Raycaster();
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(this.container);
    this.resize();
    renderer.setAnimationLoop(t => this.tick(t));
  }

  // 3Dモデルと画像を読み込む。器の種類を切り替えるときは、これだけを呼び直す
  async loadModel(p) {
    let gltf, partsImg, partsTex, detailTex, normalTex, wearTex;
    if (p.vessel) {
      // ブラウザの中で組み立てた器（js/vessel.js）。ファイルは読み込まない
      const v = p.vessel;
      gltf = { scene: new THREE.Group() };
      gltf.scene.add(new THREE.Mesh(v.geometry, new THREE.MeshStandardMaterial()));
      const pc = v.parts.getContext('2d');
      partsImg = { data: pc.getImageData(0, 0, v.parts.width, v.parts.height).data, width: v.parts.width, height: v.parts.height };
      partsTex = new THREE.CanvasTexture(v.parts);
      detailTex = new THREE.CanvasTexture(v.detail);
      wearTex = v.wear ? new THREE.CanvasTexture(v.wear) : null;
      this.coverTex = v.cover ? new THREE.CanvasTexture(v.cover) : null;
      normalTex = v.normal ? new THREE.CanvasTexture(v.normal) : null;
    } else {
      [gltf, partsImg, partsTex, detailTex, normalTex] = await Promise.all([
        new GLTFLoader().loadAsync(p.model),
        loadImageData(p.partsMap),
        new THREE.TextureLoader().loadAsync(p.partsMap),
        new THREE.TextureLoader().loadAsync(p.detailMap),
        p.normalMap ? new THREE.TextureLoader().loadAsync(p.normalMap) : null,
      ]);
      // 使い込みの表現に使う「擦れやすさの地図」（無い商品では使わない）
      wearTex = p.wearMap ? await new THREE.TextureLoader().loadAsync(p.wearMap) : null;
      this.coverTex = null;
    }
    // 前のモデル・影・文字を片付ける
    if (this.root) {
      this.scene.remove(this.root, this.shadow);
      this.root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
      if (this.uniforms.uWearMap.value === this.uniforms.uDetail.value) this.uniforms.uWearMap.value = null;
      if (this.uniforms.uCover.value === this.uniforms.uDetail.value) this.uniforms.uCover.value = null;
      [this.uniforms.uParts.value, this.uniforms.uDetail.value, this.normalTex].forEach(t => t?.dispose());
      this.shadow.geometry.dispose();
    }
    if (this.decal) { this.scene.remove(this.decal); this.decal.geometry.dispose(); this.decal = null; }
    this.textSurface = null;
    this.product = p;
    this.partsImg = partsImg;
    this.vessel = p.vessel || null;
    this.setPreview(null);

    // 部品番号の画像は混ぜずにそのまま読む
    this.partsTex = partsTex;
    partsTex.flipY = false; partsTex.colorSpace = THREE.NoColorSpace;
    partsTex.magFilter = THREE.NearestFilter; partsTex.minFilter = THREE.NearestFilter; partsTex.generateMipmaps = false;
    detailTex.flipY = false; detailTex.colorSpace = THREE.NoColorSpace; detailTex.anisotropy = 8;
    this.uniforms.uParts.value = partsTex;
    this.uniforms.uDetail.value = detailTex;
    this.uniforms.uScale.value = p.partsMapScale;
    this.uniforms.uWearMap.value?.dispose?.();
    if (wearTex) { wearTex.flipY = false; wearTex.colorSpace = THREE.NoColorSpace; }
    this.uniforms.uWearMap.value = wearTex || detailTex;
    this.uniforms.uWearOn.value = wearTex ? 1 : 0;
    // 継ぎ目と欠けの割合（0〜1）。混ぜて塗るので、縁に画素の段々が出ない
    this.uniforms.uCover.value?.dispose?.();
    if (this.coverTex) { this.coverTex.flipY = false; this.coverTex.colorSpace = THREE.NoColorSpace; this.coverTex.anisotropy = 8; }
    this.uniforms.uCover.value = this.coverTex || detailTex;
    this.uniforms.uCoverOn.value = this.coverTex ? 1 : 0;

    const root = this.root = gltf.scene;
    const box = new THREE.Box3().setFromObject(root);
    const s = 2 / box.getSize(new THREE.Vector3()).length();
    root.scale.multiplyScalar(s);
    root.position.sub(box.getCenter(new THREE.Vector3()).multiplyScalar(s));
    this.scene.add(root);
    root.updateMatrixWorld(true);

    this.mesh = null;
    root.traverse(o => { if (o.isMesh && !this.mesh) this.mesh = o; });
    const mat = this.mesh.material;
    // 表面の画像が無いモデルでも、UV座標をシェーダーへ渡すために仮の画像を割り当てる
    if (!mat.map) mat.map = detailTex;
    this.normalTex = normalTex;
    this.normalMapTex = null;
    if (normalTex) {
      normalTex.flipY = false; normalTex.colorSpace = THREE.NoColorSpace; normalTex.anisotropy = 8;
      mat.normalMap = normalTex;
      this.normalMapTex = normalTex;
      const ns = p.normalScale ?? 1;
      mat.normalScale.set(ns, ns);
    }
    this.patchMaterial(mat);

    // 床の影（ぼかした楕円）
    const min = new THREE.Box3().setFromObject(root).min.y;
    const sh = document.createElement('canvas'); sh.width = sh.height = 256;
    const g = sh.getContext('2d');
    const grd = g.createRadialGradient(128, 128, 10, 128, 128, 128);
    grd.addColorStop(0, 'rgba(0,0,0,0.45)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(...(p.shadow || [2.2, 1.1])), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sh), transparent: true, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2; this.shadow.position.y = min - 0.005;
    this.scene.add(this.shadow);
    this.controls.target.set(0, 0, 0);
  }

  patchMaterial(mat) {
    mat.roughness = 1; mat.metalness = 0;
    mat.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D uParts; uniform sampler2D uDetail; uniform float uScale;
uniform vec3 uColors[${MAX_PARTS}]; uniform float uRough[${MAX_PARTS}]; uniform float uDetailAmt[${MAX_PARTS}]; uniform float uMetal[${MAX_PARTS}];
uniform vec3 uUnder[${MAX_PARTS}]; uniform vec3 uAged[${MAX_PARTS}];
uniform sampler2D uWearMap; uniform float uWearOn; uniform float uAge;
uniform sampler2D uCover; uniform float uCoverOn;
uniform float uSel; uniform float uPulse;
vec3 partTop(int i) { return mix(uColors[i], uAged[i], uAge * uWearOn); }`)
        .replace('#include <map_fragment>', `
vec4 pv = texture2D(uParts, vMapUv);
int ip = clamp(int(floor(pv.r * 255.0 / uScale + 0.5)), 0, ${MAX_PARTS - 1});
// 継ぎ目(3)と欠け(4)は割合の画像で混ぜる。そのとき地の部位は緑の欄（継ぎ目を除いた部位）から読む
float seamC = 0.0, chipC = 0.0;
if (uCoverOn > 0.5) {
  ip = clamp(int(floor(pv.g * 255.0 / uScale + 0.5)), 0, ${MAX_PARTS - 1});
  vec4 cv = texture2D(uCover, vMapUv);
  seamC = cv.r; chipC = cv.g;
}
int ipSel = chipC > 0.5 ? 4 : (seamC > 0.5 ? 3 : ip);
float dAmt = mix(mix(uDetailAmt[ip], uDetailAmt[3], seamC), uDetailAmt[4], chipC);
float pr = mix(mix(uRough[ip], uRough[3], seamC), uRough[4], chipC);
float pm = mix(mix(uMetal[ip], uMetal[3], seamC), uMetal[4], chipC);
float dt = mix(1.0, texture2D(uDetail, vMapUv).r * 2.0, dAmt);
// 使い込み：上塗りの色は年月で深まり（uAged）、擦れやすい所から下の塗り（uUnder）がのぞく
float wv = texture2D(uWearMap, vMapUv).r;
float th = 1.03 - uAge * 0.62;
float worn = uWearOn * smoothstep(th, th + 0.07, wv);
vec3 topCol = mix(mix(partTop(ip), partTop(3), seamC), partTop(4), chipC);
diffuseColor.rgb *= mix(topCol, uUnder[ip], worn) * dt;`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor * pr, 0.05, 1.0);
// 漆は使い込むほど艶が増す。擦れて下地が出た所は艶が落ちる
roughnessFactor *= mix(1.0, 0.55, uAge * uWearOn);
roughnessFactor = mix(roughnessFactor, 0.55, worn);`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = pm;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
if (ipSel == int(uSel)) totalEmissiveRadiance += vec3(0.95, 0.72, 0.2) * uPulse;`);
    };
    mat.needsUpdate = true;
  }

  // 部品の色・質感を反映する（look: {roughness ざらつき, detail 質感の強さ, metal 金属らしさ}）
  setPart(index, hex, look) {
    this.uniforms.uColors.value[index].set(hex);
    if (look) {
      this.uniforms.uRough.value[index] = look.roughness ?? 0.8;
      this.uniforms.uDetailAmt.value[index] = look.detail ?? 1;
      this.uniforms.uMetal.value[index] = look.metal ?? 0;
      this.uniforms.uUnder.value[index].set(look.under || hex);
      this.uniforms.uAged.value[index].set(look.aged || hex);
    }
  }

  // ---- 割れと欠けの描き直し（ブラウザの中で組み立てた金継ぎの器だけ） ----
  canEditDefects() { return !!this.vessel?.kintsugi; }
  paintDefects(defs) {
    if (!this.canEditDefects()) return;
    this.vessel.paint(defs);
    const c = this.vessel.parts;
    this.partsImg = { data: c.getContext('2d').getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
    this.partsTex.needsUpdate = true;
    if (this.normalMapTex) this.normalMapTex.needsUpdate = true;
    if (this.coverTex) this.coverTex.needsUpdate = true;
  }

  // 画面上の位置から、器の表面の点を求める（器の座標：単位 cm）
  surfaceHit(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit) return null;
    const lp = this.mesh.worldToLocal(hit.point.clone());
    const n = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0);
    let theta = Math.atan2(lp.z, lp.x);
    if (theta < 0) theta += Math.PI * 2;
    // 丸くない器は向きごとに伸び縮みさせているので、断面の上の半径に戻す（割れの点は断面の上で持つ）
    const F = this.vessel?.planScale ? this.vessel.planScale(theta) : 1;
    return { theta, y: lp.y, r: Math.hypot(lp.x, lp.z) / F, local: lp, normal: n, part: hit.uv ? this.partAtUv(hit.uv) : -1 };
  }

  // なぞっている途中の線（器の表面から少し浮かせて描く）
  setPreview(points) {
    if (this.preview) { this.preview.parent?.remove(this.preview); this.preview.geometry.dispose(); this.preview = null; }
    if (!points || points.length < 2 || !this.mesh) return;
    const pos = points.map(p => p.local.clone().add(p.normal.clone().multiplyScalar(0.06)));
    const geo = new THREE.BufferGeometry().setFromPoints(pos);
    this.preview = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xe8b931, depthTest: false }));
    this.preview.renderOrder = 10;
    this.mesh.add(this.preview);
  }

  // 編集の種類：null / 'rotate'（回す） / 'trace'（なぞる） / 'chip'（欠け） / 'erase'（消す）
  setEditMode(mode) {
    this.editMode = mode;
    const drawing = mode && mode !== 'rotate';
    this.controls.enableRotate = !drawing;
    this.renderer.domElement.style.cursor = drawing ? 'crosshair' : '';
    if (drawing) { this.controls.autoRotate = false; this.idleSince = Infinity; }
    else this.idleSince = performance.now();
  }

  // 使い込みの度合い（0 = 新品 〜 1 = 長年使った姿）
  setAge(a) { this.uniforms.uAge.value = Math.max(0, Math.min(1, a)); }

  select(index) {
    this.selected = index;
    this.uniforms.uSel.value = index;
    this.pulseStart = performance.now();
  }

  partAtUv(uv) {
    const { data, width, height } = this.partsImg;
    const x = Math.min(width - 1, Math.max(0, Math.floor(uv.x * width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(uv.y * height)));
    return Math.round(data[(y * width + x) * 4] / this.product.partsMapScale);
  }

  pick(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    return hit && hit.uv ? this.partAtUv(hit.uv) : -1;
  }

  bindPointer() {
    const el = this.renderer.domElement;
    let down = null, editing = false;
    el.addEventListener('pointerdown', e => {
      down = { x: e.clientX, y: e.clientY };
      // 編集中は、器の上を押したところから「なぞる」などの操作にする
      if (this.editMode && this.editMode !== 'rotate') {
        const hit = this.surfaceHit(e.clientX, e.clientY);
        if (hit) { editing = true; el.setPointerCapture(e.pointerId); this.emit('editstart', hit); }
      }
    });
    el.addEventListener('pointermove', e => {
      if (!editing) return;
      const hit = this.surfaceHit(e.clientX, e.clientY);
      if (hit) this.emit('editmove', hit);
    });
    const endEdit = () => { if (editing) { editing = false; down = null; this.emit('editend'); return true; } return false; };
    el.addEventListener('pointercancel', endEdit);
    el.addEventListener('pointerup', e => {
      if (endEdit()) return;
      if (this.editMode && this.editMode !== 'rotate') { down = null; return; }
      // 動かさずに離したときだけ「部品を選んだ」とみなす（回転と区別する）
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) {
        const idx = this.pick(e.clientX, e.clientY);
        if (idx >= 0) this.emit('pick', idx);
      }
      down = null;
    });
    el.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse' || e.buttons || (this.editMode && this.editMode !== 'rotate')) return;
      const idx = this.pick(e.clientX, e.clientY);
      el.style.cursor = idx >= 0 ? 'pointer' : 'grab';
      this.emit('hover', { index: idx, x: e.clientX, y: e.clientY });
    });
    el.addEventListener('pointerleave', () => this.emit('hover', { index: -1 }));
  }

  // カメラを決まった向きへ滑らかに動かす
  view(name) {
    const v = this.product.views[name];
    if (!v) return;
    this.controls.autoRotate = false;
    this.idleSince = performance.now();
    this.flyTo = { from: this.camera.position.clone(), to: new THREE.Vector3(...v), t0: performance.now() };
  }

  setAutoRotate(on) { this.autoRotateAllowed = on; if (!on) this.controls.autoRotate = false; }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // 縦長の画面では引いて全体を収める
    this.camera.fov = w / h < 1 ? 42 : 30;
    this.camera.updateProjectionMatrix();
  }

  tick(now) {
    if (this.flyTo) {
      const k = Math.min(1, (now - this.flyTo.t0) / 700);
      const e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(this.flyTo.from, this.flyTo.to, e);
      if (k >= 1) this.flyTo = null;
    }
    if (this.autoRotateAllowed && !this.controls.autoRotate && now - this.idleSince > 6000) this.controls.autoRotate = true;
    if (this.selected >= 0) {
      const t = (now - this.pulseStart) / 1000;
      this.uniforms.uPulse.value = t < 1.6 ? 0.35 * (0.5 + 0.5 * Math.cos(t * Math.PI * 2.5)) * (1 - t / 1.6) : 0;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // ---- 文字入れ（デカール＝シールのように表面へ貼る） ----
  // facing を渡すと、その向きから見える面だけを使う（内側や裏の面を除く）
  findPartSurface(index, facing) {
    const geo = this.mesh.geometry;
    const pos = geo.attributes.position, uv = geo.attributes.uv, nor = geo.attributes.normal;
    const idx = geo.index;
    const P = new THREE.Vector3(), N = new THREE.Vector3(), U = new THREE.Vector2();
    const pts = [];
    const nsum = new THREE.Vector3();
    const m = this.mesh.matrixWorld, nm = new THREE.Matrix3().getNormalMatrix(m);
    for (let i = 0; i < idx.count; i += 3) {
      U.set(0, 0); P.set(0, 0, 0); N.set(0, 0, 0);
      for (let k = 0; k < 3; k++) {
        const v = idx.getX(i + k);
        U.x += uv.getX(v) / 3; U.y += uv.getY(v) / 3;
        P.x += pos.getX(v) / 3; P.y += pos.getY(v) / 3; P.z += pos.getZ(v) / 3;
        N.x += nor.getX(v); N.y += nor.getY(v); N.z += nor.getZ(v);
      }
      if (this.partAtUv(U) !== index) continue;
      N.applyMatrix3(nm).normalize();
      if (facing && N.dot(facing) < 0.55) continue;
      pts.push(P.clone().applyMatrix4(m));
      nsum.add(N);
    }
    if (!pts.length) return null;
    const center = pts.reduce((a, b) => a.add(b), new THREE.Vector3()).divideScalar(pts.length);
    const normal = nsum.normalize();
    // 部品の広がり（貼る面の幅と高さ）を測る
    const helper = new THREE.Object3D();
    helper.position.copy(center); helper.lookAt(center.clone().add(normal)); helper.updateMatrixWorld();
    const inv = helper.matrixWorld.clone().invert();
    const b = new THREE.Box3();
    pts.forEach(p => b.expandByPoint(p.clone().applyMatrix4(inv)));
    const size = b.getSize(new THREE.Vector3());
    // 広がりの中心（点の平均より見た目の中央に近い）から、外へ押し出した位置を投影の起点にする
    const mid = helper.localToWorld(b.getCenter(new THREE.Vector3()).setZ(0));
    const origin = mid.add(normal.clone().multiplyScalar(size.z * 0.5));
    return { origin, normal, rotation: helper.rotation.clone(), width: size.x, height: size.y };
  }

  async setText(textCfg, value, fontCss, color, metal = 0) {
    if (this.decal) { this.scene.remove(this.decal); this.decal.geometry.dispose(); this.decal = null; }
    if (!value) return;
    const part = this.product.parts.find(p => p.id === textCfg.part);
    const facing = textCfg.facing ? new THREE.Vector3(...this.product.views[textCfg.facing]).normalize() : null;
    this.textSurface ||= this.findPartSurface(part.index, facing);
    const s = this.textSurface;
    if (!s) return;
    await document.fonts.load(fontCss, value).catch(() => {});
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 256;
    const g = c.getContext('2d');
    g.font = fontCss;
    const w = g.measureText(value).width;
    // 短い文字は少し大きく、長い文字は枠に収まるよう縮める
    const scale = Math.min(1.5, (c.width * 0.9) / w);
    g.translate(c.width / 2, c.height / 2); g.scale(scale, scale);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = color; g.fillText(value, 0, 6);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    // 曲面で回り込むとはみ出すので、部品の幅より控えめにする
    const width = Math.min(s.width * 0.62, s.height * 2.4), height = width / 4;
    // 奥行きを深くしすぎると、裏側の面（器なら見込み）にまで文字が写るので、設定で絞れるようにする
    const depth = s.width * (textCfg.depth ?? 2);
    const geo = new DecalGeometry(this.mesh, s.origin, s.rotation, new THREE.Vector3(width, height, depth));
    this.decal = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
      roughness: metal ? 0.3 : 0.6, metalness: metal,
    }));
    this.scene.add(this.decal);
  }

  // 発注書用：決まった向きから撮った画像を返す
  snapshot(name, w = 640, h = 420) {
    const cam = this.camera.clone();
    cam.position.set(...this.product.views[name]);
    cam.aspect = w / h; cam.fov = 30; cam.updateProjectionMatrix(); cam.lookAt(0, 0, 0);
    const prevSize = this.renderer.getSize(new THREE.Vector2());
    const prevSel = this.uniforms.uPulse.value;
    this.uniforms.uPulse.value = 0;
    this.renderer.setSize(w, h, false);
    this.renderer.render(this.scene, cam);
    const url = this.renderer.domElement.toDataURL('image/png');
    this.renderer.setSize(prevSize.x, prevSize.y, false);
    this.uniforms.uPulse.value = prevSel;
    return url;
  }
}
