// PDF -> document model using pdf.js text content and operator lists.
// Groups glyph runs into lines, lines into paragraphs, detects alignment / indents / headings,
// extracts embedded images at their positions, and can alternatively rasterise whole pages.
import { newDoc, para } from './docmodel.js';
import { canvasToBytes } from './util.js';

const pdfjs = () => globalThis.pdfjsLib;

function cleanFontName(name) {
  let n = String(name || '').replace(/^[A-Z]{6}\+/, '');
  n = n.split(/[-,]/)[0].replace(/(PSMT|MT|PS)$/, '');
  n = n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/New Roman/, 'New Roman').replace(/Times New Roman PS/, 'Times New Roman');
  if (/^Arial/.test(n)) n = 'Arial';
  if (/^Times/.test(n)) n = 'Times New Roman';
  if (/^Courier/.test(n)) n = 'Courier New';
  if (/^Helvetica/.test(n)) n = 'Arial';
  return n || 'Arial';
}
function familyOfName(name, generic) {
  const s = String(name || '').toLowerCase();
  if (/courier|mono/.test(s) || generic === 'monospace') return 'mono';
  if ((/times|georgia|garamond|serif|book|cambria|minion|palatino|century|batang|myeongjo/.test(s) && !/sans/.test(s)) || generic === 'serif') return 'serif';
  return 'sans';
}

/** Extract text spans of one page in viewport (top-down, points) coordinates. */
export async function pageSpans(page, viewport) {
  // Fonts (and their bold/italic flags) are only transferred to the main thread while building
  // the operator list, so fetch it first; pdf.js caches it for the later image pass.
  try { await page.getOperatorList(); } catch { /* ignore */ }
  const tc = await page.getTextContent();
  const spans = [];
  const U = pdfjs().Util;
  for (const item of tc.items) {
    if (!('str' in item)) continue;
    if (!item.str.trim() && !item.hasEOL) { if (item.str) spans.push({ space: true, str: item.str, hasEOL: item.hasEOL }); continue; }
    const t = U.transform(viewport.transform, item.transform);
    const size = Math.hypot(t[2], t[3]);
    const horizontal = Math.abs(t[1]) < Math.abs(t[0]);
    const width = item.width * (horizontal ? Math.abs(t[0]) / (Math.hypot(t[0], t[1]) || 1) : 1) * Math.hypot(viewport.transform[0], viewport.transform[1]);
    const style = tc.styles[item.fontName] || {};
    let fontObj = null;
    try { if (page.commonObjs.has(item.fontName)) fontObj = page.commonObjs.get(item.fontName); } catch { /* not loaded */ }
    const rawName = (fontObj && fontObj.name) || item.fontName;
    const bold = !!(fontObj && (fontObj.bold || fontObj.black)) || /bold|black|heavy|semibold|demibold|extrabold/i.test(rawName);
    const italic = !!(fontObj && fontObj.italic) || /italic|oblique/i.test(rawName);
    spans.push({ str: item.str, x: t[4], y: t[5], size: Math.max(1, size), width: Math.abs(width) || item.width, height: item.height || size, bold, italic, fontName: cleanFontName(rawName), family: familyOfName(rawName, style.fontFamily), hasEOL: item.hasEOL, ascent: style.ascent || 0.9 });
  }
  return spans;
}

/** Group spans into lines: [{ y, x, right, size, spans:[...] }] sorted top to bottom. */
export function groupLines(spans) {
  const lines = [];
  for (const s of spans.filter((s) => !s.space)) {
    const tol = Math.max(2, s.size * 0.45);
    let line = lines.find((l) => Math.abs(l.y - s.y) <= tol && (Math.abs(l.size - s.size) < Math.max(l.size, s.size) * 0.6 || Math.abs(l.y - s.y) <= 1.5));
    if (!line) { line = { y: s.y, size: s.size, spans: [] }; lines.push(line); }
    line.spans.push(s);
    line.size = Math.max(line.size, s.size);
  }
  for (const l of lines) {
    l.spans.sort((a, b) => a.x - b.x);
    l.x = l.spans[0].x;
    l.right = Math.max(...l.spans.map((s) => s.x + s.width));
    l.y = l.spans.reduce((a, s) => a + s.y, 0) / l.spans.length;
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x);
  return lines;
}
/** Text of a line with spaces inserted where glyph gaps indicate word breaks. */
export function lineRuns(line) {
  const runs = [];
  let prev = null;
  for (const s of line.spans) {
    let text = s.str;
    if (prev) {
      const gap = s.x - (prev.x + prev.width);
      const needSpace = gap > Math.min(prev.size, s.size) * 0.18 && !/\s$/.test(prev.str) && !/^\s/.test(text);
      if (needSpace) text = (gap > s.size * 2.5 ? '\t' : ' ') + text;
    }
    const last = runs[runs.length - 1];
    if (last && last.bold === s.bold && last.italic === s.italic && Math.abs(last.size - s.size) < 0.5 && last.fontName === s.fontName) last.text += text;
    else runs.push({ text, bold: s.bold, italic: s.italic, size: Math.round(s.size * 2) / 2, fontName: s.fontName, family: s.family, color: '#000000', underline: false, strike: false });
    prev = s;
  }
  return runs;
}
export const lineText = (line) => lineRuns(line).map((r) => r.text).join('');

/** Lines -> paragraphs with alignment/indent/spacing detection. bounds: {left,right} text block edges. */
export function paragraphsFromLines(lines, bounds) {
  const paras = [];
  if (!lines.length) return paras;
  const widthOfBlock = bounds.right - bounds.left;
  const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const bodySize = median(lines.map((l) => l.size)) || 11;
  let cur = null;
  const pitches = [];
  for (let i = 1; i < lines.length; i++) pitches.push(lines[i].y - lines[i - 1].y);
  const normalPitch = median(pitches.filter((p) => p > 0 && p < bodySize * 3)) || bodySize * 1.2;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], prev = lines[i - 1];
    let newPara = !cur;
    if (!newPara) {
      const gap = l.y - prev.y;
      const sizeChange = Math.abs(l.size - prev.size) > Math.max(l.size, prev.size) * 0.2;
      const prevShort = prev.right < bounds.right - Math.max(bodySize * 4, widthOfBlock * 0.2);
      const indented = l.x > cur.left + bodySize * 1.2 && l.x > prev.x + bodySize * 1.2;
      const outdented = l.x < cur.left - bodySize * 0.8;
      const bigGap = gap > Math.max(normalPitch, prev.size * 1.2) * 1.45;
      const bulletStart = /^[•◦▪\-–*]\s|^\(?\d{1,3}[.)]\s|^[a-zA-Z][.)]\s/.test(lineText(l));
      if (gap < 0 || bigGap || sizeChange || (prevShort && !cur.centered) || indented || outdented || bulletStart) newPara = true;
    }
    if (newPara) {
      cur = { lines: [l], left: l.x, right: l.right, size: l.size, y: l.y };
      paras.push(cur);
    } else { cur.lines.push(l); cur.left = Math.min(cur.left, l.x); cur.right = Math.max(cur.right, l.right); }
    const lm = l.x - bounds.left, rm = bounds.right - l.right;
    cur.centered = Math.abs(lm - rm) < Math.max(6, bodySize * 0.8) && lm > bodySize * 1.5;
  }
  const out = [];
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i], next = paras[i + 1];
    const runs = [];
    p.lines.forEach((l, k) => {
      const lr = lineRuns(l);
      if (k && lr.length && runs.length) { const last = runs[runs.length - 1]; const joinChar = /[-‐]$/.test(last.text) ? '' : ' '; if (joinChar) last.text += joinChar; }
      runs.push(...lr);
    });
    // merge same-style runs
    const merged = [];
    for (const r of runs) { const last = merged[merged.length - 1]; if (last && last.bold === r.bold && last.italic === r.italic && last.size === r.size && last.fontName === r.fontName) last.text += r.text; else merged.push({ ...r }); }
    const lm = p.left - bounds.left, rm = bounds.right - p.right;
    let align = 'left';
    const allCentered = p.lines.every((l) => { const a = l.x - bounds.left, b = bounds.right - l.right; return Math.abs(a - b) < Math.max(6, bodySize * 0.8) && a > bodySize; });
    if (allCentered) align = 'center';
    else if (rm < bodySize * 0.6 && lm > bodySize * 2 && p.lines.every((l) => bounds.right - l.right < bodySize * 0.6)) align = 'right';
    else if (p.lines.length > 2 && p.lines.slice(0, -1).every((l) => bounds.right - l.right < bodySize * 0.8) && lm < bodySize) align = 'justify';
    const firstLineIndent = p.lines[0].x - p.left;
    const lineH = p.lines.length > 1 ? (p.lines[p.lines.length - 1].y - p.lines[0].y) / (p.lines.length - 1) : p.size * 1.2;
    const gapAfter = next ? next.y - p.lines[p.lines.length - 1].y - lineH : 0;
    const isHeading = p.size >= bodySize * 1.25 && p.lines.length <= 3 && merged.some((r) => r.bold || p.size >= bodySize * 1.5);
    out.push(para(merged, {
      align, indent: align === 'left' && lm > bodySize * 0.5 ? Math.round(lm) : 0, firstLine: firstLineIndent > bodySize * 0.8 ? Math.round(firstLineIndent) : 0,
      spaceBefore: 0, spaceAfter: Math.max(0, Math.min(40, Math.round(gapAfter))), lineSpacing: Math.max(0.85, Math.min(2.2, Math.round((lineH / (p.size * 1.17)) * 100) / 100)),
      heading: isHeading ? (p.size >= bodySize * 1.8 ? 1 : p.size >= bodySize * 1.45 ? 2 : 3) : null, size: p.size, y: p.y, bottom: p.lines[p.lines.length - 1].y + 2,
    }));
  }
  return out;
}

/** Find images drawn on a page: [{ x, y, width, height, bytes, imgType }] in viewport coords. */
export async function pageImages(page, viewport, limit = 60) {
  const U = pdfjs().Util, OPS = pdfjs().OPS;
  let ops;
  try { ops = await page.getOperatorList(); } catch (e) { console.warn('operator list failed', e); return []; }
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const found = [];
  for (let i = 0; i < ops.fnArray.length && found.length < limit; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = U.transform(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args[0]) ctm = U.transform(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintJpegXObject) {
      const m = U.transform(viewport.transform, ctm);
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => U.applyTransform([x, y], m));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      if (box.width < 4 || box.height < 4) continue;
      let imgObj = null;
      try {
        if (fn === OPS.paintInlineImageXObject) imgObj = args[0];
        else imgObj = await new Promise((res) => { try { if (page.objs.has(args[0])) res(page.objs.get(args[0])); else page.objs.get(args[0], res); } catch { res(null); } setTimeout(() => res(null), 3000); });
      } catch { imgObj = null; }
      if (!imgObj) continue;
      const png = await imageObjToPng(imgObj);
      if (png) found.push({ ...box, ...png });
    }
  }
  return found;
}
async function imageObjToPng(obj) {
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    if (obj.bitmap) {
      c.width = obj.bitmap.width; c.height = obj.bitmap.height;
      ctx.drawImage(obj.bitmap, 0, 0);
    } else if (obj.data && obj.width && obj.height) {
      c.width = obj.width; c.height = obj.height;
      const id = ctx.createImageData(obj.width, obj.height);
      const kind = obj.kind, d = obj.data, n = obj.width * obj.height;
      if (kind === 3) id.data.set(d.subarray(0, n * 4));
      else if (kind === 2) for (let i = 0, j = 0; i < n; i++, j += 3) { id.data[i * 4] = d[j]; id.data[i * 4 + 1] = d[j + 1]; id.data[i * 4 + 2] = d[j + 2]; id.data[i * 4 + 3] = 255; }
      else if (kind === 1) { const rowBytes = (obj.width + 7) >> 3; for (let y = 0; y < obj.height; y++) for (let x = 0; x < obj.width; x++) { const bit = (d[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1; const i = (y * obj.width + x) * 4; id.data[i] = id.data[i + 1] = id.data[i + 2] = bit ? 255 : 0; id.data[i + 3] = 255; } }
      else return null;
      ctx.putImageData(id, 0, 0);
    } else return null;
    if (c.width * c.height > 25e6) return null;
    return { bytes: await canvasToBytes(c, 'image/png'), imgType: 'png', pxWidth: c.width, pxHeight: c.height };
  } catch (e) { console.warn('image convert failed', e); return null; }
}

/**
 * Convert a pdf.js document to the document model.
 * opts: { mode:'text'|'image', images:true, scale:2, onProgress(frac) }
 */
export async function pdfToDoc(pdf, opts = {}) {
  const mode = opts.mode || 'text';
  const n = pdf.numPages;
  const first = await pdf.getPage(1);
  const vp0 = first.getViewport({ scale: 1 });
  const doc = newDoc({ pageWidth: vp0.width, pageHeight: vp0.height });
  try { const md = await pdf.getMetadata(); if (md && md.info && md.info.Title) doc.title = String(md.info.Title); } catch { /* ignore */ }
  if (mode === 'image') {
    doc.margins = { top: 0, right: 0, bottom: 0, left: 0 };
    for (let i = 1; i <= n; i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: opts.scale || 2 });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      const bytes = await canvasToBytes(c, 'image/jpeg', 0.9);
      const v1 = page.getViewport({ scale: 1 });
      if (i > 1) doc.blocks.push({ type: 'pageBreak' });
      doc.blocks.push({ type: 'image', bytes, imgType: 'jpg', width: Math.min(v1.width, doc.pageWidth), height: Math.min(v1.height, doc.pageHeight) - 1, spaceAfter: 0 });
      if (opts.onProgress) opts.onProgress(i / n);
    }
    return doc;
  }
  const pages = [];
  let left = Infinity, right = 0, top = Infinity, bottom = 0;
  for (let i = 1; i <= n; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const spans = await pageSpans(page, vp);
    const lines = groupLines(spans);
    for (const l of lines) { left = Math.min(left, l.x); right = Math.max(right, l.right); top = Math.min(top, l.y - l.size); bottom = Math.max(bottom, l.y); }
    const images = opts.images === false ? [] : await pageImages(page, vp);
    for (const im of images) { left = Math.min(left, im.x); right = Math.max(right, im.x + im.width); top = Math.min(top, im.y); bottom = Math.max(bottom, im.y + im.height); }
    pages.push({ lines, images, vp });
    if (opts.onProgress) opts.onProgress((i / n) * 0.9);
  }
  if (!Number.isFinite(left)) { left = 72; right = doc.pageWidth - 72; top = 72; bottom = doc.pageHeight - 72; }
  const clampM = (v) => Math.max(18, Math.min(120, Math.round(v)));
  doc.margins = { left: clampM(left), right: clampM(doc.pageWidth - right), top: clampM(top), bottom: clampM(doc.pageHeight - bottom) };
  const bounds = { left, right };
  const contentW = doc.pageWidth - doc.margins.left - doc.margins.right;
  for (let pi = 0; pi < pages.length; pi++) {
    const { lines, images } = pages[pi];
    const paras = paragraphsFromLines(lines, bounds);
    const items = paras.map((p) => ({ y: p.y, block: p }));
    for (const im of images) {
      let w = im.width, h = im.height;
      if (w > contentW) { h *= contentW / w; w = contentW; }
      items.push({ y: im.y + 0.01, block: { type: 'image', bytes: im.bytes, imgType: 'png', width: w, height: h, align: im.x + im.width / 2 > doc.pageWidth / 2 + 40 ? 'right' : im.x + im.width / 2 < doc.pageWidth / 2 - 40 ? 'left' : 'center', spaceAfter: 6 } });
    }
    items.sort((a, b) => a.y - b.y);
    if (pi > 0) doc.blocks.push({ type: 'pageBreak' });
    for (const it of items) { delete it.block.y; delete it.block.bottom; doc.blocks.push(it.block); }
    if (!items.length) doc.blocks.push(para([]));
  }
  // relative indents: convert absolute left offsets to indents relative to the margin
  for (const b of doc.blocks) if (b.type === 'paragraph' && b.indent) b.indent = Math.max(0, b.indent - (doc.margins.left - left));
  if (opts.onProgress) opts.onProgress(1);
  return doc;
}

/** Plain text of the whole document (lines preserved, pages separated by form feed). */
export async function pdfToText(pdf, opts = {}) {
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const lines = groupLines(await pageSpans(page, vp));
    if (opts.layout) {
      // approximate column positions with spaces
      const charW = 4.5;
      out.push(lines.map((l) => { let s = ''; for (const sp of l.spans) { const col = Math.round((sp.x - 20) / charW); while (s.length < col) s += ' '; s += sp.str; } return s.replace(/\s+$/, ''); }).join('\n'));
    } else out.push(lines.map(lineText).join('\n'));
    if (opts.onProgress) opts.onProgress(i / pdf.numPages);
  }
  return out.join('\n\f\n');
}
