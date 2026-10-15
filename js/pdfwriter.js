// Document model -> PDF. A small flow layout engine on top of pdf-lib: paragraphs with mixed
// runs, word wrap (with CJK character breaking), alignment incl. justify, lists, inline and
// block images, tables with borders/shading, page breaks, absolute boxes, headers/footers.
import { FontManager, canWinAnsi } from './fonts.js';
import { hexToRgb } from './util.js';

const { PDFDocument, rgb, PDFName, PDFString } = globalThis.PDFLib || {};

const CJK = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/;
const scriptClass = (text) => {
  if (canWinAnsi(text)) return 'latin';
  for (const ch of text) { const cp = ch.codePointAt(0); if (cp >= 0xac00 && cp <= 0xd7af) return 'hangul'; if (CJK.test(ch)) return 'cjk'; if (cp >= 0x400 && cp <= 0x4ff) return 'cyr'; if (cp >= 0x370 && cp <= 0x3ff) return 'greek'; }
  return 'other';
};

export async function renderDocToPdf(doc, opts = {}) {
  const pdfDoc = opts.pdfDoc || await PDFDocument.create();
  const layout = new Layout(pdfDoc, doc, opts);
  await layout.run();
  if (doc.title) pdfDoc.setTitle(doc.title);
  pdfDoc.setProducer('PDF Editor');
  pdfDoc.setCreator('PDF Editor');
  return opts.pdfDoc ? pdfDoc : pdfDoc.save();
}

class Layout {
  constructor(pdfDoc, doc, opts) {
    this.pdfDoc = pdfDoc;
    this.doc = doc;
    this.opts = opts;
    this.fm = new FontManager(pdfDoc);
    this.fontCache = new Map();
    this.pages = [];
    this.page = null;
    this.deferred = [];
    this.imgCache = new Map();
    this.onProgress = opts.onProgress || (() => {});
  }
  get W() { return this.doc.pageWidth; }
  get H() { return this.doc.pageHeight; }
  get m() { return this.doc.margins; }

  newPage() {
    this.page = this.pdfDoc.addPage([this.W, this.H]);
    this.pages.push(this.page);
    return this.page;
  }
  async font(run, text) {
    const key = `${run.family || ''}|${run.fontName || ''}|${run.bold ? 1 : 0}${run.italic ? 1 : 0}|${scriptClass(text)}`;
    if (!this.fontCache.has(key)) this.fontCache.set(key, await this.fm.resolve(text, { family: run.family, fontName: run.fontName, bold: run.bold, italic: run.italic }));
    return this.fontCache.get(key);
  }
  async image(img) {
    const key = img.bytes;
    if (!this.imgCache.has(key)) {
      try { this.imgCache.set(key, img.imgType === 'jpg' ? await this.pdfDoc.embedJpg(img.bytes) : await this.pdfDoc.embedPng(img.bytes)); }
      catch (e) { console.warn('embed image failed', e); this.imgCache.set(key, null); }
    }
    return this.imgCache.get(key);
  }

  async run() {
    this.newPage();
    const frame = this.mainFrame();
    const blocks = this.doc.blocks;
    for (let i = 0; i < blocks.length; i++) {
      await this.block(blocks[i], frame);
      if (i % 20 === 0) this.onProgress(i / blocks.length);
    }
    await this.headersFooters();
    for (const d of this.deferred) await this.drawField(d);
  }
  mainFrame() {
    const self = this;
    return {
      x: this.m.left, width: this.W - this.m.left - this.m.right, y: this.m.top, bottom: this.H - this.m.bottom, pageBreaks: true, draw: true,
      get page() { return self.page; },
      ensure(h) { if (this.y + h > this.bottom && this.pageBreaks && this.y > self.m.top + 0.5) { self.newPage(); this.y = self.m.top; return true; } return false; },
      pageIndex: () => self.pages.length - 1,
    };
  }
  subFrame(x, y, width, draw, bottom = Infinity) {
    const page = this.page;
    return { x, width, y, bottom, pageBreaks: false, draw, page, ensure: () => false, pageIndex: () => this.pages.indexOf(page) };
  }

  async block(b, frame) {
    switch (b.type) {
      case 'paragraph': return this.paragraph(b, frame);
      case 'image': return this.imageBlock(b, frame);
      case 'table': return this.table(b, frame);
      case 'hr': { frame.ensure(12); if (frame.draw) frame.page.drawLine({ start: { x: frame.x, y: this.H - frame.y - 6 }, end: { x: frame.x + frame.width, y: this.H - frame.y - 6 }, thickness: 0.75, color: rgb(0.6, 0.6, 0.6) }); frame.y += 12; return; }
      case 'pageBreak': if (frame.pageBreaks) { this.newPage(); frame.y = this.m.top; } return;
      case 'absolute': {
        const f = this.subFrame(b.x, b.y, b.width, frame.draw);
        for (const inner of b.blocks) await this.block(inner, f);
        return;
      }
      default: return;
    }
  }

  // ----- paragraphs -----
  async tokens(b) {
    const out = [];
    for (const r of b.runs) {
      if (r.pageBreak) { out.push({ pageBreak: true }); continue; }
      if (r.br) { out.push({ br: true }); continue; }
      if (r.tab) { out.push({ tab: true }); continue; }
      if (r.image) { out.push({ image: r.image, width: r.image.width, height: r.image.height }); continue; }
      if (r.field) { const run = { ...r }; const font = await this.font(run, '0'); out.push({ text: '00', run, font, size: run.size || 11, width: font.widthOf('00', run.size || 11), field: r.field }); continue; }
      const text = String(r.text ?? '');
      if (!text) continue;
      const size = r.size || 11;
      const parts = text.match(/\s+|[⺀-鿿가-힯豈-﫿]|[^\s⺀-鿿가-힯豈-﫿]+/g) || [];
      for (const p of parts) {
        const font = await this.font(r, p);
        out.push({ text: p, run: r, font, size, width: font.widthOf(p, size), space: /^\s+$/.test(p) });
      }
    }
    return out;
  }
  lineMetrics(line, b) {
    let natural = 0, ascent = 0, imgH = 0;
    for (const t of line.tokens) {
      if (t.image) { imgH = Math.max(imgH, t.height); continue; }
      const h = t.font.heightAt(t.size), a = t.font.ascentAt(t.size);
      natural = Math.max(natural, h); ascent = Math.max(ascent, a);
    }
    if (!natural) { const s = (b.runs.find((r) => r.size) || {}).size || 11; natural = s * 1.15; ascent = s * 0.9; }
    let height = b.lineExact ? b.lineExact : natural * (b.lineSpacing || 1);
    if (imgH) { height = Math.max(height, imgH + 2); ascent = Math.max(ascent, imgH); }
    return { height, ascent, natural };
  }
  async paragraph(b, frame) {
    if (b.pageBreakBefore && frame.pageBreaks && frame.y > this.m.top + 1) { this.newPage(); frame.y = this.m.top; }
    const tokens = await this.tokens(b);
    const indent = b.indent || 0, right = b.indentRight || 0;
    const firstOffset = (b.firstLine || 0) - (b.hanging || 0);
    const avail = Math.max(10, frame.width - indent - right);
    // break into lines
    const lines = [];
    let cur = { tokens: [], width: 0, first: true, hardBreak: false };
    const lineAvail = () => avail - (cur.first ? firstOffset : 0);
    const pushLine = (hard, pageBreak) => { while (cur.tokens.length && cur.tokens[cur.tokens.length - 1].space) cur.width -= cur.tokens.pop().width; cur.hardBreak = hard; cur.pageBreak = pageBreak; lines.push(cur); cur = { tokens: [], width: 0, first: false }; };
    for (const t of tokens) {
      if (t.br) { pushLine(true); continue; }
      if (t.pageBreak) { pushLine(true, true); continue; }
      if (t.tab) { const rel = cur.width; const next = (Math.floor(rel / 36) + 1) * 36; const w = Math.min(next, lineAvail()) - rel; if (w > 0) { cur.tokens.push({ space: true, width: w, tab: true }); cur.width += w; } continue; }
      if (t.image) {
        const maxW = lineAvail(), maxH = (frame.bottom - this.m.top) - 4;
        let w = t.width || 100, h = t.height || 100;
        if (w > maxW) { h *= maxW / w; w = maxW; }
        if (h > maxH) { w *= maxH / h; h = maxH; }
        t.width = w; t.height = h;
        if (cur.width + w > lineAvail() && cur.tokens.length) pushLine(false);
        cur.tokens.push(t); cur.width += w;
        continue;
      }
      if (t.space && !cur.tokens.length) continue;
      if (cur.width + t.width > lineAvail() + 0.01 && cur.tokens.length) {
        pushLine(false);
        if (t.space) continue;
      }
      if (t.width > lineAvail() && !t.space) { // split a very long word by characters
        let chunk = '', chunkW = 0;
        for (const ch of t.text) {
          const cw = t.font.widthOf(ch, t.size);
          if (chunkW + cw > lineAvail() - cur.width && chunk) { cur.tokens.push({ ...t, text: chunk, width: chunkW }); cur.width += chunkW; pushLine(false); chunk = ''; chunkW = 0; }
          chunk += ch; chunkW += cw;
        }
        if (chunk) { cur.tokens.push({ ...t, text: chunk, width: chunkW }); cur.width += chunkW; }
        continue;
      }
      cur.tokens.push(t); cur.width += t.width;
    }
    if (cur.tokens.length || !lines.length) pushLine(true);

    frame.y += b.spaceBefore || 0;
    // keep heading-ish paragraphs with at least 2 lines of space
    const first = this.lineMetrics(lines[0], b);
    if (frame.pageBreaks && lines.length > 1) frame.ensure(first.height * 2);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const met = this.lineMetrics(line, b);
      frame.ensure(met.height);
      const top = frame.y;
      const baseline = top + met.ascent + Math.max(0, (met.height - met.natural) * 0.5);
      const lineStartX = frame.x + indent + (line.first ? firstOffset : 0);
      const lineAvailW = avail - (line.first ? firstOffset : 0);
      let x = lineStartX;
      let extraSpace = 0;
      if (b.align === 'center') x += (lineAvailW - line.width) / 2;
      else if (b.align === 'right') x += lineAvailW - line.width;
      else if (b.align === 'justify' && !line.hardBreak && li < lines.length - 1) {
        const spaces = line.tokens.filter((t) => t.space && !t.tab).length;
        if (spaces) extraSpace = (lineAvailW - line.width) / spaces;
      }
      if (frame.draw) {
        const page = frame.page;
        if (b.shading) page.drawRectangle({ x: frame.x + indent - 2, y: this.H - top - met.height, width: avail + 4, height: met.height + (li === lines.length - 1 ? 0 : 0.5), color: rgb(...hexToRgb(b.shading)) });
        if (line.first && b.list) {
          const lr = line.tokens.find((t) => t.run) || {}; const run = lr.run || b.runs.find((r) => r.text) || { size: 11 };
          const mf = await this.font({ ...run, bold: false, italic: false }, b.list.text);
          const mw = mf.widthOf(b.list.text, run.size || 11);
          const mx = Math.max(frame.x, lineStartX - (b.hanging || 18) + 0);
          await mf.draw(page, b.list.text, Math.min(mx, lineStartX - mw - 4), this.H - baseline, run.size || 11, { color: rgb(...hexToRgb(run.color || '#000')) });
        }
        for (const t of line.tokens) {
          if (t.space) { x += t.width + (t.tab ? 0 : extraSpace); continue; }
          if (t.image) {
            const img = await this.image(t.image);
            if (img) page.drawImage(img, { x, y: this.H - baseline, width: t.width, height: t.height });
            x += t.width; continue;
          }
          const r = t.run;
          const color = rgb(...hexToRgb(r.color || '#000000'));
          let y = this.H - baseline;
          if (r.super) y += t.size * 0.5; else if (r.sub) y -= t.size * 0.2;
          if (r.highlight) page.drawRectangle({ x, y: y - t.size * 0.22, width: t.width, height: t.size * 1.15, color: rgb(...hexToRgb(r.highlight)) });
          if (t.field) { this.deferred.push({ page, x, y, token: t, color, pageIndex: frame.pageIndex() }); x += t.width; continue; }
          await t.font.draw(page, t.text, x, y, t.size, { color });
          if (r.underline) page.drawLine({ start: { x, y: y - t.size * 0.12 }, end: { x: x + t.width, y: y - t.size * 0.12 }, thickness: Math.max(0.5, t.size / 16), color });
          if (r.strike) page.drawLine({ start: { x, y: y + t.size * 0.3 }, end: { x: x + t.width, y: y + t.size * 0.3 }, thickness: Math.max(0.5, t.size / 16), color });
          if (r.link) this.link(page, x, y - t.size * 0.25, t.width, t.size * 1.2, r.link);
          x += t.width;
        }
      }
      frame.y = top + met.height;
      if (line.pageBreak && frame.pageBreaks) { this.newPage(); frame.y = this.m.top; }
    }
    frame.y += b.spaceAfter ?? 8;
  }
  link(page, x, y, w, h, url) {
    try {
      const ctx = this.pdfDoc.context;
      const annot = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [x, y, x + w, y + h], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(String(url)) } });
      page.node.addAnnot(ctx.register(annot));
    } catch (e) { /* ignore */ }
  }
  async drawField(d) {
    const value = d.token.field === 'PAGE' ? String(d.pageIndex + 1) : String(this.pages.length);
    await d.token.font.draw(d.page, value, d.x, d.y, d.token.size, { color: d.color });
  }

  // ----- images -----
  async imageBlock(b, frame) {
    let w = b.width || 200, h = b.height || 150;
    const maxW = frame.width, maxH = Math.max(20, (frame.bottom === Infinity ? this.H - this.m.bottom : frame.bottom) - this.m.top - 2);
    if (b.fit === 'fill') { w = b.width; h = b.height; }
    else {
      if (w > maxW) { h *= maxW / w; w = maxW; }
      if (h > maxH) { w *= maxH / h; h = maxH; }
    }
    frame.ensure(h);
    if (frame.draw) {
      const img = await this.image(b);
      let x = frame.x;
      if (b.align === 'center') x += (frame.width - w) / 2; else if (b.align === 'right') x += frame.width - w;
      if (img) frame.page.drawImage(img, { x, y: this.H - frame.y - h, width: w, height: h });
    }
    frame.y += h + (b.spaceAfter ?? 8);
  }

  // ----- tables -----
  async table(t, frame) {
    const rowsCols = Math.max(1, ...t.rows.map((r) => r.cells.reduce((n, c) => n + (c.colSpan || 1), 0)));
    let cols = t.colWidths && t.colWidths.length >= rowsCols ? t.colWidths.slice(0, rowsCols) : Array.from({ length: rowsCols }, (_, i) => (t.colWidths && t.colWidths[i]) || frame.width / rowsCols);
    const sum = cols.reduce((a, b) => a + b, 0) || 1;
    if (sum > frame.width + 0.5 || t.stretch) cols = cols.map((c) => (c / sum) * frame.width);
    const pad = t.cellPadding ?? 4;
    const measureCell = async (cell, width) => {
      const f = this.subFrame(0, 0, Math.max(4, width - 2 * pad), false);
      for (const b of cell.blocks || []) await this.block(b, f);
      return f.y;
    };
    for (let ri = 0; ri < t.rows.length; ri++) {
      const row = t.rows[ri];
      let col = 0;
      const cellsInfo = [];
      let rowH = 0;
      for (const cell of row.cells) {
        const span = cell.colSpan || 1;
        const width = cols.slice(col, col + span).reduce((a, b) => a + b, 0);
        const x = frame.x + cols.slice(0, col).reduce((a, b) => a + b, 0);
        const h = cell.vMerge === 'continue' ? 0 : await measureCell(cell, width);
        cellsInfo.push({ cell, x, width, h });
        rowH = Math.max(rowH, h + 2 * pad);
        col += span;
      }
      rowH = Math.max(rowH, row.minHeight || 12);
      frame.ensure(rowH);
      if (frame.draw) {
        const page = frame.page;
        const top = frame.y;
        for (const ci of cellsInfo) {
          const yBottom = this.H - top - rowH;
          if (ci.cell.shading) page.drawRectangle({ x: ci.x, y: yBottom, width: ci.width, height: rowH, color: rgb(...hexToRgb(ci.cell.shading)) });
          if (t.borders) page.drawRectangle({ x: ci.x, y: yBottom, width: ci.width, height: rowH, borderColor: rgb(0.55, 0.55, 0.55), borderWidth: 0.5 });
          if (ci.cell.vMerge === 'continue') continue;
          const f = this.subFrame(ci.x + pad, top + pad, ci.width - 2 * pad, true, top + rowH + 1000);
          for (const b of ci.cell.blocks || []) await this.block(b, f);
        }
      }
      frame.y += rowH;
    }
    frame.y += t.spaceAfter ?? 8;
  }

  // ----- headers & footers -----
  async headersFooters() {
    const { header, footer } = this.doc;
    if ((!header || !header.length) && (!footer || !footer.length)) return;
    const total = this.pages.length;
    for (let i = 0; i < total; i++) {
      const page = this.pages[i];
      const substitute = (blocks) => blocks.map((b) => (b.type === 'paragraph' ? { ...b, runs: b.runs.map((r) => (r.field ? { ...r, field: undefined, text: r.field === 'PAGE' ? String(i + 1) : String(total) } : r)) } : b));
      if (header && header.length) {
        const f = { ...this.subFrame(this.m.left, Math.min(36, this.m.top / 2), this.W - this.m.left - this.m.right, true), page };
        for (const b of substitute(header)) await this.block(b, f);
      }
      if (footer && footer.length) {
        const mf = this.subFrame(0, 0, this.W - this.m.left - this.m.right, false);
        for (const b of footer) await this.block(b, mf);
        const h = mf.y;
        const f = { ...this.subFrame(this.m.left, this.H - Math.min(36, this.m.bottom / 2) - h, this.W - this.m.left - this.m.right, true), page };
        for (const b of substitute(footer)) await this.block(b, f);
      }
    }
  }
}
