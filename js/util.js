// Small shared helpers: bytes, downloads, zip, page-range parsing, DOM.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === false || v == null) continue;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function readFileBytes(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(new Uint8Array(fr.result));
    fr.onerror = () => rej(fr.error);
    fr.readAsArrayBuffer(file);
  });
}
export function readFileText(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsText(file);
  });
}
export function readFileDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(file);
  });
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
export const downloadBytes = (bytes, name, type = 'application/octet-stream') => downloadBlob(new Blob([bytes], { type }), name);

export function baseName(name, ext = '') {
  const b = String(name || 'document').replace(/\.[^.]+$/, '');
  return ext ? `${b}.${ext}` : b;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Parse "1-3, 5, 8-" into a sorted list of 0-based page indices (total = page count). */
export function parsePageRanges(text, total) {
  const out = new Set();
  const parts = String(text || '').split(/[,\s]+/).filter(Boolean);
  for (const part of parts) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const a = m[1] ? Number(m[1]) : 1;
      const b = m[2] ? Number(m[2]) : total;
      for (let i = Math.max(1, a); i <= Math.min(total, b); i++) out.add(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n >= 1 && n <= total) out.add(n - 1);
    } else throw new Error(`Bad page range: "${part}"`);
  }
  return [...out].sort((a, b) => a - b);
}

/** Split "1-3,5" into separate range groups (each becomes its own output). */
export function parseRangeGroups(text, total) {
  return String(text || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => parsePageRanges(s, total));
}

export function makeZip() {
  const zip = new JSZip();
  return {
    add: (name, data) => zip.file(name, data),
    folder: (name) => zip.folder(name),
    blob: () => zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }),
    raw: zip,
  };
}

export function canvasToBlob(canvas, type = 'image/png', quality = 0.92) {
  return new Promise((res) => canvas.toBlob((b) => res(b), type, quality));
}
export async function canvasToBytes(canvas, type, quality) {
  return new Uint8Array(await (await canvasToBlob(canvas, type, quality)).arrayBuffer());
}

export function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not decode image'));
    img.src = src;
  });
}

/** Any raster image file (png/jpg/webp/gif/bmp/svg) -> {bytes, type:'png'|'jpg', width, height}. */
export async function normalizeImageFile(file) {
  const bytes = await readFileBytes(file);
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  if (type === 'image/jpeg' || /\.jpe?g$/.test(name)) {
    const img = await loadImage(URL.createObjectURL(file));
    return { bytes, type: 'jpg', width: img.naturalWidth, height: img.naturalHeight };
  }
  if (type === 'image/png' || /\.png$/.test(name)) {
    const img = await loadImage(URL.createObjectURL(file));
    return { bytes, type: 'png', width: img.naturalWidth, height: img.naturalHeight };
  }
  const img = await loadImage(URL.createObjectURL(file));
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width || 800;
  c.height = img.naturalHeight || img.height || 600;
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return { bytes: await canvasToBytes(c, 'image/png'), type: 'png', width: c.width, height: c.height };
}

export const PAGE_SIZES = {
  A4: [595.28, 841.89], A3: [841.89, 1190.55], A5: [419.53, 595.28], Letter: [612, 792], Legal: [612, 1008], Tabloid: [792, 1224],
};

export function hexToRgb(hex) {
  const h = String(hex || '#000000').replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const escapeXml = escapeHtml;

export function uid() { return Math.random().toString(36).slice(2, 10); }

/**
 * pdf.js getDocument() options for CMaps and standard fonts. When the app runs as the
 * single-file build (pdfeditor.html, opened from disk) the assets are embedded and served
 * through reader factories instead of URLs, because file:// pages cannot fetch().
 */
export function pdfjsDocOptions() {
  const A = globalThis.__pdfeditorAssets;
  if (A) return { CMapReaderFactory: A.CMapReaderFactory, StandardFontDataFactory: A.StandardFontDataFactory, useWorkerFetch: false, cMapPacked: true, cMapUrl: 'embedded/', standardFontDataUrl: 'embedded/' };
  return { cMapUrl: 'vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: 'vendor/pdfjs/standard_fonts/' };
}

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
