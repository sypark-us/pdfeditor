// Continuous-scroll PDF viewer on pdf.js: lazy page rendering, selectable text layer,
// thumbnails, zoom, search. Each page gets an overlay element the annotation editor draws into.
import { el, $, clamp } from './util.js';

const pdfjs = () => globalThis.pdfjsLib;

export class Viewer {
  constructor(container, thumbsContainer) {
    this.container = container;
    this.thumbs = thumbsContainer;
    this.pdf = null;
    this.pages = []; // { index, page, viewport, wrapper, canvas, textLayer, overlay, rendered, rotation }
    this.scale = 1;
    this.fitMode = 'width';
    this.onPageVisible = null;
    this.onReady = null;
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const idx = Number(e.target.dataset.index);
        if (e.isIntersecting) this.renderPage(idx);
      }
    }, { root: container, rootMargin: '600px 0px' });
    this.currentIndex = 0;
    container.addEventListener('scroll', () => this.updateCurrent());
    this.thumbObserver = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) this.renderThumb(Number(e.target.dataset.index)); }, { root: thumbsContainer, rootMargin: '400px 0px' });
  }

  async load(bytes, opts = {}) {
    await this.destroy();
    const task = pdfjs().getDocument({ data: bytes.slice(), cMapUrl: 'vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: 'vendor/pdfjs/standard_fonts/', password: opts.password, enableXfa: true });
    task.onPassword = (update, reason) => { if (opts.onPassword) opts.onPassword(update, reason); else update(null); };
    this.pdf = await task.promise;
    this.container.innerHTML = '';
    this.thumbs.innerHTML = '';
    this.pages = [];
    for (let i = 0; i < this.pdf.numPages; i++) {
      const page = await this.pdf.getPage(i + 1);
      const viewport = page.getViewport({ scale: 1 });
      const wrapper = el('div', { class: 'page', dataset: { index: i } });
      const canvas = el('canvas');
      const textLayer = el('div', { class: 'textLayer' });
      const overlay = el('div', { class: 'overlay' });
      const label = el('div', { class: 'page-label' }, `${i + 1}`);
      wrapper.append(canvas, textLayer, overlay, label);
      this.container.append(wrapper);
      const thumb = el('div', { class: 'thumb', dataset: { index: i } }, el('canvas'), el('div', { class: 'thumb-num' }, String(i + 1)));
      thumb.addEventListener('click', () => this.goTo(i));
      this.thumbs.append(thumb);
      this.pages.push({ index: i, page, baseViewport: viewport, wrapper, canvas, textLayer, overlay, rendered: false, thumb, thumbRendered: false, renderTask: null });
      this.observer.observe(wrapper);
      this.thumbObserver.observe(thumb);
    }
    this.applyScale();
    if (this.onReady) this.onReady();
  }

  async destroy() {
    for (const p of this.pages) { this.observer.unobserve(p.wrapper); this.thumbObserver.unobserve(p.thumb); if (p.renderTask) try { p.renderTask.cancel(); } catch { /* ignore */ } }
    if (this.pdf) { try { await this.pdf.destroy(); } catch { /* ignore */ } }
    this.pdf = null; this.pages = [];
  }

  get numPages() { return this.pages.length; }

  viewportFor(p, scale = this.scale) { return p.page.getViewport({ scale }); }

  computeScale() {
    if (!this.pages.length) return 1;
    const avail = this.container.clientWidth - 40;
    const first = this.pages[this.currentIndex] || this.pages[0];
    const vp = first.baseViewport;
    if (this.fitMode === 'width') return clamp(avail / vp.width, 0.2, 6);
    if (this.fitMode === 'page') return clamp(Math.min(avail / vp.width, (this.container.clientHeight - 40) / vp.height), 0.2, 6);
    return this.scale;
  }
  applyScale() {
    this.scale = this.computeScale();
    const dpr = window.devicePixelRatio || 1;
    for (const p of this.pages) {
      const vp = this.viewportFor(p);
      p.viewport = vp;
      p.wrapper.style.width = `${vp.width}px`;
      p.wrapper.style.height = `${vp.height}px`;
      p.rendered = false;
      p.canvas.style.width = `${vp.width}px`; p.canvas.style.height = `${vp.height}px`;
      void dpr;
    }
    for (const p of this.pages) if (this.isNear(p)) this.renderPage(p.index);
    if (this.onScaleChange) this.onScaleChange(this.scale);
  }
  isNear(p) {
    const r = p.wrapper.getBoundingClientRect(), c = this.container.getBoundingClientRect();
    return r.bottom > c.top - 600 && r.top < c.bottom + 600;
  }
  setZoom(mode, value) {
    this.fitMode = mode;
    if (mode === 'custom') this.scale = clamp(value, 0.2, 6);
    this.applyScale();
  }
  zoomBy(f) { this.setZoom('custom', this.scale * f); }

  async renderPage(index) {
    const p = this.pages[index];
    if (!p || p.rendered || p.rendering) return;
    p.rendering = true;
    const vp = p.viewport || this.viewportFor(p);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    p.canvas.width = Math.floor(vp.width * dpr); p.canvas.height = Math.floor(vp.height * dpr);
    const ctx = p.canvas.getContext('2d');
    try {
      p.renderTask = p.page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null, annotationMode: pdfjs().AnnotationMode.ENABLE_FORMS });
      await p.renderTask.promise;
      p.rendered = true;
      p.textLayer.innerHTML = '';
      p.textLayer.style.width = `${vp.width}px`; p.textLayer.style.height = `${vp.height}px`;
      const tc = await p.page.getTextContent();
      const tl = new (pdfjs().TextLayer)({ textContentSource: tc, container: p.textLayer, viewport: vp });
      await tl.render();
      p.textLayer.style.setProperty('--scale-factor', String(vp.scale));
    } catch (e) { if (!(e && e.name === 'RenderingCancelledException')) console.warn('render failed', e); }
    p.rendering = false;
    if (this.onPageRendered) this.onPageRendered(p);
  }
  async renderThumb(index) {
    const p = this.pages[index];
    if (!p || p.thumbRendered) return;
    p.thumbRendered = true;
    const vp = p.page.getViewport({ scale: 120 / p.baseViewport.width });
    const c = p.thumb.querySelector('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    try { await p.page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; } catch { /* ignore */ }
  }
  refreshThumb(index) { const p = this.pages[index]; if (p) { p.thumbRendered = false; this.renderThumb(index); } }

  goTo(index) {
    const p = this.pages[index];
    if (!p) return;
    this.container.scrollTo({ top: p.wrapper.offsetTop - 12, behavior: 'smooth' });
  }
  updateCurrent() {
    const c = this.container.getBoundingClientRect();
    const mid = c.top + c.height * 0.4;
    let best = 0, bestD = Infinity;
    for (const p of this.pages) {
      const r = p.wrapper.getBoundingClientRect();
      const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
      if (d < bestD) { bestD = d; best = p.index; }
    }
    if (best !== this.currentIndex) {
      this.currentIndex = best;
      for (const p of this.pages) p.thumb.classList.toggle('active', p.index === best);
      if (this.onPageVisible) this.onPageVisible(best);
    }
  }

  /** Convert a mouse event into page-visual coordinates (points, origin bottom-left, y up) for page p. */
  eventToPage(p, ev) {
    const r = p.wrapper.getBoundingClientRect();
    const sx = (ev.clientX - r.left) / this.scale, sy = (ev.clientY - r.top) / this.scale;
    return { x: sx, y: p.baseViewport.height - sy, sx, sy };
  }
  pageAt(ev) {
    for (const p of this.pages) { const r = p.wrapper.getBoundingClientRect(); if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) return p; }
    return null;
  }

  async search(query) {
    const results = [];
    if (!query || !this.pdf) return results;
    const q = query.toLowerCase();
    for (const p of this.pages) {
      const tc = await p.page.getTextContent();
      const text = tc.items.map((i) => i.str).join(' ').toLowerCase();
      let idx = text.indexOf(q);
      while (idx >= 0 && results.length < 500) { results.push({ page: p.index, snippet: text.slice(Math.max(0, idx - 30), idx + q.length + 30) }); idx = text.indexOf(q, idx + q.length); }
    }
    return results;
  }
  highlightSearch(query) {
    for (const p of this.pages) {
      for (const s of p.textLayer.querySelectorAll('span')) {
        if (!query) { s.classList.remove('hit'); continue; }
        s.classList.toggle('hit', s.textContent.toLowerCase().includes(query.toLowerCase()));
      }
    }
  }
}

export function pageSizeLabel(vp) {
  const w = vp.width, h = vp.height;
  const near = (a, b) => Math.abs(a - b) < 3;
  const names = { A4: [595.28, 841.89], Letter: [612, 792], Legal: [612, 1008], A3: [841.89, 1190.55], A5: [419.53, 595.28] };
  for (const [n, [pw, ph]] of Object.entries(names)) { if (near(w, pw) && near(h, ph)) return n; if (near(w, ph) && near(h, pw)) return `${n} landscape`; }
  return `${(w / 72).toFixed(2)} × ${(h / 72).toFixed(2)} in`;
}
void $;
