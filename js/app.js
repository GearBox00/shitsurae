// シミュレーター画面の操作。状態は1つのオブジェクトにまとめ、URLにも書き出す。
import { Viewer } from './viewer.js';
import { store, yen, newOrderNo, safeImg } from './store.js';

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
  return s;
}

// 器の種類（variants）がある商品は、選んだ種類の設定で上書きした「今の商品」を使う
function eff() {
  const v = P.variants?.find(v => v.id === state?.variant);
  if (!v) return P;
  const e = { ...P, ...v, name: P.name };
  if (P.text) e.text = { ...P.text, depth: v.textDepth ?? P.text.depth };
  return e;
}
const variantOf = () => P.variants?.find(v => v.id === state.variant);

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
  if (P.text && obj.text) {
    if (typeof obj.text.value === 'string') s.text.value = obj.text.value.slice(0, P.text.maxLength);
    if (P.text.fonts.some(f => f.id === obj.text.font)) s.text.font = obj.text.font;
    if (P.text.colors.some(c => c.hex === obj.text.color)) s.text.color = obj.text.color;
  }
  return s;
}

// ---------- 反映 ----------
let textTimer, loadedVariant, modelQueue = Promise.resolve();
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

async function syncModel() {
  if (!P.variants || loadedVariant === state.variant) return;
  const want = state.variant;
  $('loading').hidden = false;
  $('loading').textContent = '器を読み込んでいます';
  await viewer.loadModel(eff());
  loadedVariant = want;
  $('loading').hidden = true;
  renderViews();
  viewer.view('side');
  if (state.variant !== want) return syncModel();
}

function applyLooks() {
  viewer.setAge(state.age || 0);
  P.parts.forEach(pt => {
    const c = colorOf(pt, state.colors[pt.id]);
    viewer.setPart(pt.index, c.hex, lookOf(pt, c));
  });
  clearTimeout(textTimer);
  textTimer = setTimeout(() => {
    if (!P.text) return;
    const E = eff();
    const f = E.text.fonts.find(f => f.id === state.text.font);
    const col = E.text.colors.find(c => c.hex === state.text.color);
    viewer.setText(E.text, state.text.value, f.css, state.text.color, col?.metal || 0);
  }, 200);
}

function renderViews() {
  $('views').innerHTML = eff().viewButtons.map(v => `<button type="button" data-view="${esc(v.id)}">${esc(v.label)}</button>`).join('');
}

function renderVariants() {
  if (!P.variants) return;
  $('variants').innerHTML = P.variants.map(v => `
    <button type="button" class="variant" role="radio" aria-checked="${v.id === state.variant}" data-variant="${esc(v.id)}">
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

function render() {
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
  if (v) rows.unshift([P.variantLabel || '種類', `${esc(v.name)}（${esc(v.size || '')}）`]);
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
    no, product: productId, productName: P.name + (variantOf() ? ` / ${variantOf().name}` : ''), at: new Date().toISOString(), status: '受付',
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
      if (b && b.dataset.variant !== state.variant) commit(s => { s.variant = b.dataset.variant; });
    });
  }

  viewer = new Viewer($('stage'), eff());
  try {
    await viewer.init();
  } catch (e) {
    console.error(e);
    $('loading').textContent = '3Dを表示できませんでした。別のブラウザで開くか、端末の設定で WebGL を有効にしてください。';
    return;
  }
  $('loading').hidden = true;
  loadedVariant = state.variant;
  if (params.has('debug')) window.__viewer = viewer;
  viewer.setAutoRotate(!matchMedia('(prefers-reduced-motion: reduce)').matches);

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
  $('resetBtn').addEventListener('click', () => commit(s => Object.assign(s, defaultState(), s.variant ? { variant: s.variant } : {})));
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
