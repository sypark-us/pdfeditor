// Application shell: wires the viewer, annotation editor and all tool panels together.
import '../vendor/pdfjs/pdf.min.mjs';
import { $, $$, el, readFileBytes, readFileText, readFileDataURL, downloadBytes, downloadBlob, baseName, formatBytes, parsePageRanges, parseRangeGroups, makeZip, normalizeImageFile, canvasToBytes, PAGE_SIZES, sleep } from './util.js';
import { Viewer, pageSizeLabel } from './viewer.js';
import { Annotator, applyAnnotations } from './annot.js';
import * as T from './pdftools.js';
import { isEncrypted, decryptPdf, encryptPdf } from './pdfraw.js';
import { readDocx, readXlsx, readPptx, readHtml, readMarkdown, readText } from './docmodel.js';
import { writeDocx } from './docxwriter.js';
import { renderDocToPdf } from './pdfwriter.js';
import { pdfToDoc, pdfToText } from './pdf2doc.js';
import { writeHtml, writePptx } from './writers.js';
import { customFonts, addCustomFont, removeCustomFont, listLocalFonts, loadLocalFont, onFontsChanged } from './fonts.js';
import { ocrPdf, OCR_LANGS } from './ocr.js';

const pdfjsLib = globalThis.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.mjs';

// ---------------------------------------------------------------- state & UI helpers
const state = { name: 'document.pdf', bytes: null, history: [], future: [], activeTool: null, selected: new Set(), wasEncrypted: false, lastAnchor: null };
const viewer = new Viewer($('#viewer'), $('#thumbs'));
const annotator = new Annotator(viewer, {
  onChange: () => { refreshAnnotList(); $('#btn-apply').disabled = !annotator.hasAnnotations() && !annotator.getCrop(); },
  onSelect: (a) => syncStyleFromAnnot(a),
  onTextPrompt: (title, value) => promptText(title, value),
});
annotator.onNeedImage = () => pickImageForTool();
annotator.onToolChange = (t) => setAnnotTool(t);

let toastTimer = null;
function toast(msg, kind = '') {
  $$('.toast').forEach((t) => t.remove());
  const t = el('div', { class: `toast ${kind}` }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3000);
}
function status(msg) { $('#status').textContent = msg || ''; }
async function busy(label, fn) {
  const box = $('#busy'); $('#busy-label').textContent = label; $('#busy-bar').style.width = '0%'; box.hidden = false;
  const progress = (frac, msg) => { if (frac != null) $('#busy-bar').style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`; if (msg) $('#busy-label').textContent = msg; };
  try { return await fn(progress); }
  catch (e) { console.error(e); toast(e && e.message ? e.message : String(e), 'error'); throw e; }
  finally { box.hidden = true; }
}
function modal({ title, body, actions, onClose }) {
  const root = $('#modal-root');
  const back = el('div', { class: 'modal-back' });
  const m = el('div', { class: 'modal' }, el('h3', {}, title), el('div', { class: 'body' }, body));
  const act = el('div', { class: 'actions' });
  const close = (v) => { back.remove(); if (onClose) onClose(v); };
  for (const a of actions || [{ label: 'Close', value: null }]) act.append(el('button', { class: a.primary ? 'primary' : '', onClick: async () => { if (a.onClick) { const r = await a.onClick(); if (r === false) return; close(r); } else close(a.value); } }, a.label));
  m.append(act);
  back.append(m);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(null); });
  root.append(back);
  return { close, el: m };
}
function promptText(title, value = '', opts = {}) {
  return new Promise((res) => {
    const ta = opts.password ? el('input', { type: 'password', class: 'wide', value }) : el('textarea', { class: 'wide' });
    if (!opts.password) ta.value = value;
    const m = modal({ title, body: el('div', {}, opts.message ? el('p', {}, opts.message) : null, ta), actions: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, onClick: () => ta.value }], onClose: res });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (opts.password || !e.shiftKey)) { e.preventDefault(); m.close(ta.value); } });
    setTimeout(() => ta.focus(), 30);
  });
}
function confirmDialog(title, message, okLabel = 'OK') {
  return new Promise((res) => modal({ title, body: el('p', {}, message), actions: [{ label: 'Cancel', value: false }, { label: okLabel, primary: true, value: true }], onClose: (v) => res(!!v) }));
}
function pickFiles({ accept = '', multiple = false } = {}) {
  return new Promise((res) => {
    const inp = $('#file-input');
    inp.accept = accept; inp.multiple = multiple; inp.value = '';
    inp.onchange = () => res(Array.from(inp.files));
    inp.click();
  });
}

// results list
const results = [];
function addResult(r) {
  results.unshift(r);
  renderResults();
  return r;
}
function renderResults() {
  const box = $('#results');
  box.innerHTML = '';
  if (!results.length) return;
  const title = el('div', { class: 'results-title' }, el('span', {}, 'Results'), el('span', {}, results.length > 1 ? el('button', { onClick: async () => { const z = makeZip(); for (const r of results) z.add(r.name, r.bytes); downloadBlob(await z.blob(), 'pdfeditor-results.zip'); } }, 'ZIP all') : null, ' ', el('button', { onClick: () => { results.length = 0; renderResults(); } }, 'Clear')));
  box.append(title);
  for (const r of results) {
    const row = el('div', { class: 'result' }, el('span', { class: 'nm', title: r.name }, r.name), el('span', { class: 'sz' }, formatBytes(r.bytes.length)));
    if (r.type === 'application/pdf') row.append(el('button', { onClick: () => openBytes(r.bytes, r.name), title: 'Open in the editor' }, 'Open'));
    row.append(el('button', { class: 'primary', onClick: () => downloadBytes(r.bytes, r.name, r.type) }, '⤓'));
    box.append(row);
  }
}
const pdfResult = (bytes, name) => addResult({ name, bytes, type: 'application/pdf' });

// ---------------------------------------------------------------- document lifecycle
async function openFile(file) {
  const bytes = await readFileBytes(file);
  const name = file.name || 'document.pdf';
  if (/\.pdf$/i.test(name) || bytes[0] === 0x25) return openBytes(bytes, name);
  // Non-PDF: convert then open
  const ext = (name.split('.').pop() || '').toLowerCase();
  const conv = { docx: 'word2pdf', xlsx: 'xlsx2pdf', pptx: 'pptx2pdf', html: 'html2pdf', htm: 'html2pdf', txt: 'text2pdf', md: 'text2pdf', markdown: 'text2pdf', png: 'img2pdf', jpg: 'img2pdf', jpeg: 'img2pdf', webp: 'img2pdf', gif: 'img2pdf', bmp: 'img2pdf', svg: 'img2pdf' }[ext];
  if (!conv) { toast(`Unsupported file type: .${ext}`, 'error'); return; }
  const out = await convertFileToPdf(conv, [file]);
  if (out) await openBytes(out, baseName(name, 'pdf'));
}
async function openBytes(bytes, name, opts = {}) {
  if (annotator.hasAnnotations() && state.bytes && !opts.force) { const ok = await confirmDialog('Discard annotations?', 'The current document has unapplied annotations. Open the new file anyway?', 'Open'); if (!ok) return; }
  let working = bytes, wasEncrypted = false;
  if (isEncrypted(bytes)) {
    let password = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await busy('Decrypting…', () => decryptPdf(bytes, password));
        const doc = await T.loadDoc(r.bytes);
        working = await T.saveDoc(doc);
        wasEncrypted = true;
        toast(password ? 'Password accepted. Working on an unlocked copy.' : 'Owner-restricted PDF opened as an unlocked copy.');
        break;
      } catch (e) {
        if (!/password/i.test(e.message)) { toast(`Could not decrypt: ${e.message}`, 'error'); return; }
        const pw = await promptText('Password required', '', { password: true, message: attempt ? 'Incorrect password. Try again.' : 'This PDF is encrypted. Enter the user or owner password.' });
        if (pw == null) return;
        password = pw;
      }
    }
    if (!wasEncrypted) return;
  }
  await busy('Loading PDF…', async () => {
    await viewer.load(working);
  });
  state.bytes = working; state.name = name; state.history = []; state.future = []; state.wasEncrypted = wasEncrypted; state.selected.clear();
  annotator.reset();
  $('#dropzone').classList.add('hidden');
  $('#doc-name').textContent = name;
  $('#page-count').textContent = viewer.numPages;
  $('#page-input').value = 1;
  $('#btn-save').disabled = false; $('#btn-print').disabled = false;
  updateUndoButtons();
  refreshAnnotList();
  for (const b of $$('.tool-item')) b.disabled = false;
  status(`${name} · ${viewer.numPages} page${viewer.numPages === 1 ? '' : 's'} · ${formatBytes(working.length)} · ${viewer.pages[0] ? pageSizeLabel(viewer.pages[0].baseViewport) : ''}`);
  if (state.activeTool && state.activeTool.refresh) state.activeTool.refresh();
}
async function applyDoc(newBytes, label) {
  const keepPage = viewer.currentIndex;
  state.history.push(state.bytes); if (state.history.length > 30) state.history.shift();
  state.future = [];
  state.bytes = newBytes;
  annotator.reset();
  await busy('Refreshing…', () => viewer.load(newBytes));
  $('#page-count').textContent = viewer.numPages;
  viewer.goTo(Math.min(keepPage, viewer.numPages - 1));
  updateUndoButtons();
  refreshAnnotList();
  if (label) toast(label);
  status(`${state.name} · ${viewer.numPages} pages · ${formatBytes(newBytes.length)}`);
  if (state.activeTool && state.activeTool.refresh) state.activeTool.refresh();
}
function updateUndoButtons() { $('#btn-undo').disabled = !state.history.length; $('#btn-redo').disabled = !state.future.length; }
async function undoDoc() { if (!state.history.length) return; state.future.push(state.bytes); const b = state.history.pop(); state.bytes = b; annotator.reset(); await busy('Undo…', () => viewer.load(b)); $('#page-count').textContent = viewer.numPages; updateUndoButtons(); refreshAnnotList(); }
async function redoDoc() { if (!state.future.length) return; state.history.push(state.bytes); const b = state.future.pop(); state.bytes = b; annotator.reset(); await busy('Redo…', () => viewer.load(b)); $('#page-count').textContent = viewer.numPages; updateUndoButtons(); refreshAnnotList(); }
async function applyPendingAnnotations() {
  if (!annotator.hasAnnotations()) return false;
  const out = await busy('Applying annotations…', () => applyAnnotations(state.bytes, annotator.annots));
  await applyDoc(out, 'Annotations applied');
  return true;
}
async function saveDocument() {
  if (!state.bytes) return;
  if (annotator.hasAnnotations()) await applyPendingAnnotations();
  downloadBytes(state.bytes, state.name.endsWith('.pdf') ? state.name : `${baseName(state.name)}.pdf`, 'application/pdf');
}
function printDocument() {
  if (!state.bytes) return;
  const url = URL.createObjectURL(new Blob([state.bytes], { type: 'application/pdf' }));
  const frame = el('iframe', { style: { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' }, src: url });
  frame.onload = () => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { window.open(url, '_blank'); } };
  document.body.append(frame);
  setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60000);
}
const requireDoc = () => { if (!state.bytes) { toast('Open a PDF first', 'error'); throw new Error('No document'); } return state.bytes; };
const pagesFromInput = (text) => (!text || /^all$/i.test(text.trim()) ? viewer.pages.map((p) => p.index) : parsePageRanges(text, viewer.numPages));

// ---------------------------------------------------------------- annotation toolbar
function setAnnotTool(tool) {
  annotator.setTool(tool);
  for (const b of $$('#annot-tools button')) b.classList.toggle('active', b.dataset.tool === tool);
  if (tool === 'image') pickImageForTool();
  if (tool === 'signature' && !(annotator.pendingImage && annotator.pendingImage.kind === 'signature')) signatureDialog();
  status(tool === 'select' ? '' : ({ text: 'Click on the page to add text. Enter commits, Shift+Enter adds a line.', crop: 'Drag a box on a page, then use the Crop tool panel to apply it.', image: 'Click on the page to place the image.', signature: 'Click on the page to place your signature.', redact: 'Drag boxes over content to remove. Applying rasterises those pages so the text is truly gone.', note: 'Click where the note should go.' }[tool] || 'Drag on a page to draw. Hold Shift to constrain.'));
}
$$('#annot-tools button').forEach((b) => b.addEventListener('click', () => setAnnotTool(b.dataset.tool)));
async function pickImageForTool() {
  const [file] = await pickFiles({ accept: 'image/*' });
  if (!file) { setAnnotTool('select'); return; }
  const img = await normalizeImageFile(file);
  annotator.pendingImage = { ...img, dataUrl: await readFileDataURL(file), kind: 'image' };
  if (annotator.tool !== 'image') setAnnotTool('image');
}
function syncStyleFromAnnot(a) {
  if (!a) return;
  if (a.color) $('#st-color').value = a.color;
  if (a.strokeWidth) $('#st-width').value = a.strokeWidth;
  if (a.opacity != null) $('#st-opacity').value = a.opacity;
  if (a.type === 'text') { $('#st-size').value = a.size; $('#st-family').value = a.family || 'sans'; $('#st-bold').classList.toggle('active', !!a.bold); $('#st-italic').classList.toggle('active', !!a.italic); }
}
$('#st-color').addEventListener('input', (e) => annotator.setStyle({ color: e.target.value }));
const fillSync = () => annotator.setStyle({ fill: $('#st-fill-on').checked ? $('#st-fill').value : '' });
$('#st-fill').addEventListener('input', () => { $('#st-fill-on').checked = true; fillSync(); });
$('#st-fill-on').addEventListener('change', fillSync);
$('#st-width').addEventListener('input', (e) => annotator.setStyle({ strokeWidth: Number(e.target.value) || 1 }));
$('#st-opacity').addEventListener('input', (e) => annotator.setStyle({ opacity: Number(e.target.value) }));
$('#st-size').addEventListener('input', (e) => annotator.setStyle({ fontSize: Number(e.target.value) || 12 }));
$('#st-family').addEventListener('change', (e) => annotator.setStyle({ family: e.target.value }));
$('#st-bold').addEventListener('click', (e) => { e.currentTarget.classList.toggle('active'); annotator.setStyle({ bold: e.currentTarget.classList.contains('active') }); });
$('#st-italic').addEventListener('click', (e) => { e.currentTarget.classList.toggle('active'); annotator.setStyle({ italic: e.currentTarget.classList.contains('active') }); });
$('#btn-annot-undo').addEventListener('click', () => annotator.undo());
$('#btn-annot-redo').addEventListener('click', () => annotator.redo());
$('#btn-apply').addEventListener('click', async () => { if (annotator.getCrop() && !annotator.hasAnnotations()) { openTool('crop'); return; } await applyPendingAnnotations(); });
function refreshAnnotList() {
  const box = $('#annot-list');
  box.innerHTML = '';
  const items = annotator.summary();
  if (!items.length) { box.append(el('p', { class: 'hint' }, 'No annotations yet. Use the toolbar above the document.')); return; }
  for (const { page, a } of items) {
    const label = a.type === 'text' ? `“${a.text.slice(0, 30)}”` : a.type === 'note' ? `Note: ${a.text.slice(0, 30)}` : a.type;
    box.append(el('div', { class: 'ai', onClick: () => { viewer.goTo(page); annotator.select(a); } }, el('span', { class: 'pg' }, `p.${page + 1}`), el('span', { class: 't' }, label), el('button', { title: 'Delete', onClick: (e) => { e.stopPropagation(); annotator.remove(a); } }, '×')));
  }
}
$$('#tab-annots [data-act]').forEach((b) => b.addEventListener('click', () => { if (b.dataset.act === 'apply') applyPendingAnnotations(); else if (confirm('Remove all annotations?')) annotator.clearAll(); }));

// signature dialog
async function signatureDialog() {
  return new Promise((resolve) => {
    let mode = 'draw';
    const pad = el('canvas', { class: 'sig-pad', width: 600, height: 180 });
    const pctx = pad.getContext('2d');
    let drawing = false, last = null, strokes = 0;
    const pos = (e) => { const r = pad.getBoundingClientRect(); return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height }; };
    pad.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); pad.setPointerCapture(e.pointerId); });
    pad.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); pctx.strokeStyle = colorIn.value; pctx.lineWidth = 3; pctx.lineCap = 'round'; pctx.lineJoin = 'round'; pctx.beginPath(); pctx.moveTo(last.x, last.y); pctx.lineTo(p.x, p.y); pctx.stroke(); last = p; strokes++; });
    pad.addEventListener('pointerup', () => { drawing = false; });
    const colorIn = el('input', { type: 'color', value: '#1a237e' });
    const typeIn = el('input', { type: 'text', class: 'wide', placeholder: 'Type your name' });
    const fontSel = el('select', {}, ...['Brush Script MT, cursive', 'Segoe Script, cursive', 'Lucida Handwriting, cursive', 'Comic Sans MS, cursive', 'Georgia, serif'].map((f) => el('option', { value: f }, f.split(',')[0])));
    const preview = el('div', { class: 'sig-type-preview' });
    const updatePreview = () => { preview.textContent = typeIn.value || 'Signature'; preview.style.fontFamily = fontSel.value; preview.style.color = colorIn.value; };
    typeIn.addEventListener('input', updatePreview); fontSel.addEventListener('change', updatePreview); colorIn.addEventListener('input', updatePreview);
    updatePreview();
    let uploaded = null;
    const upInfo = el('span', { class: 'muted' }, 'No image chosen');
    const removeBg = el('input', { type: 'checkbox', checked: true });
    const views = {
      draw: el('div', {}, pad, el('div', { class: 'row', style: { marginTop: '6px' } }, el('button', { onClick: () => { pctx.clearRect(0, 0, pad.width, pad.height); strokes = 0; } }, 'Clear'), el('label', {}, 'Ink ', colorIn))),
      type: el('div', {}, typeIn, el('div', { class: 'row', style: { margin: '6px 0' } }, fontSel), preview),
      upload: el('div', {}, el('button', { onClick: async () => { const [f] = await pickFiles({ accept: 'image/*' }); if (f) { uploaded = f; upInfo.textContent = f.name; } } }, 'Choose image…'), ' ', upInfo, el('div', { style: { marginTop: '8px' } }, el('label', {}, removeBg, ' Make white background transparent'))),
    };
    const content = el('div', {});
    const tabs = el('div', { class: 'sig-tabs' });
    const show = (m) => { mode = m; content.innerHTML = ''; content.append(views[m]); for (const b of tabs.children) b.classList.toggle('active', b.dataset.m === m); };
    for (const [m, label] of [['draw', 'Draw'], ['type', 'Type'], ['upload', 'Upload']]) tabs.append(el('button', { dataset: { m }, onClick: () => show(m) }, label));
    show('draw');
    const build = async () => {
      let canvas;
      if (mode === 'draw') { if (!strokes) { toast('Draw your signature first', 'error'); return false; } canvas = trimCanvas(pad); }
      else if (mode === 'type') {
        if (!typeIn.value.trim()) { toast('Type your name first', 'error'); return false; }
        canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 300;
        const c = canvas.getContext('2d'); c.font = `120px ${fontSel.value}`; c.fillStyle = colorIn.value; c.textBaseline = 'middle'; c.fillText(typeIn.value, 20, 150);
        canvas = trimCanvas(canvas);
      } else {
        if (!uploaded) { toast('Choose an image first', 'error'); return false; }
        const img = await normalizeImageFile(uploaded);
        const bmp = await createImageBitmap(new Blob([img.bytes]));
        canvas = document.createElement('canvas'); canvas.width = bmp.width; canvas.height = bmp.height;
        const c = canvas.getContext('2d'); c.drawImage(bmp, 0, 0);
        if (removeBg.checked) { const id = c.getImageData(0, 0, canvas.width, canvas.height); const d = id.data; for (let i = 0; i < d.length; i += 4) { const lum = (d[i] + d[i + 1] + d[i + 2]) / 3; if (lum > 225) d[i + 3] = 0; else if (lum > 170) d[i + 3] = Math.round(255 * (225 - lum) / 55); } c.putImageData(id, 0, 0); canvas = trimCanvas(canvas); }
      }
      const bytes = await canvasToBytes(canvas, 'image/png');
      annotator.pendingImage = { bytes, type: 'png', dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, kind: 'signature' };
      setAnnotTool('signature');
      return true;
    };
    modal({ title: 'Create signature', body: el('div', { style: { width: '600px', maxWidth: '85vw' } }, tabs, content), actions: [{ label: 'Cancel', value: null }, { label: 'Use signature', primary: true, onClick: build }], onClose: resolve });
  });
}
function trimCanvas(c) {
  const ctx = c.getContext('2d'); const id = ctx.getImageData(0, 0, c.width, c.height); const d = id.data;
  let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 <= x0) return c;
  const pad = 8; const out = document.createElement('canvas'); out.width = x1 - x0 + 1 + pad * 2; out.height = y1 - y0 + 1 + pad * 2;
  out.getContext('2d').drawImage(c, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pad, pad, x1 - x0 + 1, y1 - y0 + 1);
  return out;
}

// fonts dialog
async function fontsDialog() {
  const list = el('div', { class: 'font-list' });
  const render = () => { list.innerHTML = ''; if (!customFonts.length) list.append(el('div', { class: 'muted' }, 'No fonts added. Standard PDF fonts cover Latin text; other scripts fall back to rasterised text unless you add a font here.')); for (const f of customFonts) list.append(el('div', {}, f.name, ' ', el('button', { style: { float: 'right', padding: '0 6px' }, onClick: () => { removeCustomFont(f.name); render(); } }, '×'))); };
  render();
  const body = el('div', { style: { width: '460px', maxWidth: '85vw' } },
    el('p', {}, 'Fonts added here are embedded when you add text, OCR layers, watermarks or convert documents containing non-Latin characters (e.g. Korean, Japanese, Chinese).'),
    list,
    el('div', { class: 'row', style: { marginTop: '10px' } },
      el('button', { onClick: async () => { const files = await pickFiles({ accept: '.ttf,.otf,.woff', multiple: true }); for (const f of files) addCustomFont(f.name.replace(/\.[^.]+$/, ''), await readFileBytes(f)); render(); } }, 'Add font file (.ttf / .otf)'),
      el('button', { onClick: async () => {
        try {
          const fams = await listLocalFonts();
          const pick = el('div', { class: 'font-list', style: { maxHeight: '320px' } });
          for (const [family, faces] of [...fams.entries()].sort((a, b) => a[0].localeCompare(b[0]))) pick.append(el('div', { onClick: async () => { const face = faces.find((f) => /regular|normal/i.test(f.style)) || faces[0]; try { addCustomFont(family, await loadLocalFont(face)); render(); m2.close(); } catch (e) { toast(e.message, 'error'); } } }, family));
          const m2 = modal({ title: 'Installed fonts', body: pick, actions: [{ label: 'Close', value: null }] });
        } catch (e) { toast(e.message, 'error'); }
      } }, 'Pick an installed font')));
  modal({ title: 'Fonts', body, actions: [{ label: 'Done', primary: true, value: true }] });
}
$('#btn-fonts').addEventListener('click', fontsDialog);
onFontsChanged(() => status(`${customFonts.length} custom font(s) loaded`));

// ---------------------------------------------------------------- pages tab
viewer.onReady = () => {
  for (const p of viewer.pages) {
    const t = p.thumb;
    t.draggable = true;
    t.addEventListener('click', (e) => {
      if (e.shiftKey && state.lastAnchor != null) { const [a, b] = [state.lastAnchor, p.index].sort((x, y) => x - y); for (let i = a; i <= b; i++) state.selected.add(i); }
      else if (e.ctrlKey || e.metaKey) { if (state.selected.has(p.index)) state.selected.delete(p.index); else state.selected.add(p.index); }
      else { state.selected.has(p.index) && state.selected.size === 1 ? state.selected.delete(p.index) : (state.selected.clear(), state.selected.add(p.index)); }
      state.lastAnchor = p.index;
      refreshSelection();
    });
    t.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(p.index)); e.dataTransfer.effectAllowed = 'move'; });
    t.addEventListener('dragover', (e) => { e.preventDefault(); t.classList.add('drag-over'); });
    t.addEventListener('dragleave', () => t.classList.remove('drag-over'));
    t.addEventListener('drop', async (e) => {
      e.preventDefault(); t.classList.remove('drag-over');
      const from = Number(e.dataTransfer.getData('text/plain')); const to = p.index;
      if (!Number.isInteger(from) || from === to) return;
      const moving = state.selected.has(from) && state.selected.size > 1 ? [...state.selected].sort((a, b) => a - b) : [from];
      const rest = viewer.pages.map((x) => x.index).filter((i) => !moving.includes(i));
      let insertAt = rest.indexOf(to); if (insertAt < 0) insertAt = rest.length; if (from < to) insertAt += 1;
      const order = [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
      state.selected.clear();
      await applyDoc(await T.reorderPages(state.bytes, order), 'Pages reordered');
    });
  }
  refreshSelection();
};
function refreshSelection() { for (const p of viewer.pages) p.thumb.classList.toggle('selected', state.selected.has(p.index)); }
const selectedOrCurrent = () => (state.selected.size ? [...state.selected].sort((a, b) => a - b) : [viewer.currentIndex]);
$$('#tab-pages [data-act]').forEach((b) => b.addEventListener('click', async () => {
  if (!state.bytes) return;
  const act = b.dataset.act;
  const sel = selectedOrCurrent();
  try {
    if (act === 'select-all') { viewer.pages.forEach((p) => state.selected.add(p.index)); refreshSelection(); }
    else if (act === 'select-none') { state.selected.clear(); refreshSelection(); }
    else if (act === 'rotate-left') await applyDoc(await T.rotatePages(state.bytes, sel, -90), 'Rotated');
    else if (act === 'rotate-right') await applyDoc(await T.rotatePages(state.bytes, sel, 90), 'Rotated');
    else if (act === 'delete') { if (await confirmDialog('Delete pages', `Delete ${sel.length} page(s)?`, 'Delete')) { state.selected.clear(); await applyDoc(await T.deletePages(state.bytes, sel), 'Pages deleted'); } }
    else if (act === 'duplicate') await applyDoc(await T.duplicatePages(state.bytes, sel), 'Pages duplicated');
    else if (act === 'extract') pdfResult(await T.extractPages(state.bytes, sel), `${baseName(state.name)}-pages.pdf`);
    else if (act === 'blank') await applyDoc(await T.insertBlankPage(state.bytes, sel[sel.length - 1] + 1), 'Blank page inserted');
  } catch (e) { toast(e.message, 'error'); }
}));

// ---------------------------------------------------------------- form helpers for tool panels
function field(label, input, opts = {}) { const f = el('div', { class: `field${opts.inline ? ' inline' : ''}` }, el('span', {}, label), input); if (opts.hint) f.append(el('span', { class: 'hint' }, opts.hint)); return f; }
const text = (value = '', attrs = {}) => el('input', { type: 'text', value, ...attrs });
const number = (value, attrs = {}) => el('input', { type: 'number', value, ...attrs });
const select = (options, value) => { const s = el('select', {}, ...options.map(([v, l]) => el('option', { value: v }, l))); if (value != null) s.value = value; return s; };
const checkbox = (checked = false) => el('input', { type: 'checkbox', checked });
const color = (value) => el('input', { type: 'color', value });
const pagesInput = () => text('all', { placeholder: 'all, or e.g. 1-3, 5' });
const runButton = (label, fn) => el('button', { class: 'primary run', onClick: async () => { try { await fn(); } catch (e) { if (e.message !== 'No document') toast(e.message, 'error'); console.error(e); } } }, label);
function fileList({ accept, multiple = true, label = 'Add files…' }) {
  const files = [];
  const box = el('div', { class: 'file-list' });
  const render = () => {
    box.innerHTML = '';
    if (!files.length) { box.append(el('div', { class: 'empty' }, 'No files added')); return; }
    files.forEach((f, i) => box.append(el('div', { class: 'item' }, el('span', { class: 'nm', title: f.name }, `${i + 1}. ${f.name}`), el('span', { class: 'muted' }, formatBytes(f.size)), el('button', { title: 'Move up', disabled: i === 0, onClick: () => { [files[i - 1], files[i]] = [files[i], files[i - 1]]; render(); } }, '↑'), el('button', { title: 'Move down', disabled: i === files.length - 1, onClick: () => { [files[i + 1], files[i]] = [files[i], files[i + 1]]; render(); } }, '↓'), el('button', { title: 'Remove', onClick: () => { files.splice(i, 1); render(); } }, '×'))));
  };
  render();
  const btn = el('button', { onClick: async () => { const picked = await pickFiles({ accept, multiple }); if (!multiple) files.length = 0; files.push(...picked); render(); } }, label);
  const wrap = el('div', {}, box, btn);
  return { el: wrap, files, add: (fs) => { files.push(...fs); render(); } };
}

// ---------------------------------------------------------------- conversions to PDF
async function fileToDocModel(kind, file, opts = {}) {
  if (kind === 'word2pdf') return readDocx(await readFileBytes(file));
  if (kind === 'xlsx2pdf') return readXlsx(await readFileBytes(file));
  if (kind === 'pptx2pdf') return readPptx(await readFileBytes(file));
  if (kind === 'html2pdf') return readHtml(await readFileText(file));
  if (kind === 'text2pdf') { const t = await readFileText(file); return /\.(md|markdown)$/i.test(file.name) || opts.markdown ? readMarkdown(t) : readText(t, opts); }
  throw new Error('Unsupported conversion');
}
async function convertFileToPdf(kind, files, opts = {}) {
  if (kind === 'img2pdf') return busy('Building PDF…', () => T.imagesToPdf(files, opts));
  const file = files[0];
  return busy(`Converting ${file.name}…`, async (progress) => {
    const doc = await fileToDocModel(kind, file, opts);
    if (opts.pageSize && PAGE_SIZES[opts.pageSize] && kind !== 'pptx2pdf') { let [w, h] = PAGE_SIZES[opts.pageSize]; if (opts.landscape) [w, h] = [h, w]; doc.pageWidth = w; doc.pageHeight = h; }
    return renderDocToPdf(doc, { onProgress: (f) => progress(f) });
  });
}

// ---------------------------------------------------------------- tool registry
const TOOLS = [];
const tool = (def) => TOOLS.push(def);
const GROUPS = [['organize', 'Organize'], ['edit', 'Edit'], ['from', 'Convert from PDF'], ['to', 'Convert to PDF'], ['secure', 'Secure'], ['optimize', 'Optimize']];

tool({ id: 'merge', group: 'organize', icon: '⧉', name: 'Merge PDFs', desc: 'Combine several PDFs into one', needsDoc: false, build(body) {
  const fl = fileList({ accept: '.pdf,application/pdf' });
  const includeOpen = checkbox(!!state.bytes);
  body.append(fl.el, state.bytes ? field(el('label', {}, includeOpen, ' Put the open document first'), el('span')) : el('span'));
  body.append(runButton('Merge', async () => {
    const list = [];
    if (state.bytes && includeOpen.checked) list.push(state.bytes);
    for (const f of fl.files) list.push(await readFileBytes(f));
    if (list.length < 2) throw new Error('Add at least two PDFs');
    const out = await busy('Merging…', () => T.mergePdfs(list));
    pdfResult(out, 'merged.pdf');
    if (state.bytes && includeOpen.checked) await applyDoc(out, 'Merged'); else await openBytes(out, 'merged.pdf');
  }));
} });
tool({ id: 'split', group: 'organize', icon: '✂', name: 'Split PDF', desc: 'By ranges, every N pages, or one file per page', needsDoc: true, build(body) {
  const mode = select([['ranges', 'Custom ranges'], ['every', 'Every N pages'], ['each', 'One file per page']], 'ranges');
  const ranges = text('1-2, 3-', { placeholder: 'e.g. 1-2, 3-5, 6-' });
  const every = number(1, { min: 1 });
  const zip = checkbox(true);
  body.append(field('Mode', mode), field('Ranges (comma separates files)', ranges), field('N', every), field(el('label', {}, zip, ' Download as a single ZIP'), el('span')));
  body.append(runButton('Split', async () => {
    const bytes = requireDoc();
    const n = viewer.numPages;
    let groups;
    if (mode.value === 'ranges') groups = parseRangeGroups(ranges.value, n);
    else if (mode.value === 'every') { const k = Math.max(1, Number(every.value) || 1); groups = []; for (let i = 0; i < n; i += k) groups.push(Array.from({ length: Math.min(k, n - i) }, (_, j) => i + j)); }
    else groups = Array.from({ length: n }, (_, i) => [i]);
    if (!groups.length) throw new Error('Nothing to split');
    const outs = await busy('Splitting…', () => T.splitGroups(bytes, groups));
    const base = baseName(state.name);
    if (zip.checked && outs.length > 1) { const z = makeZip(); outs.forEach((o, i) => z.add(`${base}-part${i + 1}.pdf`, o)); downloadBlob(await z.blob(), `${base}-split.zip`); toast(`${outs.length} files zipped`); }
    else outs.forEach((o, i) => pdfResult(o, `${base}-part${i + 1}.pdf`));
  }));
} });
tool({ id: 'extract', group: 'organize', icon: '⤓', name: 'Extract pages', desc: 'Save selected pages as a new PDF', needsDoc: true, build(body) {
  const p = pagesInput(); p.value = state.selected.size ? [...state.selected].map((i) => i + 1).join(',') : '1';
  body.append(field('Pages', p));
  body.append(runButton('Extract', async () => { const idx = pagesFromInput(p.value); pdfResult(await busy('Extracting…', () => T.extractPages(requireDoc(), idx)), `${baseName(state.name)}-extract.pdf`); }));
} });
tool({ id: 'delete', group: 'organize', icon: '🗑', name: 'Delete pages', desc: 'Remove pages from the document', needsDoc: true, build(body) {
  const p = pagesInput(); p.value = state.selected.size ? [...state.selected].map((i) => i + 1).join(',') : '';
  body.append(field('Pages to delete', p));
  body.append(runButton('Delete', async () => { const idx = parsePageRanges(p.value, viewer.numPages); if (!idx.length) throw new Error('Enter page numbers'); await applyDoc(await busy('Deleting…', () => T.deletePages(requireDoc(), idx)), 'Pages deleted'); }));
} });
tool({ id: 'rotate', group: 'organize', icon: '⟳', name: 'Rotate pages', desc: 'Rotate all or some pages', needsDoc: true, build(body) {
  const p = pagesInput(); const angle = select([['90', '90° clockwise'], ['180', '180°'], ['270', '90° counter-clockwise']], '90');
  body.append(field('Pages', p), field('Angle', angle));
  body.append(runButton('Rotate', async () => applyDoc(await busy('Rotating…', () => T.rotatePages(requireDoc(), pagesFromInput(p.value), Number(angle.value))), 'Rotated')));
} });
tool({ id: 'reorder', group: 'organize', icon: '⇅', name: 'Reorder pages', desc: 'Drag thumbnails in the Pages tab', needsDoc: true, build(body) {
  const order = text('', { placeholder: 'e.g. 3,1,2,4-6' });
  body.append(el('p', {}, 'Open the ', el('b', {}, 'Pages'), ' tab on the left and drag thumbnails to reorder. Or type the new order here:'), field('New page order', order));
  body.append(runButton('Apply order', async () => { const idx = parsePageRanges(order.value, viewer.numPages); const rest = viewer.pages.map((p) => p.index).filter((i) => !idx.includes(i)); await applyDoc(await T.reorderPages(requireDoc(), [...idx, ...rest]), 'Pages reordered'); }), el('div', { style: { marginTop: '8px' } }, el('button', { onClick: async () => applyDoc(await T.reversePages(requireDoc()), 'Order reversed') }, 'Reverse page order')));
  body.append(el('div', { style: { marginTop: '8px' } }));
} });
tool({ id: 'insert', group: 'organize', icon: '＋', name: 'Insert pages', desc: 'Blank pages or another PDF', needsDoc: true, build(body) {
  const after = number(viewer.currentIndex + 1, { min: 0 }); const count = number(1, { min: 1, max: 50 });
  const size = select([['same', 'Same as neighbouring page'], ['A4', 'A4'], ['Letter', 'Letter'], ['A3', 'A3'], ['Legal', 'Legal']], 'same');
  const fl = fileList({ accept: '.pdf', multiple: false, label: 'Choose PDF to insert…' });
  body.append(field('Insert after page (0 = at start)', after), el('h4', {}, 'Blank pages'), field('Count', count), field('Size', size), runButton('Insert blank pages', async () => { let b = requireDoc(); for (let i = 0; i < Number(count.value); i++) b = await T.insertBlankPage(b, Number(after.value) + i, size.value === 'same' ? null : PAGE_SIZES[size.value]); await applyDoc(b, 'Pages inserted'); }), el('h4', {}, 'Another PDF'), fl.el, runButton('Insert PDF', async () => { if (!fl.files[0]) throw new Error('Choose a PDF'); await applyDoc(await T.insertPdf(requireDoc(), await readFileBytes(fl.files[0]), Number(after.value)), 'PDF inserted'); }));
} });
tool({ id: 'nup', group: 'organize', icon: '▦', name: 'N-up / booklet sheet', desc: 'Put 2, 4 or more pages on one sheet', needsDoc: true, build(body) {
  const per = select([['2', '2 per sheet'], ['4', '4 per sheet'], ['6', '6 per sheet'], ['9', '9 per sheet'], ['16', '16 per sheet']], '2'); const size = select(Object.keys(PAGE_SIZES).map((k) => [k, k]), 'A4'); const border = checkbox(true);
  body.append(field('Layout', per), field('Sheet size', size), field(el('label', {}, border, ' Draw a border around each page'), el('span')));
  body.append(runButton('Create', async () => pdfResult(await busy('Arranging…', () => T.nUp(requireDoc(), { per: Number(per.value), size: size.value, border: border.checked })), `${baseName(state.name)}-${per.value}up.pdf`)));
} });

tool({ id: 'annotate', group: 'edit', icon: '✎', name: 'Edit & annotate', desc: 'Text, drawings, shapes, images, highlights', needsDoc: true, build(body) {
  body.append(el('p', {}, 'Use the toolbar above the document:'), el('ul', {}, el('li', {}, el('b', {}, 'T'), ' adds text (double-click text to edit it). To replace existing text, cover it with ', el('b', {}, 'Whiteout'), ' and type over it.'), el('li', {}, 'Pen and highlighter draw freehand; shapes and lines drag out.'), el('li', {}, 'Selected items can be moved, resized by their handles, nudged with arrow keys and deleted with ', el('kbd', {}, 'Del'), '.'), el('li', {}, el('b', {}, 'Redact'), ' permanently removes what is underneath (the page is rasterised).'), el('li', {}, 'Press ', el('b', {}, 'Apply changes'), ' to burn everything into the PDF.')), el('p', { class: 'hint' }, 'Non-Latin text uses an embedded font from the Fonts dialog, or is rasterised automatically if none is loaded.'));
  body.append(el('button', { class: 'run', onClick: () => setAnnotTool('text') }, 'Start adding text'));
} });
tool({ id: 'sign', group: 'edit', icon: '✍', name: 'Sign PDF', desc: 'Draw, type or upload a signature', needsDoc: true, build(body) {
  body.append(el('p', {}, 'Create a signature, then click on the page where it should go. Resize it with the corner handles and press Apply changes.'));
  body.append(runButton('Create signature', () => signatureDialog()));
} });
tool({ id: 'watermark', group: 'edit', icon: '🏷', name: 'Watermark', desc: 'Text or image stamp on pages', needsDoc: true, build(body) {
  const kind = select([['text', 'Text'], ['image', 'Image']], 'text'); const txt = text('CONFIDENTIAL'); const size = number(48, { min: 6 }); const col = color('#d32f2f'); const opacity = number(0.3, { min: 0.05, max: 1, step: 0.05 }); const angle = number(45, { min: -180, max: 180 }); const pos = select([['center', 'Centre'], ['tile', 'Tiled'], ['top-left', 'Top left'], ['top-center', 'Top centre'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-center', 'Bottom centre'], ['bottom-right', 'Bottom right']], 'center'); const pages = pagesInput(); const bold = checkbox(true); const fam = select([['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']], 'sans');
  const fl = fileList({ accept: 'image/*', multiple: false, label: 'Choose image…' }); const scale = number(0.4, { min: 0.05, max: 1, step: 0.05 });
  const tb = el('div', {}, field('Text', txt), el('div', { class: 'row' }, field('Size', size), field('Colour', col), field('Font', fam)), field(el('label', {}, bold, ' Bold'), el('span')));
  const ib = el('div', { style: { display: 'none' } }, fl.el, field('Scale (fraction of page)', scale));
  kind.addEventListener('change', () => { tb.style.display = kind.value === 'text' ? '' : 'none'; ib.style.display = kind.value === 'image' ? '' : 'none'; });
  body.append(field('Type', kind), tb, ib, el('div', { class: 'row' }, field('Opacity', opacity), field('Angle', angle)), field('Position', pos), field('Pages', pages));
  body.append(runButton('Add watermark', async () => {
    const opts = { opacity: Number(opacity.value), angle: Number(angle.value), position: pos.value === 'tile' ? 'center' : pos.value, tile: pos.value === 'tile', pages: pagesFromInput(pages.value), size: Number(size.value), color: col.value, bold: bold.checked, family: fam.value, text: txt.value, scale: Number(scale.value) };
    if (kind.value === 'image') { if (!fl.files[0]) throw new Error('Choose an image'); opts.image = await normalizeImageFile(fl.files[0]); }
    await applyDoc(await busy('Stamping…', () => T.watermark(requireDoc(), opts)), 'Watermark added');
  }));
} });
tool({ id: 'pagenum', group: 'edit', icon: '#', name: 'Page numbers', desc: 'Number pages in any position', needsDoc: true, build(body) {
  const fmt = select([['{n}', '1, 2, 3'], ['Page {n}', 'Page 1'], ['Page {n} of {N}', 'Page 1 of 10'], ['{n} / {N}', '1 / 10'], ['- {n} -', '- 1 -']], '{n}'); const custom = text('', { placeholder: 'Custom, e.g. Chapter {n}' }); const pos = select([['bottom-center', 'Bottom centre'], ['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'], ['top-center', 'Top centre'], ['top-right', 'Top right'], ['top-left', 'Top left']], 'bottom-center'); const size = number(11, { min: 4 }); const start = number(1); const margin = number(28, { min: 0 }); const pages = pagesInput(); const col = color('#000000'); const fam = select([['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']], 'sans');
  body.append(field('Format', fmt), field('Custom format', custom), field('Position', pos), el('div', { class: 'row' }, field('Size', size), field('First number', start), field('Margin', margin)), el('div', { class: 'row' }, field('Colour', col), field('Font', fam)), field('Pages', pages));
  body.append(runButton('Add page numbers', async () => applyDoc(await busy('Numbering…', () => T.pageNumbers(requireDoc(), { format: custom.value.trim() || fmt.value, position: pos.value, size: Number(size.value), start: Number(start.value), margin: Number(margin.value), pages: pagesFromInput(pages.value), color: col.value, family: fam.value })), 'Page numbers added')));
} });
tool({ id: 'headfoot', group: 'edit', icon: '≡', name: 'Header & footer', desc: 'Text in the top/bottom margins', needsDoc: true, build(body) {
  const inputs = {}; const mk = (band) => el('div', { class: 'row' }, ...['left', 'center', 'right'].map((s) => { inputs[`${band}.${s}`] = text('', { placeholder: s }); return inputs[`${band}.${s}`]; }));
  const size = number(10, { min: 4 }); const col = color('#333333'); const pages = pagesInput();
  body.append(el('p', { class: 'hint' }, 'Tokens: {n} page number, {N} page count, {date}, {title}'), field('Header', mk('header')), field('Footer', mk('footer')), el('div', { class: 'row' }, field('Size', size), field('Colour', col)), field('Pages', pages));
  body.append(runButton('Add header & footer', async () => applyDoc(await busy('Stamping…', () => T.headerFooter(requireDoc(), { header: { left: inputs['header.left'].value, center: inputs['header.center'].value, right: inputs['header.right'].value }, footer: { left: inputs['footer.left'].value, center: inputs['footer.center'].value, right: inputs['footer.right'].value }, size: Number(size.value), color: col.value, pages: pagesFromInput(pages.value) })), 'Header/footer added')));
} });
tool({ id: 'crop', group: 'edit', icon: '⌗', name: 'Crop pages', desc: 'Crop to a box or trim margins', needsDoc: true, build(body) {
  const scope = select([['page', 'The page the box is on'], ['all', 'All pages'], ['ranges', 'Pages:']], 'page'); const pages = pagesInput();
  const margins = ['top', 'right', 'bottom', 'left'].map((m) => number(0, { min: 0, placeholder: m, title: m }));
  body.append(el('p', {}, 'Choose the ', el('b', {}, '✂ crop tool'), ' in the toolbar and drag a box on a page.'), field('Apply to', scope), field('Pages', pages), runButton('Crop to box', async () => {
    const c = annotator.getCrop(); if (!c) throw new Error('Draw a crop box first');
    const idx = scope.value === 'page' ? [c.page] : scope.value === 'all' ? viewer.pages.map((p) => p.index) : pagesFromInput(pages.value);
    const out = await busy('Cropping…', () => T.cropPages(requireDoc(), idx, { x: c.x, y: c.y, width: c.w, height: c.h }));
    annotator.clearCrop(); await applyDoc(out, 'Cropped');
  }), el('h4', {}, 'Trim margins (points, 72 = 1 inch)'), el('div', { class: 'row' }, ...margins), runButton('Trim margins', async () => {
    const [t, r, b, l] = margins.map((m) => Number(m.value) || 0);
    let bytes = requireDoc();
    const doc = await T.loadDoc(bytes);
    const idx = scope.value === 'all' || scope.value === 'page' ? doc.getPageIndices() : pagesFromInput(pages.value);
    for (const i of idx) { const g = T.visualGeom(doc.getPage(i)); bytes = await T.cropPages(bytes, [i], { x: l, y: b, width: g.vw - l - r, height: g.vh - t - b }); }
    await applyDoc(bytes, 'Margins trimmed');
  }));
  this.refresh = () => {};
} });
tool({ id: 'resize', group: 'edit', icon: '⤢', name: 'Resize pages', desc: 'Scale pages to A4, Letter, …', needsDoc: true, build(body) {
  const size = select(Object.keys(PAGE_SIZES).map((k) => [k, k]), 'A4'); const orient = select([['auto', 'Keep orientation'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], 'auto'); const mode = select([['fit', 'Scale content to fit'], ['center', 'Keep content size, centre']], 'fit'); const margin = number(0, { min: 0 });
  body.append(field('Page size', size), field('Orientation', orient), field('Mode', mode), field('Margin (pt)', margin));
  body.append(runButton('Resize', async () => applyDoc(await busy('Resizing…', () => T.resizePages(requireDoc(), { size: size.value, orientation: orient.value, mode: mode.value, margin: Number(margin.value) })), 'Pages resized')));
} });
tool({ id: 'forms', group: 'edit', icon: '☐', name: 'Fill forms', desc: 'Fill and flatten form fields', needsDoc: true, async build(body) {
  const fields = await T.getFormFields(requireDoc());
  if (!fields.length) { body.append(el('p', {}, 'This document has no interactive form fields.'), el('p', { class: 'hint' }, 'You can still type into it with the text tool.')); return; }
  const inputs = new Map();
  const table = el('table', { class: 'fields-table' });
  for (const f of fields) {
    let inp;
    if (f.kind === 'text') inp = f.multiline ? el('textarea', { class: 'wide' }) : text(f.value, { class: 'wide' });
    else if (f.kind === 'checkbox') inp = checkbox(!!f.value);
    else if (f.kind === 'radio' || f.kind === 'dropdown') inp = select([['', '—'], ...f.options.map((o) => [o, o])], f.value);
    else if (f.kind === 'list') inp = select(f.options.map((o) => [o, o]), (f.value || [])[0]);
    else inp = el('span', { class: 'muted' }, f.kind);
    if (f.kind === 'text' && f.multiline) inp.value = f.value;
    inputs.set(f.name, { f, inp });
    table.append(el('tr', {}, el('td', {}, f.name), el('td', {}, inp)));
  }
  const collect = () => { const v = {}; for (const [name, { f, inp }] of inputs) { if (f.kind === 'checkbox') v[name] = inp.checked; else if (inp.value != null && f.kind !== 'signature' && f.kind !== 'button' && f.kind !== 'other') v[name] = inp.value; } return v; };
  body.append(table, el('div', { class: 'row', style: { marginTop: '10px' } }, runButton('Fill', async () => applyDoc(await busy('Filling…', () => T.setFormFields(requireDoc(), collect())), 'Form filled')), runButton('Fill & flatten', async () => applyDoc(await busy('Flattening…', () => T.setFormFields(requireDoc(), collect(), { flatten: true })), 'Form flattened'))));
} });
tool({ id: 'metadata', group: 'edit', icon: 'ℹ', name: 'Document properties', desc: 'Title, author, keywords…', needsDoc: true, async build(body) {
  const m = await T.getMetadata(requireDoc());
  const inputs = {}; for (const k of ['title', 'author', 'subject', 'keywords', 'creator', 'producer']) inputs[k] = text(m[k] || '');
  body.append(...Object.entries(inputs).map(([k, i]) => field(k[0].toUpperCase() + k.slice(1), i)), el('p', { class: 'hint' }, `Created ${m.created || '?'} · Modified ${m.modified || '?'} · ${m.pages} pages`));
  body.append(runButton('Save properties', async () => applyDoc(await T.setMetadata(requireDoc(), Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]))), 'Properties saved')), el('button', { class: 'run', onClick: async () => applyDoc(await T.stripMetadata(requireDoc()), 'Metadata removed') }, 'Remove all metadata'));
} });
tool({ id: 'rmannots', group: 'edit', icon: '⌫', name: 'Remove annotations', desc: 'Strip comments, links or form widgets', needsDoc: true, build(body) {
  const keepLinks = checkbox(true), keepWidgets = checkbox(true);
  body.append(field(el('label', {}, keepLinks, ' Keep links'), el('span')), field(el('label', {}, keepWidgets, ' Keep form fields'), el('span')));
  body.append(runButton('Remove', async () => applyDoc(await T.removeAnnotations(requireDoc(), { keepLinks: keepLinks.checked, keepWidgets: keepWidgets.checked }), 'Annotations removed')));
} });

tool({ id: 'pdf2word', group: 'from', icon: 'W', name: 'PDF to Word', desc: 'Editable .docx with text, styles and images', needsDoc: true, build(body) {
  const mode = select([['text', 'Editable text (recommended)'], ['image', 'Each page as an image (exact look)']], 'text'); const images = checkbox(true);
  body.append(field('Mode', mode), field(el('label', {}, images, ' Include images'), el('span')), el('p', { class: 'hint' }, 'Text mode rebuilds paragraphs, headings, alignment and fonts from the PDF layout. Scanned PDFs need OCR first.'));
  body.append(runButton('Convert to Word', async () => {
    const bytes = requireDoc();
    const out = await busy('Converting to Word…', async (progress) => {
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), cMapUrl: 'vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: 'vendor/pdfjs/standard_fonts/' }).promise;
      const doc = await pdfToDoc(pdf, { mode: mode.value, images: images.checked, onProgress: progress });
      await pdf.destroy();
      return writeDocx(doc, { title: baseName(state.name) });
    });
    addResult({ name: `${baseName(state.name)}.docx`, bytes: out, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    downloadBytes(out, `${baseName(state.name)}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  }));
} });
tool({ id: 'pdf2text', group: 'from', icon: 'T', name: 'PDF to Text', desc: 'Plain .txt', needsDoc: true, build(body) {
  const layout = checkbox(false);
  body.append(field(el('label', {}, layout, ' Keep column layout with spaces'), el('span')));
  body.append(runButton('Extract text', async () => { const bytes = requireDoc(); const txt = await busy('Extracting…', async (progress) => { const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), cMapUrl: 'vendor/pdfjs/cmaps/', cMapPacked: true }).promise; const t = await pdfToText(pdf, { layout: layout.checked, onProgress: progress }); await pdf.destroy(); return t; }); const b = new TextEncoder().encode(txt); addResult({ name: `${baseName(state.name)}.txt`, bytes: b, type: 'text/plain' }); downloadBytes(b, `${baseName(state.name)}.txt`, 'text/plain'); }));
} });
tool({ id: 'pdf2html', group: 'from', icon: '<>', name: 'PDF to HTML', desc: 'Web page with text and images', needsDoc: true, build(body) {
  body.append(runButton('Convert to HTML', async () => { const bytes = requireDoc(); const html = await busy('Converting…', async (progress) => { const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), cMapUrl: 'vendor/pdfjs/cmaps/', cMapPacked: true }).promise; const doc = await pdfToDoc(pdf, { onProgress: progress }); await pdf.destroy(); return writeHtml(doc, { title: baseName(state.name) }); }); const b = new TextEncoder().encode(html); addResult({ name: `${baseName(state.name)}.html`, bytes: b, type: 'text/html' }); downloadBytes(b, `${baseName(state.name)}.html`, 'text/html'); }));
} });
tool({ id: 'pdf2img', group: 'from', icon: '🖼', name: 'PDF to images', desc: 'PNG / JPG / WebP per page', needsDoc: true, build(body) {
  const fmt = select([['png', 'PNG'], ['jpeg', 'JPG'], ['webp', 'WebP']], 'png'); const dpi = number(150, { min: 36, max: 600 }); const quality = number(0.9, { min: 0.1, max: 1, step: 0.05 }); const pages = pagesInput(); const gray = checkbox(false); const transparent = checkbox(false);
  body.append(el('div', { class: 'row' }, field('Format', fmt), field('DPI', dpi), field('Quality', quality)), field('Pages', pages), field(el('label', {}, gray, ' Grayscale'), el('span')), field(el('label', {}, transparent, ' Transparent background (PNG)'), el('span')));
  body.append(runButton('Convert', async () => {
    const bytes = requireDoc();
    const imgs = await busy('Rendering pages…', (progress) => T.pdfToImages(bytes, { format: fmt.value, dpi: Number(dpi.value), quality: Number(quality.value), pages: pagesFromInput(pages.value), grayscale: gray.checked, transparent: transparent.checked }, (n) => progress(n / viewer.numPages)));
    if (imgs.length === 1) { addResult(imgs[0]); downloadBytes(imgs[0].bytes, imgs[0].name, imgs[0].type); }
    else { const z = makeZip(); imgs.forEach((i) => z.add(i.name, i.bytes)); downloadBlob(await z.blob(), `${baseName(state.name)}-images.zip`); toast(`${imgs.length} images zipped`); }
  }));
} });
tool({ id: 'pdf2pptx', group: 'from', icon: 'P', name: 'PDF to PowerPoint', desc: 'One slide per page (.pptx)', needsDoc: true, build(body) {
  const dpi = number(110, { min: 50, max: 300 });
  body.append(field('Render DPI', dpi), el('p', { class: 'hint' }, 'Each page becomes a full-slide picture, keeping the exact look.'));
  body.append(runButton('Convert to PowerPoint', async () => {
    const bytes = requireDoc();
    const out = await busy('Building slides…', async (progress) => {
      const imgs = [];
      await T.renderPages(bytes, { dpi: Number(dpi.value) }, async (c, i, vp1) => { imgs.push({ bytes: await canvasToBytes(c, 'image/jpeg', 0.9), imgType: 'jpg', width: vp1.width, height: vp1.height }); progress(imgs.length / viewer.numPages); });
      return writePptx(imgs, { title: baseName(state.name) });
    });
    addResult({ name: `${baseName(state.name)}.pptx`, bytes: out, type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    downloadBytes(out, `${baseName(state.name)}.pptx`, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  }));
} });
tool({ id: 'extractimg', group: 'from', icon: '⧈', name: 'Extract images', desc: 'Save pictures embedded in the PDF', needsDoc: true, build(body) {
  body.append(runButton('Extract images', async () => {
    const imgs = await busy('Scanning pages…', (progress) => T.extractImages(requireDoc(), progress));
    if (!imgs.length) { toast('No images found'); return; }
    const z = makeZip(); imgs.forEach((i) => z.add(i.name, i.bytes)); downloadBlob(await z.blob(), `${baseName(state.name)}-images.zip`); toast(`${imgs.length} images extracted`);
  }));
} });

const toPdfTool = (id, name, desc, accept, icon, extra) => tool({ id, group: 'to', icon, name, desc, needsDoc: false, build(body) {
  const fl = fileList({ accept, multiple: id === 'img2pdf' });
  const size = select([['', 'Keep document size'], ...Object.keys(PAGE_SIZES).map((k) => [k, k])], ''); const landscape = checkbox(false);
  body.append(fl.el);
  const opts = extra ? extra(body) : {};
  if (id !== 'img2pdf' && id !== 'pptx2pdf') body.append(field('Page size', size), field(el('label', {}, landscape, ' Landscape'), el('span')));
  body.append(el('p', { class: 'hint' }, id === 'word2pdf' ? 'Paragraph styles, lists, tables, images, headers/footers are supported. For Korean/CJK text add a font in Fonts (otherwise text is rasterised).' : ''));
  body.append(runButton('Convert to PDF', async () => {
    if (!fl.files.length) throw new Error('Choose a file');
    const out = await convertFileToPdf(id, fl.files, { ...(opts.get ? opts.get() : {}), pageSize: size.value, landscape: landscape.checked });
    const name = baseName(fl.files[0].name, 'pdf');
    pdfResult(out, name);
    await openBytes(out, name);
  }));
  this.addFiles = (files) => fl.add(files);
} });
toPdfTool('word2pdf', 'Word to PDF', '.docx → PDF', '.docx', 'W');
toPdfTool('xlsx2pdf', 'Excel to PDF', '.xlsx → PDF (one table per sheet)', '.xlsx', 'X');
toPdfTool('pptx2pdf', 'PowerPoint to PDF', '.pptx → PDF (text boxes and pictures)', '.pptx', 'P');
toPdfTool('html2pdf', 'HTML to PDF', 'Web page file → PDF', '.html,.htm', '<>');
toPdfTool('text2pdf', 'Text / Markdown to PDF', '.txt or .md → PDF', '.txt,.md,.markdown,text/plain', 'T', (body) => { const mono = checkbox(false); const fs = number(11, { min: 6, max: 30 }); body.append(el('div', { class: 'row' }, field('Font size', fs), field(el('label', {}, mono, ' Monospace'), el('span')))); return { get: () => ({ mono: mono.checked, size: Number(fs.value) }) }; });
toPdfTool('img2pdf', 'Images to PDF', 'JPG, PNG, WebP, GIF, BMP, SVG → PDF', 'image/*', '🖼', (body) => { const ps = select([['fit', 'Fit page to image'], ...Object.keys(PAGE_SIZES).map((k) => [k, k])], 'fit'); const orient = select([['auto', 'Auto'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], 'auto'); const margin = number(0, { min: 0 }); const fit = select([['contain', 'Fit inside'], ['cover', 'Fill page (crop)'], ['stretch', 'Stretch']], 'contain'); body.append(field('Page size', ps), el('div', { class: 'row' }, field('Orientation', orient), field('Margin', margin)), field('Image placement', fit)); return { get: () => ({ pageSize: ps.value, orientation: orient.value, margin: Number(margin.value), fit: fit.value }) }; });

tool({ id: 'protect', group: 'secure', icon: '🔒', name: 'Protect with password', desc: 'Encrypt and set permissions', needsDoc: true, build(body) {
  const user = el('input', { type: 'password', placeholder: 'Needed to open (optional)' }); const owner = el('input', { type: 'password', placeholder: 'Needed to change permissions' }); const method = select([['aes256', 'AES-256 (strongest)'], ['aes128', 'AES-128 (widest compatibility)'], ['rc4', 'RC4-128 (legacy)']], 'aes128');
  const perms = {}; const grid = el('div', { class: 'perm-grid' }); for (const [k, l] of [['print', 'Printing'], ['copy', 'Copying text'], ['modify', 'Editing'], ['annotate', 'Commenting'], ['fillForms', 'Filling forms'], ['assemble', 'Page assembly']]) { perms[k] = checkbox(true); grid.append(el('label', {}, perms[k], ' ', l)); }
  body.append(field('Open password', user), field('Permissions password', owner), field('Encryption', method), field('Allow', grid), el('p', { class: 'hint' }, 'Permissions are enforced by PDF readers only when the open password is not known. The protected file is produced as a download; the editor keeps working on the unprotected copy.'));
  body.append(runButton('Protect', async () => {
    if (!user.value && !owner.value) throw new Error('Enter at least one password');
    const out = await busy('Encrypting…', async () => { const plain = await T.saveDoc(await T.loadDoc(requireDoc()), { useObjectStreams: false }); return encryptPdf(plain, { userPassword: user.value, ownerPassword: owner.value || user.value, method: method.value, permissions: Object.fromEntries(Object.entries(perms).map(([k, c]) => [k, c.checked])) }); });
    pdfResult(out, `${baseName(state.name)}-protected.pdf`); downloadBytes(out, `${baseName(state.name)}-protected.pdf`, 'application/pdf');
  }));
} });
tool({ id: 'unlock', group: 'secure', icon: '🔓', name: 'Unlock PDF', desc: 'Remove password and restrictions', needsDoc: false, build(body) {
  const fl = fileList({ accept: '.pdf', multiple: false, label: 'Choose protected PDF…' }); const pw = el('input', { type: 'password', placeholder: 'Password (leave empty for owner-restricted files)' });
  if (state.bytes && state.wasEncrypted) body.append(el('div', { class: 'note' }, 'The open document was encrypted; the editor already works on an unlocked copy. Use Download to save it.'));
  body.append(fl.el, field('Password', pw));
  body.append(runButton('Unlock', async () => {
    if (!fl.files[0]) throw new Error('Choose a PDF');
    const bytes = await readFileBytes(fl.files[0]);
    const out = await busy('Decrypting…', async () => { const r = await decryptPdf(bytes, pw.value); return T.saveDoc(await T.loadDoc(r.bytes)); });
    const name = `${baseName(fl.files[0].name)}-unlocked.pdf`; pdfResult(out, name); downloadBytes(out, name, 'application/pdf');
  }));
} });
tool({ id: 'flatten', group: 'secure', icon: '▬', name: 'Flatten', desc: 'Make forms and annotations non-editable', needsDoc: true, build(body) {
  body.append(el('p', {}, 'Form fields are converted into static page content. Burned-in annotations are already flat.'));
  body.append(runButton('Flatten forms', async () => applyDoc(await busy('Flattening…', () => T.flattenForms(requireDoc())), 'Flattened')));
} });

tool({ id: 'compress', group: 'optimize', icon: '🗜', name: 'Compress PDF', desc: 'Shrink images and structure', needsDoc: true, build(body) {
  const level = select([['light', 'Light (quality 80%, images ≤ 2400px)'], ['medium', 'Medium (60%, ≤ 1600px)'], ['strong', 'Strong (45%, ≤ 1200px)'], ['extreme', 'Extreme (rasterise pages, text becomes image)']], 'medium'); const gray = checkbox(false);
  body.append(field('Level', level), field(el('label', {}, gray, ' Convert images to grayscale'), el('span')), el('p', { class: 'hint' }, `Current size: ${state.bytes ? formatBytes(state.bytes.length) : '-'}`));
  body.append(runButton('Compress', async () => {
    const bytes = requireDoc();
    const before = bytes.length;
    let out;
    if (level.value === 'extreme') out = await busy('Rasterising…', (progress) => T.rasterizePdf(bytes, { dpi: 100, quality: 0.6, grayscale: gray.checked }, (n) => progress(n / viewer.numPages)));
    else {
      const cfg = { light: [0.8, 2400], medium: [0.6, 1600], strong: [0.45, 1200] }[level.value];
      const r = await busy('Recompressing images…', (progress) => T.compressImages(bytes, { quality: cfg[0], maxDim: cfg[1], grayscale: gray.checked }, progress));
      out = r.bytes; status(`Images recompressed: ${r.replaced}, skipped: ${r.skipped}`);
    }
    if (out.length >= before) { toast(`No gain (${formatBytes(before)} → ${formatBytes(out.length)}). Try a stronger level.`); return; }
    await applyDoc(out, `Compressed ${formatBytes(before)} → ${formatBytes(out.length)} (−${Math.round((1 - out.length / before) * 100)}%)`);
  }));
} });
tool({ id: 'repair', group: 'optimize', icon: '🩹', name: 'Repair PDF', desc: 'Rebuild a damaged file', needsDoc: false, build(body) {
  const fl = fileList({ accept: '.pdf', multiple: false, label: 'Choose a damaged PDF…' });
  body.append(el('p', {}, 'Rewrites the file structure (cross-reference table, object streams). If parsing fails, the pages are re-rendered instead.'), fl.el);
  body.append(runButton('Repair', async () => {
    const bytes = fl.files[0] ? await readFileBytes(fl.files[0]) : requireDoc();
    let out;
    try { out = await busy('Repairing…', () => T.repair(bytes)); }
    catch (e) { console.warn('repair fallback', e); out = await busy('Re-rendering pages…', () => T.rasterizePdf(bytes, { dpi: 150, quality: 0.85 })); }
    const name = fl.files[0] ? `${baseName(fl.files[0].name)}-repaired.pdf` : `${baseName(state.name)}-repaired.pdf`;
    if (fl.files[0]) { pdfResult(out, name); await openBytes(out, name); } else await applyDoc(out, 'Repaired');
  }));
} });
tool({ id: 'ocr', group: 'optimize', icon: '👁', name: 'OCR (make searchable)', desc: 'Recognise text in scanned pages', needsDoc: true, build(body) {
  const lang = select(Object.entries(OCR_LANGS), 'eng'); const dpi = number(200, { min: 100, max: 400 }); const pages = pagesInput();
  body.append(field('Language', lang), field('Render DPI', dpi), field('Pages', pages), el('p', { class: 'hint' }, 'Uses tesseract.js, downloaded on first use (needs internet). An invisible text layer is added so the PDF becomes searchable and copyable. Non-Latin languages need a font from the Fonts dialog to embed the text layer.'));
  body.append(runButton('Run OCR', async () => {
    const bytes = requireDoc();
    const r = await busy('OCR…', (progress) => ocrPdf(bytes, { lang: lang.value, dpi: Number(dpi.value), pages: pagesFromInput(pages.value), onProgress: progress }));
    addResult({ name: `${baseName(state.name)}-ocr.txt`, bytes: new TextEncoder().encode(r.text), type: 'text/plain' });
    await applyDoc(r.bytes, r.skippedWords ? `OCR done (${r.skippedWords} words skipped: add a font for this language)` : 'OCR text layer added');
  }));
} });
tool({ id: 'grayscale', group: 'optimize', icon: '◐', name: 'Convert to grayscale', desc: 'Black & white version of the pages', needsDoc: true, build(body) {
  const dpi = number(150, { min: 72, max: 300 });
  body.append(field('Render DPI', dpi), el('p', { class: 'hint' }, 'Pages are re-rendered as grayscale images (text is no longer selectable; run OCR afterwards if needed).'));
  body.append(runButton('Convert', async () => applyDoc(await busy('Rendering…', (progress) => T.rasterizePdf(requireDoc(), { dpi: Number(dpi.value), quality: 0.85, grayscale: true }, (n) => progress(n / viewer.numPages))), 'Converted to grayscale')));
} });
tool({ id: 'compare', group: 'optimize', icon: '⇄', name: 'Compare PDFs', desc: 'Visual diff against another file', needsDoc: true, build(body) {
  const fl = fileList({ accept: '.pdf', multiple: false, label: 'Choose PDF to compare with…' });
  const out = el('div', { class: 'compare-wrap' });
  body.append(fl.el, runButton('Compare', async () => {
    if (!fl.files[0]) throw new Error('Choose a PDF');
    const other = await readFileBytes(fl.files[0]);
    const res = await busy('Comparing…', () => T.comparePdfs(requireDoc(), other, { scale: 0.8 }));
    out.innerHTML = '';
    const changed = res.filter((r) => r.diffRatio > 0.0005);
    out.append(el('p', {}, `${changed.length} of ${res.length} pages differ. Red = only in the open document, blue = only in the other file.`));
    for (const r of changed) { out.append(el('div', { class: 'hint' }, `Page ${r.page}: ${(r.diffRatio * 100).toFixed(2)}% pixels differ`)); r.canvas.style.maxWidth = '100%'; out.append(r.canvas); }
  }), out);
} });

// render tool list
function renderToolList(filter = '') {
  const list = $('#tool-list');
  list.innerHTML = '';
  const q = filter.trim().toLowerCase();
  for (const [gid, gname] of GROUPS) {
    const items = TOOLS.filter((t) => t.group === gid && (!q || `${t.name} ${t.desc}`.toLowerCase().includes(q)));
    if (!items.length) continue;
    list.append(el('div', { class: 'tool-group-title' }, gname));
    for (const t of items) list.append(el('button', { class: `tool-item${state.activeTool && state.activeTool.id === t.id ? ' active' : ''}`, dataset: { id: t.id }, disabled: t.needsDoc && !state.bytes, onClick: () => openTool(t.id) }, el('span', { class: 'ico' }, t.icon), el('span', {}, t.name, el('span', { class: 'desc' }, t.desc))));
  }
}
$('#tool-filter').addEventListener('input', (e) => renderToolList(e.target.value));
async function openTool(id, prefill) {
  const t = TOOLS.find((x) => x.id === id);
  if (!t) return;
  if (t.needsDoc && !state.bytes) { toast('Open a PDF first', 'error'); return; }
  state.activeTool = t;
  $('#panel-title').textContent = t.name;
  const body = $('#panel-body');
  body.innerHTML = '';
  const ctx = { id, refresh: null, addFiles: null };
  try { await t.build.call(ctx, body); } catch (e) { body.append(el('p', { class: 'note warn' }, e.message)); }
  state.activeTool = { ...t, refresh: ctx.refresh ? () => openTool(id) : null };
  if (prefill && ctx.addFiles) ctx.addFiles(prefill);
  renderToolList($('#tool-filter').value);
  if (id === 'crop') setAnnotTool('crop');
}
$('#panel-close').addEventListener('click', () => { state.activeTool = null; $('#panel-title').textContent = 'Tools'; $('#panel-body').innerHTML = '<p>Pick a tool on the left.</p>'; renderToolList(); });
renderToolList();

// ---------------------------------------------------------------- top bar, tabs, search, keyboard, drag & drop
$$('.tab').forEach((b) => b.addEventListener('click', () => { $$('.tab').forEach((x) => x.classList.toggle('active', x === b)); $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${b.dataset.tab}`)); }));
const openPicker = async () => { const [f] = await pickFiles({ accept: '.pdf,.docx,.xlsx,.pptx,.html,.htm,.txt,.md,image/*,application/pdf' }); if (f) await openFile(f).catch((e) => toast(e.message, 'error')); };
$('#btn-open').addEventListener('click', openPicker);
$('#btn-open-2').addEventListener('click', openPicker);
$('#btn-save').addEventListener('click', () => saveDocument().catch((e) => toast(e.message, 'error')));
$('#btn-print').addEventListener('click', printDocument);
$('#btn-undo').addEventListener('click', undoDoc);
$('#btn-redo').addEventListener('click', redoDoc);
$('#btn-zoom-in').addEventListener('click', () => { viewer.zoomBy(1.2); $('#zoom-select').value = ''; });
$('#btn-zoom-out').addEventListener('click', () => { viewer.zoomBy(1 / 1.2); $('#zoom-select').value = ''; });
$('#zoom-select').addEventListener('change', (e) => { const v = e.target.value; if (v === 'width' || v === 'page') viewer.setZoom(v); else viewer.setZoom('custom', Number(v)); });
viewer.onScaleChange = () => { annotator.redrawAll(); };
viewer.onPageVisible = (i) => { $('#page-input').value = i + 1; };
$('#page-input').addEventListener('change', (e) => viewer.goTo(Number(e.target.value) - 1));
let searchHits = [], searchPos = 0;
$('#search').addEventListener('input', async (e) => {
  const q = e.target.value.trim();
  viewer.highlightSearch(q);
  if (!q) { $('#search-count').textContent = ''; return; }
  searchHits = await viewer.search(q); searchPos = 0;
  $('#search-count').textContent = searchHits.length ? `${searchHits.length} hit${searchHits.length > 1 ? 's' : ''}` : 'no hits';
  if (searchHits.length) viewer.goTo(searchHits[0].page);
});
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter' && searchHits.length) { searchPos = (searchPos + 1) % searchHits.length; viewer.goTo(searchHits[searchPos].page); $('#search-count').textContent = `${searchPos + 1} / ${searchHits.length}`; } });
viewer.onPageRendered = (p) => { annotator.redraw(p.index); const q = $('#search').value.trim(); if (q) viewer.highlightSearch(q); };
$$('[data-quick]').forEach((b) => b.addEventListener('click', async () => {
  const id = b.dataset.quick;
  if (id === 'merge') { openTool('merge'); return; }
  const accept = { word2pdf: '.docx', xlsx2pdf: '.xlsx', pptx2pdf: '.pptx', img2pdf: 'image/*', html2pdf: '.html,.htm', text2pdf: '.txt,.md' }[id];
  const files = await pickFiles({ accept, multiple: id === 'img2pdf' });
  if (!files.length) return;
  await openTool(id, files);
}));
window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); openPicker(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveDocument(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p' && state.bytes) { e.preventDefault(); printDocument(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); if (!annotator.undo()) undoDoc(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) && !typing) { e.preventDefault(); if (!annotator.redo()) redoDoc(); }
  else if (!typing && (e.key === '+' || e.key === '=') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); viewer.zoomBy(1.2); }
  else if (!typing && e.key === '-' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); viewer.zoomBy(1 / 1.2); }
});
const dz = $('#dropzone');
for (const target of [document.body]) {
  target.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  target.addEventListener('dragleave', (e) => { if (e.target === document.body) dz.classList.remove('over'); });
  target.addEventListener('drop', async (e) => {
    e.preventDefault(); dz.classList.remove('over');
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    if (files.length > 1 && files.every((f) => /\.pdf$/i.test(f.name))) { openTool('merge', files); return; }
    if (files.length > 1 && files.every((f) => /^image\//.test(f.type))) { openTool('img2pdf', files); return; }
    await openFile(files[0]).catch((err) => toast(err.message, 'error'));
  });
}
window.addEventListener('resize', () => { if (viewer.fitMode !== 'custom') viewer.applyScale(); });
window.addEventListener('beforeunload', (e) => { if (state.bytes && (state.history.length || annotator.hasAnnotations())) { e.preventDefault(); e.returnValue = ''; } });

// expose for tests / console
globalThis.pdfEditor = { state, viewer, annotator, openBytes, openFile, applyDoc, T, tools: TOOLS, openTool, results, busy, sleep, applyAnnotations, setAnnotTool, modules: { readDocx, readXlsx, readPptx, readHtml, readMarkdown, readText, writeDocx, renderDocToPdf, pdfToDoc, pdfToText, writeHtml, writePptx, decryptPdf, encryptPdf, isEncrypted, ocrPdf, addCustomFont } };
status('Ready. Open a PDF or drop one here.');
