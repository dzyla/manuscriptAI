// A2 smoke: a stored document loads into the editor as JSON (one apply, no loop), provenance survives an edit + reload.
// Usage: npm run dev (port 3000) in another terminal, then:
//   npm i --no-save playwright && npx playwright install chromium && node scripts/smoke/a2-json-load.mjs
import { chromium } from 'playwright';

const URL = process.env.APP_URL ?? 'http://localhost:3000';
const OOXML = { blockId: 'b1', sourceHash: 'deadbeef' };
const browser = await chromium.launch();
const page = await browser.newPage();
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const idb = (fn, arg) => page.evaluate(fn, arg);
const readRow = () => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('ManuscriptAIEditor');
  req.onsuccess = () => {
    const get = req.result.transaction('documents').objectStore('documents').get('current');
    get.onsuccess = () => { resolve(get.result); req.result.close(); };
  };
}));

// First visit creates the database; then seed a v3 JSON row carrying provenance.
await page.goto(URL);
await page.waitForSelector('.ProseMirror');
await idb(async (ooxml) => {
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('ManuscriptAIEditor');
    req.onsuccess = () => {
      const tx = req.result.transaction('documents', 'readwrite');
      tx.objectStore('documents').put({
        id: 'current', title: 'Smoke', schemaVersion: 3, saveState: 'Saved',
        docJson: { type: 'doc', content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Aims' }] },
          { type: 'paragraph', attrs: { ooxml }, content: [{ type: 'text', text: 'imported json text' }] },
        ] },
        citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1,
      });
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}, OOXML);

// Count document-changing transactions from the moment the editor exists.
await page.addInitScript(() => {
  window.__docChanges = 0;
  window.__txLog = [];
  const t = setInterval(() => {
    const ed = document.querySelector('.ProseMirror')?.editor;
    if (ed) { clearInterval(t); ed.on('transaction', ({ transaction }) => { if (transaction.docChanged) { window.__docChanges++; window.__txLog.push({ text: transaction.doc.textContent.slice(0, 40), meta: Object.keys(transaction.meta), stack: new Error().stack.split('\n').slice(2, 14).map((l) => l.trim().replace(/http:\/\/[^/]+\//, '')).join(' | ') }); } }); }
  }, 1);
});
await page.reload();
await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent.includes('imported json text'));
await page.waitForTimeout(1500);
const changes = await page.evaluate(() => window.__docChanges);
console.log('doc-changing transactions during load:', changes);
if (changes > 1) console.log(JSON.stringify(await page.evaluate(() => window.__txLog), null, 1));
if (changes > 1) fail(`loading applied the document ${changes} times (expected at most 1)`);
const attrOnLoad = await page.evaluate(() => document.querySelector('.ProseMirror').editor.getJSON().content[1].attrs.ooxml);
if (JSON.stringify(attrOnLoad) !== JSON.stringify(OOXML)) fail('provenance not in the editor after load: ' + JSON.stringify(attrOnLoad));
const stateAfterLoad = await page.evaluate(() => document.querySelector('.ProseMirror').editor.getHTML());
console.log('editor html after load:', stateAfterLoad);

await page.click('.ProseMirror p:last-of-type');
await page.keyboard.press('End');
await page.keyboard.type(' plus an edit');
await page.waitForTimeout(31_000); // autosave interval

const row = await readRow();
if (!JSON.stringify(row.docJson).includes('plus an edit')) fail('edit not persisted in docJson');
if (JSON.stringify(row.docJson.content[1].attrs.ooxml) !== JSON.stringify(OOXML)) fail('provenance lost in saved row: ' + JSON.stringify(row.docJson.content[1].attrs));

await page.reload();
await page.waitForSelector('.ProseMirror');
await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent.includes('plus an edit'));
const attrAfterReload = await page.evaluate(() => document.querySelector('.ProseMirror').editor.getJSON().content[1].attrs.ooxml);
if (JSON.stringify(attrAfterReload) !== JSON.stringify(OOXML)) fail('provenance lost after reload');
const loopErrors = errors.filter((e) => /Maximum update depth|Too many re-renders/.test(e));
if (loopErrors.length) fail('render loop errors: ' + loopErrors.join('; '));
if (errors.length) console.log('console errors (informational):', errors.slice(0, 5));

await browser.close();
if (!process.exitCode) console.log('A2 json-load smoke: PASS');
