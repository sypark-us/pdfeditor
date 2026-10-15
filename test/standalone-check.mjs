// Builds pdfeditor.html and opens it from disk (file://) in headless Chrome, exactly like a
// double-click, then verifies the app boots, renders a PDF (worker + text layer), reads a
// CMap-encoded font and converts to Word. Usage: node test/standalone-check.mjs
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
execFileSync(process.execPath, [`${root}build.mjs`], { stdio: 'inherit' });
const CDP = 9341;
const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) { console.error('No Chrome found'); process.exit(2); }
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', `--remote-debugging-port=${CDP}`, `--user-data-dir=${process.env.TEMP || '/tmp'}/pdfe-standalone-profile`, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { browser.kill(); } catch { /* */ } });
let targets = null;
for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); } catch { await delay(200); } }
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' ')); else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); };
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return r.result?.exceptionDetails ? { error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text } : r.result?.result?.value; };
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: pathToFileURL(`${root}pdfeditor.html`).href });
await delay(2500);
const result = await evaluate(`(async () => {
  const out = {};
  out.protocol = location.protocol;
  out.booted = !!window.pdfEditor;
  if (!out.booted) return out;
  const E = pdfEditor, L = PDFLib;
  const doc = await L.PDFDocument.create();
  const font = await doc.embedFont(L.StandardFonts.TimesRoman);
  const p = doc.addPage([400, 300]);
  p.drawText('Standalone build works', { x: 30, y: 200, size: 18, font });
  await E.openBytes(await doc.save(), 'standalone.pdf');
  for (let i = 0; i < 60 && !(E.viewer.pages[0] && E.viewer.pages[0].rendered); i++) await E.sleep(100);
  out.rendered = !!E.viewer.pages[0].rendered;
  out.spans = E.viewer.pages[0].textLayer.querySelectorAll('span').length;
  out.search = (await E.viewer.search('build works')).length;
  // CMap-dependent PDF: a Type0 font with a predefined CMap, no embedded font program.
  const raw = '%PDF-1.4\\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\\n4 0 obj<</Type/Font/Subtype/Type0/BaseFont/HYSMyeongJo-Medium/Encoding/UniKS-UCS2-H/DescendantFonts[6 0 R]>>endobj\\n5 0 obj<</Length 44>>stream\\nBT /F1 24 Tf 30 100 Td <D55CAE00C5B4> Tj ET\\nendstream\\nendobj\\n6 0 obj<</Type/Font/Subtype/CIDFontType0/BaseFont/HYSMyeongJo-Medium/CIDSystemInfo<</Registry(Adobe)/Ordering(Korea1)/Supplement 1>>/FontDescriptor 7 0 R/DW 1000>>endobj\\n7 0 obj<</Type/FontDescriptor/FontName/HYSMyeongJo-Medium/Flags 4/FontBBox[0 -100 1000 900]/ItalicAngle 0/Ascent 900/Descent -100/CapHeight 700/StemV 80>>endobj\\ntrailer<</Root 1 0 R>>';
  const bytes = new TextEncoder().encode(raw);
  const pdf = await pdfjsLib.getDocument({ data: bytes, ...E.modules.pdfjsDocOptions() }).promise;
  const tc = await (await pdf.getPage(1)).getTextContent();
  out.cjkText = tc.items.map((i) => i.str).join('');
  await pdf.destroy();
  const docx = await (async () => { const pj = await pdfjsLib.getDocument({ data: (await E.T.saveDoc(await E.T.loadDoc(E.state.bytes))).slice(), ...E.modules.pdfjsDocOptions() }).promise; const m = await E.modules.pdfToDoc(pj); await pj.destroy(); return E.modules.writeDocx(m); })();
  out.docxBytes = docx.length;
  return out;
})()`);
console.log(JSON.stringify(result));
const errors = logs.filter((l) => /EXC|Error|error/.test(l) && !/Warning/.test(l));
if (errors.length) console.log('console errors:', errors.slice(0, 5).join('\n'));
const ok = result && result.booted && result.rendered && result.spans > 0 && result.search === 1 && result.cjkText === '한글어' && result.docxBytes > 1000;
console.log(ok ? 'STANDALONE CHECK PASSED' : 'STANDALONE CHECK FAILED');
ws.close(); browser.kill();
process.exit(ok ? 0 : 1);
