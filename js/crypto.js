// Pure-JS MD5 / RC4 plus WebCrypto-backed SHA-2 and AES, and the PDF standard security
// handler (R2/R3/R4 RC4 + AESV2, R6 AESV3) used by the protect / unlock tools.
// Works in browsers and Node (globalThis.crypto.subtle).

const subtle = globalThis.crypto.subtle;

// ---------- MD5 ----------
const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];

export function md5(input) {
  const msg = input instanceof Uint8Array ? input : new TextEncoder().encode(String(input));
  const len = msg.length;
  const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64);
  padded.set(msg);
  padded[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bits >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return out;
}

// ---------- RC4 ----------
export function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + S[i]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
    out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}

// ---------- SHA / AES via WebCrypto ----------
export async function sha(bits, data) {
  return new Uint8Array(await subtle.digest(`SHA-${bits}`, data));
}
export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}
export function concat(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
const importAes = (key) => subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);

/** AES-CBC with PKCS#7 padding (what PDF uses for strings/streams). */
export async function aesCbcEncrypt(key, iv, data) {
  return new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, await importAes(key), data));
}
export async function aesCbcDecrypt(key, iv, data) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, await importAes(key), data));
}
/** AES-CBC with no padding; data length must be a multiple of 16. */
export async function aesCbcEncryptNoPad(key, iv, data) {
  const padded = await aesCbcEncrypt(key, iv, data);
  return padded.subarray(0, data.length);
}
export async function aesCbcDecryptNoPad(key, iv, data) {
  if (data.length === 0) return new Uint8Array(0);
  // Append a block that decrypts to a full PKCS#7 padding block so WebCrypto accepts the input.
  const lastC = data.subarray(data.length - 16);
  const padBlock = new Uint8Array(16).fill(16);
  const fake = await aesCbcEncryptNoPad(key, lastC, padBlock);
  return aesCbcDecrypt(key, iv, concat(data, fake));
}

// ---------- PDF standard security handler ----------
const PAD = new Uint8Array([0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A]);
const SALT = new Uint8Array([0x73, 0x41, 0x6C, 0x54]);

export const PERMISSIONS = {
  print: 1 << 2, modify: 1 << 3, copy: 1 << 4, annotate: 1 << 5, fillForms: 1 << 8, extractAccessibility: 1 << 9, assemble: 1 << 10, printHighQuality: 1 << 11,
};
export function permissionsToP(perms) {
  let p = 0xFFFFFFFF;
  for (const [name, bit] of Object.entries(PERMISSIONS)) if (perms && perms[name] === false) p = (p & ~bit) >>> 0;
  p = (p & ~0b11) >>> 0; // bits 1-2 must be 0
  p = (p | 0b11000000) >>> 0; // bits 7-8 must be 1
  return p | 0; // signed 32-bit, as written in /P
}
export function pToPermissions(P) {
  const out = {};
  for (const [name, bit] of Object.entries(PERMISSIONS)) out[name] = (P & bit) !== 0;
  return out;
}

const latin1 = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
const padPassword = (pw) => concat(pw, PAD).subarray(0, 32);
const pwBytes = (pw) => (pw instanceof Uint8Array ? pw : latin1(String(pw || '')));
const equalBytes = (a, b, n = Math.min(a.length, b.length)) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };

// Algorithm 2: encryption key from user password
function computeKeyR234(userPw, O, P, id0, R, keyLen, encryptMetadata) {
  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, P | 0, true);
  const parts = [padPassword(pwBytes(userPw)), O.subarray(0, 32), pBytes, id0];
  if (R >= 4 && !encryptMetadata) parts.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  let hash = md5(concat(...parts));
  const n = R === 2 ? 5 : keyLen;
  if (R >= 3) for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, n));
  return hash.subarray(0, n);
}
// Algorithm 3: O value
function computeO(ownerPw, userPw, R, keyLen) {
  let hash = md5(padPassword(pwBytes(ownerPw || userPw)));
  const n = R === 2 ? 5 : keyLen;
  if (R >= 3) for (let i = 0; i < 50; i++) hash = md5(hash);
  const key = hash.subarray(0, n);
  let out = rc4(key, padPassword(pwBytes(userPw)));
  if (R >= 3) for (let i = 1; i <= 19; i++) out = rc4(key.map((b) => b ^ i), out);
  return out;
}
// Algorithm 4/5: U value
function computeU(key, R, id0) {
  if (R === 2) return rc4(key, PAD);
  let out = rc4(key, md5(concat(PAD, id0)));
  for (let i = 1; i <= 19; i++) out = rc4(key.map((b) => b ^ i), out);
  return concat(out, new Uint8Array(16));
}
function ownerToUserPassword(ownerPw, O, R, keyLen) {
  let hash = md5(padPassword(pwBytes(ownerPw)));
  const n = R === 2 ? 5 : keyLen;
  if (R >= 3) for (let i = 0; i < 50; i++) hash = md5(hash);
  const key = hash.subarray(0, n);
  let out = O.subarray(0, 32);
  if (R === 2) out = rc4(key, out);
  else for (let i = 19; i >= 0; i--) out = rc4(key.map((b) => b ^ i), out);
  return out;
}

// R6 hash (ISO 32000-2 algorithm 2.B)
async function hashR6(pw, salt, udata) {
  let k = await sha(256, concat(pw, salt, udata));
  let i = 0;
  while (true) {
    const k1 = concat(...Array.from({ length: 64 }, () => concat(pw, k, udata)));
    const e = await aesCbcEncryptNoPad(k.subarray(0, 16), k.subarray(16, 32), k1);
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += e[j];
    const mod = sum % 3;
    k = mod === 0 ? await sha(256, e) : mod === 1 ? await sha(384, e) : await sha(512, e);
    i++;
    if (i >= 64 && e[e.length - 1] <= i - 32) break;
  }
  return k.subarray(0, 32);
}
const utf8Pw = (pw) => new TextEncoder().encode(String(pw || '')).subarray(0, 127);

function objectKeyR234(fileKey, num, gen, aes) {
  const extra = new Uint8Array([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
  const h = md5(aes ? concat(fileKey, extra, SALT) : concat(fileKey, extra));
  return h.subarray(0, Math.min(fileKey.length + 5, 16));
}

/**
 * Create a handler for encrypting a new document.
 * opts: { userPassword, ownerPassword, permissions:{print,modify,copy,annotate,fillForms,...}, method:'rc4'|'aes128'|'aes256', id0 }
 * Returns { id0, dict (plain object describing the /Encrypt dictionary), encrypt(num, gen, bytes) -> Promise<Uint8Array> }
 */
export async function createEncryption(opts) {
  const method = opts.method || 'aes128';
  const P = permissionsToP(opts.permissions);
  const userPw = opts.userPassword || '';
  const ownerPw = opts.ownerPassword || userPw || '';
  const id0 = opts.id0 || md5(randomBytes(32));
  if (method === 'aes256') {
    const fileKey = randomBytes(32);
    const u = utf8Pw(userPw), o = utf8Pw(ownerPw);
    const uvs = randomBytes(8), uks = randomBytes(8);
    const U = concat(await hashR6(u, uvs, new Uint8Array(0)), uvs, uks);
    const uik = await hashR6(u, uks, new Uint8Array(0));
    const UE = await aesCbcEncryptNoPad(uik, new Uint8Array(16), fileKey);
    const ovs = randomBytes(8), oks = randomBytes(8);
    const O = concat(await hashR6(o, ovs, U), ovs, oks);
    const oik = await hashR6(o, oks, U);
    const OE = await aesCbcEncryptNoPad(oik, new Uint8Array(16), fileKey);
    const perms = new Uint8Array(16);
    new DataView(perms.buffer).setInt32(0, P, true);
    perms.set([0xff, 0xff, 0xff, 0xff], 4);
    perms[8] = 0x54; perms[9] = 0x61; perms[10] = 0x64; perms[11] = 0x62;
    perms.set(randomBytes(4), 12);
    const Perms = await aesCbcEncryptNoPad(fileKey, new Uint8Array(16), perms);
    return {
      id0,
      dict: { Filter: 'Standard', V: 5, R: 6, Length: 256, P, O, U, OE, UE, Perms, CF: { StdCF: { CFM: 'AESV3', AuthEvent: 'DocOpen', Length: 32 } }, StmF: 'StdCF', StrF: 'StdCF' },
      encrypt: async (num, gen, bytes) => { const iv = randomBytes(16); return concat(iv, await aesCbcEncrypt(fileKey, iv, bytes)); },
    };
  }
  const aes = method === 'aes128';
  const R = aes ? 4 : 3, V = aes ? 4 : 2, keyLen = 16;
  const O = computeO(ownerPw, userPw, R, keyLen);
  const key = computeKeyR234(userPw, O, P, id0, R, keyLen, true);
  const U = computeU(key, R, id0);
  const dict = { Filter: 'Standard', V, R, Length: 128, P, O, U };
  if (aes) Object.assign(dict, { CF: { StdCF: { CFM: 'AESV2', AuthEvent: 'DocOpen', Length: 16 } }, StmF: 'StdCF', StrF: 'StdCF' });
  return {
    id0, dict,
    encrypt: async (num, gen, bytes) => {
      const ok = objectKeyR234(key, num, gen, aes);
      if (!aes) return rc4(ok, bytes);
      const iv = randomBytes(16);
      return concat(iv, await aesCbcEncrypt(ok, iv, bytes));
    },
  };
}

/**
 * Open an existing document's /Encrypt dictionary with a password (user or owner).
 * enc: { Filter, V, R, Length, O, U, P, OE, UE, Perms, EncryptMetadata, StmF, StrF, CF:{name:{CFM}} } with byte strings as Uint8Array.
 * Returns { decrypt(num, gen, bytes, kind:'string'|'stream'), isOwner, encryptMetadata, permissions } or throws.
 */
export async function openEncryption(enc, id0, password = '') {
  if (enc.Filter && enc.Filter !== 'Standard') throw new Error(`Unsupported security handler ${enc.Filter}`);
  const V = enc.V || 0, R = enc.R || (V >= 4 ? 4 : V === 1 ? 2 : 3);
  const encryptMetadata = enc.EncryptMetadata !== false;
  const cfm = (name) => {
    if (V < 4) return 'V2';
    if (!name || name === 'Identity') return 'Identity';
    return (enc.CF && enc.CF[name] && enc.CF[name].CFM) || 'Identity';
  };
  const stmMethod = cfm(enc.StmF), strMethod = cfm(enc.StrF);
  let fileKey, isOwner = false;
  if (R >= 5) {
    const pw = utf8Pw(password);
    const U = enc.U, O = enc.O;
    const uvs = U.subarray(32, 40), uks = U.subarray(40, 48), ovs = O.subarray(32, 40), oks = O.subarray(40, 48);
    const h = R === 5 ? (p, s, u) => sha(256, concat(p, s, u)) : hashR6;
    if (equalBytes(await h(pw, ovs, U.subarray(0, 48)), O, 32)) {
      isOwner = true;
      fileKey = await aesCbcDecryptNoPad(await h(pw, oks, U.subarray(0, 48)), new Uint8Array(16), enc.OE);
    } else if (equalBytes(await h(pw, uvs, new Uint8Array(0)), U, 32)) {
      fileKey = await aesCbcDecryptNoPad(await h(pw, uks, new Uint8Array(0)), new Uint8Array(16), enc.UE);
    } else throw new Error('Incorrect password');
  } else {
    const keyLen = Math.max(5, Math.min(16, ((enc.Length || 40) / 8) | 0));
    const tryUser = (pw) => {
      const key = computeKeyR234(pw, enc.O, enc.P, id0, R, keyLen, encryptMetadata);
      const U = computeU(key, R, id0);
      return equalBytes(U, enc.U, R === 2 ? 32 : 16) ? key : null;
    };
    fileKey = tryUser(password);
    if (!fileKey) {
      const userPw = ownerToUserPassword(password, enc.O, R, keyLen);
      fileKey = tryUser(userPw);
      if (fileKey) isOwner = true;
    }
    if (!fileKey) throw new Error('Incorrect password');
  }
  const decryptWith = async (method, num, gen, bytes) => {
    if (method === 'Identity' || method === 'None') return bytes;
    if (method === 'AESV3') {
      if (bytes.length < 16) return new Uint8Array(0);
      const body = bytes.subarray(16, 16 + ((bytes.length - 16) >> 4 << 4));
      try { return await aesCbcDecrypt(fileKey, bytes.subarray(0, 16), body); } catch { return aesCbcDecryptNoPad(fileKey, bytes.subarray(0, 16), body); }
    }
    const aes = method === 'AESV2';
    const ok = objectKeyR234(fileKey, num, gen, aes);
    if (!aes) return rc4(ok, bytes);
    if (bytes.length < 16) return new Uint8Array(0);
    const body = bytes.subarray(16, 16 + ((bytes.length - 16) >> 4 << 4));
    try { return await aesCbcDecrypt(ok, bytes.subarray(0, 16), body); } catch { return aesCbcDecryptNoPad(ok, bytes.subarray(0, 16), body); }
  };
  return {
    isOwner, encryptMetadata, R, permissions: pToPermissions(enc.P | 0),
    decrypt: (num, gen, bytes, kind = 'stream') => decryptWith(kind === 'string' ? strMethod : stmMethod, num, gen, bytes),
  };
}
