// Low-level PDF object parser / serializer used to add or remove encryption at the byte level.
// It scans the whole file linearly ("N G obj" ... "endobj"), keeps the last definition of every
// object, and rewrites a clean file with a fresh cross-reference table. pdf-lib then loads that.
import { createEncryption, openEncryption, concat, md5, randomBytes } from './crypto.js';

const latin1 = new TextDecoder('latin1');
const enc = new TextEncoder();

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isWs = (b) => WS.has(b);
const isRegular = (b) => b !== undefined && !WS.has(b) && !DELIM.has(b);

export const Name = (v) => ({ t: 'name', v });
export const Str = (bytes) => ({ t: 'str', bytes });
export const Ref = (num, gen = 0) => ({ t: 'ref', num, gen });
export const Dict = (entries = {}) => ({ t: 'dict', map: new Map(Object.entries(entries)) });
export const isName = (v, name) => v && v.t === 'name' && (name === undefined || v.v === name);

class Lexer {
  constructor(bytes, pos = 0) { this.b = bytes; this.p = pos; }
  skipWs() {
    for (; ;) {
      while (this.p < this.b.length && isWs(this.b[this.p])) this.p++;
      if (this.b[this.p] === 0x25) { while (this.p < this.b.length && this.b[this.p] !== 0x0a && this.b[this.p] !== 0x0d) this.p++; }
      else return;
    }
  }
  token() {
    this.skipWs();
    const start = this.p;
    while (this.p < this.b.length && isRegular(this.b[this.p])) this.p++;
    return latin1.decode(this.b.subarray(start, this.p));
  }
  peekBytes(n) { return latin1.decode(this.b.subarray(this.p, this.p + n)); }
  startsWith(s) { this.skipWs(); return this.peekBytes(s.length) === s; }

  parse() {
    this.skipWs();
    const b = this.b[this.p];
    if (b === undefined) throw new Error('Unexpected end of PDF data');
    if (b === 0x3c) { // <
      if (this.b[this.p + 1] === 0x3c) return this.parseDict();
      return this.parseHexString();
    }
    if (b === 0x28) return this.parseLiteralString();
    if (b === 0x5b) return this.parseArray();
    if (b === 0x2f) return this.parseName();
    if (b === 0x5d || b === 0x3e || b === 0x29 || b === 0x7d || b === 0x7b) { this.p++; return this.parse(); }
    const tok = this.token();
    if (tok === '') { this.p++; return null; }
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      if (/^\d+$/.test(tok)) {
        const save = this.p;
        const t2 = this.token();
        if (/^\d+$/.test(t2)) {
          const save2 = this.p;
          const t3 = this.token();
          if (t3 === 'R') return Ref(Number(tok), Number(t2));
          this.p = save2;
        }
        this.p = save;
      }
      return Number(tok);
    }
    return { t: 'kw', v: tok };
  }
  parseName() {
    this.p++; // '/'
    const start = this.p;
    while (this.p < this.b.length && isRegular(this.b[this.p])) this.p++;
    const raw = latin1.decode(this.b.subarray(start, this.p));
    return Name(raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
  }
  parseArray() {
    this.p++;
    const arr = [];
    for (; ;) {
      this.skipWs();
      if (this.p >= this.b.length) break;
      if (this.b[this.p] === 0x5d) { this.p++; break; }
      const v = this.parse();
      if (v && v.t === 'kw') { if (v.v === 'endobj' || v.v === 'stream') break; continue; }
      arr.push(v);
    }
    return arr;
  }
  parseDict() {
    this.p += 2;
    const map = new Map();
    for (; ;) {
      this.skipWs();
      if (this.p >= this.b.length) break;
      if (this.b[this.p] === 0x3e && this.b[this.p + 1] === 0x3e) { this.p += 2; break; }
      if (this.b[this.p] !== 0x2f) { const junk = this.parse(); if (junk && junk.t === 'kw' && (junk.v === 'endobj' || junk.v === 'stream')) { this.p -= junk.v.length; break; } continue; }
      const key = this.parseName().v;
      const val = this.parse();
      if (val && val.t === 'kw') { if (val.v === 'endobj' || val.v === 'stream') { this.p -= val.v.length; break; } continue; }
      map.set(key, val);
    }
    return { t: 'dict', map };
  }
  parseHexString() {
    this.p++;
    const out = [];
    let digit = null;
    while (this.p < this.b.length) {
      const c = this.b[this.p++];
      if (c === 0x3e) break;
      let v;
      if (c >= 0x30 && c <= 0x39) v = c - 0x30;
      else if (c >= 0x41 && c <= 0x46) v = c - 0x37;
      else if (c >= 0x61 && c <= 0x66) v = c - 0x57;
      else continue;
      if (digit === null) digit = v; else { out.push(digit * 16 + v); digit = null; }
    }
    if (digit !== null) out.push(digit * 16);
    return Str(new Uint8Array(out));
  }
  parseLiteralString() {
    this.p++;
    const out = [];
    let depth = 1;
    while (this.p < this.b.length) {
      let c = this.b[this.p++];
      if (c === 0x5c) { // backslash
        c = this.b[this.p++];
        switch (c) {
          case 0x6e: out.push(10); break; case 0x72: out.push(13); break; case 0x74: out.push(9); break;
          case 0x62: out.push(8); break; case 0x66: out.push(12); break;
          case 0x0d: if (this.b[this.p] === 0x0a) this.p++; break;
          case 0x0a: break;
          default:
            if (c >= 0x30 && c <= 0x37) {
              let v = c - 0x30;
              for (let i = 0; i < 2 && this.b[this.p] >= 0x30 && this.b[this.p] <= 0x37; i++) v = v * 8 + (this.b[this.p++] - 0x30);
              out.push(v & 255);
            } else out.push(c);
        }
      } else if (c === 0x28) { depth++; out.push(c); }
      else if (c === 0x29) { depth--; if (depth === 0) break; out.push(c); }
      else out.push(c);
    }
    return Str(new Uint8Array(out));
  }
}

function findEndstream(bytes, from) {
  const pat = enc.encode('endstream');
  outer: for (let i = from; i <= bytes.length - pat.length; i++) {
    for (let j = 0; j < pat.length; j++) if (bytes[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}

/** Parse a PDF file into { version, objects: Map<num,{num,gen,value,stream}>, trailer: Map, xrefStreams:Set<num> }. */
export function parsePdf(bytes) {
  const text = latin1.decode(bytes);
  const version = (text.slice(0, 1024).match(/%PDF-(\d\.\d)/) || [, '1.7'])[1];
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  const heads = [];
  let m;
  while ((m = re.exec(text))) {
    // Must not be preceded by a regular character (e.g. "123 0 obj" inside a bigger token)
    const prev = m.index > 0 ? text.charCodeAt(m.index - 1) : 0x20;
    if (isRegular(prev)) continue;
    heads.push({ num: Number(m[1]), gen: Number(m[2]), start: m.index, bodyStart: m.index + m[0].length });
  }
  const byNum = new Map();
  for (const h of heads) byNum.set(h.num, h); // last definition wins for Length lookups
  const objects = new Map();
  const xrefStreams = new Set();
  let cursor = 0;
  const lengthOf = (val) => {
    if (typeof val === 'number') return val;
    if (val && val.t === 'ref') {
      const h = byNum.get(val.num);
      if (!h) return null;
      try { const v = new Lexer(bytes, h.bodyStart).parse(); return typeof v === 'number' ? v : null; } catch { return null; }
    }
    return null;
  };
  for (const h of heads) {
    if (h.start < cursor) continue; // inside a previous object's stream data
    const lx = new Lexer(bytes, h.bodyStart);
    let value;
    try { value = lx.parse(); } catch { continue; }
    if (value && value.t === 'kw') value = null;
    let stream = null;
    lx.skipWs();
    if (lx.peekBytes(6) === 'stream') {
      let p = lx.p + 6;
      if (bytes[p] === 0x0d) p++;
      if (bytes[p] === 0x0a) p++;
      const dataStart = p;
      let len = value && value.t === 'dict' ? lengthOf(value.map.get('Length')) : null;
      let ok = false;
      if (len !== null && len >= 0 && dataStart + len <= bytes.length) {
        let q = dataStart + len;
        while (q < bytes.length && isWs(bytes[q])) q++;
        if (latin1.decode(bytes.subarray(q, q + 9)) === 'endstream') { ok = true; lx.p = q + 9; }
      }
      if (!ok) {
        const e = findEndstream(bytes, dataStart);
        if (e < 0) continue;
        let end = e;
        if (bytes[end - 1] === 0x0a) end--;
        if (bytes[end - 1] === 0x0d) end--;
        len = end - dataStart;
        lx.p = e + 9;
      }
      stream = bytes.slice(dataStart, dataStart + len);
    }
    // find endobj (not strictly required)
    const tail = text.indexOf('endobj', lx.p);
    cursor = tail >= 0 ? tail + 6 : lx.p;
    if (value && value.t === 'dict' && isName(value.map.get('Type'), 'XRef')) xrefStreams.add(h.num);
    objects.set(h.num, { num: h.num, gen: h.gen, value, stream, fileOrder: h.start });
  }
  // Trailers: classic 'trailer' dicts and XRef stream dicts, in file order (later wins).
  const trailer = new Map();
  const contributions = [];
  const tre = /trailer\s*<</g;
  while ((m = tre.exec(text))) {
    try { contributions.push({ at: m.index, dict: new Lexer(bytes, m.index + m[0].length - 2).parseDict() }); } catch { /* ignore */ }
  }
  for (const h of heads) if (xrefStreams.has(h.num)) { const o = objects.get(h.num); if (o && o.value && o.value.t === 'dict') contributions.push({ at: h.start, dict: o.value }); }
  contributions.sort((a, b) => a.at - b.at);
  for (const c of contributions) for (const k of ['Root', 'Info', 'ID', 'Encrypt']) if (c.dict.map.has(k)) trailer.set(k, c.dict.map.get(k));
  return { version, objects, trailer, xrefStreams };
}

// ---------- serializer ----------
function fmtNum(n) {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1e6) / 1e6);
}
function hex(bytes) {
  let s = '<';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s + '>';
}
export function serializeValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return '[' + v.map(serializeValue).join(' ') + ']';
  switch (v.t) {
    case 'name': return '/' + v.v.replace(/[^!-~]|[#()<>\[\]{}\/%]/g, (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'));
    case 'str': return hex(v.bytes);
    case 'ref': return `${v.num} ${v.gen} R`;
    case 'dict': { let s = '<<'; for (const [k, val] of v.map) s += serializeValue(Name(k)) + ' ' + serializeValue(val) + ' '; return s + '>>'; }
    case 'kw': return v.v;
    default: return 'null';
  }
}

/** Write objects + trailer into a fresh PDF file with a classic xref table. */
export function serializePdf({ version = '1.7', objects, trailer }) {
  const parts = [];
  let offset = 0;
  const push = (chunk) => { const b = typeof chunk === 'string' ? latin1Encode(chunk) : chunk; parts.push(b); offset += b.length; };
  push(`%PDF-${version}\n%\xE2\xE3\xCF\xD3\n`);
  const nums = [...objects.keys()].sort((a, b) => a - b);
  const offsets = new Map();
  for (const num of nums) {
    const o = objects.get(num);
    offsets.set(num, offset);
    push(`${num} ${o.gen} obj\n`);
    if (o.stream) {
      const d = o.value && o.value.t === 'dict' ? o.value : Dict();
      d.map.set('Length', o.stream.length);
      push(serializeValue(d) + '\nstream\n');
      push(o.stream);
      push('\nendstream');
    } else push(serializeValue(o.value));
    push('\nendobj\n');
  }
  const maxNum = nums.length ? nums[nums.length - 1] : 0;
  const xrefOffset = offset;
  let xref = `xref\n0 ${maxNum + 1}\n0000000000 65535 f\r\n`;
  for (let i = 1; i <= maxNum; i++) {
    if (offsets.has(i)) xref += `${String(offsets.get(i)).padStart(10, '0')} ${String(objects.get(i).gen).padStart(5, '0')} n\r\n`;
    else xref += '0000000000 65535 f\r\n';
  }
  push(xref);
  const t = Dict();
  t.map.set('Size', maxNum + 1);
  for (const k of ['Root', 'Info', 'ID', 'Encrypt']) if (trailer.has(k)) t.map.set(k, trailer.get(k));
  push(`trailer\n${serializeValue(t)}\nstartxref\n${xrefOffset}\n%%EOF\n`);
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function latin1Encode(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; }

// ---------- object streams ----------
async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const w = ds.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
function unpredict(data, params) {
  const pred = params.get('Predictor') || 1;
  if (pred < 10) return data;
  const colors = params.get('Colors') || 1, bpc = params.get('BitsPerComponent') || 8, columns = params.get('Columns') || 1;
  const bpp = Math.ceil(colors * bpc / 8), rowLen = Math.ceil(colors * bpc * columns / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)];
    const row = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  return out;
}
async function decodeStream(doc, o) {
  const d = o.value;
  let data = o.stream;
  let filters = resolve(doc, d.map.get('Filter'));
  let params = resolve(doc, d.map.get('DecodeParms'));
  if (!filters) return data;
  if (!Array.isArray(filters)) { filters = [filters]; params = [params]; }
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i] && filters[i].v;
    const pm = resolve(doc, Array.isArray(params) ? params[i] : params);
    if (f === 'FlateDecode' || f === 'Fl') data = await inflate(data);
    else throw new Error(`Unsupported object stream filter ${f}`);
    if (pm && pm.t === 'dict') data = unpredict(data, pm.map);
  }
  return data;
}
/** Replace every /ObjStm with the objects it contains (so the file no longer needs xref streams). */
export async function expandObjectStreams(doc) {
  const order = [...doc.objects.values()];
  for (const o of order) {
    if (!(o.value && o.value.t === 'dict' && isName(o.value.map.get('Type'), 'ObjStm') && o.stream)) continue;
    let data;
    try { data = await decodeStream(doc, o); } catch { continue; }
    const n = resolve(doc, o.value.map.get('N')) || 0, first = resolve(doc, o.value.map.get('First')) || 0;
    const head = new Lexer(data, 0);
    const pairs = [];
    for (let i = 0; i < n; i++) { const num = head.parse(), off = head.parse(); if (typeof num !== 'number' || typeof off !== 'number') break; pairs.push([num, off]); }
    for (const [num, off] of pairs) {
      const existing = doc.objects.get(num);
      if (existing && !existing.inObjStm && existing.fileOrder > o.fileOrder) continue; // a newer direct definition exists
      try {
        const value = new Lexer(data, first + off).parse();
        doc.objects.set(num, { num, gen: 0, value: value && value.t === 'kw' ? null : value, stream: null, inObjStm: true, fileOrder: o.fileOrder });
      } catch { /* skip broken member */ }
    }
    doc.objects.delete(o.num);
  }
  return doc;
}

// ---------- value walking ----------
async function mapStrings(v, fn) {
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = await mapStrings(v[i], fn); return v; }
  if (v && v.t === 'str') return Str(await fn(v.bytes));
  if (v && v.t === 'dict') { for (const [k, val] of v.map) v.map.set(k, await mapStrings(val, fn)); return v; }
  return v;
}
function resolve(doc, v) { return v && v.t === 'ref' ? (doc.objects.get(v.num) || {}).value : v; }
function toPlain(doc, v, depth = 0) {
  v = resolve(doc, v);
  if (v === null || v === undefined || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => toPlain(doc, x, depth + 1));
  if (v.t === 'name') return v.v;
  if (v.t === 'str') return v.bytes;
  if (v.t === 'dict') { const o = {}; for (const [k, val] of v.map) o[k] = depth > 4 ? null : toPlain(doc, val, depth + 1); return o; }
  return null;
}
function fromPlain(v) {
  if (v instanceof Uint8Array) return Str(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return Name(v);
  if (Array.isArray(v)) return v.map(fromPlain);
  const d = Dict();
  for (const [k, val] of Object.entries(v)) d.map.set(k, fromPlain(val));
  return d;
}

export function isEncrypted(bytes) {
  try { return parsePdf(bytes).trailer.has('Encrypt'); } catch { return false; }
}

/**
 * Remove encryption. Returns { bytes, isOwner, permissions }. Throws Error('Incorrect password') on a bad password.
 * The output is a loosely structured file meant to be normalised by pdf-lib (load + save).
 */
export async function decryptPdf(bytes, password = '') {
  const doc = parsePdf(bytes);
  if (!doc.trailer.has('Encrypt')) return { bytes, isOwner: true, permissions: null, wasEncrypted: false };
  const encRef = doc.trailer.get('Encrypt');
  const encDict = toPlain(doc, encRef);
  const idArr = toPlain(doc, doc.trailer.get('ID'));
  const id0 = Array.isArray(idArr) && idArr[0] instanceof Uint8Array ? idArr[0] : new Uint8Array(0);
  const handler = await openEncryption(encDict, id0, password);
  const encNum = encRef && encRef.t === 'ref' ? encRef.num : -1;
  const out = new Map();
  for (const [num, o] of doc.objects) {
    if (num === encNum || doc.xrefStreams.has(num)) continue;
    const value = await mapStrings(o.value, (b) => handler.decrypt(num, o.gen, b, 'string'));
    let stream = o.stream;
    if (stream) {
      const isMeta = value && value.t === 'dict' && isName(value.map.get('Type'), 'Metadata');
      if (!(isMeta && !handler.encryptMetadata)) stream = await handler.decrypt(num, o.gen, stream, 'stream');
    }
    out.set(num, { num, gen: o.gen, value, stream, fileOrder: o.fileOrder });
  }
  const trailer = new Map(doc.trailer);
  trailer.delete('Encrypt');
  const plainDoc = await expandObjectStreams({ ...doc, objects: out, trailer });
  return { bytes: serializePdf({ version: doc.version, objects: plainDoc.objects, trailer }), isOwner: handler.isOwner, permissions: handler.permissions, wasEncrypted: true };
}

/**
 * Encrypt a (plain, object-stream-free) PDF. opts: { userPassword, ownerPassword, permissions, method }.
 */
export async function encryptPdf(bytes, opts = {}) {
  const doc = await expandObjectStreams(parsePdf(bytes));
  if (doc.trailer.has('Encrypt')) throw new Error('Document is already encrypted; unlock it first');
  const idArr = toPlain(doc, doc.trailer.get('ID'));
  const existingId = Array.isArray(idArr) && idArr[0] instanceof Uint8Array && idArr[0].length ? idArr[0] : null;
  const handler = await createEncryption({ ...opts, id0: existingId || md5(concat(randomBytes(16), enc.encode(String(Date.now())))) });
  const out = new Map();
  for (const [num, o] of doc.objects) {
    if (doc.xrefStreams.has(num)) continue;
    const value = await mapStrings(o.value, (b) => handler.encrypt(num, o.gen, b));
    const stream = o.stream ? await handler.encrypt(num, o.gen, o.stream) : null;
    out.set(num, { num, gen: o.gen, value, stream });
  }
  const encNum = Math.max(0, ...out.keys()) + 1;
  out.set(encNum, { num: encNum, gen: 0, value: fromPlain(handler.dict), stream: null });
  const trailer = new Map(doc.trailer);
  trailer.set('Encrypt', Ref(encNum, 0));
  trailer.set('ID', [Str(handler.id0), Str(handler.id0)]);
  return serializePdf({ version: opts.method === 'aes256' ? '1.7' : doc.version, objects: out, trailer });
}
