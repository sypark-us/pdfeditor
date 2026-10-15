// Node-side tests for the pure parts of the converters: page ranges, line/paragraph detection,
// the docx writer's package structure, and the PDF layout engine (Latin text only; no DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
globalThis.PDFLib = require(`${root}/vendor/pdf-lib.min.js`);
globalThis.JSZip = require(`${root}/vendor/jszip.min.js`);
const pdfjs = await import(pathToFileURL(`${root}/vendor/pdfjs/pdf.min.mjs`));
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(`${root}/vendor/pdfjs/pdf.worker.min.mjs`).href;
globalThis.pdfjsLib = pdfjs;
const { parsePageRanges, parseRangeGroups } = await import('../js/util.js');
const { groupLines, lineRuns, paragraphsFromLines } = await import('../js/pdf2doc.js');
const { newDoc, para, run, readMarkdown, readText } = await import('../js/docmodel.js');
const { writeDocx } = await import('../js/docxwriter.js');
const { renderDocToPdf } = await import('../js/pdfwriter.js');
const { writeHtml, writePptx } = await import('../js/writers.js');

const textOf = async (bytes) => {
  const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) out.push((await (await pdf.getPage(i)).getTextContent()).items.map((x) => x.str).join(' ').replace(/\s+/g, ' '));
  const n = pdf.numPages; await pdf.destroy();
  return { text: out.join('\n'), pages: n, perPage: out };
};

test('page range parsing', () => {
  assert.deepEqual(parsePageRanges('1-3, 5', 10), [0, 1, 2, 4]);
  assert.deepEqual(parsePageRanges('8-', 10), [7, 8, 9]);
  assert.deepEqual(parsePageRanges('-2', 10), [0, 1]);
  assert.deepEqual(parsePageRanges('3,1,1', 10), [0, 2]);
  assert.deepEqual(parsePageRanges('12', 10), []);
  assert.throws(() => parsePageRanges('abc', 10));
  assert.deepEqual(parseRangeGroups('1-2, 3-', 5), [[0, 1], [2, 3, 4]]);
});

test('line grouping and paragraph detection', () => {
  const span = (str, x, y, size = 12, extra = {}) => ({ str, x, y, size, width: str.length * size * 0.5, height: size, bold: false, italic: false, fontName: 'Arial', family: 'sans', ...extra });
  const spans = [
    span('Big Heading', 72, 100, 24, { bold: true }),
    span('First line of the paragraph that is', 72, 140), span('long enough to wrap around the', 72, 155), span('onto three lines.', 72, 170),
    span('Second paragraph after a gap.', 72, 210),
    span('Centered', 153, 250),
  ];
  const lines = groupLines(spans);
  assert.equal(lines.length, 6);
  assert.equal(lineRuns(lines[0])[0].bold, true);
  const paras = paragraphsFromLines(lines, { left: 72, right: 72 + 'First line of the paragraph that is'.length * 6 });
  assert.equal(paras.length, 4, JSON.stringify(paras.map((p) => p.runs.map((r) => r.text).join(''))));
  assert.equal(paras[0].heading, 1);
  assert.match(paras[1].runs.map((r) => r.text).join(''), /^First line .* three lines\.$/);
  assert.equal(paras[3].align, 'center');
});

test('word spacing inferred from glyph gaps', () => {
  const l = groupLines([{ str: 'Hello', x: 10, y: 10, size: 10, width: 25, height: 10, fontName: 'A', family: 'sans' }, { str: 'World', x: 40, y: 10, size: 10, width: 25, height: 10, fontName: 'A', family: 'sans' }])[0];
  assert.equal(lineRuns(l).map((r) => r.text).join(''), 'Hello World');
});

test('docx writer produces a valid package', async () => {
  const doc = newDoc();
  doc.title = 'T';
  doc.blocks.push(para([run('Hello <world> & "friends"', { bold: true })], { heading: 1 }));
  doc.blocks.push(para([run('bullet')], { list: { kind: 'bullet', level: 0, text: '•' } }));
  doc.blocks.push({ type: 'table', colWidths: [100, 100], borders: true, rows: [{ cells: [{ blocks: [para([run('a')])], colSpan: 2 }] }] });
  const bytes = await writeDocx(doc);
  const zip = await JSZip.loadAsync(bytes);
  for (const f of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) assert.ok(zip.file(f), f);
  const xml = await zip.file('word/document.xml').async('string');
  assert.ok(xml.includes('Hello &lt;world&gt; &amp; &quot;friends&quot;'));
  assert.ok(xml.includes('<w:pStyle w:val="Heading1"/>'));
  assert.ok(xml.includes('<w:numPr>'));
  assert.ok(xml.includes('<w:gridSpan w:val="2"/>'));
  assert.ok(xml.includes('<w:sectPr>'));
  // every opened tag closes (cheap well-formedness check)
  const opens = (xml.match(/<w:p>/g) || []).length, closes = (xml.match(/<\/w:p>/g) || []).length;
  assert.equal(opens, closes);
});

test('layout engine: wrapping, pages, alignment, tables, lists, fields', async () => {
  const doc = newDoc();
  doc.blocks.push(para([run('Title', { size: 24, bold: true })], { align: 'center' }));
  doc.blocks.push(para([run('word '.repeat(1500))], { align: 'justify' }));
  doc.blocks.push(para([run('item one')], { list: { kind: 'number', level: 0, text: '1.' }, indent: 18, hanging: 14 }));
  doc.blocks.push({ type: 'table', colWidths: [100, 300], borders: true, rows: [{ cells: [{ blocks: [para([run('left cell')])] }, { blocks: [para([run('right cell '.repeat(30))])] }] }] });
  doc.blocks.push({ type: 'pageBreak' });
  doc.blocks.push(para([run('After break')]));
  doc.footer = [para([{ text: '', field: 'PAGE', size: 9 }], { align: 'right' })];
  const bytes = await renderDocToPdf(doc);
  const r = await textOf(bytes);
  assert.ok(r.pages >= 3, `pages ${r.pages}`);
  assert.ok(r.perPage[0].includes('Title'));
  assert.ok(r.perPage[0].includes('word'));
  assert.ok(r.text.includes('right cell'));
  assert.ok(r.text.includes('1.'));
  assert.ok(r.perPage[r.pages - 1].includes('After break'));
  assert.ok(r.perPage[1].includes('2'));
  const doc2 = await PDFLib.PDFDocument.load(bytes);
  assert.equal(Math.round(doc2.getPage(0).getWidth()), 595);
});

test('markdown and text readers', async () => {
  const md = readMarkdown('# H\n\ntext **b**\n\n- x\n- y\n');
  assert.equal(md.blocks.length, 4);
  assert.equal(md.blocks[1].runs[1].bold, true);
  const t = readText('a\nb');
  assert.equal(t.blocks.length, 2);
  const html = writeHtml(md);
  assert.ok(html.includes('<h1') && html.includes('<b>') === false && html.includes('font-weight:bold'));
});

test('pptx writer package structure', async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 255, 255, 63, 0, 5, 254, 2, 254, 167, 53, 129, 132, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
  const bytes = await writePptx([{ bytes: png, imgType: 'png', width: 960, height: 540 }, { bytes: png, imgType: 'png', width: 960, height: 540 }]);
  const zip = await JSZip.loadAsync(bytes);
  for (const f of ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/_rels/slide1.xml.rels', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml', 'ppt/media/image2.png']) assert.ok(zip.file(f), f);
  const pres = await zip.file('ppt/presentation.xml').async('string');
  assert.ok(pres.includes('<p:sldId id="256" r:id="rId2"/>') && pres.includes('<p:sldId id="257" r:id="rId3"/>'));
});
