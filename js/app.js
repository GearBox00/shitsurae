// シミュレーター画面の操作。状態は1つのオブジェクトにまとめ、URLにも書き出す。
import { Viewer } from './viewer.js';
import { store, yen, newOrderNo, safeImg } from './store.js';
import { buildVessel, sanitizeShape, sampleDefects, crackLength, distToCrack, floorOf, CHIP_SCALE, chipOf } from './vessel.js';
import { openPhotoShape } from './photo-shape.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const productId = (params.get('p') || 'shoe').replace(/[^a-z0-9_-]/gi, '');

let P, viewer, state;
const undoStack = [], redoStack = [];
let openPart = null;

// ---------- 状態 ----------
function defaultState() {
  const colors = {};
  P.parts.forEach(pt => { colors[pt.id] = pt.default; });
  const material = P.defaultMaterial || Object.keys(P.materials)[0];
  const s = { colors, material, text: { value: '', font: P.text?.fonts[0].id, color: P.text?.colors[0].hex } };
  if (P.variants) s.variant = P.defaultVariant || P.variants[0].id;
  if (P.aging) s.age = 0;
  if (shapeEnabled()) s.shape = null;   // null = 見本の形
  if (defectsOn()) s.defects = null;    // null = 見本の割れと欠け
  return s;
}

// 器の種類（variants）がある商品は、選んだ種類の設定で上書きした「今の商品」を使う
function eff() {
  const v = P.variants?.find(v => v.id === state?.variant);
  // 写真から作った器を使っているときは、写真用の設定（価格・向き・大きさ）で上書きする
  const photo = state?.shape && P.photoShape;
  if (!v && !photo) return P;
  const e = { ...P, ...(v || {}), ...(photo ? P.photoShape : {}), name: P.name };
  if (P.text) e.text = { ...P.text, depth: (photo ? null : v?.textDepth) ?? P.text.depth };
  return e;
}
const variantOf = () => P.variants?.find(v => v.id === state.variant);

// 写真から形を作れる商品（漆は見本の形も組み立てる。金継ぎは写真を使ったときだけ組み立てる）
const shapeEnabled = () => !!(P.defaultShape || P.photoShape);
const shapeOf = () => state.shape || variantOf()?.shape || P.defaultShape || null;

// ---------- 割れと欠け（金継ぎ） ----------
const defectsOn = () => P.vesselMode === 'kintsugi';
const r3 = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const roundDefects = d => ({
  cracks: d.cracks.map(pts => pts.map(([t, y, r, a = 0]) => [r3(t, 3), r3(y, 2), r3(r, 2), a])),
  chips: d.chips.map(c => (Array.isArray(c) ? [r3(c[0], 3), c[1]] : r3(c, 3))),
});
const currentDefects = () => state.defects || (shapeOf() ? roundDefects(sampleDefects(shapeOf())) : null);
function sanitizeDefects(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.cracks) || !Array.isArray(d.chips)) return null;
  const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (d.cracks.length > 12 || d.chips.length > 8) return null;
  const cracks = [];
  for (const pts of d.cracks) {
    if (!Array.isArray(pts) || pts.length < 2 || pts.length > 150) return null;
    for (const p of pts) {
      if (!Array.isArray(p) || (p.length !== 3 && p.length !== 4) || !num(p[0], -10, 20) || !num(p[1], -1, 32) || !num(p[2], 0, 21)) return null;
      if (p.length === 4 && p[3] !== 0 && p[3] !== 1) return null;
    }
    cracks.push(pts.map(p => [p[0], p[1], p[2], p[3] ?? 0]));
  }
  // 欠けは角度だけ（中）か、[角度, 大きさ 0〜2]
  const chipOk = c => num(c, -10, 20) || (Array.isArray(c) && c.length === 2 && num(c[0], -10, 20) && [0, 1, 2].includes(c[1]));
  if (!d.chips.every(chipOk)) return null;
  return { cracks, chips: d.chips.map(c => (Array.isArray(c) ? [c[0], c[1]] : c)) };
}
const CHIP_NAMES = ['小', '中', '大'];
const largeChips = d => d.chips.filter(c => chipOf(c)[1] === 2).length;
function defectSummary(d) {
  const len = d.cracks.reduce((a, pts) => a + crackLength(pts), 0);
  // 欠けの大きさの内訳（中だけなら書かない）
  const n = [0, 0, 0]; d.chips.forEach(c => { n[chipOf(c)[1]]++; });
  const sizes = n[0] || n[2] ? `（${[2, 1, 0].filter(i => n[i]).map(i => CHIP_NAMES[i] + n[i]).join('・')}）` : '';
  return state.defects
    ? `なぞった割れ ${d.cracks.length}本（合計 ${len.toFixed(1)}cm）・欠け ${d.chips.length}か所${sizes}`
    : `見本の割れ（${d.cracks.length}本）・欠け ${d.chips.length}か所${sizes}`;
}
function textCfg() {
  const E = eff();
  if (!shapeOf() || !E.text) return E.text;
  // 底が浅い器では、銘を貼る深さを浅くしないと内側の底に写り込む
  const sh = shapeOf();
  return { ...E.text, depth: Math.min(0.3, (Math.min(floorOf(sh), sh.h - 0.4) * 0.8) / (2 * sh.rf)) };
}
function effModel() {
  const E = eff();
  if (shapeOf()) { E.vessel = buildVessel(shapeOf(), { mode: P.vesselMode || 'lacquer' }); E.text = textCfg(); }
  return E;
}
const modelKey = () => JSON.stringify([state.variant ?? null, state.shape ?? null]);

// 色の一覧は文字列（#rrggbb）でも、{hex, name, metal} の形でも書けるようにそろえる
function normalizeProduct(p) {
  if (p.text) p.text.colors = p.text.colors.map(c => (typeof c === 'string' ? { hex: c, name: c } : c));
  p.viewButtons ||= [{ id: 'side', label: '横' }, { id: 'front', label: '前' }, { id: 'back', label: '後ろ' }, { id: 'top', label: '上' }];
  p.snapshotViews ||= p.viewButtons.slice(0, 3).map(v => v.id);
  p.presetDots ||= p.parts.slice(0, 4).map(pt => pt.id);
  p.sizeLabel ||= 'サイズ';
  p.sizeUnit ??= '';
  return p;
}

function colorOf(part, value) {
  if (value?.startsWith('#')) return { hex: value, name: '好きな色 ' + value.toUpperCase(), custom: true, price: 0 };
  const c = P.palettes[part.palette].find(c => c.id === value) || P.palettes[part.palette][0];
  return { hex: c.hex, name: c.name, custom: false, metal: c.metal || 0, roughMul: c.roughMul || 1, price: c.price || 0,
    under: c.under, aged: c.aged, underName: c.underName };
}

// 部位の質感 = 素材（または部位の標準）× 色ごとの金属らしさ
function lookOf(pt, c) {
  const base = pt.materials ? P.materials[state.material] : (pt.look || { roughness: 0.8, detail: 1 });
  return { roughness: base.roughness * (c.roughMul || 1), detail: base.detail, metal: c.metal || 0, under: c.under, aged: c.aged };
}

function price() {
  const E = eff();
  const lines = [{ label: E.priceLabel || E.name, amount: E.basePrice }];
  const mat = P.materials[state.material];
  if (mat.price) lines.push({ label: (P.materialLabel || '素材') + ': ' + mat.name, amount: mat.price });
  P.parts.forEach(pt => {
    const c = colorOf(pt, state.colors[pt.id]);
    if (c.price) lines.push({ label: `${pt.name}: ${c.name}`, amount: c.price });
  });
  const customs = P.parts.filter(pt => colorOf(pt, state.colors[pt.id]).custom);
  if (customs.length && P.customColor) lines.push({ label: `好きな色 ×${customs.length}`, amount: customs.length * P.customColor.price });
  if (P.text && state.text.value) lines.push({ label: P.text.label, amount: P.text.price });
  // なぞった割れと欠けが、基本料金に含まれる数より多いときの追加料金
  const dp = eff().defectPricing;
  if (dp && state.defects) {
    const extraC = Math.max(0, state.defects.cracks.length - dp.includedCracks);
    const extraH = Math.max(0, state.defects.chips.length - dp.includedChips);
    if (extraC) lines.push({ label: `割れの追加 ×${extraC}`, amount: extraC * dp.perCrack });
    if (extraH) lines.push({ label: `欠けの追加 ×${extraH}`, amount: extraH * dp.perChip });
    const big = largeChips(state.defects);
    if (big && dp.perLargeChip) lines.push({ label: `大きな欠け ×${big}`, amount: big * dp.perLargeChip });
  }
  return { lines, total: lines.reduce((a, l) => a + l.amount, 0) };
}

function commit(mutator) {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
  mutator(state);
  apply();
}

function restore(json) { state = JSON.parse(json); apply(); }

// ---------- URL（共有リンク） ----------
function encodeState() {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeState(s) {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const obj = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
    return sanitize(obj);
  } catch { return null; }
}
// 外から来た値は、設定にあるものだけ受け入れる
function sanitize(obj) {
  const s = defaultState();
  if (!obj || typeof obj !== 'object') return s;
  P.parts.forEach(pt => {
    const v = obj.colors?.[pt.id];
    if (typeof v !== 'string') return;
    if ((P.customColor && /^#[0-9a-f]{6}$/i.test(v)) || P.palettes[pt.palette].some(c => c.id === v)) s.colors[pt.id] = v;
  });
  if (P.materials[obj.material]) s.material = obj.material;
  if (P.variants?.some(v => v.id === obj.variant)) s.variant = obj.variant;
  if (P.aging && typeof obj.age === 'number' && obj.age >= 0 && obj.age <= 1) s.age = obj.age;
  if (shapeEnabled() && obj.shape) s.shape = sanitizeShape(obj.shape);
  if (defectsOn() && obj.defects) s.defects = sanitizeDefects(obj.defects);
  if (P.text && obj.text) {
    if (typeof obj.text.value === 'string') s.text.value = obj.text.value.slice(0, P.text.maxLength);
    if (P.text.fonts.some(f => f.id === obj.text.font)) s.text.font = obj.text.font;
    if (P.text.colors.some(c => c.hex === obj.text.color)) s.text.color = obj.text.color;
  }
  return s;
}

// ---------- 反映 ----------
let textTimer, loadedKey, paintedKey, modelQueue = Promise.resolve();
function apply() {
  // 器の種類が変わったときだけ、3Dモデルを読み込み直す（連続で押されても順番に処理する）
  modelQueue = modelQueue.then(syncModel).then(applyLooks).catch(e => {
    console.error(e);
    $('loading').hidden = false;
    $('loading').textContent = '3Dモデルを読み込めませんでした。通信の状態を確かめて、もう一度お試しください。';
  });
  history.replaceState(null, '', `?p=${productId}#d=${encodeState()}`);
  render();
}

// 器の種類か形が変わったときだけ、3Dを作り直す
async function syncModel() {
  const want = modelKey();
  if (loadedKey === want) return;
  $('loading').hidden = false;
  $('loading').textContent = '器を読み込んでいます';
  await new Promise(r => setTimeout(r, 30));   // 「読み込んでいます」を先に描かせる
  await viewer.loadModel(effModel());
  loadedKey = want;
  paintedKey = null;
  if (!viewer.canEditDefects()) exitEdit();
  renderDefects();
  $('loading').hidden = true;
  renderViews();
  viewer.view('side');
  if (modelKey() !== want) return syncModel();
}

function applyLooks() {
  viewer.setAge(state.age || 0);
  // 割れと欠けが変わったときだけ描き直す（器の形は作り直さない）
  if (viewer.canEditDefects() && shapeOf()) {
    const key = loadedKey + JSON.stringify(state.defects);
    if (key !== paintedKey) { viewer.paintDefects(currentDefects()); paintedKey = key; }
  }
  P.parts.forEach(pt => {
    const c = colorOf(pt, state.colors[pt.id]);
    viewer.setPart(pt.index, c.hex, lookOf(pt, c));
  });
  clearTimeout(textTimer);
  textTimer = setTimeout(() => {
    if (!P.text) return;
    const tc = textCfg();
    const f = tc.fonts.find(f => f.id === state.text.font);
    const col = tc.colors.find(c => c.hex === state.text.color);
    viewer.setText(tc, state.text.value, f.css, state.text.color, col?.metal || 0);
  }, 200);
}

function renderViews() {
  $('views').innerHTML = eff().viewButtons.map(v => `<button type="button" data-view="${esc(v.id)}">${esc(v.label)}</button>`).join('');
}

function renderVariants() {
  if (!P.variants) return;
  $('variants').innerHTML = P.variants.map(v => `
    <button type="button" class="variant" role="radio" aria-checked="${!state.shape && v.id === state.variant}" data-variant="${esc(v.id)}">
      <svg viewBox="0 0 40 40" aria-hidden="true"><path d="${esc(v.icon || '')}"/></svg>
      <span class="variant-name">${esc(v.name)}</span>
      <span class="variant-meta mono">${yen(v.basePrice)}〜</span>
    </button>`).join('');
}

function renderAge() {
  if (!P.aging) return;
  const v = Math.round((state.age || 0) * 100);
  if (+$('ageRange').value !== v) $('ageRange').value = v;
  const stop = P.aging.stops.reduce((a, b) => (Math.abs(b.at - state.age) < Math.abs(a.at - state.age) ? b : a));
  $('ageLabel').textContent = stop.label;
}

function renderShape() {
  if (!shapeEnabled()) return;
  const sh = state.shape;
  const sample = P.defaultShapeLabel || (variantOf() ? `見本の器（${variantOf().name}）` : '見本の形');
  $('shapeStatus').textContent = sh ? `写真から作った形（口径 ${sh.rim}cm・高さ ${sh.h.toFixed(1)}cm）` : sample;
  $('shapeReset').hidden = !sh;
}

function renderDefects() {
  if (!defectsOn()) return;
  // 器の切り替え中（新しい3Dを読み込む前）は、切り替え先の器で判断する
  const can = !!(shapeOf() && viewer?.canEditDefects());
  $('traceBtn').disabled = !can;
  $('defectSample').hidden = !can || !state.defects;
  $('defectClear').hidden = !can;
  if (!can) {
    $('defectStatus').textContent = '見本の割れと欠け';
    $('defectNote').textContent = 'この器では、割れをなぞる機能は使えません。茶碗か、写真から作った器でお使いください。';
    return;
  }
  $('defectStatus').textContent = defectSummary(currentDefects());
  const dp = eff().defectPricing;
  $('defectNote').textContent = dp ? `割れ${dp.includedCracks}本・欠け${dp.includedChips}か所までは基本料金に含みます。増えた分は 割れ1本 +${yen(dp.perCrack)}・欠け1か所 +${yen(dp.perChip)}。${dp.perLargeChip ? `大きな欠けは1か所につき +${yen(dp.perLargeChip)}。` : ''}` : '';
}

function render() {
  renderDefects();
  renderShape();
  renderAge();
  renderVariants();
  renderParts();
  renderText();
  const { lines, total } = price();
  $('total').textContent = yen(total);
  $('lines').innerHTML = lines.map(l => `<li><span>${esc(l.label)}</span><span>${yen(l.amount)}</span></li>`).join('');
  $('undoBtn').disabled = !undoStack.length;
  $('redoBtn').disabled = !redoStack.length;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderParts() {
  const ol = $('parts');
  ol.innerHTML = '';
  P.parts.forEach(pt => {
    const c = colorOf(pt, state.colors[pt.id]);
    const li = document.createElement('li');
    li.className = 'part' + (openPart === pt.id ? ' open' : '');
    const matNote = pt.materials ? `<span class="part-mat">${esc(P.materials[state.material].name)}</span>` : '';
    li.innerHTML = `
      <button type="button" class="part-row" aria-expanded="${openPart === pt.id}">
        <span class="part-name">${esc(pt.name)}</span>
        <span class="part-val">${matNote}<span class="part-color">${esc(c.name)}</span><span class="dot" style="background:${c.hex}"></span></span>
      </button>`;
    li.querySelector('.part-row').addEventListener('click', () => {
      openPart = openPart === pt.id ? null : pt.id;
      if (openPart) viewer.select(pt.index); else viewer.select(-1);
      renderParts();
    });
    if (openPart === pt.id) li.appendChild(partEditor(pt, c));
    ol.appendChild(li);
  });
}

function partEditor(pt, current) {
  const box = document.createElement('div');
  box.className = 'part-edit';
  if (pt.materials) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', P.materialLabel || '素材');
    pt.materials.forEach(mid => {
      const m = P.materials[mid];
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', state.material === mid);
      b.innerHTML = `${esc(m.name)}<small class="mono">${m.price ? '+' + yen(m.price) : '標準'}</small>`;
      b.addEventListener('click', () => commit(s => { s.material = mid; }));
      seg.appendChild(b);
    });
    box.appendChild(seg);
  }
  const sw = document.createElement('div');
  sw.className = 'swatches';
  sw.setAttribute('role', 'radiogroup');
  sw.setAttribute('aria-label', pt.name + 'の色');
  P.palettes[pt.palette].forEach(col => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sw';
    b.style.setProperty('--c', col.hex);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', state.colors[pt.id] === col.id);
    b.setAttribute('aria-label', col.name + (col.price ? ` +${yen(col.price)}` : ''));
    b.title = col.name + (col.price ? ` +${yen(col.price)}` : '');
    if (col.metal) b.classList.add('metal');
    b.addEventListener('click', () => commit(s => { s.colors[pt.id] = col.id; }));
    sw.appendChild(b);
  });
  box.appendChild(sw);
  // 追加料金のある色は、名前と金額を書き出す
  const paid = P.palettes[pt.palette].filter(c => c.price);
  if (paid.length) {
    const n = document.createElement('p');
    n.className = 'note';
    n.textContent = '追加料金: ' + paid.map(c => `${c.name} +${yen(c.price)}`).join('　');
    box.appendChild(n);
  }
  if (!P.customColor) return box;
  // 好きな色（カラーピッカー）
  const lab = document.createElement('label');
  lab.className = 'sw custom' + (current.custom ? ' on' : '');
  lab.title = `${P.customColor.label} +${yen(P.customColor.price)}`;
  lab.innerHTML = `<input type="color" value="${current.custom ? current.hex : '#888888'}" aria-label="${esc(P.customColor.label)}"><span aria-hidden="true">＋</span>`;
  const input = lab.querySelector('input');
  let before = null;
  input.addEventListener('focus', () => { before = JSON.stringify(state); });
  input.addEventListener('input', () => {
    // ドラッグ中は画面だけ変え、確定時に履歴へ積む
    state.colors[pt.id] = input.value;
    viewer.setPart(pt.index, input.value, lookOf(pt, colorOf(pt, input.value)));
  });
  input.addEventListener('change', () => {
    if (before) { undoStack.push(before); redoStack.length = 0; before = null; }
    state.colors[pt.id] = input.value;
    apply();
  });
  sw.appendChild(lab);
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = `「＋」は${P.customColor.label}。+${yen(P.customColor.price)}`;
  box.appendChild(note);
  return box;
}

function renderText() {
  if (!P.text) return;
  const t = P.text;
  const input = $('textInput');
  if (document.activeElement !== input) input.value = state.text.value;
  $('textCount').textContent = `${[...input.value].length}/${t.maxLength}`;
  $('fontSeg').innerHTML = '';
  t.fonts.forEach(f => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', state.text.font === f.id);
    b.textContent = f.name;
    b.style.fontFamily = f.css.split(/\d+px /)[1];
    b.addEventListener('click', () => commit(s => { s.text.font = f.id; }));
    $('fontSeg').appendChild(b);
  });
  $('textColors').innerHTML = '';
  t.colors.forEach(({ hex, name, metal }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sw small' + (metal ? ' metal' : '');
    b.style.setProperty('--c', hex);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', state.text.color === hex);
    b.setAttribute('aria-label', `${t.colorLabel || '色'} ${name}`);
    b.title = name;
    b.addEventListener('click', () => commit(s => { s.text.color = hex; }));
    $('textColors').appendChild(b);
  });
}

function renderSaved() {
  const list = store.saved(productId);
  $('savedSec').hidden = !list.length;
  $('saved').innerHTML = '';
  list.forEach(item => {
    const fig = document.createElement('figure');
    fig.className = 'saved-item';
    fig.innerHTML = `<button type="button" class="saved-open" aria-label="${esc(item.label)}を開く"><img src="${safeImg(item.thumb)}" alt=""></button>
      <figcaption>${esc(item.label)}<button type="button" class="saved-del" aria-label="削除">×</button></figcaption>`;
    fig.querySelector('.saved-open').addEventListener('click', () => commit(s => Object.assign(s, sanitize(item.state))));
    fig.querySelector('.saved-del').addEventListener('click', () => { store.removeSaved(item.id); renderSaved(); });
    $('saved').appendChild(fig);
  });
}

// ---------- 割れの編集モード ----------
const EDIT_HINT = {
  rotate: 'ドラッグで器を回して、なぞりたい面を手前に向けます',
  trace: '器の上を指やマウスでなぞると、その線が割れになります',
  chip: '口縁をタップすると、選んだ大きさの欠けを置きます',
  erase: '消したい割れや欠けをタップします',
};
let chipSize = 1;
function setEdit(mode) {
  viewer.setEditMode(mode);
  $('chipSizes').hidden = mode !== 'chip';
  document.querySelectorAll('#editBar [data-edit]').forEach(b => b.setAttribute('aria-pressed', b.dataset.edit === mode));
  $('editHint').textContent = EDIT_HINT[mode];
}
function enterEdit(mode) {
  if (!viewer.canEditDefects() || !shapeOf()) return;
  $('editBar').hidden = false;
  document.body.classList.add('editing');
  setEdit(mode);
  if (matchMedia('(max-width: 860px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' });
}
function exitEdit() {
  if (!$('editBar') || $('editBar').hidden) return;
  $('editBar').hidden = true;
  document.body.classList.remove('editing');
  viewer.setEditMode(null);
  viewer.setPreview(null);
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- 発注書 ----------
function specRows() {
  const rows = P.parts.map(pt => {
    const c = colorOf(pt, state.colors[pt.id]);
    const mat = pt.materials ? `・${P.materials[state.material].name}` : '';
    return [pt.name, `<span class="dot" style="background:${c.hex}"></span>${esc(c.name)}${esc(mat)}`];
  });
  const v = variantOf();
  if (v && !state.shape) rows.unshift([P.variantLabel || '種類', `${esc(v.name)}（${esc(v.size || '')}）`]);
  if (defectsOn() && viewer?.canEditDefects() && shapeOf()) rows.push(['割れと欠け', esc(defectSummary(currentDefects()))]);
  const sh = shapeOf();
  if (sh && (state.shape || P.defaultShape)) {
    rows.unshift([P.variantLabel || '形', `${state.shape ? '写真から作った形' : esc(P.defaultShapeLabel || '見本の形')}（口径 ${sh.rim}cm・高さ ${sh.h.toFixed(1)}cm・高台の直径 ${(sh.rf * 2).toFixed(1)}cm）`]);
  }
  if (P.text && state.text.value) {
    const f = P.text.fonts.find(f => f.id === state.text.font);
    const col = P.text.colors.find(c => c.hex === state.text.color);
    rows.push([P.text.label, `「${esc(state.text.value)}」${esc(f.name)} <span class="dot" style="background:${state.text.color}"></span>${esc(col && col.name !== col.hex ? col.name : '')}`]);
  }
  return rows;
}

function openOrder() {
  $('shots').innerHTML = eff().snapshotViews.map(v => `<img src="${viewer.snapshot(v)}" alt="">`).join('');
  $('spec').innerHTML = specRows().map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('');
  $('sizeSel').innerHTML = '<option value="">選んでください</option>' + eff().sizes.map(s => `<option>${esc(s)}</option>`).join('');
  $('orderErr').textContent = '';
  updateOrderTotal();
  $('orderDlg').showModal();
}
function updateOrderTotal() {
  const q = Math.max(1, Math.min(20, +$('qtyInput').value || 1));
  $('orderTotal').textContent = `合計 ${yen(price().total * q)}`;
}

function submitOrder() {
  const form = $('orderForm');
  const missing = [];
  if (!$('sizeSel').value) missing.push(P.sizeLabel);
  if (!$('nameInput').value.trim()) missing.push('お名前');
  if (!$('mailInput').checkValidity() || !$('mailInput').value) missing.push('メールアドレス');
  const q = +$('qtyInput').value;
  if (!(q >= 1 && q <= 20)) missing.push('数量（1〜20）');
  if (missing.length) { $('orderErr').textContent = `${missing.join('・')}を入力してください。`; return; }
  const no = newOrderNo();
  const ok = store.addOrder({
    no, product: productId, productName: P.name + (state.shape ? ' / 写真から作った器' : variantOf() ? ` / ${variantOf().name}` : ''), at: new Date().toISOString(), status: '受付',
    size: $('sizeSel').value + P.sizeUnit, qty: q, name: $('nameInput').value.trim().slice(0, 40), mail: $('mailInput').value.trim().slice(0, 120),
    total: price().total * q, spec: specRows().map(([k, v]) => [k, v.replace(/<[^>]+>/g, '')]),
    state, thumb: viewer.snapshot('side', 360, 236),
  });
  if (!ok) { $('orderErr').textContent = 'この端末に保存できませんでした。ブラウザの保存領域がいっぱいか、使えない設定になっています。'; return; }
  form.reset();
  $('orderDlg').close();
  $('doneNo').textContent = no;
  $('doneDlg').showModal();
}

// ---------- 起動 ----------
async function main() {
  try {
    const res = await fetch(`products/${productId}.json`);
    if (!res.ok) throw new Error('商品が見つかりません');
    P = normalizeProduct(await res.json());
  } catch (e) {
    $('loading').textContent = '商品の設定を読み込めませんでした。トップに戻って選び直してください。';
    return;
  }
  document.title = `${P.name}のシミュレーター｜しつらえ`;
  $('productName').textContent = P.name;
  $('credit').textContent = P.credit;
  $('slipNo').textContent = 'No. ' + productId.toUpperCase() + '-' + String(P.basePrice ?? P.variants?.[0].basePrice ?? '').slice(0, 3);
  $('sizeLabel').textContent = P.sizeLabel + (P.sizeUnit ? `（${P.sizeUnit}）` : '');
  $('orderBtn').textContent = `${P.sizeLabel}を選んで注文へ`;
  $('orderNote').textContent = P.orderNote || '';
  $('orderNote').hidden = !P.orderNote;
  if (P.text?.placeholder) $('textInput').placeholder = P.text.placeholder;
  const fromUrl = location.hash.startsWith('#d=') ? decodeState(location.hash.slice(3)) : null;
  state = fromUrl || defaultState();
  renderViews();
  if (P.variants) {
    $('variantSec').hidden = false;
    $('variantTitle').textContent = P.variantLabel || '種類';
    $('variants').addEventListener('click', e => {
      const b = e.target.closest('[data-variant]');
      // 写真から作った器を使っているときに種類を押したら、その見本の器に戻す
      if (b && (b.dataset.variant !== state.variant || state.shape)) commit(s => { s.variant = b.dataset.variant; if (s.shape) s.shape = null; });
    });
  }

  viewer = new Viewer($('stage'), effModel());
  try {
    await viewer.init();
  } catch (e) {
    console.error(e);
    $('loading').textContent = '3Dを表示できませんでした。別のブラウザで開くか、端末の設定で WebGL を有効にしてください。';
    return;
  }
  $('loading').hidden = true;
  loadedKey = modelKey();
  if (params.has('debug')) window.__viewer = viewer;
  viewer.setAutoRotate(!matchMedia('(prefers-reduced-motion: reduce)').matches);

  // 写真から器の形を作る（写真はこの端末の中だけで使う）
  if (shapeEnabled()) {
    $('shapeSec').hidden = false;
    $('tipBroken').hidden = !defectsOn();
    $('photoInput').addEventListener('change', e => {
      const file = e.target.files[0];
      e.target.value = '';   // 同じ写真を選び直しても反応するように
      $('shapeErr').textContent = '';
      openPhotoShape(file, {
        // 写真の器を使っていればその口径、無ければ写真用の初期値（徳利の口径などを引き継がない）
        rim: state.shape?.rim || P.photoShape?.defaultRim || shapeOf()?.rim || 12,
        onApply: shape => commit(s => { s.shape = shape; }),
        onError: msg => { $('shapeErr').textContent = msg; },
      });
    });
    $('shapeReset').addEventListener('click', () => commit(s => { s.shape = null; }));
  }

  // 割れをなぞる（金継ぎ）
  if (defectsOn()) {
    $('defectSec').hidden = false;
    $('traceBtn').addEventListener('click', () => enterEdit('trace'));
    $('defectSample').addEventListener('click', () => commit(s => { s.defects = null; }));
    $('defectClear').addEventListener('click', () => commit(s => { s.defects = { cracks: [], chips: [] }; }));
    $('editBar').addEventListener('click', e => {
      const b = e.target.closest('[data-edit]');
      if (b) setEdit(b.dataset.edit);
      const z = e.target.closest('[data-size]');
      if (z) {
        chipSize = +z.dataset.size;
        document.querySelectorAll('#chipSizes [data-size]').forEach(x => x.setAttribute('aria-pressed', x === z));
      }
    });
    $('editDone').addEventListener('click', exitEdit);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && viewer.editMode) exitEdit(); });
    let stroke = null;
    const editDefs = s => (s.defects ? JSON.parse(JSON.stringify(s.defects)) : roundDefects(sampleDefects(shapeOf())));
    viewer.on('editstart', hit => {
      const mode = viewer.editMode, sh = shapeOf();
      if (mode === 'trace') { stroke = [hit]; return; }
      if (mode === 'chip') {
        if (hit.y < sh.h - 0.9) { toast('欠けは口縁の近くをタップしてください'); return; }
        if (currentDefects().chips.length >= 8) { toast('欠けは8か所までです'); return; }
        // 中は角度だけで持つ（古いリンクと同じ形）。小と大は [角度, 大きさ]
        commit(s => { const d = editDefs(s); d.chips.push(chipSize === 1 ? r3(hit.theta, 3) : [r3(hit.theta, 3), chipSize]); s.defects = d; });
        return;
      }
      if (mode === 'erase') {
        const d = currentDefects();
        let best = { kind: null, i: -1, d: 0.5 };
        d.cracks.forEach((pts, i) => { const dd = distToCrack(pts, hit.theta, hit.y, hit.r); if (dd < best.d) best = { kind: 'crack', i, d: dd }; });
        d.chips.forEach((c, i) => {
          const [t, size] = chipOf(c), k = CHIP_SCALE[size];
          const dd = Math.abs((((hit.theta - t + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) * hit.r;
          if (hit.y > sh.h - 1.2 * k[1] && dd < 0.9 * k[0] && dd < best.d + 0.4) best = { kind: 'chip', i, d: dd };
        });
        if (!best.kind) { toast('近くに割れや欠けがありません'); return; }
        commit(s => { const e = editDefs(s); (best.kind === 'crack' ? e.cracks : e.chips).splice(best.i, 1); s.defects = e; });
      }
    });
    viewer.on('editmove', hit => {
      if (!stroke) return;
      if (hit.local.distanceTo(stroke[stroke.length - 1].local) > 0.12) { stroke.push(hit); viewer.setPreview(stroke); }
    });
    viewer.on('editend', () => {
      if (!stroke) return;
      const pts = stroke; stroke = null;
      viewer.setPreview(null);
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += pts[i].local.distanceTo(pts[i - 1].local);
      if (pts.length < 2 || len < 0.5) { toast('もう少し長くなぞってください'); return; }
      if (currentDefects().cracks.length >= 12) { toast('割れは12本までです'); return; }
      // 点が多すぎるとリンクが長くなるので、120点までに間引く
      const step = Math.max(1, Math.ceil(pts.length / 120));
      const kept = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
      // 平らな面（上向き・下向き）でなぞった点は上下に、壁でなぞった点は内外に器を貫く
      commit(s => { const d = editDefs(s); d.cracks.push(kept.map(p => [r3(p.theta, 3), r3(p.y, 2), r3(p.r, 2), Math.abs(p.normal.y) > 0.7 ? 1 : 0])); s.defects = d; });
    });
  }

  // 使い込みのつまみ（値段や発注書には入れず、見た目だけ変える）
  if (P.aging) {
    $('ageSec').hidden = false;
    $('ageTitle').textContent = P.aging.label;
    $('ageNote').textContent = P.aging.note || '';
    $('ageTicks').innerHTML = P.aging.stops.map(s => `<span style="left:${s.at * 100}%">${esc(s.label)}</span>`).join('');
    // 動かし始めた時点の状態を覚えておき、手を離したときに「ひとつ戻す」の履歴へ積む（指・マウス・キーボード共通）
    let before = null;
    $('ageRange').addEventListener('input', e => {
      if (before === null) before = JSON.stringify(state);
      state.age = +e.target.value / 100;
      viewer.setAge(state.age);
      renderAge();
      history.replaceState(null, '', `?p=${productId}#d=${encodeState()}`);
    });
    $('ageRange').addEventListener('change', () => {
      if (before && before !== JSON.stringify(state)) { undoStack.push(before); redoStack.length = 0; $('undoBtn').disabled = false; $('redoBtn').disabled = true; }
      before = null;
    });
  }

  // 配色見本
  P.presets.forEach(pr => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    const dots = P.presetDots.map(id => {
      const pt = P.parts.find(p => p.id === id);
      return `<i style="background:${colorOf(pt, pr.colors[id]).hex}"></i>`;
    }).join('');
    b.innerHTML = `<span class="preset-dots">${dots}</span>${esc(pr.name)}`;
    b.addEventListener('click', () => commit(s => {
      Object.assign(s.colors, pr.colors); s.material = pr.material;
      if (P.aging && typeof pr.age === 'number') s.age = pr.age;
    }));
    $('presets').appendChild(b);
  });

  if (P.text) {
    $('textTitle').textContent = P.text.label;
    $('textNote').textContent = `${P.text.maxLength}文字まで。入れると +${yen(P.text.price)}`;
    let before = null;
    $('textInput').addEventListener('focus', () => { before = JSON.stringify(state); });
    $('textInput').addEventListener('input', e => {
      const v = [...e.target.value].slice(0, P.text.maxLength).join('');
      if (v !== e.target.value) e.target.value = v;
      state.text.value = v;
      apply();
    });
    // 入力欄を離れたときに画面を描き直すと、次に押したボタンのクリックが空振りするため、戻すボタンの状態だけ変える
    $('textInput').addEventListener('change', () => {
      if (before && before !== JSON.stringify(state)) {
        undoStack.push(before); redoStack.length = 0;
        $('undoBtn').disabled = false; $('redoBtn').disabled = true;
      }
      before = null;
    });
  } else $('textSec').hidden = true;

  viewer.on('pick', idx => {
    const pt = P.parts.find(p => p.index === idx);
    if (!pt) return;
    openPart = pt.id;
    viewer.select(idx);
    renderParts();
    // スマホでは3Dの下に色選びが見えるよう、部位の行を上端に寄せる
    const narrow = matchMedia('(max-width: 860px)').matches;
    document.querySelector('.part.open')?.scrollIntoView({ block: narrow ? 'start' : 'nearest', behavior: 'smooth' });
  });
  viewer.on('hover', ({ index, x, y }) => {
    const tip = $('tip');
    const pt = P.parts.find(p => p.index === index);
    if (!pt) { tip.hidden = true; return; }
    const r = $('stage').getBoundingClientRect();
    tip.hidden = false;
    tip.textContent = pt.name;
    tip.style.transform = `translate(${x - r.left + 14}px, ${y - r.top + 14}px)`;
  });

  $('views').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) viewer.view(b.dataset.view); });
  $('undoBtn').addEventListener('click', () => { if (undoStack.length) { redoStack.push(JSON.stringify(state)); restore(undoStack.pop()); } });
  $('redoBtn').addEventListener('click', () => { if (redoStack.length) { undoStack.push(JSON.stringify(state)); restore(redoStack.pop()); } });
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? $('redoBtn') : $('undoBtn')).click(); }
  });
  // 「最初に戻す」は配色だけを戻し、選んでいる器の種類はそのままにする
  $('resetBtn').addEventListener('click', () => commit(s => Object.assign(s, defaultState(), s.variant ? { variant: s.variant } : {}, s.shape ? { shape: s.shape } : {})));
  $('shuffleBtn').addEventListener('click', () => commit(s => {
    P.parts.forEach(pt => {
      const pal = P.palettes[pt.palette];
      s.colors[pt.id] = pal[Math.floor(Math.random() * pal.length)].id;
    });
  }));
  $('shareBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('このデザインのリンクをコピーしました'); }
    catch { prompt('このリンクをコピーしてください', location.href); }
  });
  $('saveBtn').addEventListener('click', () => {
    const n = store.saved(productId).length + 1;
    const ok = store.addSaved({ id: Date.now().toString(36), product: productId, label: `デザイン ${n}`, state, thumb: viewer.snapshot('side', 240, 158) });
    toast(ok ? 'この端末にデザインを保存しました' : '保存できませんでした。ブラウザの保存領域を確認してください');
    renderSaved();
  });
  $('orderBtn').addEventListener('click', openOrder);
  $('qtyInput').addEventListener('input', updateOrderTotal);
  $('submitBtn').addEventListener('click', submitOrder);
  $('printBtn').addEventListener('click', () => window.print());
  $('doneClose').addEventListener('click', () => $('doneDlg').close());

  renderSaved();
  apply();
  document.body.dataset.ready = '1';
}

main();
