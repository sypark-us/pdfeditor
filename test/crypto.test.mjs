import { test } from 'node:test';
import assert from 'node:assert/strict';
import { md5, rc4, aesCbcEncryptNoPad, aesCbcDecryptNoPad, randomBytes, createEncryption, openEncryption, permissionsToP, pToPermissions } from '../js/crypto.js';

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

test('md5 test vectors', () => {
  assert.equal(hex(md5('')), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(hex(md5('abc')), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(hex(md5('The quick brown fox jumps over the lazy dog')), '9e107d9d372bb6826bd81d3542a419d6');
  assert.equal(hex(md5('a'.repeat(1000))), 'cabe45dcc9ae5b66ba86600cca6b8ba8');
  assert.equal(hex(md5('a'.repeat(55))), 'ef1772b6dff9a122358552954ad0df65');
  assert.equal(hex(md5('a'.repeat(64))), '014842d480b571495a4a0363793f7367');
});
test('rc4 test vector', () => {
  assert.equal(hex(rc4(enc('Key'), enc('Plaintext'))), 'bbf316e8d940af0ad3');
  assert.equal(hex(rc4(enc('Wiki'), enc('pedia'))), '1021bf0420');
});
test('aes-cbc without padding round trip', async () => {
  const k = randomBytes(16), iv = randomBytes(16), d = randomBytes(64);
  const e = await aesCbcEncryptNoPad(k, iv, d);
  assert.equal(e.length, 64);
  assert.equal(hex(await aesCbcDecryptNoPad(k, iv, e)), hex(d));
});
test('permission bits', () => {
  const p = permissionsToP({ copy: false, print: true });
  const back = pToPermissions(p);
  assert.equal(back.copy, false); assert.equal(back.print, true); assert.equal(back.modify, true);
  assert.equal(p & 0b11, 0); assert.equal(p & 0b11000000, 0b11000000);
});
for (const method of ['rc4', 'aes128', 'aes256']) {
  test(`security handler ${method}: user, owner, bad password`, async () => {
    const h = await createEncryption({ userPassword: 'u', ownerPassword: 'o', method, permissions: { copy: false } });
    const ct = await h.encrypt(5, 0, enc('hello world'));
    assert.notEqual(dec(ct), 'hello world');
    const u = await openEncryption(h.dict, h.id0, 'u');
    assert.equal(dec(await u.decrypt(5, 0, ct)), 'hello world');
    assert.equal(u.isOwner, false); assert.equal(u.permissions.copy, false);
    const o = await openEncryption(h.dict, h.id0, 'o');
    assert.equal(o.isOwner, true);
    assert.equal(dec(await o.decrypt(5, 0, ct, 'string')), 'hello world');
    await assert.rejects(openEncryption(h.dict, h.id0, 'x'), /password/i);
  });
}
test('empty user password opens without prompting', async () => {
  const h = await createEncryption({ userPassword: '', ownerPassword: 'o', method: 'aes128' });
  const u = await openEncryption(h.dict, h.id0, '');
  assert.equal(u.isOwner, false);
});
