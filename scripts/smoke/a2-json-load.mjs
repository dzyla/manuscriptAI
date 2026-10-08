// A2 smoke: a stored document loads into the editor as JSON (exactly one apply, no loop), and an attribute with NO
// HTML mapping (`styleId`, injected into the schema via a route override: the production schema has none yet) survives
// load, edit, autosave and reload. On the old docJson -> docToHtml -> editor path this script fails.
// Usage: npm run dev (port 3000) in another terminal, then:
//   npm i --no-save playwright && npx playwright install chromium && node scripts/smoke/a2-json-load.mjs
import { chromium } from 'playwright';

const URL = process.env.APP_URL ?? 'http://localhost:3000';
const OOXML = { blockId: 'b1', sourceHash: 'deadbeef' };
const browser = await chromium.launch();
const page = await browser.newPage();
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };
const STYLE_ID = 'SmokeStyle1';
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

// Add an unmapped paragraph attribute to the app's real schema (no parseHTML/renderHTML), so HTML cannot carry it.
await page.route('**/src/extensions/schema.ts*', async (route) => {
  const res = await route.fetch();
  let body = await res.text();
  const core = body.match(/from "(\/node_modules\/\.vite\/deps\/@tiptap_core\.js[^"]*)"/)?.[1];
  if (!core || !body.includes('export function getSchemaExtensions(')) throw new Error('cannot patch schema module');
  body = body.replace('export function getSchemaExtensions(', 'function __baseSchemaExtensions(') + `
import { Extension as __SmokeExt } from "${core}";
const __SmokeStyleId = __SmokeExt.create({ name: 'smokeStyleId', addGlobalAttributes() { return [{ types: ['paragraph'], attributes: { styleId: { default: null, rendered: false } } }]; } });
export function getSchemaExtensions() { return [...__baseSchemaExtensions(), __SmokeStyleId]; }
`;
  await route.fulfill({ response: res, body });
});

// First visit creates the database; then seed a v3 JSON row carrying provenance.
await page.goto(URL);
await page.waitForSelector('.ProseMirror');
await idb(async ({ ooxml, styleId }) => {
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('ManuscriptAIEditor');
    req.onsuccess = () => {
      const tx = req.result.transaction('documents', 'readwrite');
      tx.objectStore('documents').put({
        id: 'current', title: 'Smoke', schemaVersion: 3, saveState: 'Saved',
        docJson: { type: 'doc', content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Aims' }] },
          { type: 'paragraph', attrs: { ooxml, styleId }, content: [{ type: 'text', text: 'imported json text' }] },
        ] },
        citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1,
      });
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}, { ooxml: OOXML, styleId: STYLE_ID });

// Count document-changing transactions on every editor from the moment it is created. TipTap assigns
// `view.dom.editor = this` synchronously inside the Editor constructor, before any content can be applied, so a
// setter on HTMLElement.prototype sees the editor first and cannot under-count.
await page.addInitScript(() => {
  window.__docChanges = 0;
  window.__txLog = [];
  window.__editorsSeen = 0;
  Object.defineProperty(HTMLElement.prototype, 'editor', {
    configurable: true,
    set(ed) {
      Object.defineProperty(this, 'editor', { value: ed, configurable: true, writable: true });
      window.__editorsSeen++;
      ed.on('transaction', ({ transaction }) => {
        if (!transaction.docChanged) return;
        window.__docChanges++;
        window.__txLog.push({ text: transaction.doc.textContent.slice(0, 40), stack: new Error().stack.split('\n').slice(2, 14).map((l) => l.trim().replace(/http:\/\/[^/]+\//, '')).join(' | ') });
      });
    },
  });
});
await page.reload();
await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent.includes('imported json text'));
await page.waitForTimeout(1500);
const changes = await page.evaluate(() => window.__docChanges);
console.log('doc-changing transactions during load:', changes);
const editorsSeen = await page.evaluate(() => window.__editorsSeen);
console.log('editors created:', editorsSeen);
if (changes !== 1) console.log(JSON.stringify(await page.evaluate(() => window.__txLog), null, 1));
if (changes !== 1) fail(`loading changed the document ${changes} times (expected exactly 1)`);
const attrOnLoad = await page.evaluate(() => document.querySelector('.ProseMirror').editor.getJSON().content[1].attrs.ooxml);
if (JSON.stringify(attrOnLoad) !== JSON.stringify(OOXML)) fail('provenance not in the editor after load: ' + JSON.stringify(attrOnLoad));
const styleOnLoad = await page.evaluate(() => document.querySelector('.ProseMirror').editor.getJSON().content[1].attrs.styleId);
if (styleOnLoad !== STYLE_ID) fail('unmapped attribute lost on load: ' + JSON.stringify(styleOnLoad));
const stateAfterLoad = await page.evaluate(() => document.querySelector('.ProseMirror').editor.getHTML());
console.log('editor html after load:', stateAfterLoad);

await page.click('.ProseMirror p:last-of-type');
await page.keyboard.press('End');
await page.keyboard.type(' plus an edit');
await page.waitForTimeout(31_000); // autosave interval

const row = await readRow();
if (!JSON.stringify(row.docJson).includes('plus an edit')) fail('edit not persisted in docJson');
if (JSON.stringify(row.docJson.content[1].attrs.ooxml) !== JSON.stringify(OOXML)) fail('provenance lost in saved row: ' + JSON.stringify(row.docJson.content[1].attrs));

if (row.docJson.content[1].attrs.styleId !== STYLE_ID) fail('unmapped attribute lost in saved row: ' + JSON.stringify(row.docJson.content[1].attrs));

await page.reload();
await page.waitForSelector('.ProseMirror');
await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent.includes('plus an edit'));
const styleAfterReload = await page.evaluate(() => document.querySelector('.ProseMirror').editor.getJSON().content[1].attrs.styleId);
if (styleAfterReload !== STYLE_ID) fail('unmapped attribute lost after reload: ' + JSON.stringify(styleAfterReload));
const attrAfterReload = await page.evaluate(() => document.querySelector('.ProseMirror').editor.getJSON().content[1].attrs.ooxml);
if (JSON.stringify(attrAfterReload) !== JSON.stringify(OOXML)) fail('provenance lost after reload');
const loopErrors = errors.filter((e) => /Maximum update depth|Too many re-renders/.test(e));
if (loopErrors.length) fail('render loop errors: ' + loopErrors.join('; '));
if (errors.length) console.log('console errors (informational):', errors.slice(0, 5));

// Scenario B: a legacy HTML row with plain-text [N] citations and a registry migrates to citation nodes inside
// initialize() (before the editor sees the document), and the migrated document is what gets stored.
{
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await p2.goto(URL);
  await p2.waitForSelector('.ProseMirror');
  await p2.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('ManuscriptAIEditor');
      req.onsuccess = () => {
        const tx = req.result.transaction('documents', 'readwrite');
        tx.objectStore('documents').put({ id: 'current', title: 'Legacy', content: '<p>Prior work [1] showed this [2].</p>', saveState: 'Saved', citationRegistry: { 'src-a': 1, 'src-b': 2 }, citationCounter: 2, figureRegistry: {}, figureCounter: 0, updatedAt: 1 });
        tx.oncomplete = () => { req.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  });
  await p2.reload();
  await p2.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent.includes('Prior work'));
  await p2.waitForTimeout(1000);
  const nodes = await p2.evaluate(() => document.querySelectorAll('.ProseMirror [data-citation-node]').length);
  console.log('legacy [N] markers rendered as citation nodes:', nodes);
  if (nodes !== 2) fail(`expected 2 citation nodes after migration, got ${nodes}`);
  await p2.waitForTimeout(31_000); // autosave: the row held unmigrated text, so it must be written
  const legacyRow = await p2.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('ManuscriptAIEditor');
    req.onsuccess = () => {
      const get = req.result.transaction('documents').objectStore('documents').get('current');
      get.onsuccess = () => { resolve(get.result); req.result.close(); };
    };
  }));
  const rowJson = JSON.stringify(legacyRow.docJson);
  if (!rowJson.includes('"type":"citation"')) fail('stored row not migrated to citation nodes');
  await p2.reload();
  await p2.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent.includes('Prior work'));
  const nodesAfter = await p2.evaluate(() => document.querySelectorAll('.ProseMirror [data-citation-node]').length);
  if (nodesAfter !== 2) fail(`expected 2 citation nodes after reload, got ${nodesAfter}`);
  await ctx.close();
}

await browser.close();
if (!process.exitCode) console.log('A2 json-load smoke: PASS');
