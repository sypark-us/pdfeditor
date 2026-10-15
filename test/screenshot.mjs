// Takes screenshots of the app in headless Chrome: empty state, a loaded PDF with annotations,
// and the merge tool panel. Usage: node test/screenshot.mjs [outDir]
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const outDir = process.argv[2] || 'screenshots';
mkdirSync(outDir, { recursive: true });
const PORT = 8139, CDP = 9339;
const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) { console.error('No Chrome found'); process.exit(2); }
const server = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url)), String(PORT)], { stdio: 'ignore' });
await delay(500);
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1400,900', `--remote-debugging-port=${CDP}`, `--user-data-dir=${process.env.TEMP || '/tmp'}/pdfe-shot-profile`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { browser.kill(); } catch { /* */ } try { server.kill(); } catch { /* */ } };
process.on('exit', cleanup);
let targets = null;
for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); } catch { await delay(200); } }
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('eval error', JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64')); console.log('saved', join(outDir, name)); };
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: `http://localhost:${PORT}/` });
await delay(1500);
await shot('01-empty.png');
await evaluate(`(async () => {
  const E = pdfEditor, L = PDFLib;
  const doc = await L.PDFDocument.create();
  const font = await doc.embedFont(L.StandardFonts.Helvetica), bold = await doc.embedFont(L.StandardFonts.HelveticaBold);
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText('Quarterly Report ' + (i + 1), { x: 60, y: 760, size: 24, font: bold });
    const lines = ['Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor', 'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis', 'nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.', 'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore.'];
    lines.forEach((l, k) => p.drawText(l, { x: 60, y: 700 - k * 18, size: 12, font }));
    p.drawRectangle({ x: 60, y: 400, width: 300, height: 180, color: L.rgb(0.85, 0.9, 1), borderColor: L.rgb(0.3, 0.5, 0.9), borderWidth: 1 });
  }
  await E.openBytes(await doc.save(), 'quarterly-report.pdf');
  for (let i = 0; i < 40 && !(E.viewer.pages[0] && E.viewer.pages[0].rendered); i++) await E.sleep(100);
  const A = E.annotator;
  A.list(0).push({ id: 's1', type: 'text', page: 0, x: 380, y: 760, text: 'Reviewed ✔', size: 16, color: '#d32f2f', family: 'sans', bold: true, opacity: 1 });
  A.list(0).push({ id: 's2', type: 'highlight', page: 0, x: 58, y: 690, w: 420, h: 18, color: '#ffeb3b' });
  A.list(0).push({ id: 's3', type: 'ellipse', page: 0, x: 40, y: 380, w: 340, h: 220, color: '#1976d2', fill: '', strokeWidth: 2, opacity: 1 });
  A.list(0).push({ id: 's4', type: 'arrow', page: 0, x1: 420, y1: 300, x2: 370, y2: 420, color: '#333', strokeWidth: 2, opacity: 1 });
  A.list(0).push({ id: 's5', type: 'pen', page: 0, points: Array.from({ length: 40 }, (_, k) => ({ x: 60 + k * 8, y: 250 + Math.sin(k / 3) * 20 })), color: '#2e7d32', strokeWidth: 3, opacity: 1 });
  A.list(0).push({ id: 's6', type: 'note', page: 0, x: 500, y: 600, text: 'Check the numbers', color: '#ffd54f' });
  A.redraw(0); A.select(A.list(0)[2]); A.onChange();
  E.setAnnotTool('select');
  await E.openTool('watermark');
})()`);
await delay(1500);
await shot('02-editor.png');
await evaluate(`(async () => { document.querySelector('[data-tab=pages]').click(); await pdfEditor.openTool('pdf2word'); })()`);
await delay(800);
await shot('03-pages-convert.png');
ws.close(); cleanup(); process.exit(0);
