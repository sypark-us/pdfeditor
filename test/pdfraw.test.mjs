import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const { PDFDocument, StandardFonts } = require(`${root}/vendor/pdf-lib.min.js`);
const raw = await import('../js/pdfraw.js');
const pdfjs = await import(pathToFileURL(`${root}/vendor/pdfjs/pdf.min.mjs`));
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(`${root}/vendor/pdfjs/pdf.worker.min.mjs`).href;

async function sample(objectStreams) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 200]);
  page.drawText('Secret hello (parens) \\ back', { x: 20, y: 100, size: 18, font });
  doc.setTitle('Title (with) parens');
  return doc.save({ useObjectStreams: objectStreams });
}
const textOf = async (bytes, password) => {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), password }).promise;
  const t = (await (await pdf.getPage(1)).getTextContent()).items.map((i) => i.str).join('');
  const title = (await pdf.getMetadata()).info.Title;
  await pdf.destroy();
  return { t, title };
};

test('parse + serialize keeps pdf-lib loadable', async () => {
  const bytes = await sample(false);
  const parsed = raw.parsePdf(bytes);
  assert.ok(parsed.objects.size >= 5);
  assert.ok(parsed.trailer.has('Root'));
  const out = raw.serializePdf(parsed);
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 1);
  assert.equal(doc.getTitle(), 'Title (with) parens');
});
test('expandObjectStreams removes ObjStm objects', async () => {
  const bytes = await sample(true);
  const parsed = await raw.expandObjectStreams(raw.parsePdf(bytes));
  for (const o of parsed.objects.values()) assert.ok(!(o.value && o.value.t === 'dict' && o.value.map.get('Type') && o.value.map.get('Type').v === 'ObjStm'));
  const out = raw.serializePdf(parsed);
  assert.equal((await textOf(out)).t, 'Secret hello (parens) \\ back');
});
for (const method of ['rc4', 'aes128', 'aes256']) {
  test(`encrypt (${method}) opens in pdf.js with password and decrypts back`, async () => {
    const plain = await sample(false);
    const enc = await raw.encryptPdf(plain, { userPassword: 'user', ownerPassword: 'owner', method, permissions: { copy: false } });
    assert.ok(raw.isEncrypted(enc));
    await assert.rejects(pdfjs.getDocument({ data: enc.slice(), password: 'wrong' }).promise);
    const r = await textOf(enc, 'user');
    assert.equal(r.t, 'Secret hello (parens) \\ back');
    assert.equal(r.title, 'Title (with) parens');
    const dec = await raw.decryptPdf(enc, 'owner');
    assert.equal(dec.isOwner, true);
    assert.equal(dec.permissions.copy, false);
    const reloaded = await (await PDFDocument.load(dec.bytes)).save();
    assert.equal((await textOf(reloaded)).t, 'Secret hello (parens) \\ back');
    const asUser = await raw.decryptPdf(enc, 'user');
    assert.equal(asUser.isOwner, false);
  });
}
test('encrypting an object-stream PDF with empty user password', async () => {
  const enc = await raw.encryptPdf(await sample(true), { userPassword: '', ownerPassword: 'o', method: 'aes128' });
  assert.equal((await textOf(enc)).t, 'Secret hello (parens) \\ back');
  const dec = await raw.decryptPdf(enc, '');
  assert.equal((await PDFDocument.load(dec.bytes)).getTitle(), 'Title (with) parens');
});
test('decryptPdf passes unencrypted files through', async () => {
  const plain = await sample(false);
  const r = await raw.decryptPdf(plain, '');
  assert.equal(r.wasEncrypted, false);
  assert.equal(r.bytes, plain);
});
