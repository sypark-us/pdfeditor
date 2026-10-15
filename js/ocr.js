// OCR via tesseract.js (loaded on demand from a CDN; needs network the first time).
// Produces a searchable PDF by adding an invisible text layer (text render mode 3) over each page.
import { FontManager, canWinAnsi } from './fonts.js';
import { loadDoc, saveDoc, visualGeom, renderPages } from './pdftools.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
export const OCR_LANGS = { eng: 'English', kor: 'Korean', jpn: 'Japanese', chi_sim: 'Chinese (simplified)', chi_tra: 'Chinese (traditional)', deu: 'German', fra: 'French', spa: 'Spanish', ita: 'Italian', por: 'Portuguese', rus: 'Russian', nld: 'Dutch', vie: 'Vietnamese', ara: 'Arabic', hin: 'Hindi', tur: 'Turkish', pol: 'Polish' };

export async function loadTesseract() {
  if (globalThis.Tesseract) return globalThis.Tesseract;
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = TESSERACT_URL; s.onload = res; s.onerror = () => rej(new Error('Could not load tesseract.js (no network?)')); document.head.append(s); });
  return globalThis.Tesseract;
}

/**
 * OCR every page (or the given pages). opts: { lang:'eng', dpi:200, pages, onProgress(frac, msg) }
 * Returns { bytes, text, skippedWords } where text is the recognised plain text per page.
 */
export async function ocrPdf(bytes, opts = {}) {
  const T = await loadTesseract();
  const lang = opts.lang || 'eng';
  const dpi = opts.dpi || 200;
  const progress = opts.onProgress || (() => {});
  progress(0, 'Loading OCR language data…');
  const worker = await T.createWorker(lang, 1, { logger: (m) => { if (m.status === 'recognizing text') progress(null, `Recognising… ${Math.round((m.progress || 0) * 100)}%`); } });
  const results = new Map();
  let n = 0;
  const pages = opts.pages;
  try {
    await renderPages(bytes, { dpi, pages }, async (canvas, i) => {
      progress(null, `OCR page ${i + 1}`);
      const { data } = await worker.recognize(canvas);
      results.set(i, { words: (data.words || []).filter((w) => w.text && w.text.trim() && w.confidence > 25), text: data.text || '' });
      n++;
      progress(n / (pages ? pages.length : results.size + 1), null);
    });
  } finally { await worker.terminate(); }
  const { pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextRenderingMode, TextRenderingMode, showText, rotateAndSkewTextRadiansAndTranslate, radians } = globalThis.PDFLib;
  const doc = await loadDoc(bytes);
  const fm = new FontManager(doc);
  let skippedWords = 0;
  const texts = [];
  for (const [i, r] of results) {
    const page = doc.getPage(i);
    const g = visualGeom(page);
    const k = 72 / dpi;
    const fontKeys = new Map();
    const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
    for (const w of r.words) {
      const text = w.text.trim();
      const { x0, y0, x1, y1 } = w.bbox;
      const boxW = (x1 - x0) * k, boxH = (y1 - y0) * k;
      if (boxW <= 0 || boxH <= 0) continue;
      let font;
      if (canWinAnsi(text)) font = await fm.stdFont('sans', false, false);
      else font = await fm.embeddedFor(text);
      if (!font) { skippedWords++; continue; }
      let size;
      try { size = boxW / Math.max(0.1, font.widthOfTextAtSize(text, 1)); } catch { skippedWords++; continue; }
      size = Math.min(size, boxH * 1.4);
      if (!fontKeys.has(font)) fontKeys.set(font, page.node.newFontDictionary('OCR', font.ref));
      const vx = x0 * k, vy = g.vh - y1 * k + boxH * 0.2;
      const [ux, uy] = g.toUser(vx, vy);
      let encoded;
      try { encoded = font.encodeText(text); } catch { skippedWords++; continue; }
      ops.push(setFontAndSize(fontKeys.get(font), size), rotateAndSkewTextRadiansAndTranslate(radians(g.rot), 0, ux, uy), showText(encoded));
    }
    ops.push(endText(), popGraphicsState());
    page.pushOperators(...ops);
    texts.push(r.text);
  }
  return { bytes: await saveDoc(doc), text: texts.join('\n\f\n'), skippedWords };
}
