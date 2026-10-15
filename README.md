# PDF Editor

A free PDF editor and converter that runs entirely in the browser. No server, no build step,
no uploads: open `index.html` (or serve the folder) and work on your files locally.

```
node test/serve.mjs 8080      # then open http://localhost:8080/
# or any static server: npx serve . / python -m http.server 8080
```

Tests (Node 20+; the browser test needs Chrome or Edge installed):

```
npm run test:unit    # node --test: crypto, raw PDF rewriter, converters, layout engine
npm run test:smoke   # drives the real app in headless Chrome through every tool
npm test             # both
```

## Features

### View
- Continuous scroll viewer (pdf.js) with lazy rendering, selectable text layer, thumbnails,
  zoom (fit width / fit page / 20–600 %), page navigation, full-text search with highlights, print.
- Opens password-protected PDFs: asks for the password, then works on an unlocked copy.
  Owner-restricted files (no open password) are unlocked automatically.
- Drag & drop PDFs, Word, Excel, PowerPoint, image, HTML, text or Markdown files anywhere.

### Edit & annotate
- Text boxes (any size/colour/font; double-click to edit), freehand pen, freehand highlighter,
  area highlight, rectangles, ellipses, lines, arrows, images, sticky-note comments.
- Whiteout to cover content and retype over it.
- **Redaction** that really removes content: redacted pages are rasterised when applied.
- Select, move, resize with handles, nudge with arrow keys, delete, undo/redo. Everything is burned
  into the PDF with pdf-lib when you press *Apply changes*; the annotation list shows what is pending.
- **Sign**: draw on a pad, type with a script font, or upload a picture (white background removed).
- Crop with a drag box or by trimming margins; resize pages to A4/Letter/…; N-up (2, 4, 6, 9, 16 per sheet).
- Watermarks (text or image, tiled or positioned, opacity, angle), page numbers (any format and
  position), headers & footers with `{n}`, `{N}`, `{date}`, `{title}` tokens.
- Form filling (text, check boxes, radio, dropdown, list) and flattening; document properties
  (title, author, subject, keywords) and metadata stripping; remove annotations.

### Organize
- Merge, split (custom ranges, every N pages, one file per page), extract, delete, rotate, insert blank
  pages or another PDF, duplicate, reverse, reorder by dragging thumbnails (multi-select with Shift/Ctrl).

### Convert from PDF
- **PDF → Word (.docx)**: rebuilds paragraphs, headings, bold/italic, sizes, fonts, alignment, indents,
  line spacing and page breaks from the PDF text layout, and places embedded images. An image mode keeps
  the exact look (one picture per page).
- PDF → Text, PDF → HTML, PDF → PNG/JPG/WebP (DPI, quality, grayscale, transparent), PDF → PowerPoint
  (one slide per page), extract embedded images.

### Convert to PDF
- Word (.docx): paragraph and character styles, headings, numbered/bulleted lists, tables with spans
  and shading, inline and anchored images, hyperlinks, page size/margins, headers/footers with PAGE /
  NUMPAGES fields, page breaks.
- Excel (.xlsx): one table per sheet. PowerPoint (.pptx): text boxes, tables and pictures at their
  positions. HTML, plain text and Markdown (headings, lists, code blocks, tables, quotes).
- Images → PDF with page size, orientation, margin and fit options.

### Secure & optimise
- **Protect**: RC4-128, AES-128 or AES-256 encryption with user/owner passwords and permission flags.
- **Unlock**: removes encryption given the user or owner password (RC4, AESV2, AESV3; R2–R6).
- Compress: recompresses and downsamples embedded images (three levels, optional grayscale) or
  rasterises pages for extreme reduction. Repair rewrites damaged files. Grayscale conversion.
- **OCR** with tesseract.js (downloaded on first use): adds an invisible, searchable text layer in
  17 languages. Compare two PDFs visually, page by page.

### Fonts for Korean, Japanese, Chinese and other scripts
The 14 standard PDF fonts only cover Latin text. For other scripts the app embeds a font you add in
*Fonts* (a .ttf/.otf file, or an installed font via the Local Font Access API in Chrome/Edge). Without
one, non-Latin text is still rendered correctly by rasterising it with the browser's fonts, so nothing
fails, it just is not selectable.

## Layout

```
index.html          app shell
css/style.css
js/app.js           UI: tool registry, panels, dialogs, pages tab, keyboard shortcuts
js/viewer.js        pdf.js viewer: pages, text layer, thumbnails, search
js/annot.js         annotation editor (SVG overlay) + burning into the PDF, redaction rasterising
js/pdftools.js      page operations, stamps, crop/resize/n-up, forms, metadata, images, compression, compare
js/pdfraw.js        byte-level PDF parser/serialiser used to add/remove encryption
js/crypto.js        MD5, RC4, AES (WebCrypto) and the PDF standard security handler
js/fonts.js         standard / embedded / rasterised text drawing
js/docmodel.js      document model + readers for DOCX, XLSX, PPTX, HTML, Markdown, text
js/docxwriter.js    model -> .docx
js/pdfwriter.js     model -> PDF (flow layout engine: wrapping, justify, lists, tables, headers/footers)
js/pdf2doc.js       PDF -> model (line/paragraph detection, images)
js/writers.js       model -> HTML / text, page images -> .pptx
js/ocr.js           tesseract.js integration
vendor/             pdf-lib 1.17.1 (MIT), @pdf-lib/fontkit 1.1.1 (MIT), pdf.js 4.10.38 (Apache-2.0), JSZip 3.10.1 (MIT)
test/               node --test unit tests, headless-Chrome smoke test, screenshot script
```

## Limitations
- Existing PDF text cannot be edited in place (no free browser tool does this reliably); use whiteout + text.
- PDF → Word works on the text layer. Scanned PDFs need OCR first; multi-column layouts are read top to bottom.
- OCR language data comes from a CDN, so OCR is the only feature that needs internet access.
- Digital (certificate) signatures are not created; the Sign tool places a visual signature.

## License
MIT for this project's own code. Bundled libraries keep their own licenses (see `vendor/`).
