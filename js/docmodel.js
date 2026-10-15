// A small document model shared by every converter, plus readers that build it from
// DOCX, XLSX, PPTX, HTML, Markdown and plain text.
//
// Doc:   { pageWidth, pageHeight, margins:{top,right,bottom,left}, blocks:[], header:[], footer:[], title }
// Block: { type:'paragraph', align, spaceBefore, spaceAfter, lineSpacing, indent, firstLine, hanging, list:{kind,level,text}, pageBreakBefore, runs:[] }
//        { type:'image', bytes, imgType:'png'|'jpg', width, height, align }
//        { type:'table', colWidths:[], rows:[{ cells:[{ blocks:[], colSpan, shading, width }] }], borders }
//        { type:'pageBreak' } | { type:'hr' } | { type:'absolute', x, y, width, height, blocks }
// Run:   { text, bold, italic, underline, strike, size, color, family, fontName, highlight, super, sub, link, field }
//        { image:{bytes,imgType,width,height} } | { tab:true } | { br:true }

export const defaultRun = { bold: false, italic: false, underline: false, strike: false, size: 11, color: '#000000', family: 'sans' };
export const newDoc = (over = {}) => ({ pageWidth: 595.28, pageHeight: 841.89, margins: { top: 72, right: 72, bottom: 72, left: 72 }, blocks: [], header: [], footer: [], title: '', ...over });
export const para = (runs = [], props = {}) => ({ type: 'paragraph', align: 'left', spaceBefore: 0, spaceAfter: 6, lineSpacing: 1, indent: 0, firstLine: 0, runs, ...props });
export const run = (text, props = {}) => ({ ...defaultRun, text, ...props });

export function docText(doc) {
  const out = [];
  const walk = (blocks) => {
    for (const b of blocks) {
      if (b.type === 'paragraph') out.push(b.runs.map((r) => (r.text != null ? r.text : r.tab ? '\t' : r.br ? '\n' : '')).join(''));
      else if (b.type === 'table') for (const row of b.rows) out.push(row.cells.map((c) => { const t = []; const w = (bl) => bl.forEach((x) => x.type === 'paragraph' && t.push(x.runs.map((r) => r.text || '').join(''))); w(c.blocks); return t.join(' '); }).join('\t'));
      else if (b.type === 'absolute') walk(b.blocks);
      else if (b.type === 'pageBreak') out.push('\f');
    }
  };
  walk(doc.blocks);
  return out.join('\n');
}

// ---------- shared zip/xml helpers ----------
async function openZip(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const xml = async (path) => { const f = zip.file(path); if (!f) return null; return new DOMParser().parseFromString(await f.async('string'), 'application/xml'); };
  const bin = async (path) => { const f = zip.file(path); return f ? await f.async('uint8array') : null; };
  return { zip, xml, bin };
}
const ln = (el) => el.localName;
const attr = (el, name) => { if (!el) return null; const a = el.getAttribute(name) ?? el.getAttribute(`w:${name}`) ?? el.getAttribute(`r:${name}`); return a; };
const kids = (el, name) => Array.from(el.children).filter((c) => ln(c) === name);
const kid = (el, name) => (el ? kids(el, name)[0] || null : null);
const findAll = (el, name) => Array.from(el.getElementsByTagNameNS('*', name));
const twip = (v) => (v == null ? null : Number(v) / 20);
const emu = (v) => Number(v) / 12700;
const EXT_TYPES = { png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif', bmp: 'bmp', webp: 'webp', tif: 'tiff', tiff: 'tiff', emf: 'emf', wmf: 'wmf', svg: 'svg' };

async function readRels(z, relsPath) {
  const d = await z.xml(relsPath);
  const map = new Map();
  if (!d) return map;
  for (const r of findAll(d, 'Relationship')) map.set(r.getAttribute('Id'), { target: r.getAttribute('Target'), type: r.getAttribute('Type') || '', mode: r.getAttribute('TargetMode') });
  return map;
}
function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
  return parts.join('/');
}
/** Load an image from the package; converts gif/bmp/webp via canvas; returns null for unsupported (emf/wmf). */
export async function loadPackageImage(z, path, cache = new Map()) {
  if (cache.has(path)) return cache.get(path);
  let result = null;
  const bytes = await z.bin(path);
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (bytes) {
    const kind = EXT_TYPES[ext];
    try {
      if (kind === 'png' || kind === 'jpg') {
        const dim = await imageSize(bytes, kind);
        result = { bytes, imgType: kind, ...dim };
      } else if (kind && kind !== 'emf' && kind !== 'wmf' && typeof document !== 'undefined') {
        const mime = kind === 'svg' ? 'image/svg+xml' : `image/${kind === 'tiff' ? 'tiff' : kind}`;
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
        const c = document.createElement('canvas'); c.width = img.naturalWidth || 300; c.height = img.naturalHeight || 300;
        c.getContext('2d').drawImage(img, 0, 0);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        result = { bytes: new Uint8Array(await blob.arrayBuffer()), imgType: 'png', width: c.width, height: c.height };
        URL.revokeObjectURL(url);
      }
    } catch (e) { console.warn('image load failed', path, e); }
  }
  cache.set(path, result);
  return result;
}
export async function imageSize(bytes, kind) {
  if (kind === 'png' && bytes.length > 24) { const dv = new DataView(bytes.buffer, bytes.byteOffset); return { width: dv.getUint32(16), height: dv.getUint32(20) }; }
  if (kind === 'jpg') {
    let i = 2;
    while (i < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
      }
      i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    }
  }
  if (typeof document !== 'undefined') {
    const url = URL.createObjectURL(new Blob([bytes]));
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    URL.revokeObjectURL(url);
    return { width: img.naturalWidth, height: img.naturalHeight };
  }
  return { width: 300, height: 300 };
}

// =====================================================================
// DOCX
// =====================================================================
export async function readDocx(bytes) {
  const z = await openZip(bytes);
  const docXml = await z.xml('word/document.xml');
  if (!docXml) throw new Error('Not a Word document (word/document.xml missing)');
  const rels = await readRels(z, 'word/_rels/document.xml.rels');
  const styles = await readStyles(z);
  const numbering = await readNumbering(z);
  const imgCache = new Map();
  const ctx = { z, rels, styles, numbering, imgCache, counters: new Map(), base: 'word/document.xml' };
  const doc = newDoc();
  const body = findAll(docXml, 'body')[0];
  doc.blocks = await readBlocks(body, ctx);
  const sect = kid(body, 'sectPr');
  if (sect) await applySection(sect, doc, ctx);
  const core = await z.xml('docProps/core.xml');
  if (core) { const t = findAll(core, 'title')[0]; if (t) doc.title = t.textContent; }
  return doc;
}

async function applySection(sect, doc, ctx) {
  const pg = kid(sect, 'pgSz'), mar = kid(sect, 'pgMar');
  if (pg) { doc.pageWidth = twip(attr(pg, 'w')) || doc.pageWidth; doc.pageHeight = twip(attr(pg, 'h')) || doc.pageHeight; if (attr(pg, 'orient') === 'landscape' && doc.pageWidth < doc.pageHeight) [doc.pageWidth, doc.pageHeight] = [doc.pageHeight, doc.pageWidth]; }
  if (mar) doc.margins = { top: twip(attr(mar, 'top')) ?? 72, right: twip(attr(mar, 'right')) ?? 72, bottom: twip(attr(mar, 'bottom')) ?? 72, left: twip(attr(mar, 'left')) ?? 72 };
  for (const [key, name] of [['header', 'headerReference'], ['footer', 'footerReference']]) {
    const refs = kids(sect, name);
    const def = refs.find((r) => attr(r, 'type') === 'default') || refs[0];
    if (!def) continue;
    const rel = ctx.rels.get(attr(def, 'id'));
    if (!rel) continue;
    const path = resolvePath('word/document.xml', rel.target);
    const x = await ctx.z.xml(path);
    if (!x) continue;
    const subRels = await readRels(ctx.z, path.replace(/([^/]+)$/, '_rels/$1.rels'));
    doc[key] = await readBlocks(x.documentElement, { ...ctx, rels: subRels, base: path });
  }
}

async function readStyles(z) {
  const x = await z.xml('word/styles.xml');
  const out = { byId: new Map(), defaultRun: {}, defaultPara: {} };
  if (!x) return out;
  const dd = findAll(x, 'docDefaults')[0];
  if (dd) { out.defaultRun = runProps(findAll(dd, 'rPr')[0]); out.defaultPara = paraProps(findAll(dd, 'pPr')[0]); }
  for (const s of findAll(x, 'style')) {
    out.byId.set(attr(s, 'styleId'), { type: attr(s, 'type'), basedOn: attr(kid(s, 'basedOn'), 'val'), name: attr(kid(s, 'name'), 'val'), run: runProps(kid(s, 'rPr')), para: paraProps(kid(s, 'pPr')), isDefault: attr(s, 'default') === '1' });
  }
  return out;
}
function resolveStyle(styles, id, type) {
  const chain = [];
  let cur = id ? styles.byId.get(id) : null;
  let guard = 0;
  while (cur && guard++ < 10) { chain.unshift(cur); cur = cur.basedOn ? styles.byId.get(cur.basedOn) : null; }
  if (!id) { for (const s of styles.byId.values()) if (s.isDefault && s.type === type) { chain.unshift(s); break; } }
  const run = { ...styles.defaultRun }, para = { ...styles.defaultPara };
  for (const s of chain) { Object.assign(run, s.run); Object.assign(para, s.para); }
  const name = chain.length ? chain[chain.length - 1].name || '' : '';
  return { run, para, name };
}
async function readNumbering(z) {
  const x = await z.xml('word/numbering.xml');
  const abstract = new Map(), nums = new Map();
  if (!x) return { abstract, nums };
  for (const a of findAll(x, 'abstractNum')) {
    const lvls = new Map();
    for (const l of kids(a, 'lvl')) lvls.set(Number(attr(l, 'ilvl')), { fmt: attr(kid(l, 'numFmt'), 'val') || 'decimal', text: attr(kid(l, 'lvlText'), 'val') || '', start: Number(attr(kid(l, 'start'), 'val') || 1), indent: twip(attr(kid(kid(l, 'pPr'), 'ind'), 'left')) });
    abstract.set(attr(a, 'abstractNumId'), lvls);
  }
  for (const n of findAll(x, 'num')) {
    const overrides = new Map();
    for (const o of kids(n, 'lvlOverride')) { const so = kid(o, 'startOverride'); if (so) overrides.set(Number(attr(o, 'ilvl')), Number(attr(so, 'val'))); }
    nums.set(attr(n, 'numId'), { abstractId: attr(kid(n, 'abstractNumId'), 'val'), overrides });
  }
  return { abstract, nums };
}
const onOff = (el) => { if (!el) return undefined; const v = attr(el, 'val'); return v == null || v === '1' || v === 'true' || v === 'on'; };
function runProps(rPr) {
  const p = {};
  if (!rPr) return p;
  const b = onOff(kid(rPr, 'b')); if (b !== undefined) p.bold = b;
  const i = onOff(kid(rPr, 'i')); if (i !== undefined) p.italic = i;
  const u = kid(rPr, 'u'); if (u) p.underline = attr(u, 'val') !== 'none';
  const s = onOff(kid(rPr, 'strike')); if (s !== undefined) p.strike = s;
  const sz = kid(rPr, 'sz'); if (sz) p.size = Number(attr(sz, 'val')) / 2;
  const color = kid(rPr, 'color'); if (color && attr(color, 'val') && attr(color, 'val') !== 'auto') p.color = '#' + attr(color, 'val');
  const hl = kid(rPr, 'highlight'); if (hl) p.highlight = attr(hl, 'val');
  const va = kid(rPr, 'vertAlign'); if (va) { p.super = attr(va, 'val') === 'superscript'; p.sub = attr(va, 'val') === 'subscript'; }
  const f = kid(rPr, 'rFonts'); if (f) { const n = attr(f, 'ascii') || attr(f, 'hAnsi') || attr(f, 'eastAsia') || attr(f, 'cs'); if (n) { p.fontName = n; p.family = familyFromName(n); } }
  const rs = kid(rPr, 'rStyle'); if (rs) p.rStyle = attr(rs, 'val');
  return p;
}
function familyFromName(n) {
  const s = n.toLowerCase();
  if (/courier|mono|consolas/.test(s)) return 'mono';
  if (/times|georgia|garamond|serif|cambria|book antiqua|palatino|batang|myeongjo/.test(s) && !/sans/.test(s)) return 'serif';
  return 'sans';
}
function paraProps(pPr) {
  const p = {};
  if (!pPr) return p;
  const jc = attr(kid(pPr, 'jc'), 'val'); if (jc) p.align = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' }[jc] || 'left';
  const sp = kid(pPr, 'spacing');
  if (sp) {
    if (attr(sp, 'before') != null) p.spaceBefore = twip(attr(sp, 'before'));
    if (attr(sp, 'after') != null) p.spaceAfter = twip(attr(sp, 'after'));
    const line = attr(sp, 'line'), rule = attr(sp, 'lineRule') || 'auto';
    if (line != null) p.lineSpacing = rule === 'auto' ? Number(line) / 240 : null, p.lineExact = rule !== 'auto' ? twip(line) : null;
  }
  const ind = kid(pPr, 'ind');
  if (ind) {
    const left = twip(attr(ind, 'left') ?? attr(ind, 'start')); if (left != null) p.indent = left;
    const right = twip(attr(ind, 'right') ?? attr(ind, 'end')); if (right != null) p.indentRight = right;
    const fl = twip(attr(ind, 'firstLine')); if (fl != null) p.firstLine = fl;
    const hg = twip(attr(ind, 'hanging')); if (hg != null) p.hanging = hg;
  }
  if (kid(pPr, 'pageBreakBefore') && onOff(kid(pPr, 'pageBreakBefore')) !== false) p.pageBreakBefore = true;
  const num = kid(pPr, 'numPr'); if (num) p.numPr = { id: attr(kid(num, 'numId'), 'val'), lvl: Number(attr(kid(num, 'ilvl'), 'val') || 0) };
  const ps = kid(pPr, 'pStyle'); if (ps) p.pStyle = attr(ps, 'val');
  const shd = kid(pPr, 'shd'); if (shd && attr(shd, 'fill') && attr(shd, 'fill') !== 'auto') p.shading = '#' + attr(shd, 'fill');
  return p;
}

async function readBlocks(container, ctx) {
  const blocks = [];
  for (const el of Array.from(container.children)) {
    const n = ln(el);
    if (n === 'p') blocks.push(await readParagraph(el, ctx));
    else if (n === 'tbl') blocks.push(await readTable(el, ctx));
    else if (n === 'sdt') { const c = kid(el, 'sdtContent'); if (c) blocks.push(...await readBlocks(c, ctx)); }
    else if (n === 'altChunk' || n === 'sectPr' || n === 'bookmarkStart' || n === 'bookmarkEnd') continue;
    else if (el.children.length) blocks.push(...await readBlocks(el, ctx));
  }
  return blocks;
}
function formatNumber(n, fmt) {
  const roman = (num) => { const t = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]; let s = ''; for (const [v, r] of t) while (num >= v) { s += r; num -= v; } return s; };
  switch (fmt) {
    case 'lowerLetter': return String.fromCharCode(96 + ((n - 1) % 26) + 1);
    case 'upperLetter': return String.fromCharCode(64 + ((n - 1) % 26) + 1);
    case 'lowerRoman': return roman(n).toLowerCase();
    case 'upperRoman': return roman(n);
    case 'bullet': return '•';
    case 'none': return '';
    default: return String(n);
  }
}
function listLabel(ctx, numPr) {
  const num = ctx.numbering.nums.get(numPr.id);
  if (!num) return null;
  const lvls = ctx.numbering.abstract.get(num.abstractId);
  if (!lvls) return null;
  const lvl = lvls.get(numPr.lvl) || lvls.get(0);
  if (!lvl) return null;
  const key = `${numPr.id}`;
  const counters = ctx.counters.get(key) || new Map();
  ctx.counters.set(key, counters);
  const start = num.overrides.has(numPr.lvl) ? num.overrides.get(numPr.lvl) : lvl.start;
  counters.set(numPr.lvl, (counters.has(numPr.lvl) ? counters.get(numPr.lvl) + 1 : start));
  for (const [l] of counters) if (l > numPr.lvl) counters.delete(l);
  if (lvl.fmt === 'bullet') return { kind: 'bullet', level: numPr.lvl, text: ['•', '◦', '▪'][numPr.lvl % 3], indent: lvl.indent };
  let text = lvl.text || '%1.';
  text = text.replace(/%(\d)/g, (_, d) => { const L = Number(d) - 1; const lv = lvls.get(L); const c = counters.get(L) ?? (lv ? lv.start : 1); return formatNumber(c, lv ? lv.fmt : 'decimal'); });
  return { kind: 'number', level: numPr.lvl, text, indent: lvl.indent };
}
async function readParagraph(p, ctx) {
  const pPr = kid(p, 'pPr');
  const own = paraProps(pPr);
  const style = resolveStyle(ctx.styles, own.pStyle, 'paragraph');
  const props = { ...style.para, ...own };
  const baseRun = { ...defaultRun, ...style.run };
  const block = para([], {
    align: props.align || 'left', spaceBefore: props.spaceBefore ?? 0, spaceAfter: props.spaceAfter ?? 8, lineSpacing: props.lineSpacing ?? 1.08, lineExact: props.lineExact || null,
    indent: props.indent || 0, indentRight: props.indentRight || 0, firstLine: props.firstLine || 0, hanging: props.hanging || 0, pageBreakBefore: !!props.pageBreakBefore, shading: props.shading || null,
    styleName: style.name, heading: /^heading\s*(\d)/i.test(style.name || '') ? Number(style.name.match(/(\d)/)[1]) : (/^title$/i.test(style.name || '') ? 0 : null),
  });
  if (props.numPr) { const l = listLabel(ctx, props.numPr); if (l) { block.list = l; if (!own.indent && l.indent) block.indent = l.indent; if (!block.hanging) block.hanging = 18; } }
  ctx.fld = { active: false, instr: '', skip: false };
  await collectRuns(p, ctx, baseRun, block.runs, pPr);
  return block;
}
async function collectRuns(el, ctx, baseRun, runs, pPr) {
  for (const child of Array.from(el.children)) {
    const n = ln(child);
    if (n === 'r') await readRun(child, ctx, baseRun, runs);
    else if (n === 'hyperlink') { const rel = ctx.rels.get(attr(child, 'id')); const start = runs.length; await collectRuns(child, ctx, { ...baseRun, color: '#0563C1', underline: true }, runs); for (let i = start; i < runs.length; i++) if (rel && rel.target) runs[i].link = rel.target; }
    else if (n === 'ins' || n === 'smartTag' || n === 'fldSimple' || n === 'customXml' || n === 'dir' || n === 'bdo') {
      if (n === 'fldSimple' && /\bPAGE\b/.test(attr(child, 'instr') || '') && !/NUMPAGES/.test(attr(child, 'instr') || '')) { runs.push({ ...baseRun, text: '', field: 'PAGE' }); continue; }
      if (n === 'fldSimple' && /NUMPAGES/.test(attr(child, 'instr') || '')) { runs.push({ ...baseRun, text: '', field: 'NUMPAGES' }); continue; }
      await collectRuns(child, ctx, baseRun, runs);
    }
    else if (n === 'sdt') { const c = kid(child, 'sdtContent'); if (c) await collectRuns(c, ctx, baseRun, runs); }
    else if (n === 'del' || n === 'pPr' || n === 'proofErr' || n === 'bookmarkStart' || n === 'bookmarkEnd') continue;
  }
}
async function readRun(r, ctx, baseRun, runs) {
  const own = runProps(kid(r, 'rPr'));
  let charStyle = {};
  if (own.rStyle) charStyle = resolveStyle(ctx.styles, own.rStyle, 'character').run;
  const props = { ...baseRun, ...charStyle, ...own };
  delete props.rStyle;
  const fld = ctx.fld || (ctx.fld = { active: false, instr: '', skip: false });
  for (const c of Array.from(r.children)) {
    const n = ln(c);
    if (n === 'fldChar') {
      const type = attr(c, 'fldCharType');
      if (type === 'begin') { fld.active = true; fld.instr = ''; fld.skip = false; }
      else if (type === 'separate') {
        if (/\bPAGE\b/.test(fld.instr) && !/NUMPAGES|SECTIONPAGES/.test(fld.instr)) { runs.push({ ...props, text: '', field: 'PAGE' }); fld.skip = true; }
        else if (/NUMPAGES/.test(fld.instr)) { runs.push({ ...props, text: '', field: 'NUMPAGES' }); fld.skip = true; }
        else fld.skip = false;
      } else if (type === 'end') { fld.active = false; fld.skip = false; fld.instr = ''; }
      continue;
    }
    if (n === 'instrText') { if (fld.active) fld.instr += c.textContent; continue; }
    if (fld.skip) continue;
    if (n === 't') runs.push({ ...props, text: c.textContent });
    else if (n === 'tab') runs.push({ tab: true });
    else if (n === 'br') { if (attr(c, 'type') === 'page') runs.push({ pageBreak: true }); else runs.push({ br: true }); }
    else if (n === 'cr') runs.push({ br: true });
    else if (n === 'sym') { const ch = attr(c, 'char'); if (ch) runs.push({ ...props, text: String.fromCharCode(parseInt(ch, 16) & 0xff) }); }
    else if (n === 'noBreakHyphen') runs.push({ ...props, text: '-' });
    else if (n === 'softHyphen') continue;
    else if (n === 'drawing' || n === 'pict' || n === 'object') {
      const img = await readDrawing(c, ctx);
      if (img) runs.push({ image: img, anchor: img.anchor });
    }
    else if (n === 'rPr' || n === 'lastRenderedPageBreak') continue;
  }
}
async function readDrawing(el, ctx) {
  const blip = findAll(el, 'blip')[0];
  const imagedata = findAll(el, 'imagedata')[0];
  const rid = blip ? (blip.getAttribute('r:embed') || blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed')) : imagedata ? (imagedata.getAttribute('r:id') || imagedata.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')) : null;
  if (!rid) return null;
  const rel = ctx.rels.get(rid);
  if (!rel) return null;
  const path = resolvePath(ctx.base, rel.target);
  const img = await loadPackageImage(ctx.z, path, ctx.imgCache);
  if (!img) return null;
  let w = img.width * 0.75, h = img.height * 0.75;
  const extent = findAll(el, 'extent')[0];
  if (extent) { w = emu(extent.getAttribute('cx')); h = emu(extent.getAttribute('cy')); }
  else if (imagedata) {
    const shape = el.querySelector ? findAll(el, 'shape')[0] : null;
    const style = shape ? shape.getAttribute('style') || '' : '';
    const mw = style.match(/width:([\d.]+)(pt|in|px)/), mh = style.match(/height:([\d.]+)(pt|in|px)/);
    const toPt = (m) => (m ? Number(m[1]) * (m[2] === 'in' ? 72 : m[2] === 'px' ? 0.75 : 1) : null);
    if (mw && mh) { w = toPt(mw); h = toPt(mh); }
  }
  const anchor = findAll(el, 'anchor')[0];
  return { bytes: img.bytes, imgType: img.imgType, width: w, height: h, pxWidth: img.width, pxHeight: img.height, anchor: !!anchor };
}
async function readTable(tbl, ctx) {
  const grid = kid(tbl, 'tblGrid');
  const colWidths = grid ? kids(grid, 'gridCol').map((g) => twip(attr(g, 'w')) || 60) : [];
  const tblPr = kid(tbl, 'tblPr');
  const borders = kid(tblPr, 'tblBorders');
  const hasBorders = !borders || kids(borders, 'top').some((b) => attr(b, 'val') !== 'none' && attr(b, 'val') !== 'nil') || kids(borders, 'insideH').some((b) => attr(b, 'val') !== 'none' && attr(b, 'val') !== 'nil');
  const tblStyle = attr(kid(tblPr, 'tblStyle'), 'val');
  const rows = [];
  const vmergeRows = [];
  for (const tr of kids(tbl, 'tr')) {
    const cells = [];
    for (const tc of kids(tr, 'tc')) {
      const tcPr = kid(tc, 'tcPr');
      const span = Number(attr(kid(tcPr, 'gridSpan'), 'val') || 1);
      const shd = kid(tcPr, 'shd');
      const vm = kid(tcPr, 'vMerge');
      const blocks = await readBlocks(tc, ctx);
      cells.push({ blocks, colSpan: span, shading: shd && attr(shd, 'fill') && attr(shd, 'fill') !== 'auto' ? '#' + attr(shd, 'fill') : null, vMerge: vm ? (attr(vm, 'val') === 'restart' ? 'restart' : 'continue') : null, width: twip(attr(kid(tcPr, 'tcW'), 'w')) });
    }
    rows.push({ cells, header: !!kid(kid(tr, 'trPr'), 'tblHeader') });
    vmergeRows.push(rows.length - 1);
  }
  return { type: 'table', colWidths, rows, borders: hasBorders || !!tblStyle, cellPadding: 4 };
}

// =====================================================================
// XLSX
// =====================================================================
export async function readXlsx(bytes) {
  const z = await openZip(bytes);
  const wb = await z.xml('xl/workbook.xml');
  if (!wb) throw new Error('Not an Excel workbook');
  const rels = await readRels(z, 'xl/_rels/workbook.xml.rels');
  const shared = [];
  const ss = await z.xml('xl/sharedStrings.xml');
  if (ss) for (const si of findAll(ss, 'si')) shared.push(findAll(si, 't').map((t) => t.textContent).join(''));
  const doc = newDoc({ pageWidth: 841.89, pageHeight: 595.28, margins: { top: 54, right: 54, bottom: 54, left: 54 } });
  const colIndex = (ref) => { const m = ref.match(/^([A-Z]+)/); if (!m) return 0; let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const sheets = findAll(wb, 'sheet');
  let first = true;
  for (const sh of sheets) {
    const rel = rels.get(sh.getAttribute('r:id') || sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    if (!rel) continue;
    const sx = await z.xml(resolvePath('xl/workbook.xml', rel.target));
    if (!sx) continue;
    const name = sh.getAttribute('name') || 'Sheet';
    if (!first) doc.blocks.push({ type: 'pageBreak' });
    first = false;
    doc.blocks.push(para([run(name, { bold: true, size: 14 })], { spaceAfter: 8 }));
    const rows = [];
    let maxCol = 0;
    for (const r of findAll(sx, 'row')) {
      const cells = [];
      for (const c of kids(r, 'c')) {
        const ref = c.getAttribute('r') || '';
        const idx = colIndex(ref);
        const t = c.getAttribute('t');
        let v = '';
        const vEl = kid(c, 'v');
        if (t === 's') v = shared[Number(vEl ? vEl.textContent : -1)] ?? '';
        else if (t === 'inlineStr') v = findAll(c, 't').map((x) => x.textContent).join('');
        else if (t === 'b') v = vEl && vEl.textContent === '1' ? 'TRUE' : 'FALSE';
        else if (vEl) { const num = Number(vEl.textContent); v = Number.isFinite(num) ? String(Math.round(num * 1e10) / 1e10) : vEl.textContent; }
        cells[idx] = v;
        maxCol = Math.max(maxCol, idx + 1);
      }
      rows.push(cells);
    }
    if (!rows.length) { doc.blocks.push(para([run('(empty sheet)', { italic: true, color: '#777777' })])); continue; }
    const widths = [];
    for (const col of findAll(sx, 'col')) { const min = Number(col.getAttribute('min')), max = Number(col.getAttribute('max')), w = Number(col.getAttribute('width') || 9) * 5.5; for (let i = min; i <= max; i++) widths[i - 1] = w; }
    const colWidths = Array.from({ length: maxCol }, (_, i) => widths[i] || 50);
    doc.blocks.push({
      type: 'table', colWidths, borders: true, cellPadding: 3, fontSize: 9,
      rows: rows.map((cells, ri) => ({ header: ri === 0, cells: Array.from({ length: maxCol }, (_, i) => ({ blocks: [para([run(cells[i] ?? '', { size: 9, bold: ri === 0 })], { spaceAfter: 0 })], colSpan: 1, shading: ri === 0 ? '#EEEEEE' : null })) })),
    });
  }
  return doc;
}

// =====================================================================
// PPTX (absolute positioned text boxes and pictures per slide)
// =====================================================================
export async function readPptx(bytes) {
  const z = await openZip(bytes);
  const pres = await z.xml('ppt/presentation.xml');
  if (!pres) throw new Error('Not a PowerPoint presentation');
  const sz = findAll(pres, 'sldSz')[0];
  const W = sz ? emu(sz.getAttribute('cx')) : 960, H = sz ? emu(sz.getAttribute('cy')) : 540;
  const doc = newDoc({ pageWidth: W, pageHeight: H, margins: { top: 0, right: 0, bottom: 0, left: 0 } });
  const rels = await readRels(z, 'ppt/_rels/presentation.xml.rels');
  const imgCache = new Map();
  const ids = findAll(pres, 'sldId');
  let first = true;
  for (const id of ids) {
    const rel = rels.get(id.getAttribute('r:id') || id.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    if (!rel) continue;
    const path = resolvePath('ppt/presentation.xml', rel.target);
    const sx = await z.xml(path);
    if (!sx) continue;
    const srels = await readRels(z, path.replace(/([^/]+)$/, '_rels/$1.rels'));
    if (!first) doc.blocks.push({ type: 'pageBreak' });
    first = false;
    const spTree = findAll(sx, 'spTree')[0];
    if (!spTree) continue;
    for (const shape of Array.from(spTree.children)) {
      const n = ln(shape);
      const xfrm = findAll(shape, 'xfrm')[0];
      const off = xfrm ? kid(xfrm, 'off') : null, ext = xfrm ? kid(xfrm, 'ext') : null;
      const box = off && ext ? { x: emu(off.getAttribute('x')), y: emu(off.getAttribute('y')), width: emu(ext.getAttribute('cx')), height: emu(ext.getAttribute('cy')) } : { x: 36, y: 36, width: W - 72, height: H - 72 };
      if (n === 'pic') {
        const blip = findAll(shape, 'blip')[0];
        const rid = blip && (blip.getAttribute('r:embed') || blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed'));
        const r2 = rid && srels.get(rid);
        if (!r2) continue;
        const img = await loadPackageImage(z, resolvePath(path, r2.target), imgCache);
        if (img) doc.blocks.push({ type: 'absolute', ...box, blocks: [{ type: 'image', bytes: img.bytes, imgType: img.imgType, width: box.width, height: box.height, fit: 'fill' }] });
      } else if (n === 'sp' || n === 'graphicFrame') {
        const blocks = [];
        const txBody = findAll(shape, 'txBody')[0];
        if (txBody) {
          for (const p of kids(txBody, 'p')) {
            const pPr = kid(p, 'pPr');
            const algn = pPr ? pPr.getAttribute('algn') : null;
            const lvl = pPr ? Number(pPr.getAttribute('lvl') || 0) : 0;
            const bullet = pPr && (kid(pPr, 'buChar') || kid(pPr, 'buAutoNum'));
            const runs = [];
            for (const r of Array.from(p.children)) {
              const rn = ln(r);
              if (rn !== 'r' && rn !== 'fld' && rn !== 'br') continue;
              if (rn === 'br') { runs.push({ br: true }); continue; }
              const rPr = kid(r, 'rPr');
              const t = kid(r, 't');
              const solid = rPr ? findAll(rPr, 'srgbClr')[0] : null;
              runs.push({ ...defaultRun, text: t ? t.textContent : '', size: rPr && rPr.getAttribute('sz') ? Number(rPr.getAttribute('sz')) / 100 : 18, bold: rPr ? rPr.getAttribute('b') === '1' : false, italic: rPr ? rPr.getAttribute('i') === '1' : false, underline: rPr ? !!rPr.getAttribute('u') && rPr.getAttribute('u') !== 'none' : false, color: solid ? '#' + solid.getAttribute('val') : '#000000' });
            }
            blocks.push(para(runs, { align: { ctr: 'center', r: 'right', just: 'justify' }[algn] || 'left', spaceAfter: 4, indent: lvl * 18, list: bullet ? { kind: 'bullet', level: lvl, text: '•' } : null, hanging: bullet ? 14 : 0 }));
          }
        }
        const tbl = findAll(shape, 'tbl')[0];
        if (tbl) {
          const rows = kids(tbl, 'tr').map((tr) => ({ cells: kids(tr, 'tc').map((tc) => ({ colSpan: Number(tc.getAttribute('gridSpan') || 1), blocks: findAll(tc, 'p').map((p) => para(findAll(p, 't').map((t) => run(t.textContent, { size: 12 })), { spaceAfter: 0 })) })) }));
          const colWidths = findAll(tbl, 'gridCol').map((g) => emu(g.getAttribute('w')));
          blocks.push({ type: 'table', rows, colWidths, borders: true, cellPadding: 3 });
        }
        if (blocks.length) doc.blocks.push({ type: 'absolute', ...box, blocks });
      }
    }
  }
  return doc;
}

// =====================================================================
// HTML
// =====================================================================
export async function readHtml(html, opts = {}) {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const doc = newDoc();
  doc.title = dom.title || '';
  const imgCache = new Map();
  const base = opts.baseUrl || null;
  const fetchImage = async (src) => {
    if (!src) return null;
    if (imgCache.has(src)) return imgCache.get(src);
    let result = null;
    try {
      const url = base ? new URL(src, base).href : src;
      const resp = await fetch(url);
      const blob = await resp.blob();
      const file = new File([blob], 'img', { type: blob.type });
      const { normalizeImageFile } = await import('./util.js');
      const n = await normalizeImageFile(file);
      result = { bytes: n.bytes, imgType: n.type, width: n.width * 0.75, height: n.height * 0.75 };
    } catch (e) { console.warn('image skipped', src, e.message); }
    imgCache.set(src, result);
    return result;
  };
  const HEAD = { h1: 24, h2: 18, h3: 14, h4: 12, h5: 11, h6: 10 };
  const cssColor = (c) => {
    if (!c) return null;
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) return '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
    if (/^#[0-9a-f]{3,6}$/i.test(c)) return c.length === 4 ? '#' + c.slice(1).split('').map((x) => x + x).join('') : c;
    const named = { black: '#000000', red: '#ff0000', blue: '#0000ff', green: '#008000', gray: '#808080', grey: '#808080', white: '#ffffff', orange: '#ffa500', purple: '#800080' };
    return named[c.toLowerCase()] || null;
  };
  const styleOf = (el, inherited) => {
    const s = { ...inherited };
    const st = el.style || {};
    if (st.fontWeight && (st.fontWeight === 'bold' || Number(st.fontWeight) >= 600)) s.bold = true;
    if (st.fontStyle === 'italic') s.italic = true;
    if (/underline/.test(st.textDecoration || '')) s.underline = true;
    if (/line-through/.test(st.textDecoration || '')) s.strike = true;
    if (st.color) { const c = cssColor(st.color); if (c) s.color = c; }
    if (st.fontSize) { const m = st.fontSize.match(/([\d.]+)(px|pt|em|rem)?/); if (m) s.size = m[2] === 'pt' ? Number(m[1]) : m[2] === 'em' || m[2] === 'rem' ? Number(m[1]) * 11 : Number(m[1]) * 0.75; }
    if (st.fontFamily) s.family = familyFromName(st.fontFamily);
    if (st.backgroundColor) { const c = cssColor(st.backgroundColor); if (c && c !== '#ffffff') s.highlight = c; }
    return s;
  };
  const blocks = [];
  let current = null;
  const ensurePara = (props = {}) => { if (!current) { current = para([], { spaceAfter: 8, ...props }); blocks.push(current); } return current; };
  const flush = () => { current = null; };
  const addText = (text, style, pre) => {
    if (!pre) { text = text.replace(/\s+/g, ' '); if (!text) return; if (!current && text === ' ') return; }
    const p = ensurePara();
    if (!pre && !p.runs.length) text = text.replace(/^ /, '');
    if (!text) return;
    p.runs.push({ ...defaultRun, ...style, text });
  };
  const walk = async (node, style, ctx) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) { if (ctx.pre) { const lines = child.nodeValue.split('\n'); lines.forEach((l, i) => { if (i) { ensurePara().runs.push({ br: true }); } if (l) addText(l, style, true); }); } else addText(child.nodeValue, style, false); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (['script', 'style', 'head', 'noscript', 'template', 'nav', 'iframe', 'svg', 'button', 'select', 'input'].includes(tag)) continue;
      const s = styleOf(child, style);
      if (tag === 'br') { ensurePara().runs.push({ br: true }); continue; }
      if (tag === 'hr') { flush(); blocks.push({ type: 'hr' }); continue; }
      if (tag === 'img') { const img = await fetchImage(child.getAttribute('src')); if (img) { const w = Number(child.getAttribute('width')) * 0.75 || img.width, h = Number(child.getAttribute('height')) * 0.75 || img.height * (w / img.width); ensurePara().runs.push({ image: { ...img, width: w, height: h } }); } continue; }
      if (HEAD[tag]) { flush(); const p = ensurePara({ spaceBefore: 12, spaceAfter: 6, heading: Number(tag[1]) }); await walk(child, { ...s, bold: true, size: HEAD[tag] }, ctx); void p; flush(); continue; }
      if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article' || tag === 'main' || tag === 'header' || tag === 'footer' || tag === 'figure' || tag === 'figcaption' || tag === 'address' || tag === 'dd' || tag === 'dt' || tag === 'summary' || tag === 'details' || tag === 'form' || tag === 'label') {
        flush();
        const align = child.style.textAlign || child.getAttribute('align');
        ensurePara({ align: ['center', 'right', 'justify'].includes(align) ? align : 'left', indent: ctx.indent || 0 });
        await walk(child, s, ctx);
        flush();
        continue;
      }
      if (tag === 'blockquote') { flush(); await walk(child, { ...s, italic: true, color: s.color || '#444444' }, { ...ctx, indent: (ctx.indent || 0) + 24 }); flush(); continue; }
      if (tag === 'pre') { flush(); ensurePara({ indent: ctx.indent || 0, spaceAfter: 8, shading: '#F4F4F4' }); await walk(child, { ...s, family: 'mono', size: s.size ? s.size * 0.9 : 9.5 }, { ...ctx, pre: true }); flush(); continue; }
      if (tag === 'ul' || tag === 'ol') {
        flush();
        const level = ctx.listLevel || 0;
        let idx = Number(child.getAttribute('start') || 1);
        for (const li of Array.from(child.children)) {
          if (li.tagName.toLowerCase() !== 'li') continue;
          flush();
          ensurePara({ indent: (ctx.indent || 0) + 18 + level * 18, hanging: 14, spaceAfter: 2, list: tag === 'ul' ? { kind: 'bullet', level, text: ['•', '◦', '▪'][level % 3] } : { kind: 'number', level, text: `${idx++}.` } });
          await walk(li, s, { ...ctx, listLevel: level + 1, indent: (ctx.indent || 0) + 18 + level * 18 });
          flush();
        }
        continue;
      }
      if (tag === 'li') { flush(); ensurePara({ indent: (ctx.indent || 0) + 18, hanging: 14, list: { kind: 'bullet', level: 0, text: '•' } }); await walk(child, s, ctx); flush(); continue; }
      if (tag === 'table') {
        flush();
        const rows = [];
        let maxCols = 0;
        for (const tr of Array.from(child.querySelectorAll(':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr'))) {
          const cells = [];
          for (const td of Array.from(tr.children)) {
            const t = td.tagName.toLowerCase();
            if (t !== 'td' && t !== 'th') continue;
            const saved = [blocks.length, current];
            const sub = [];
            const prevBlocks = blocks.splice(0, blocks.length);
            current = null;
            await walk(td, t === 'th' ? { ...s, bold: true } : s, { ...ctx, indent: 0 });
            flush();
            sub.push(...blocks.splice(0, blocks.length));
            blocks.push(...prevBlocks);
            void saved;
            cells.push({ blocks: sub.length ? sub : [para([])], colSpan: Number(td.getAttribute('colspan') || 1), shading: t === 'th' ? '#EEEEEE' : cssColor(td.style.backgroundColor) });
          }
          maxCols = Math.max(maxCols, cells.reduce((n, c) => n + c.colSpan, 0));
          rows.push({ cells, header: tr.parentElement && tr.parentElement.tagName.toLowerCase() === 'thead' });
        }
        if (rows.length) blocks.push({ type: 'table', rows, colWidths: Array.from({ length: maxCols }, () => 100), borders: child.getAttribute('border') !== '0', cellPadding: 4 });
        continue;
      }
      if (tag === 'tr' || tag === 'td' || tag === 'th' || tag === 'thead' || tag === 'tbody') { await walk(child, s, ctx); continue; }
      // inline formatting
      const inline = { b: { bold: true }, strong: { bold: true }, i: { italic: true }, em: { italic: true }, u: { underline: true }, s: { strike: true }, del: { strike: true }, strike: { strike: true }, code: { family: 'mono' }, kbd: { family: 'mono' }, samp: { family: 'mono' }, mark: { highlight: '#FFFF00' }, sup: { super: true, size: (s.size || 11) * 0.7 }, sub: { sub: true, size: (s.size || 11) * 0.7 }, small: { size: (s.size || 11) * 0.85 }, big: { size: (s.size || 11) * 1.2 } }[tag];
      if (tag === 'a') { const href = child.getAttribute('href'); const start = ensurePara().runs.length; await walk(child, { ...s, color: '#0563C1', underline: true }, ctx); const p = ensurePara(); for (let i = start; i < p.runs.length; i++) p.runs[i].link = href; continue; }
      if (tag === 'font') { const c = cssColor(child.getAttribute('color')); await walk(child, c ? { ...s, color: c } : s, ctx); continue; }
      await walk(child, inline ? { ...s, ...inline } : s, ctx);
    }
  };
  await walk(dom.body, {}, {});
  doc.blocks = blocks.filter((b) => b.type !== 'paragraph' || b.runs.length);
  return doc;
}

// =====================================================================
// Markdown (CommonMark-ish subset)
// =====================================================================
export function readMarkdown(text) {
  const doc = newDoc();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks = doc.blocks;
  const inline = (s, base = {}) => {
    const runs = [];
    const re = /(\*\*\*([^*]+)\*\*\*)|(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*]+)\*)|(_([^_]+)_)|(~~([^~]+)~~)|(`([^`]+)`)|(!\[([^\]]*)\]\(([^)]+)\))|(\[([^\]]+)\]\(([^)]+)\))/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) runs.push(run(s.slice(last, m.index), base));
      if (m[1]) runs.push(run(m[2], { ...base, bold: true, italic: true }));
      else if (m[3]) runs.push(run(m[4], { ...base, bold: true }));
      else if (m[5]) runs.push(run(m[6], { ...base, bold: true }));
      else if (m[7]) runs.push(run(m[8], { ...base, italic: true }));
      else if (m[9]) runs.push(run(m[10], { ...base, italic: true }));
      else if (m[11]) runs.push(run(m[12], { ...base, strike: true }));
      else if (m[13]) runs.push(run(m[14], { ...base, family: 'mono', highlight: '#F0F0F0' }));
      else if (m[15]) runs.push(run(m[16] || m[17], { ...base, italic: true, color: '#555555' }));
      else if (m[18]) runs.push(run(m[19], { ...base, color: '#0563C1', underline: true, link: m[20] }));
      last = m.index + m[0].length;
    }
    if (last < s.length) runs.push(run(s.slice(last), base));
    return runs;
  };
  let i = 0;
  let paraLines = [];
  const flushPara = () => { if (paraLines.length) { blocks.push(para(inline(paraLines.join(' ')), { spaceAfter: 8, align: 'left' })); paraLines = []; } };
  const counters = {};
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*$/))) { flushPara(); const lvl = m[1].length; blocks.push(para(inline(m[2], { bold: true, size: [24, 18, 14, 12, 11, 10][lvl - 1] }), { spaceBefore: 12, spaceAfter: 6, heading: lvl })); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); blocks.push({ type: 'hr' }); i++; continue; }
    if ((m = line.match(/^```(\w*)/))) {
      flushPara();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      const runs = [];
      code.forEach((l, k) => { if (k) runs.push({ br: true }); runs.push(run(l || ' ', { family: 'mono', size: 9.5 })); });
      blocks.push(para(runs, { spaceAfter: 8, shading: '#F4F4F4', indent: 6 }));
      continue;
    }
    if ((m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      flushPara();
      const level = Math.floor(m[1].replace(/\t/g, '    ').length / 2);
      const numbered = /\d/.test(m[2]);
      const key = `${level}`;
      if (numbered) counters[key] = (counters[key] || 0) + 1; else counters[key] = 0;
      for (const k of Object.keys(counters)) if (Number(k) > level) delete counters[k];
      blocks.push(para(inline(m[3]), { indent: 18 + level * 18, hanging: 14, spaceAfter: 2, list: numbered ? { kind: 'number', level, text: `${counters[key]}.` } : { kind: 'bullet', level, text: ['•', '◦', '▪'][level % 3] } }));
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) { flushPara(); const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, '')); blocks.push(para(inline(q.join(' '), { italic: true, color: '#444444' }), { indent: 24, spaceAfter: 8 })); continue; }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flushPara();
      const rowsText = [line];
      i += 2;
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rowsText.push(lines[i++]);
      const rows = rowsText.map((r, ri) => ({ header: ri === 0, cells: r.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => ({ blocks: [para(inline(c.trim(), ri === 0 ? { bold: true } : {}), { spaceAfter: 0 })], colSpan: 1, shading: ri === 0 ? '#EEEEEE' : null })) }));
      const cols = Math.max(...rows.map((r) => r.cells.length));
      blocks.push({ type: 'table', rows, colWidths: Array.from({ length: cols }, () => 100), borders: true, cellPadding: 4 });
      continue;
    }
    paraLines.push(line.trim());
    i++;
  }
  flushPara();
  return doc;
}

// =====================================================================
// Plain text
// =====================================================================
export function readText(text, opts = {}) {
  const doc = newDoc();
  const mono = !!opts.mono;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (const line of lines) {
    if (line.trim() === '') { doc.blocks.push(para([], { spaceAfter: 0, lineSpacing: 1 })); continue; }
    doc.blocks.push(para([run(line.replace(/\t/g, '    '), { family: mono ? 'mono' : 'sans', size: opts.size || 11 })], { spaceAfter: 0, lineSpacing: 1.15 }));
  }
  return doc;
}
