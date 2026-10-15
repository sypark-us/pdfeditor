// Page-level tools built on pdf-lib (and pdf.js for anything that needs rendering/decoding).
// Every function takes PDF bytes and returns new bytes (or files), so the app can keep an undo stack.
import { FontManager } from './fonts.js';
import { hexToRgb, PAGE_SIZES, canvasToBytes, normalizeImageFile } from './util.js';

const PL = () => globalThis.PDFLib;
const pdfjs = () => globalThis.pdfjsLib;

export async function loadDoc(bytes) {
  return PL().PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
}
export const saveDoc = (doc, opts = {}) => doc.save({ useObjectStreams: true, ...opts });

/** Visual (as displayed, rotation applied) geometry helpers for a pdf-lib page. */
export function visualGeom(page) {
  const rot = ((Math.round(page.getRotation().angle / 90) * 90) % 360 + 360) % 360;
  const { width, height } = page.getSize();
  const vw = rot % 180 ? height : width, vh = rot % 180 ? width : height;
  const toUser = (x, y) => {
    switch (rot) {
      case 90: return [width - y, x];
      case 180: return [width - x, height - y];
      case 270: return [y, height - x];
      default: return [x, y];
    }
  };
  const rectToUser = (x, y, w, h) => {
    const [x1, y1] = toUser(x, y), [x2, y2] = toUser(x + w, y + h);
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  };
  return { rot, width, height, vw, vh, toUser, rectToUser, rotate: PL().degrees(rot) };
}

// ---------- organise ----------
export async function mergePdfs(list) {
  const out = await PL().PDFDocument.create();
  for (const bytes of list) {
    const src = await loadDoc(bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return saveDoc(out);
}
export async function extractPages(bytes, indices) {
  const src = await loadDoc(bytes);
  const out = await PL().PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return saveDoc(out);
}
export async function splitGroups(bytes, groups) {
  const results = [];
  for (const g of groups) results.push(await extractPages(bytes, g));
  return results;
}
export async function deletePages(bytes, indices) {
  const doc = await loadDoc(bytes);
  const set = new Set(indices);
  if (set.size >= doc.getPageCount()) throw new Error('Cannot delete every page');
  for (let i = doc.getPageCount() - 1; i >= 0; i--) if (set.has(i)) doc.removePage(i);
  return saveDoc(doc);
}
export async function reorderPages(bytes, order) {
  const src = await loadDoc(bytes);
  const out = await PL().PDFDocument.create();
  const pages = await out.copyPages(src, order);
  pages.forEach((p) => out.addPage(p));
  return saveDoc(out);
}
export async function rotatePages(bytes, indices, delta) {
  const doc = await loadDoc(bytes);
  const set = new Set(indices);
  doc.getPages().forEach((p, i) => { if (set.has(i)) p.setRotation(PL().degrees((p.getRotation().angle + delta) % 360)); });
  return saveDoc(doc);
}
export async function insertBlankPage(bytes, at, size) {
  const doc = await loadDoc(bytes);
  const ref = doc.getPage(Math.max(0, Math.min(doc.getPageCount() - 1, at - 1 < 0 ? 0 : at - 1)));
  const s = size || [ref.getWidth(), ref.getHeight()];
  doc.insertPage(at, s);
  return saveDoc(doc);
}
export async function duplicatePages(bytes, indices) {
  const doc = await loadDoc(bytes);
  const sorted = [...indices].sort((a, b) => b - a);
  for (const i of sorted) { const [copy] = await doc.copyPages(doc, [i]); doc.insertPage(i + 1, copy); }
  return saveDoc(doc);
}
export async function insertPdf(bytes, otherBytes, at) {
  const doc = await loadDoc(bytes);
  const other = await loadDoc(otherBytes);
  const pages = await doc.copyPages(other, other.getPageIndices());
  pages.forEach((p, k) => doc.insertPage(at + k, p));
  return saveDoc(doc);
}
export async function reversePages(bytes) {
  const doc = await loadDoc(bytes);
  return reorderPages(bytes, doc.getPageIndices().reverse());
}

// ---------- stamps: watermark, page numbers, header/footer ----------
async function stampText(fm, page, text, opts) {
  const g = visualGeom(page);
  const font = await fm.resolve(text, { family: opts.family || 'sans', bold: opts.bold, italic: opts.italic, fontName: opts.fontName });
  const size = opts.size || 12;
  const w = font.widthOf(text, size), h = size;
  const color = PL().rgb(...hexToRgb(opts.color || '#000000'));
  const angle = (opts.angle || 0) * Math.PI / 180;
  const drawAt = async (cx, cy) => { // centre in visual coords
    const dx = (w / 2) * Math.cos(angle) - (h / 3) * Math.sin(angle), dy = (w / 2) * Math.sin(angle) + (h / 3) * Math.cos(angle);
    const [ux, uy] = g.toUser(cx - dx, cy - dy);
    await font.draw(page, text, ux, uy, size, { color, opacity: opts.opacity ?? 1, rotate: PL().degrees(g.rot + (opts.angle || 0)) });
  };
  if (opts.tile) {
    const stepX = Math.max(w, 80) + 80, stepY = Math.max(h, 40) + 100;
    for (let y = stepY / 2; y < g.vh; y += stepY) for (let x = stepX / 2; x < g.vw; x += stepX) await drawAt(x, y);
  } else {
    const m = opts.margin ?? 36;
    const pos = opts.position || 'center';
    let cx = g.vw / 2, cy = g.vh / 2;
    if (/left/.test(pos)) cx = m + w / 2; else if (/right/.test(pos)) cx = g.vw - m - w / 2;
    if (/top/.test(pos)) cy = g.vh - m - h / 2; else if (/bottom/.test(pos)) cy = m + h / 2;
    await drawAt(cx + (opts.dx || 0), cy + (opts.dy || 0));
  }
}
async function stampImage(doc, page, img, opts) {
  const g = visualGeom(page);
  const embedded = img.type === 'jpg' ? await doc.embedJpg(img.bytes) : await doc.embedPng(img.bytes);
  let w = embedded.width, h = embedded.height;
  const scale = (opts.scale || 0.4) * Math.min(g.vw, g.vh) / Math.max(w, h);
  w *= scale; h *= scale;
  const drawAt = (cx, cy) => {
    const [ux, uy] = g.toUser(cx - w / 2, cy - h / 2);
    page.drawImage(embedded, { x: ux, y: uy, width: w, height: h, opacity: opts.opacity ?? 1, rotate: g.rotate });
  };
  if (opts.tile) { for (let y = h / 2 + 20; y < g.vh; y += h + 80) for (let x = w / 2 + 20; x < g.vw; x += w + 80) drawAt(x, y); }
  else {
    const m = opts.margin ?? 36; const pos = opts.position || 'center';
    let cx = g.vw / 2, cy = g.vh / 2;
    if (/left/.test(pos)) cx = m + w / 2; else if (/right/.test(pos)) cx = g.vw - m - w / 2;
    if (/top/.test(pos)) cy = g.vh - m - h / 2; else if (/bottom/.test(pos)) cy = m + h / 2;
    drawAt(cx, cy);
  }
}
/** opts: { text | image:{bytes,type}, size, color, opacity, angle, position, tile, pages:[idx] } */
export async function watermark(bytes, opts) {
  const doc = await loadDoc(bytes);
  const fm = new FontManager(doc);
  const pages = doc.getPages();
  const set = opts.pages ? new Set(opts.pages) : null;
  for (let i = 0; i < pages.length; i++) {
    if (set && !set.has(i)) continue;
    if (opts.image) await stampImage(doc, pages[i], opts.image, opts);
    else await stampText(fm, pages[i], opts.text || 'CONFIDENTIAL', { size: 48, color: '#ff0000', opacity: 0.3, angle: 45, ...opts });
  }
  return saveDoc(doc);
}
/** opts: { format:'{n}' , position:'bottom-center', size, margin, start:1, color, pages, family } */
export async function pageNumbers(bytes, opts = {}) {
  const doc = await loadDoc(bytes);
  const fm = new FontManager(doc);
  const pages = doc.getPages();
  const set = opts.pages ? new Set(opts.pages) : null;
  const total = pages.length;
  let n = opts.start ?? 1;
  for (let i = 0; i < pages.length; i++) {
    if (set && !set.has(i)) continue;
    const text = (opts.format || '{n}').replace(/\{n\}/g, String(n)).replace(/\{N\}/g, String(set ? set.size : total)).replace(/\{total\}/g, String(total));
    await stampText(fm, pages[i], text, { size: 11, color: '#000000', opacity: 1, angle: 0, position: 'bottom-center', margin: 28, ...opts, tile: false });
    n++;
  }
  return saveDoc(doc);
}
/** opts: { header:{left,center,right}, footer:{left,center,right}, size, color, margin, pages } tokens: {n} {N} {date} {title} */
export async function headerFooter(bytes, opts = {}) {
  const doc = await loadDoc(bytes);
  const fm = new FontManager(doc);
  const pages = doc.getPages();
  const date = new Date().toLocaleDateString();
  const title = doc.getTitle() || '';
  const set = opts.pages ? new Set(opts.pages) : null;
  for (let i = 0; i < pages.length; i++) {
    if (set && !set.has(i)) continue;
    const sub = (s) => String(s || '').replace(/\{n\}/g, String(i + 1)).replace(/\{N\}/g, String(pages.length)).replace(/\{date\}/g, date).replace(/\{title\}/g, title);
    for (const [band, vert] of [['header', 'top'], ['footer', 'bottom']]) {
      const cfg = opts[band] || {};
      for (const [slot, pos] of [['left', 'left'], ['center', 'center'], ['right', 'right']]) {
        const text = sub(cfg[slot]);
        if (!text.trim()) continue;
        await stampText(fm, pages[i], text, { size: opts.size || 10, color: opts.color || '#333333', opacity: 1, angle: 0, position: `${vert}-${pos}`, margin: opts.margin ?? 24, family: opts.family || 'sans' });
      }
    }
  }
  return saveDoc(doc);
}

// ---------- geometry ----------
/** box in visual coordinates {x,y,width,height} (origin bottom-left of displayed page). */
export async function cropPages(bytes, indices, box) {
  const doc = await loadDoc(bytes);
  const set = new Set(indices);
  doc.getPages().forEach((p, i) => {
    if (!set.has(i)) return;
    const g = visualGeom(p);
    const r = g.rectToUser(box.x, box.y, box.width, box.height);
    const mb = p.getMediaBox();
    p.setCropBox(mb.x + r.x, mb.y + r.y, r.width, r.height);
    p.setMediaBox(mb.x + r.x, mb.y + r.y, r.width, r.height);
    p.setBleedBox(mb.x + r.x, mb.y + r.y, r.width, r.height);
    p.setTrimBox(mb.x + r.x, mb.y + r.y, r.width, r.height);
    p.setArtBox(mb.x + r.x, mb.y + r.y, r.width, r.height);
  });
  return saveDoc(doc);
}
/** Resize every page to a named size (or [w,h]); mode 'fit' scales content, 'center' keeps scale. */
export async function resizePages(bytes, opts = {}) {
  const src = await loadDoc(bytes);
  const out = await PL().PDFDocument.create();
  const embedded = await out.embedPdf(bytes, src.getPageIndices());
  const target = Array.isArray(opts.size) ? opts.size : PAGE_SIZES[opts.size] || PAGE_SIZES.A4;
  src.getPages().forEach((p, i) => {
    const g = visualGeom(p);
    let [tw, th] = target;
    if (opts.orientation === 'auto' ? g.vw > g.vh : opts.orientation === 'landscape') [tw, th] = [Math.max(tw, th), Math.min(tw, th)];
    else if (opts.orientation === 'portrait') [tw, th] = [Math.min(tw, th), Math.max(tw, th)];
    const page = out.addPage([tw, th]);
    const e = embedded[i];
    const ew = e.width, eh = e.height; // embedded page bbox (user space, unrotated)
    const margin = opts.margin || 0;
    const vw = g.rot % 180 ? eh : ew, vh = g.rot % 180 ? ew : eh;
    const scale = opts.mode === 'center' ? 1 : Math.min((tw - 2 * margin) / vw, (th - 2 * margin) / vh);
    const dw = vw * scale, dh = vh * scale;
    const cx = tw / 2, cy = th / 2;
    // place rotated embedded page so that its visual box is centred
    const rot = g.rot;
    let x = cx - dw / 2, y = cy - dh / 2;
    if (rot === 90) x = cx + dw / 2; else if (rot === 180) { x = cx + dw / 2; y = cy + dh / 2; } else if (rot === 270) y = cy + dh / 2;
    page.drawPage(e, { x, y, width: ew * scale, height: eh * scale, rotate: PL().degrees(rot) });
  });
  return saveDoc(out);
}
/** Put N source pages on each sheet (2 or 4 or 9 ...). */
export async function nUp(bytes, opts = {}) {
  const per = opts.per || 2;
  const src = await loadDoc(bytes);
  const out = await PL().PDFDocument.create();
  const embedded = await out.embedPdf(bytes, src.getPageIndices());
  const [sw, sh] = PAGE_SIZES[opts.size] || PAGE_SIZES.A4;
  const cols = per === 2 ? 2 : Math.ceil(Math.sqrt(per)), rows = Math.ceil(per / cols);
  const landscape = per === 2 || per === 6 || per === 8;
  const W = landscape ? Math.max(sw, sh) : Math.min(sw, sh), H = landscape ? Math.min(sw, sh) : Math.max(sw, sh);
  const gap = opts.gap ?? 12;
  const cw = (W - gap * (cols + 1)) / cols, ch = (H - gap * (rows + 1)) / rows;
  for (let i = 0; i < embedded.length; i += per) {
    const page = out.addPage([W, H]);
    for (let k = 0; k < per && i + k < embedded.length; k++) {
      const e = embedded[i + k];
      const g = visualGeom(src.getPage(i + k));
      const vw = g.rot % 180 ? e.height : e.width, vh = g.rot % 180 ? e.width : e.height;
      const scale = Math.min(cw / vw, ch / vh);
      const col = k % cols, row = Math.floor(k / cols);
      const cx = gap + col * (cw + gap) + cw / 2, cy = H - (gap + row * (ch + gap) + ch / 2);
      const dw = vw * scale, dh = vh * scale;
      let x = cx - dw / 2, y = cy - dh / 2;
      if (g.rot === 90) x = cx + dw / 2; else if (g.rot === 180) { x = cx + dw / 2; y = cy + dh / 2; } else if (g.rot === 270) y = cy + dh / 2;
      page.drawPage(e, { x, y, width: e.width * scale, height: e.height * scale, rotate: PL().degrees(g.rot) });
      if (opts.border) page.drawRectangle({ x: cx - dw / 2, y: cy - dh / 2, width: dw, height: dh, borderWidth: 0.5, borderColor: PL().rgb(0.6, 0.6, 0.6) });
    }
  }
  return saveDoc(out);
}

// ---------- metadata / forms / annotations ----------
export async function getMetadata(bytes) {
  const doc = await loadDoc(bytes);
  const safe = (fn) => { try { return fn() || ''; } catch { return ''; } };
  return { title: safe(() => doc.getTitle()), author: safe(() => doc.getAuthor()), subject: safe(() => doc.getSubject()), keywords: safe(() => doc.getKeywords()), creator: safe(() => doc.getCreator()), producer: safe(() => doc.getProducer()), created: safe(() => doc.getCreationDate()?.toISOString()), modified: safe(() => doc.getModificationDate()?.toISOString()), pages: doc.getPageCount() };
}
export async function setMetadata(bytes, meta) {
  const doc = await loadDoc(bytes);
  if (meta.title != null) doc.setTitle(meta.title);
  if (meta.author != null) doc.setAuthor(meta.author);
  if (meta.subject != null) doc.setSubject(meta.subject);
  if (meta.keywords != null) doc.setKeywords(String(meta.keywords).split(/[,;]\s*/).filter(Boolean));
  if (meta.creator != null) doc.setCreator(meta.creator);
  if (meta.producer != null) doc.setProducer(meta.producer);
  doc.setModificationDate(new Date());
  return saveDoc(doc);
}
export async function stripMetadata(bytes) {
  const doc = await loadDoc(bytes);
  doc.setTitle(''); doc.setAuthor(''); doc.setSubject(''); doc.setKeywords([]); doc.setCreator(''); doc.setProducer('');
  try { doc.catalog.delete(PL().PDFName.of('Metadata')); } catch { /* ignore */ }
  return saveDoc(doc);
}
export async function getFormFields(bytes) {
  const doc = await loadDoc(bytes);
  let form;
  try { form = doc.getForm(); } catch { return []; }
  const out = [];
  for (const f of form.getFields()) {
    const type = fieldType(f);
    const entry = { name: f.getName(), type };
    try {
      if (type === 'PDFTextField') { entry.kind = 'text'; entry.value = f.getText() || ''; entry.multiline = f.isMultiline(); }
      else if (type === 'PDFCheckBox') { entry.kind = 'checkbox'; entry.value = f.isChecked(); }
      else if (type === 'PDFRadioGroup') { entry.kind = 'radio'; entry.options = f.getOptions(); entry.value = f.getSelected() || ''; }
      else if (type === 'PDFDropdown') { entry.kind = 'dropdown'; entry.options = f.getOptions(); entry.value = (f.getSelected() || [])[0] || ''; }
      else if (type === 'PDFOptionList') { entry.kind = 'list'; entry.options = f.getOptions(); entry.value = f.getSelected() || []; }
      else if (type === 'PDFSignature') { entry.kind = 'signature'; }
      else if (type === 'PDFButton') { entry.kind = 'button'; }
      else entry.kind = 'other';
    } catch (e) { entry.kind = 'other'; entry.error = e.message; }
    out.push(entry);
  }
  return out;
}
function fieldType(f) {
  const L = PL();
  for (const name of ['PDFTextField', 'PDFCheckBox', 'PDFRadioGroup', 'PDFDropdown', 'PDFOptionList', 'PDFSignature', 'PDFButton']) if (L[name] && f instanceof L[name]) return name;
  return 'other';
}
export async function setFormFields(bytes, values, opts = {}) {
  const doc = await loadDoc(bytes);
  const form = doc.getForm();
  const fm = new FontManager(doc);
  let unicodeFont = null;
  for (const [name, value] of Object.entries(values)) {
    let f;
    try { f = form.getField(name); } catch { continue; }
    const type = fieldType(f);
    try {
      if (type === 'PDFTextField') {
        const text = String(value ?? '');
        if (!/^[\x00-\xff]*$/.test(text)) { if (!unicodeFont) unicodeFont = await fm.embeddedFor(text); if (unicodeFont) f.updateAppearances(unicodeFont); }
        f.setText(text);
      }
      else if (type === 'PDFCheckBox') { if (value) f.check(); else f.uncheck(); }
      else if (type === 'PDFRadioGroup') { if (value) f.select(value); }
      else if (type === 'PDFDropdown') { if (value) f.select(value); }
      else if (type === 'PDFOptionList') { f.select(Array.isArray(value) ? value : [value]); }
    } catch (e) { console.warn('field', name, e.message); }
  }
  if (opts.flatten) form.flatten();
  else try { form.updateFieldAppearances(); } catch { /* ignore */ }
  return saveDoc(doc);
}
export async function flattenForms(bytes) {
  const doc = await loadDoc(bytes);
  try { doc.getForm().flatten(); } catch (e) { console.warn(e); }
  return saveDoc(doc);
}
export async function removeAnnotations(bytes, opts = {}) {
  const doc = await loadDoc(bytes);
  const { PDFName } = PL();
  for (const p of doc.getPages()) {
    const annots = p.node.Annots();
    if (!annots) continue;
    if (opts.keepLinks || opts.keepWidgets) {
      const keep = [];
      for (let i = 0; i < annots.size(); i++) {
        const ref = annots.get(i);
        const d = doc.context.lookup(ref);
        const sub = d && d.get && d.get(PDFName.of('Subtype'));
        const st = sub ? sub.toString() : '';
        if ((opts.keepLinks && st === '/Link') || (opts.keepWidgets && st === '/Widget')) keep.push(ref);
      }
      p.node.set(PDFName.of('Annots'), doc.context.obj(keep));
    } else p.node.delete(PDFName.of('Annots'));
  }
  if (!opts.keepWidgets) { try { doc.catalog.delete(PDFName.of('AcroForm')); } catch { /* ignore */ } }
  return saveDoc(doc);
}
export async function repair(bytes) {
  const doc = await loadDoc(bytes);
  return saveDoc(doc, { useObjectStreams: false });
}

// ---------- images ----------
/** Render pages with pdf.js. returns canvases (caller frees). opts: {scale|dpi, pages:[idx]} */
export async function renderPages(bytes, opts, onPage) {
  const task = pdfjs().getDocument({ data: bytes.slice(), cMapUrl: 'vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: 'vendor/pdfjs/standard_fonts/', password: opts.password });
  const pdf = await task.promise;
  const pages = opts.pages || Array.from({ length: pdf.numPages }, (_, i) => i);
  for (const i of pages) {
    const page = await pdf.getPage(i + 1);
    const scale = opts.dpi ? opts.dpi / 72 : opts.scale || 2;
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d');
    if (opts.background !== 'transparent') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
    await page.render({ canvasContext: ctx, viewport: vp, background: opts.background === 'transparent' ? 'rgba(0,0,0,0)' : '#ffffff' }).promise;
    if (opts.grayscale) { const id = ctx.getImageData(0, 0, c.width, c.height); const d = id.data; for (let k = 0; k < d.length; k += 4) { const g = 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]; d[k] = d[k + 1] = d[k + 2] = g; } ctx.putImageData(id, 0, 0); }
    await onPage(c, i, page.getViewport({ scale: 1 }));
    page.cleanup();
  }
  await pdf.destroy();
}
/** PDF -> [{name, bytes, type}] images per page. opts: {format:'png'|'jpeg'|'webp', dpi, quality, pages} */
export async function pdfToImages(bytes, opts = {}, onProgress) {
  const out = [];
  const fmt = opts.format || 'png';
  await renderPages(bytes, { dpi: opts.dpi || 150, pages: opts.pages, grayscale: opts.grayscale, background: fmt === 'png' && opts.transparent ? 'transparent' : 'white' }, async (c, i) => {
    const mime = fmt === 'jpg' || fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
    out.push({ name: `page-${String(i + 1).padStart(3, '0')}.${fmt === 'jpeg' ? 'jpg' : fmt}`, bytes: await canvasToBytes(c, mime, opts.quality ?? 0.9), type: mime });
    if (onProgress) onProgress(out.length);
  });
  return out;
}
/** Rasterise the whole document (used by "compress: extreme", redaction and unlock fallback). */
export async function rasterizePdf(bytes, opts = {}, onProgress) {
  const out = await PL().PDFDocument.create();
  let n = 0;
  await renderPages(bytes, { dpi: opts.dpi || 110, grayscale: opts.grayscale, password: opts.password }, async (c, i, vp1) => {
    const jpg = await canvasToBytes(c, 'image/jpeg', opts.quality ?? 0.75);
    const img = await out.embedJpg(jpg);
    const page = out.addPage([vp1.width, vp1.height]);
    page.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    if (onProgress) onProgress(++n);
  });
  return saveDoc(out);
}
/** Image files -> PDF. opts: { pageSize:'fit'|'A4'|..., orientation:'auto'|'portrait'|'landscape', margin, fit:'contain'|'cover'|'stretch' } */
export async function imagesToPdf(files, opts = {}) {
  const doc = await PL().PDFDocument.create();
  for (const file of files) {
    const img = await normalizeImageFile(file);
    const embedded = img.type === 'jpg' ? await doc.embedJpg(img.bytes) : await doc.embedPng(img.bytes);
    const iw = embedded.width, ih = embedded.height;
    let pw, ph;
    if (!opts.pageSize || opts.pageSize === 'fit') { const s = (opts.dpi ? 72 / opts.dpi : 0.75); pw = iw * s + 2 * (opts.margin || 0); ph = ih * s + 2 * (opts.margin || 0); }
    else {
      [pw, ph] = PAGE_SIZES[opts.pageSize] || PAGE_SIZES.A4;
      const landscape = opts.orientation === 'landscape' || (opts.orientation !== 'portrait' && iw > ih);
      if (landscape) [pw, ph] = [Math.max(pw, ph), Math.min(pw, ph)]; else [pw, ph] = [Math.min(pw, ph), Math.max(pw, ph)];
    }
    const page = doc.addPage([pw, ph]);
    const m = opts.margin || 0;
    const aw = pw - 2 * m, ah = ph - 2 * m;
    let w, h;
    if (opts.fit === 'stretch') { w = aw; h = ah; }
    else { const s = opts.fit === 'cover' ? Math.max(aw / iw, ah / ih) : Math.min(aw / iw, ah / ih); w = iw * s; h = ih * s; }
    page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return saveDoc(doc);
}

// ---------- compression ----------
/**
 * Recompress images inside the PDF. opts: { quality:0.6, maxDim:1600, grayscale:false, minBytes: 20000 }
 * Returns { bytes, replaced, skipped }.
 */
export async function compressImages(bytes, opts = {}, onProgress) {
  const { PDFName, PDFRawStream, PDFNumber, PDFArray, decodePDFRawStream } = PL();
  const doc = await loadDoc(bytes);
  const quality = opts.quality ?? 0.6, maxDim = opts.maxDim ?? 1600, minBytes = opts.minBytes ?? 8000;
  let replaced = 0, skipped = 0, k = 0;
  const entries = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
  const nameOf = (v) => (v ? v.toString() : '');
  for (const [ref, obj] of entries) {
    k++;
    if (onProgress) onProgress(k / entries.length);
    const d = obj.dict;
    if (obj.contents.length < minBytes) { skipped++; continue; }
    if (d.get(PDFName.of('ImageMask'))) { skipped++; continue; }
    const w = d.get(PDFName.of('Width')), h = d.get(PDFName.of('Height'));
    if (!(w instanceof PDFNumber) || !(h instanceof PDFNumber)) { skipped++; continue; }
    const width = w.asNumber(), height = h.asNumber();
    let filter = d.get(PDFName.of('Filter'));
    if (filter instanceof PDFArray) filter = filter.size() === 1 ? filter.get(0) : null;
    const fname = nameOf(filter);
    const bpc = d.get(PDFName.of('BitsPerComponent'));
    let cs = d.get(PDFName.of('ColorSpace'));
    if (cs && cs.constructor && cs.constructor.name === 'PDFRef') cs = doc.context.lookup(cs);
    let csName = cs instanceof PDFArray ? nameOf(cs.get(0)) : nameOf(cs);
    let ncomp = csName === '/DeviceRGB' || csName === '/CalRGB' ? 3 : csName === '/DeviceGray' || csName === '/CalGray' ? 1 : csName === '/DeviceCMYK' ? 4 : 0;
    if (csName === '/ICCBased' && cs instanceof PDFArray) { const s = doc.context.lookup(cs.get(1)); const n = s && s.dict && s.dict.get(PDFName.of('N')); ncomp = n instanceof PDFNumber ? n.asNumber() : 3; }
    const canvas = document.createElement('canvas');
    let drawn = false;
    try {
      if (fname === '/DCTDecode') {
        const bmp = await createImageBitmap(new Blob([obj.contents], { type: 'image/jpeg' }));
        const s = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
        canvas.width = Math.max(1, Math.round(bmp.width * s)); canvas.height = Math.max(1, Math.round(bmp.height * s));
        canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
        bmp.close();
        drawn = true;
      } else if ((fname === '/FlateDecode' || fname === '' || fname === '/LZWDecode' || fname === '/RunLengthDecode') && bpc instanceof PDFNumber && bpc.asNumber() === 8 && (ncomp === 1 || ncomp === 3)) {
        const raw = fname ? decodePDFRawStream(obj).decode() : obj.contents;
        if (raw.length < width * height * ncomp) throw new Error('short image data');
        const s = Math.min(1, maxDim / Math.max(width, height));
        const src = document.createElement('canvas'); src.width = width; src.height = height;
        const id = src.getContext('2d').createImageData(width, height);
        const n = width * height;
        const decodeArr = d.get(PDFName.of('Decode'));
        const inverted = decodeArr instanceof PDFArray && decodeArr.get(0) instanceof PDFNumber && decodeArr.get(0).asNumber() === 1;
        for (let i = 0; i < n; i++) {
          let r, g, b;
          if (ncomp === 3) { r = raw[i * 3]; g = raw[i * 3 + 1]; b = raw[i * 3 + 2]; } else { r = g = b = raw[i]; }
          if (inverted) { r = 255 - r; g = 255 - g; b = 255 - b; }
          id.data[i * 4] = r; id.data[i * 4 + 1] = g; id.data[i * 4 + 2] = b; id.data[i * 4 + 3] = 255;
        }
        src.getContext('2d').putImageData(id, 0, 0);
        canvas.width = Math.max(1, Math.round(width * s)); canvas.height = Math.max(1, Math.round(height * s));
        canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
        drawn = true;
      }
    } catch (e) { console.warn('compress: skip image', e.message); }
    if (!drawn) { skipped++; continue; }
    if (opts.grayscale) { const ctx = canvas.getContext('2d'); const id = ctx.getImageData(0, 0, canvas.width, canvas.height); const dd = id.data; for (let i = 0; i < dd.length; i += 4) { const g = 0.299 * dd[i] + 0.587 * dd[i + 1] + 0.114 * dd[i + 2]; dd[i] = dd[i + 1] = dd[i + 2] = g; } ctx.putImageData(id, 0, 0); }
    const jpg = await canvasToBytes(canvas, 'image/jpeg', quality);
    if (jpg.length >= obj.contents.length * 0.95) { skipped++; continue; }
    const newDict = doc.context.obj({ Type: 'XObject', Subtype: 'Image', Width: canvas.width, Height: canvas.height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' });
    const smask = d.get(PDFName.of('SMask'));
    if (smask) newDict.set(PDFName.of('SMask'), smask);
    doc.context.assign(ref, PDFRawStream.of(newDict, jpg));
    replaced++;
  }
  return { bytes: await saveDoc(doc), replaced, skipped };
}

/** List images in the document via pdf.js (decoded), for the Extract Images tool. */
export async function extractImages(bytes, onProgress) {
  const { pageImages } = await import('./pdf2doc.js');
  const pdf = await pdfjs().getDocument({ data: bytes.slice(), cMapUrl: 'vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: 'vendor/pdfjs/standard_fonts/' }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const imgs = await pageImages(page, page.getViewport({ scale: 1 }), 200);
    imgs.forEach((im, k) => out.push({ name: `page${i}-image${k + 1}.png`, bytes: im.bytes, type: 'image/png', page: i, width: im.pxWidth, height: im.pxHeight }));
    if (onProgress) onProgress(i / pdf.numPages);
  }
  await pdf.destroy();
  return out;
}

/** Compare two PDFs page by page (pixel diff). Returns [{page, diffRatio, canvas}] */
export async function comparePdfs(a, b, opts = {}) {
  const pagesA = [], pagesB = [];
  await renderPages(a, { scale: opts.scale || 1 }, async (c, i) => pagesA.push({ i, c }));
  await renderPages(b, { scale: opts.scale || 1 }, async (c, i) => pagesB.push({ i, c }));
  const n = Math.max(pagesA.length, pagesB.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const ca = pagesA[i] && pagesA[i].c, cb = pagesB[i] && pagesB[i].c;
    const w = Math.max(ca ? ca.width : 0, cb ? cb.width : 0), h = Math.max(ca ? ca.height : 0, cb ? cb.height : 0);
    const diff = document.createElement('canvas'); diff.width = w; diff.height = h;
    const ctx = diff.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    const da = ca ? ca.getContext('2d').getImageData(0, 0, ca.width, ca.height) : null, db = cb ? cb.getContext('2d').getImageData(0, 0, cb.width, cb.height) : null;
    const out1 = ctx.createImageData(w, h);
    let changed = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const pa = da && x < da.width && y < da.height ? (y * da.width + x) * 4 : -1, pb = db && x < db.width && y < db.height ? (y * db.width + x) * 4 : -1;
      const ga = pa >= 0 ? (da.data[pa] + da.data[pa + 1] + da.data[pa + 2]) / 3 : 255, gb = pb >= 0 ? (db.data[pb] + db.data[pb + 1] + db.data[pb + 2]) / 3 : 255;
      const o = (y * w + x) * 4;
      const same = Math.abs(ga - gb) < 40;
      if (same) { out1.data[o] = out1.data[o + 1] = out1.data[o + 2] = 255 - (255 - ga) * 0.25; }
      else { changed++; if (ga < gb) { out1.data[o] = 230; out1.data[o + 1] = 40; out1.data[o + 2] = 40; } else { out1.data[o] = 40; out1.data[o + 1] = 120; out1.data[o + 2] = 230; } }
      out1.data[o + 3] = 255;
    }
    ctx.putImageData(out1, 0, 0);
    out.push({ page: i + 1, diffRatio: changed / (w * h || 1), canvas: diff });
  }
  return out;
}
