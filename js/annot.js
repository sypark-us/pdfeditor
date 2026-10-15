// Annotation editor: draws on an SVG overlay per page (coordinates in page points, origin
// bottom-left) and burns the result into the PDF with pdf-lib. Also hosts the crop selection.
import { el, uid, hexToRgb, clamp } from './util.js';
import { FontManager, FAMILIES } from './fonts.js';
import { loadDoc, saveDoc, visualGeom, renderPages } from './pdftools.js';
import { canvasToBytes } from './util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => { const n = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v); return n; };
const BOX_TYPES = new Set(['highlight', 'rect', 'ellipse', 'whiteout', 'redact', 'image', 'signature', 'crop']);

export const DEFAULT_STYLE = { color: '#d32f2f', fill: '', strokeWidth: 2, opacity: 1, fontSize: 14, family: 'sans', bold: false, italic: false, highlightColor: '#ffeb3b' };

export class Annotator {
  constructor(viewer, opts = {}) {
    this.viewer = viewer;
    this.onChange = opts.onChange || (() => {});
    this.onSelect = opts.onSelect || (() => {});
    this.onTextPrompt = opts.onTextPrompt || (async () => null);
    this.tool = 'select';
    this.style = { ...DEFAULT_STYLE };
    this.annots = new Map();
    this.selected = null;
    this.pendingImage = null;
    this.history = []; this.future = [];
    this.svgs = new Map();
    this.drag = null;
    this.container = viewer.container;
    this.container.addEventListener('pointerdown', (e) => this.pointerDown(e));
    window.addEventListener('pointermove', (e) => this.pointerMove(e));
    window.addEventListener('pointerup', (e) => this.pointerUp(e));
    this.container.addEventListener('dblclick', (e) => this.dblClick(e));
    window.addEventListener('keydown', (e) => this.keyDown(e));
    viewer.onPageRendered = () => { };
  }

  reset() { this.annots.clear(); this.selected = null; this.history = []; this.future = []; this.svgs.clear(); this.drag = null; }
  hasAnnotations() { for (const list of this.annots.values()) if (list.some((a) => a.type !== 'crop')) return true; return false; }
  count() { let n = 0; for (const l of this.annots.values()) n += l.filter((a) => a.type !== 'crop').length; return n; }
  setTool(tool) {
    this.tool = tool;
    this.select(null);
    for (const p of this.viewer.pages) p.overlay.classList.toggle('drawing', tool !== 'select');
    this.container.dataset.tool = tool;
  }
  setStyle(patch) {
    Object.assign(this.style, patch);
    if (this.selected) { this.snapshot(); Object.assign(this.selected, this.styleFor(this.selected.type, patch)); this.redraw(this.selected.page); this.onChange(); }
  }
  styleFor(type, patch) {
    const out = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'color') { if (type === 'highlight') out.color = v; else out.color = v; }
      else if (k === 'fontSize' && type === 'text') out.size = v;
      else if (k === 'fontSize') continue;
      else out[k] = v;
    }
    return out;
  }
  list(page) { if (!this.annots.has(page)) this.annots.set(page, []); return this.annots.get(page); }
  snapshot() { this.history.push(JSON.stringify([...this.annots.entries()].map(([k, v]) => [k, v.map((a) => ({ ...a, _img: undefined }))]))); if (this.history.length > 100) this.history.shift(); this.future = []; }
  restore(json) {
    const keep = new Map();
    for (const l of this.annots.values()) for (const a of l) if (a.bytes) keep.set(a.id, a);
    this.annots = new Map(JSON.parse(json).map(([k, v]) => [k, v.map((a) => (keep.has(a.id) ? { ...keep.get(a.id), ...a, bytes: keep.get(a.id).bytes, dataUrl: keep.get(a.id).dataUrl } : a))]));
    this.selected = null;
    for (const p of this.viewer.pages) this.redraw(p.index);
    this.onChange();
  }
  undo() { if (!this.history.length) return false; this.future.push(JSON.stringify([...this.annots.entries()])); this.restore(this.history.pop()); return true; }
  redo() { if (!this.future.length) return false; this.history.push(JSON.stringify([...this.annots.entries()])); this.restore(this.future.pop()); return true; }
  clearPage(page) { this.snapshot(); this.annots.set(page, []); this.redraw(page); this.onChange(); }
  clearAll() { this.snapshot(); this.annots.clear(); for (const p of this.viewer.pages) this.redraw(p.index); this.onChange(); }
  remove(annot) { if (!annot) return; this.snapshot(); const l = this.list(annot.page); const i = l.indexOf(annot); if (i >= 0) l.splice(i, 1); if (this.selected === annot) this.select(null); this.redraw(annot.page); this.onChange(); }
  getCrop() { for (const l of this.annots.values()) for (const a of l) if (a.type === 'crop') return a; return null; }
  clearCrop() { for (const [k, l] of this.annots) { const n = l.filter((a) => a.type !== 'crop'); if (n.length !== l.length) { this.annots.set(k, n); this.redraw(k); } } }

  // ----- drawing to SVG -----
  svgFor(p) {
    let svg = this.svgs.get(p.index);
    if (!svg || svg.parentNode !== p.overlay) {
      p.overlay.innerHTML = '';
      svg = svgEl('svg', { class: 'annot-layer' });
      p.overlay.append(svg);
      this.svgs.set(p.index, svg);
      p.overlay.classList.toggle('drawing', this.tool !== 'select');
    }
    const vp = p.baseViewport;
    svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
    svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
    return svg;
  }
  redraw(pageIndex) {
    const p = this.viewer.pages[pageIndex];
    if (!p) return;
    const svg = this.svgFor(p);
    svg.innerHTML = '';
    const H = p.baseViewport.height;
    const flip = (y) => H - y;
    for (const a of this.list(pageIndex)) {
      const g = svgEl('g', { 'data-id': a.id, class: `annot ${a.type}${this.selected === a ? ' selected' : ''}` });
      let shape;
      switch (a.type) {
        case 'text': {
          shape = svgEl('text', { x: a.x, y: flip(a.y), 'font-size': a.size, fill: a.color, 'font-family': FAMILIES[a.family] ? FAMILIES[a.family].css : a.family, 'font-weight': a.bold ? 'bold' : 'normal', 'font-style': a.italic ? 'italic' : 'normal', opacity: a.opacity ?? 1 });
          const lines = String(a.text).split('\n');
          lines.forEach((ln, i) => { const t = svgEl('tspan', { x: a.x, y: flip(a.y - i * a.size * 1.2) }); t.textContent = ln || ' '; shape.append(t); });
          g.append(shape);
          // transparent hit box
          const w = this.textWidth(a), h = lines.length * a.size * 1.2;
          g.append(svgEl('rect', { class: 'hit', x: a.x - 2, y: flip(a.y) - a.size, width: w + 4, height: h + 4, fill: 'transparent', stroke: this.selected === a ? '#1976d2' : 'none', 'stroke-dasharray': '3 2', 'stroke-width': 1 }));
          break;
        }
        case 'pen': case 'highlighter': {
          const d = a.points.map((pt, i) => `${i ? 'L' : 'M'}${pt.x.toFixed(1)} ${flip(pt.y).toFixed(1)}`).join(' ');
          shape = svgEl('path', { d, fill: 'none', stroke: a.color, 'stroke-width': a.strokeWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: a.type === 'highlighter' ? 0.4 : a.opacity ?? 1, style: a.type === 'highlighter' ? 'mix-blend-mode:multiply' : '' });
          g.append(shape);
          break;
        }
        case 'highlight': shape = svgEl('rect', { x: a.x, y: flip(a.y + a.h), width: a.w, height: a.h, fill: a.color, opacity: 0.4, style: 'mix-blend-mode:multiply' }); g.append(shape); break;
        case 'whiteout': shape = svgEl('rect', { x: a.x, y: flip(a.y + a.h), width: a.w, height: a.h, fill: '#ffffff', stroke: this.selected === a ? '#1976d2' : '#ddd', 'stroke-width': 0.5 }); g.append(shape); break;
        case 'redact': shape = svgEl('rect', { x: a.x, y: flip(a.y + a.h), width: a.w, height: a.h, fill: '#000', opacity: 0.85 }); g.append(shape); break;
        case 'crop': shape = svgEl('rect', { x: a.x, y: flip(a.y + a.h), width: a.w, height: a.h, fill: 'rgba(25,118,210,0.08)', stroke: '#1976d2', 'stroke-width': 1.5, 'stroke-dasharray': '6 3' }); g.append(shape); break;
        case 'rect': shape = svgEl('rect', { x: a.x, y: flip(a.y + a.h), width: a.w, height: a.h, fill: a.fill || 'none', stroke: a.color, 'stroke-width': a.strokeWidth, opacity: a.opacity ?? 1 }); g.append(shape); break;
        case 'ellipse': shape = svgEl('ellipse', { cx: a.x + a.w / 2, cy: flip(a.y + a.h / 2), rx: a.w / 2, ry: a.h / 2, fill: a.fill || 'none', stroke: a.color, 'stroke-width': a.strokeWidth, opacity: a.opacity ?? 1 }); g.append(shape); break;
        case 'line': case 'arrow': {
          shape = svgEl('line', { x1: a.x1, y1: flip(a.y1), x2: a.x2, y2: flip(a.y2), stroke: a.color, 'stroke-width': a.strokeWidth, 'stroke-linecap': 'round', opacity: a.opacity ?? 1 });
          g.append(shape);
          if (a.type === 'arrow') { const pts = arrowHead(a); g.append(svgEl('polygon', { points: pts.map((pt) => `${pt.x},${flip(pt.y)}`).join(' '), fill: a.color, opacity: a.opacity ?? 1 })); }
          // wider invisible hit line
          g.append(svgEl('line', { class: 'hit', x1: a.x1, y1: flip(a.y1), x2: a.x2, y2: flip(a.y2), stroke: 'transparent', 'stroke-width': Math.max(10, a.strokeWidth + 8) }));
          break;
        }
        case 'image': case 'signature': {
          shape = svgEl('image', { x: a.x, y: flip(a.y + a.h), width: a.w, height: a.h, href: a.dataUrl, preserveAspectRatio: 'none', opacity: a.opacity ?? 1 });
          g.append(shape);
          if (this.selected === a) g.append(svgEl('rect', { x: a.x, y: flip(a.y + a.h), width: a.w, height: a.h, fill: 'none', stroke: '#1976d2', 'stroke-dasharray': '4 2' }));
          break;
        }
        case 'note': {
          shape = svgEl('g', {});
          shape.append(svgEl('rect', { x: a.x, y: flip(a.y + 18), width: 20, height: 18, rx: 3, fill: a.color || '#ffd54f', stroke: '#b28704' }));
          const t = svgEl('text', { x: a.x + 10, y: flip(a.y + 18) + 13, 'font-size': 12, 'text-anchor': 'middle', fill: '#5d4037', 'font-family': 'sans-serif' }); t.textContent = '✎'; shape.append(t);
          const title = svgEl('title'); title.textContent = a.text; shape.append(title);
          g.append(shape);
          break;
        }
        default: break;
      }
      if (this.selected === a && (BOX_TYPES.has(a.type))) {
        for (const [hx, hy, name] of [[a.x, a.y, 'sw'], [a.x + a.w, a.y, 'se'], [a.x, a.y + a.h, 'nw'], [a.x + a.w, a.y + a.h, 'ne']]) g.append(svgEl('rect', { class: 'handle', 'data-handle': name, x: hx - 4, y: flip(hy) - 4, width: 8, height: 8, fill: '#fff', stroke: '#1976d2' }));
      }
      if (this.selected === a && (a.type === 'line' || a.type === 'arrow')) {
        for (const [hx, hy, name] of [[a.x1, a.y1, 'p1'], [a.x2, a.y2, 'p2']]) g.append(svgEl('circle', { class: 'handle', 'data-handle': name, cx: hx, cy: flip(hy), r: 5, fill: '#fff', stroke: '#1976d2' }));
      }
      svg.append(g);
    }
  }
  redrawAll() { for (const p of this.viewer.pages) this.redraw(p.index); }
  textWidth(a) {
    const c = this._mc || (this._mc = document.createElement('canvas').getContext('2d'));
    c.font = `${a.italic ? 'italic ' : ''}${a.bold ? 'bold ' : ''}${a.size}px ${FAMILIES[a.family] ? FAMILIES[a.family].css : a.family}`;
    return Math.max(...String(a.text).split('\n').map((l) => c.measureText(l || ' ').width));
  }

  select(a) {
    const prev = this.selected;
    this.selected = a;
    if (prev && prev !== a) this.redraw(prev.page);
    if (a) this.redraw(a.page);
    this.onSelect(a);
  }
  findAnnot(target) {
    const g = target.closest && target.closest('g.annot');
    if (!g) return null;
    const id = g.dataset.id;
    for (const l of this.annots.values()) for (const a of l) if (a.id === id) return a;
    return null;
  }

  // ----- pointer handling -----
  pointerDown(e) {
    if (e.button !== 0) return;
    if (this.editingText) return;
    const p = this.viewer.pageAt(e);
    if (!p) return;
    const pt = this.viewer.eventToPage(p, e);
    const handle = e.target.closest && e.target.closest('.handle');
    if (handle && this.selected) {
      e.preventDefault();
      this.snapshot();
      this.drag = { kind: 'resize', handle: handle.dataset.handle, a: this.selected, start: pt, orig: { ...this.selected }, page: p };
      return;
    }
    if (this.tool === 'select') {
      const a = this.findAnnot(e.target);
      if (a) { e.preventDefault(); this.select(a); this.snapshot(); this.drag = { kind: 'move', a, start: pt, orig: JSON.parse(JSON.stringify(a)), page: p }; }
      else if (this.selected) this.select(null);
      return;
    }
    e.preventDefault();
    if (this.tool === 'text') { this.beginText(p, pt); return; }
    if (this.tool === 'note') { this.placeNote(p, pt); return; }
    if (this.tool === 'image' || this.tool === 'signature') { this.placeImage(p, pt); return; }
    if (this.tool === 'pen' || this.tool === 'highlighter') {
      this.snapshot();
      const a = { id: uid(), type: this.tool, page: p.index, points: [pt], color: this.tool === 'highlighter' ? this.style.highlightColor : this.style.color, strokeWidth: this.tool === 'highlighter' ? Math.max(10, this.style.strokeWidth * 6) : this.style.strokeWidth, opacity: this.style.opacity };
      this.list(p.index).push(a);
      this.drag = { kind: 'draw', a, page: p };
      this.redraw(p.index);
      return;
    }
    if (BOX_TYPES.has(this.tool) || this.tool === 'line' || this.tool === 'arrow') {
      this.snapshot();
      if (this.tool === 'crop') this.clearCrop();
      const base = { id: uid(), type: this.tool, page: p.index, color: this.tool === 'highlight' ? this.style.highlightColor : this.style.color, fill: this.style.fill, strokeWidth: this.style.strokeWidth, opacity: this.style.opacity };
      const a = this.tool === 'line' || this.tool === 'arrow' ? { ...base, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y } : { ...base, x: pt.x, y: pt.y, w: 0, h: 0 };
      this.list(p.index).push(a);
      this.drag = { kind: 'create', a, start: pt, page: p };
      this.redraw(p.index);
    }
  }
  pointerMove(e) {
    const d = this.drag;
    if (!d) return;
    const pt = this.viewer.eventToPage(d.page, e);
    const a = d.a;
    const W = d.page.baseViewport.width, H = d.page.baseViewport.height;
    if (d.kind === 'draw') { const last = a.points[a.points.length - 1]; if (Math.hypot(pt.x - last.x, pt.y - last.y) > 0.7) a.points.push(pt); }
    else if (d.kind === 'create') {
      if (a.type === 'line' || a.type === 'arrow') { a.x2 = pt.x; a.y2 = pt.y; if (e.shiftKey) { const dx = a.x2 - a.x1, dy = a.y2 - a.y1; if (Math.abs(dx) > Math.abs(dy)) a.y2 = a.y1; else a.x2 = a.x1; } }
      else { a.x = Math.min(d.start.x, pt.x); a.y = Math.min(d.start.y, pt.y); a.w = Math.abs(pt.x - d.start.x); a.h = Math.abs(pt.y - d.start.y); if (e.shiftKey) { const s = Math.max(a.w, a.h); a.w = a.h = s; } }
    } else if (d.kind === 'move') {
      const dx = pt.x - d.start.x, dy = pt.y - d.start.y;
      if (a.points) a.points = d.orig.points.map((q) => ({ x: q.x + dx, y: q.y + dy }));
      else if (a.type === 'line' || a.type === 'arrow') { a.x1 = d.orig.x1 + dx; a.y1 = d.orig.y1 + dy; a.x2 = d.orig.x2 + dx; a.y2 = d.orig.y2 + dy; }
      else { a.x = clamp(d.orig.x + dx, -(a.w || 0) + 4, W - 4); a.y = clamp(d.orig.y + dy, -(a.h || 0) + 4, H - 4); }
    } else if (d.kind === 'resize') {
      const o = d.orig;
      if (d.handle === 'p1') { a.x1 = pt.x; a.y1 = pt.y; }
      else if (d.handle === 'p2') { a.x2 = pt.x; a.y2 = pt.y; }
      else {
        let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
        if (d.handle.includes('w')) x1 = pt.x; if (d.handle.includes('e')) x2 = pt.x;
        if (d.handle.includes('s')) y1 = pt.y; if (d.handle.includes('n')) y2 = pt.y;
        let w = Math.max(4, x2 - x1), h = Math.max(4, y2 - y1);
        if ((a.type === 'image' || a.type === 'signature') && !e.shiftKey && o.w && o.h) { const r = o.w / o.h; if (w / h > r) w = h * r; else h = w / r; if (d.handle.includes('w')) x1 = x2 - w; if (d.handle.includes('s')) y1 = y2 - h; }
        a.x = Math.min(x1, x2); a.y = Math.min(y1, y2); a.w = w; a.h = h;
      }
    }
    this.redraw(d.page.index);
  }
  pointerUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const a = d.a;
    if (d.kind === 'create' && a.type !== 'line' && a.type !== 'arrow' && (a.w < 3 || a.h < 3)) {
      if (a.type === 'highlight' || a.type === 'rect' || a.type === 'ellipse' || a.type === 'whiteout' || a.type === 'redact' || a.type === 'crop') { // click without drag: default size
        if (a.type === 'crop') { this.remove(a); return; }
        a.w = a.w < 3 ? 120 : a.w; a.h = a.h < 3 ? (a.type === 'highlight' ? 16 : 60) : a.h; a.y -= a.h; a.y = Math.max(0, a.y);
      }
    }
    if (d.kind === 'create' && (a.type === 'line' || a.type === 'arrow') && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 3) { a.x2 = a.x1 + 100; }
    if (d.kind === 'draw' && a.points.length < 2) a.points.push({ x: a.points[0].x + 0.5, y: a.points[0].y });
    if (d.kind === 'draw') a.points = simplify(a.points, 0.4);
    this.redraw(d.page.index);
    if (a.type !== 'crop' && (d.kind === 'create' || d.kind === 'draw')) { if (a.type !== 'pen' && a.type !== 'highlighter') this.select(a); }
    this.onChange();
  }
  dblClick(e) {
    const a = this.findAnnot(e.target);
    if (!a) return;
    if (a.type === 'text') { const p = this.viewer.pages[a.page]; this.beginText(p, { x: a.x, y: a.y }, a); }
    else if (a.type === 'note') { this.editNote(a); }
  }
  keyDown(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { e.preventDefault(); this.remove(this.selected); }
    else if (e.key === 'Escape') { this.setTool('select'); if (this.onToolChange) this.onToolChange('select'); }
    else if (this.selected && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1, dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, dy = e.key === 'ArrowUp' ? d : e.key === 'ArrowDown' ? -d : 0;
      const a = this.selected;
      if (a.points) a.points = a.points.map((q) => ({ x: q.x + dx, y: q.y + dy })); else if (a.x1 != null) { a.x1 += dx; a.x2 += dx; a.y1 += dy; a.y2 += dy; } else { a.x += dx; a.y += dy; }
      this.redraw(a.page); this.onChange();
    }
  }

  // ----- text / note / image placement -----
  beginText(p, pt, existing = null) {
    const size = existing ? existing.size : this.style.fontSize;
    const scale = this.viewer.scale;
    const ta = el('textarea', { class: 'text-editor', spellcheck: 'false' });
    ta.value = existing ? existing.text : '';
    const H = p.baseViewport.height;
    Object.assign(ta.style, { left: `${pt.x * scale - 2}px`, top: `${(H - pt.y - size * 0.95) * scale}px`, fontSize: `${size * scale}px`, lineHeight: `${size * 1.2 * scale}px`, color: existing ? existing.color : this.style.color, fontFamily: FAMILIES[existing ? existing.family : this.style.family].css, fontWeight: (existing ? existing.bold : this.style.bold) ? 'bold' : 'normal', fontStyle: (existing ? existing.italic : this.style.italic) ? 'italic' : 'normal' });
    p.wrapper.append(ta);
    this.editingText = ta;
    if (existing) existing._hidden = true, this.redraw(p.index);
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 4}px`; ta.style.width = 'auto'; ta.style.width = `${Math.max(60, ta.scrollWidth + 8)}px`; };
    grow();
    ta.addEventListener('input', grow);
    let done = false;
    const finish = (cancel) => {
      if (done) return; done = true;
      ta.remove(); this.editingText = null;
      const text = ta.value.replace(/\s+$/, '');
      if (existing) { delete existing._hidden; if (!cancel && text) { this.snapshot(); existing.text = text; } else if (!cancel && !text) { this.remove(existing); return; } this.redraw(p.index); this.onChange(); return; }
      if (cancel || !text) return;
      this.snapshot();
      const a = { id: uid(), type: 'text', page: p.index, x: pt.x, y: pt.y, text, size, color: this.style.color, family: this.style.family, bold: this.style.bold, italic: this.style.italic, opacity: this.style.opacity };
      this.list(p.index).push(a);
      this.redraw(p.index);
      this.onChange();
    };
    ta.addEventListener('blur', () => finish(false));
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(true); } else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(false); } e.stopPropagation(); });
    setTimeout(() => ta.focus(), 0);
  }
  async placeNote(p, pt) {
    const text = await this.onTextPrompt('Note text', '');
    if (!text) return;
    this.snapshot();
    const a = { id: uid(), type: 'note', page: p.index, x: pt.x, y: pt.y - 18, text, color: '#ffd54f' };
    this.list(p.index).push(a);
    this.redraw(p.index); this.onChange();
  }
  async editNote(a) {
    const text = await this.onTextPrompt('Edit note', a.text);
    if (text == null) return;
    this.snapshot(); a.text = text; this.redraw(a.page); this.onChange();
  }
  placeImage(p, pt) {
    const img = this.pendingImage;
    if (!img) { if (this.onNeedImage) this.onNeedImage(); return; }
    this.snapshot();
    const maxW = p.baseViewport.width * 0.4;
    let w = img.width * 0.75, h = img.height * 0.75;
    if (w > maxW) { h *= maxW / w; w = maxW; }
    if (img.kind === 'signature') { const target = p.baseViewport.width * 0.25; h *= target / w; w = target; }
    const a = { id: uid(), type: this.tool === 'signature' ? 'signature' : 'image', page: p.index, x: pt.x - w / 2, y: pt.y - h / 2, w, h, bytes: img.bytes, imgType: img.type, dataUrl: img.dataUrl, opacity: 1 };
    this.list(p.index).push(a);
    this.redraw(p.index);
    this.select(a);
    this.onChange();
  }

  // ----- JSON export of annotations (for sidebar list) -----
  summary() {
    const out = [];
    for (const [page, l] of this.annots) for (const a of l) if (a.type !== 'crop') out.push({ page, a });
    return out.sort((x, y) => x.page - y.page);
  }
}

function arrowHead(a) {
  const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const len = Math.max(8, a.strokeWidth * 4), spread = Math.PI / 7;
  return [{ x: a.x2, y: a.y2 }, { x: a.x2 - len * Math.cos(ang - spread), y: a.y2 - len * Math.sin(ang - spread) }, { x: a.x2 - len * Math.cos(ang + spread), y: a.y2 - len * Math.sin(ang + spread) }];
}
function simplify(points, tol) {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1], cur = points[i], next = points[i + 1];
    const d = Math.abs((next.x - prev.x) * (prev.y - cur.y) - (prev.x - cur.x) * (next.y - prev.y)) / (Math.hypot(next.x - prev.x, next.y - prev.y) || 1);
    if (d > tol || Math.hypot(cur.x - prev.x, cur.y - prev.y) > 6) out.push(cur);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Burn annotations into the PDF. annots: Map<pageIndex, Annot[]>. Returns new bytes. */
export async function applyAnnotations(bytes, annots, opts = {}) {
  const { rgb, degrees, LineCapStyle, BlendMode, PDFHexString, PDFName } = globalThis.PDFLib;
  const doc = await loadDoc(bytes);
  const fm = new FontManager(doc);
  const imgCache = new Map();
  const redactPages = new Set();
  for (const [pageIndex, list] of annots) {
    const page = doc.getPage(pageIndex);
    if (!page) continue;
    const g = visualGeom(page);
    for (const a of list) {
      const color = rgb(...hexToRgb(a.color || '#000000'));
      switch (a.type) {
        case 'text': {
          const lines = String(a.text).split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            const font = await fm.resolve(line, { family: a.family, bold: a.bold, italic: a.italic, fontName: a.fontName });
            const [ux, uy] = g.toUser(a.x, a.y - i * a.size * 1.2);
            await font.draw(page, line, ux, uy, a.size, { color, opacity: a.opacity, rotate: g.rotate });
          }
          break;
        }
        case 'pen': case 'highlighter': {
          const path = a.points.map((pt, i) => { const [ux, uy] = g.toUser(pt.x, pt.y); return `${i ? 'L' : 'M'}${ux.toFixed(2)} ${(-uy).toFixed(2)}`; }).join(' ');
          page.drawSvgPath(path, { x: 0, y: 0, borderColor: color, borderWidth: a.strokeWidth, borderOpacity: a.type === 'highlighter' ? 0.4 : a.opacity ?? 1, borderLineCap: LineCapStyle.Round, blendMode: a.type === 'highlighter' ? BlendMode.Multiply : undefined });
          break;
        }
        case 'highlight': { const r = g.rectToUser(a.x, a.y, a.w, a.h); page.drawRectangle({ ...r, color, opacity: 0.4, blendMode: BlendMode.Multiply }); break; }
        case 'whiteout': { const r = g.rectToUser(a.x, a.y, a.w, a.h); page.drawRectangle({ ...r, color: rgb(1, 1, 1) }); break; }
        case 'redact': { const r = g.rectToUser(a.x, a.y, a.w, a.h); page.drawRectangle({ ...r, color: rgb(0, 0, 0) }); redactPages.add(pageIndex); break; }
        case 'rect': { const r = g.rectToUser(a.x, a.y, a.w, a.h); page.drawRectangle({ ...r, borderColor: color, borderWidth: a.strokeWidth, color: a.fill ? rgb(...hexToRgb(a.fill)) : undefined, opacity: a.opacity, borderOpacity: a.opacity }); break; }
        case 'ellipse': { const r = g.rectToUser(a.x, a.y, a.w, a.h); page.drawEllipse({ x: r.x + r.width / 2, y: r.y + r.height / 2, xScale: r.width / 2, yScale: r.height / 2, borderColor: color, borderWidth: a.strokeWidth, color: a.fill ? rgb(...hexToRgb(a.fill)) : undefined, opacity: a.opacity, borderOpacity: a.opacity }); break; }
        case 'line': case 'arrow': {
          const [x1, y1] = g.toUser(a.x1, a.y1), [x2, y2] = g.toUser(a.x2, a.y2);
          page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: a.strokeWidth, color, opacity: a.opacity, lineCap: LineCapStyle.Round });
          if (a.type === 'arrow') { const pts = arrowHead(a).map((pt) => g.toUser(pt.x, pt.y)); page.drawSvgPath(`M${pts[0][0]} ${-pts[0][1]} L${pts[1][0]} ${-pts[1][1]} L${pts[2][0]} ${-pts[2][1]} Z`, { x: 0, y: 0, color, opacity: a.opacity, borderWidth: 0 }); }
          break;
        }
        case 'image': case 'signature': {
          if (!a.bytes) break;
          let img = imgCache.get(a.bytes);
          if (!img) { img = a.imgType === 'jpg' ? await doc.embedJpg(a.bytes) : await doc.embedPng(a.bytes); imgCache.set(a.bytes, img); }
          const [ux, uy] = g.toUser(a.x, a.y);
          page.drawImage(img, { x: ux, y: uy, width: a.w, height: a.h, opacity: a.opacity, rotate: g.rotate });
          break;
        }
        case 'note': {
          const r = g.rectToUser(a.x, a.y, 20, 18);
          const annot = doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [r.x, r.y, r.x + r.width, r.y + r.height], Contents: PDFHexString.fromText(a.text || ''), T: PDFHexString.fromText(opts.author || 'PDF Editor'), Name: 'Comment', Open: false, C: [1, 0.84, 0.3], F: 4, M: PDFHexString.fromText(new Date().toISOString()) });
          page.node.addAnnot(doc.context.register(annot));
          break;
        }
        default: break;
      }
    }
  }
  let out = await saveDoc(doc);
  if (redactPages.size) out = await rasterizePages(out, [...redactPages], opts.redactDpi || 150);
  void PDFName;
  return out;
}

/** Replace the given pages with flat images of themselves (true redaction: text underneath is gone). */
export async function rasterizePages(bytes, indices, dpi = 150) {
  const rendered = new Map();
  await renderPages(bytes, { dpi, pages: indices }, async (canvas, i, vp1) => { rendered.set(i, { jpg: await canvasToBytes(canvas, 'image/jpeg', 0.92), w: vp1.width, h: vp1.height }); });
  const doc = await loadDoc(bytes);
  for (const i of [...rendered.keys()].sort((a, b) => a - b)) {
    const { jpg, w, h } = rendered.get(i);
    const img = await doc.embedJpg(jpg);
    const page = doc.insertPage(i, [w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    doc.removePage(i + 1);
  }
  return saveDoc(doc);
}
