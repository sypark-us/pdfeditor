// Builds pdfeditor.html: the whole app in one file (scripts, pdf.js worker, CMaps, standard fonts,
// CSS) so it works when opened from disk with a double-click, where browsers block ES modules
// and fetch(). Usage: node build.mjs [out.html]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const out = process.argv[2] || join(root, 'pdfeditor.html');
const read = (p) => readFileSync(join(root, p), 'utf8');
const safe = (js) => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

// ---- app modules -> classic scripts with a tiny module registry ----
const ORDER = ['util', 'crypto', 'pdfraw', 'fonts', 'docmodel', 'docxwriter', 'pdfwriter', 'pdf2doc', 'writers', 'pdftools', 'viewer', 'annot', 'ocr', 'app'];
function transformModule(name, src) {
  const exported = [];
  let s = src;
  s = s.replace(/^import\s+['"][^'"]+['"];\s*$/gm, ''); // side-effect imports (pdf.js)
  s = s.replace(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]\.\/([\w.-]+)['"];/gm, (_, id, file) => `const ${id} = __mod('./${file}');`);
  s = s.replace(/^import\s+\{([^}]+)\}\s+from\s+['"]\.\/([\w.-]+)['"];/gm, (_, names, file) => {
    const list = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => { const m = n.match(/^(\w+)\s+as\s+(\w+)$/); return m ? `${m[1]}: ${m[2]}` : n; });
    return `const { ${list.join(', ')} } = __mod('./${file}');`;
  });
  s = s.replace(/\bimport\(\s*['"]\.\/([\w.-]+)['"]\s*\)/g, (_, file) => `Promise.resolve(__mod('./${file}'))`);
  s = s.replace(/^export\s+(async\s+function|function|class|const|let|var)\s+([$\w]+)/gm, (_, kind, id) => { exported.push(id); return `${kind} ${id}`; });
  s = s.replace(/^export\s+\{([^}]+)\};?/gm, (_, names) => { for (const n of names.split(',')) { const m = n.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/); if (m) exported.push(m[2] ? `${m[2]}: ${m[1]}` : m[1]); } return ''; });
  if (/^\s*export\b/m.test(s)) throw new Error(`Unhandled export syntax in ${name}`);
  if (/^\s*import\b/m.test(s)) throw new Error(`Unhandled import syntax in ${name}`);
  return `__define('./${name}.js', function () {\n${s}\nreturn { ${exported.join(', ')} };\n});\n`;
}
const registry = `const __modules = {}; const __factories = {};
function __define(name, factory) { __factories[name] = factory; }
function __mod(name) { if (!__modules[name]) { if (!__factories[name]) throw new Error('module not bundled: ' + name); __modules[name] = __factories[name](); } return __modules[name]; }
`;
const appBundle = registry + ORDER.map((n) => transformModule(n, read(`js/${n}.js`))).join('\n') + "__mod('./app.js');\n";

// ---- embedded pdf.js assets ----
const b64 = (p) => readFileSync(join(root, p)).toString('base64');
const cmaps = {};
for (const f of readdirSync(join(root, 'vendor/pdfjs/cmaps'))) if (f.endsWith('.bcmap')) cmaps[f.replace(/\.bcmap$/, '')] = b64(`vendor/pdfjs/cmaps/${f}`);
const fonts = {};
for (const f of readdirSync(join(root, 'vendor/pdfjs/standard_fonts'))) if (/\.(pfb|ttf)$/.test(f)) fonts[f] = b64(`vendor/pdfjs/standard_fonts/${f}`);
const assets = `(function () {
const CMAPS = ${JSON.stringify(cmaps)};
const FONTS = ${JSON.stringify(fonts)};
const decode = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
class CMapReaderFactory { constructor() {} async fetch({ name }) { const d = CMAPS[name]; if (!d) throw new Error('Unable to load CMap ' + name); return { cMapData: decode(d), isCompressed: true }; } }
class StandardFontDataFactory { constructor() {} async fetch({ filename }) { const d = FONTS[filename]; if (!d) throw new Error('Unable to load font ' + filename); return decode(d); } }
const workerSrc = document.getElementById('pdfjs-worker-src').textContent;
const workerUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
globalThis.__pdfeditorAssets = { CMapReaderFactory, StandardFontDataFactory, workerUrl };
})();`;

// ---- pdf.js main build as a classic script (it assigns globalThis.pdfjsLib itself) ----
let pdfjsMain = read('vendor/pdfjs/pdf.min.mjs');
const exportIdx = pdfjsMain.lastIndexOf('export{');
if (exportIdx < 0) throw new Error('pdf.min.mjs export statement not found');
pdfjsMain = pdfjsMain.slice(0, exportIdx).replace(/import\.meta\.url/g, 'location.href'); // Node-only code path
let worker = read('vendor/pdfjs/pdf.worker.min.mjs');

// ---- syntax-check every chunk before writing (classic-script semantics) ----
import('node:vm').then(({ Script }) => {
  for (const [name, code] of [['pdf-lib', read('vendor/pdf-lib.min.js')], ['fontkit', read('vendor/fontkit.umd.min.js')], ['jszip', read('vendor/jszip.min.js')], ['pdfjs-main', pdfjsMain], ['assets', assets], ['app-bundle', appBundle]]) {
    try { new Script(safe(code), { filename: `${name}.js` }); } catch (e) { console.error(`Syntax error in chunk ${name}: ${e.message}\n${e.stack.split('\n').slice(0, 4).join('\n')}`); process.exitCode = 1; }
  }
});

// ---- assemble the page ----
let html = read('index.html');
html = html.replace(/<script>\s*\/\/ Browsers block[\s\S]*?<\/script>\s*/, '');
// Replacer functions everywhere: a replacement *string* would expand "$&", "$'" etc. found in minified code.
html = html.replace('<link rel="stylesheet" href="css/style.css">', () => `<style>\n${read('css/style.css')}\n</style>`);
html = html.replace(/<script src="vendor\/[^"]+"><\/script>\s*/g, '');
html = html.replace('<script type="module" src="js/app.js"></script>', () => [
  `<script id="pdfjs-worker-src" type="text/plain">${worker.replace(/<\/script/gi, '<\\/script')}</script>`,
  `<script>${safe(read('vendor/pdf-lib.min.js'))}</script>`,
  `<script>${safe(read('vendor/fontkit.umd.min.js'))}</script>`,
  `<script>${safe(read('vendor/jszip.min.js'))}</script>`,
  `<script>${safe(pdfjsMain)}</script>`,
  `<script>${safe(assets)}</script>`,
  `<script>${safe(appBundle)}</script>`,
].join('\n'));
html = html.replace('<title>', '<!-- Generated by build.mjs from index.html + js/ + css/ + vendor/. Edit the sources, not this file. -->\n<title>');
writeFileSync(out, html);
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MB)`);
