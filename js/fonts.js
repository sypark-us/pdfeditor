// Font management for everything we draw into a PDF with pdf-lib.
// Three tiers: pdf-lib standard fonts (WinAnsi text), embedded TTF/OTF fonts supplied by the
// user or the Local Font Access API (any script), and a canvas raster fallback that draws the
// text with the browser's own fonts and embeds it as an image, so e.g. Korean text never fails.

const { StandardFonts, rgb } = globalThis.PDFLib || {};

export const customFonts = []; // { name, bytes }
const listeners = new Set();
export function onFontsChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function addCustomFont(name, bytes) {
  const existing = customFonts.findIndex((f) => f.name === name);
  if (existing >= 0) customFonts.splice(existing, 1);
  customFonts.unshift({ name, bytes });
  for (const fn of listeners) fn();
}
export function removeCustomFont(name) {
  const i = customFonts.findIndex((f) => f.name === name);
  if (i >= 0) customFonts.splice(i, 1);
  for (const fn of listeners) fn();
}

/** Pick fonts installed on this machine (Chrome/Edge only, needs a user gesture). */
export async function listLocalFonts() {
  if (!('queryLocalFonts' in window)) throw new Error('Local Font Access API is not available in this browser. Upload a .ttf/.otf file instead.');
  const fonts = await window.queryLocalFonts();
  const families = new Map();
  for (const f of fonts) {
    if (!families.has(f.family)) families.set(f.family, []);
    families.get(f.family).push(f);
  }
  return families;
}
export async function loadLocalFont(fontData) {
  const blob = await fontData.blob();
  return new Uint8Array(await blob.arrayBuffer());
}

const WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split('').map((c) => c.codePointAt(0)));
export function canWinAnsi(text) {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x20 && cp <= 0x7e) continue;
    if (cp >= 0xa0 && cp <= 0xff) continue;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) continue;
    if (WINANSI_EXTRA.has(cp)) continue;
    return false;
  }
  return true;
}
/** Replace characters a standard font can't encode with '?'. */
export function toWinAnsi(text) {
  let out = '';
  for (const ch of text) out += canWinAnsi(ch) ? ch : '?';
  return out;
}

export const FAMILIES = {
  sans: { std: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'], css: "Helvetica, Arial, 'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans CJK KR', 'Noto Sans', sans-serif" },
  serif: { std: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'], css: "'Times New Roman', Times, Batang, 'Noto Serif CJK KR', serif" },
  mono: { std: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'], css: "'Courier New', Courier, Consolas, 'D2Coding', monospace" },
  cursive: { std: ['TimesRomanItalic', 'TimesRomanBoldItalic', 'TimesRomanItalic', 'TimesRomanBoldItalic'], css: "'Brush Script MT', 'Segoe Script', 'Lucida Handwriting', cursive" },
};
export function familyOf(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return 'sans';
  if (/courier|mono|consolas|menlo|d2coding/.test(n)) return 'mono';
  if (/times|georgia|garamond|serif|book|cambria|batang|myeongjo|minion|palatino|century/.test(n) && !/sans/.test(n)) return 'serif';
  if (/script|hand|brush|cursive/.test(n)) return 'cursive';
  return 'sans';
}

export class FontManager {
  constructor(pdfDoc) {
    this.doc = pdfDoc;
    this.std = new Map();
    this.embedded = new Map(); // name -> PDFFont | null
    this.rasterCache = new Map();
    if (customFonts.length && globalThis.fontkit && !pdfDoc.__fontkit) { pdfDoc.registerFontkit(globalThis.fontkit); pdfDoc.__fontkit = true; }
  }

  async stdFont(family, bold, italic) {
    const fam = FAMILIES[family] || FAMILIES.sans;
    const key = fam.std[(bold ? 1 : 0) + (italic ? 2 : 0)];
    if (!this.std.has(key)) this.std.set(key, await this.doc.embedFont(StandardFonts[key]));
    return this.std.get(key);
  }

  async embeddedFor(text, preferred) {
    const order = preferred ? [...customFonts.filter((f) => f.name === preferred), ...customFonts.filter((f) => f.name !== preferred)] : customFonts;
    for (const cf of order) {
      if (!this.embedded.has(cf.name)) {
        try {
          if (!this.doc.__fontkit) { this.doc.registerFontkit(globalThis.fontkit); this.doc.__fontkit = true; }
          this.embedded.set(cf.name, await this.doc.embedFont(cf.bytes, { subset: true }));
        } catch (e) { console.warn('font embed failed', cf.name, e); this.embedded.set(cf.name, null); }
      }
      const f = this.embedded.get(cf.name);
      if (f && covers(f, text)) return f;
    }
    return null;
  }

  /**
   * Resolve a drawable font for `text`. style: { family:'sans'|'serif'|'mono'|'cursive'|fontName, bold, italic, fontName }
   * Returns { kind, widthOf(text,size), heightAt(size), draw(page, text, x, y, size, {color, opacity, rotate}) }
   */
  async resolve(text, style = {}) {
    const family = FAMILIES[style.family] ? style.family : familyOf(style.family || style.fontName);
    const bold = !!style.bold, italic = !!style.italic;
    if (canWinAnsi(text) && !style.fontName) return this.wrap('std', await this.stdFont(family, bold, italic), style);
    const emb = await this.embeddedFor(text, style.fontName);
    if (emb) return this.wrap('embed', emb, style);
    if (canWinAnsi(text)) return this.wrap('std', await this.stdFont(family, bold, italic), style);
    if (typeof document !== 'undefined') return this.raster(family, bold, italic, style);
    return this.wrap('std', await this.stdFont(family, bold, italic), { ...style, lossy: true });
  }

  wrap(kind, font, style) {
    const lossy = kind === 'std';
    return {
      kind, font,
      widthOf: (text, size) => { try { return font.widthOfTextAtSize(lossy ? toWinAnsi(text) : text, size); } catch { return text.length * size * 0.5; } },
      heightAt: (size) => font.heightAtSize(size),
      ascentAt: (size) => { try { return font.heightAtSize(size, { descender: false }); } catch { return size * 0.8; } },
      draw: (page, text, x, y, size, opts = {}) => {
        const t = lossy ? toWinAnsi(text) : text;
        try { page.drawText(t, { x, y, size, font, color: opts.color || rgb(0, 0, 0), opacity: opts.opacity, rotate: opts.rotate, ...(opts.extra || {}) }); }
        catch (e) { console.warn('drawText failed', e); }
      },
    };
  }

  raster(family, bold, italic, style) {
    const css = (FAMILIES[family] || FAMILIES.sans).css;
    const fontStr = (size) => `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${css}`;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const self = this;
    return {
      kind: 'raster', font: null,
      widthOf: (text, size) => { ctx.font = fontStr(size); return ctx.measureText(text).width; },
      heightAt: (size) => size * 1.2,
      ascentAt: (size) => size * 0.88,
      draw: async (page, text, x, y, size, opts = {}) => {
        const color = opts.color ? [opts.color.red, opts.color.green, opts.color.blue] : [0, 0, 0];
        const hex = '#' + color.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
        const key = `${text}|${fontStr(size)}|${hex}`;
        let img = self.rasterCache.get(key);
        const S = 4;
        ctx.font = fontStr(size);
        const m = ctx.measureText(text);
        const w = Math.max(1, Math.ceil(m.width)), asc = Math.ceil(m.actualBoundingBoxAscent || size * 0.9), desc = Math.ceil(m.actualBoundingBoxDescent || size * 0.25);
        if (!img) {
          canvas.width = Math.ceil((w + 2) * S); canvas.height = Math.ceil((asc + desc + 2) * S);
          const c2 = canvas.getContext('2d');
          c2.scale(S, S);
          c2.font = fontStr(size);
          c2.fillStyle = hex;
          c2.textBaseline = 'alphabetic';
          c2.fillText(text, 1, asc + 1);
          const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
          img = await self.doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
          self.rasterCache.set(key, img);
        }
        const dw = w + 2, dh = asc + desc + 2;
        page.drawImage(img, { x: x - 1, y: y - desc - 1, width: dw, height: dh, opacity: opts.opacity, rotate: opts.rotate });
      },
    };
  }
}

function covers(pdfFont, text) {
  const fk = pdfFont.embedder && pdfFont.embedder.font;
  if (!fk || !fk.hasGlyphForCodePoint) return true;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20) continue;
    if (!fk.hasGlyphForCodePoint(cp)) return false;
  }
  return true;
}
