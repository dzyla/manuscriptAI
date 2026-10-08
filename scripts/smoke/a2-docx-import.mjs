// A2a smoke: open a Word document through the file input.
//   1. Cancel in the report dialog leaves the open document untouched.
//   2. Import replaces it; the editor shows the document's text; the stored row carries the document's font and an importId that
//      its package shares.
//   3. Ctrl+Z neither restores the replaced document nor blanks the import.
//   4. "Restore previous document" (the button on the message, and the File menu entry) brings the replaced document back, and again
//      brings the import back.
//   5. A document with inferred headings: all candidates start rejected, each shows its evidence, only the accepted one becomes a heading.
//   6. New Manuscript detaches the package (no package row left for the new document).
//   7. A reload shows what was imported.
//   8. If fixtures/private/r01.docx exists: importing it never freezes the page (longest gap between animation frames is reported).
// Usage: npm run dev (port 3000) in another terminal, then:
//   npm i --no-save playwright && npx playwright install chromium && node scripts/smoke/a2-docx-import.mjs
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL = process.env.APP_URL ?? 'http://localhost:3000';
const fx = (name) => fileURLToPath(new globalThis.URL(`../../src/test/fixtures/docx/${name}`, import.meta.url));
const PRIVATE_R01 = fileURLToPath(new globalThis.URL('../../fixtures/private/r01.docx', import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage();
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };
const ok = (msg) => console.log('ok:', msg);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

const idb = (store, key = 'current') => page.evaluate(([s, k]) => new Promise((resolve) => {
  const req = indexedDB.open('ManuscriptAIEditor');
  req.onsuccess = () => {
    const get = req.result.transaction(s).objectStore(s).get(k);
    get.onsuccess = () => { resolve(get.result ?? null); req.result.close(); };
  };
}), [store, key]);
const editorText = () => page.evaluate(() => document.querySelector('.ProseMirror').textContent);
const dialog = '[data-testid="import-report-dialog"]';
const pick = async (path) => { await page.setInputFiles('input[type="file"][accept*=".docx"]', path); await page.waitForSelector(dialog, { timeout: 60_000 }); };
const waitText = (t) => page.waitForFunction((x) => document.querySelector('.ProseMirror')?.textContent.includes(x), t);

await page.goto(URL);
await page.waitForSelector('.ProseMirror');
await page.click('.ProseMirror p:last-of-type');
await page.keyboard.type('the document that is open before the import');
const OLD = 'the document that is open before the import';

// 1. Cancel leaves everything as it was
await pick(fx('body-basics.docx'));
const notice = (await page.textContent('[data-testid="replace-notice"]')).replace(/\s+/g, ' ');
if (!notice.includes('Undo will not bring it back')) fail('the dialog does not say Undo will not bring it back');
if (!(await page.evaluate(() => document.activeElement?.textContent === 'Cancel'))) fail('initial focus is not on Cancel');
await page.click(`${dialog} button:has-text("Cancel")`);
await page.waitForSelector(dialog, { state: 'detached' });
if (!(await editorText()).includes(OLD)) fail('Cancel changed the open document'); else ok('Cancel leaves the open document untouched');
if ((await idb('docxPackages')) !== null) fail('Cancel left a package behind'); else ok('Cancel wrote nothing');

// 2. Import replaces it
await pick(fx('body-basics.docx'));
await page.click(`${dialog} button:has-text("Import")`);
await page.waitForSelector(dialog, { state: 'detached' });
await waitText('Aims Overview');
if ((await editorText()).includes(OLD)) fail('the replaced document is still in the editor');
const row = await idb('documents');
if (row.format?.defaults?.fontFamily !== 'Arial') fail('stored format lacks the fixture font: ' + JSON.stringify(row.format?.defaults));
if (!JSON.stringify(row.docJson).includes('Aims Overview')) fail('stored row lacks the imported text');
const pkg = await idb('docxPackages');
if (!row.importId || pkg?.importId !== row.importId) fail(`row and package do not share an importId (${row.importId} / ${pkg?.importId})`);
else ok('imported; row has the font and shares its importId with the package');

// 3. Ctrl+Z neither restores the replaced document nor blanks the import
await page.click('.ProseMirror');
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
const afterUndo = await editorText();
if (!afterUndo.includes('Aims Overview')) fail('Ctrl+Z after the import changed the imported document');
if (afterUndo.includes(OLD)) fail('Ctrl+Z brought the replaced document back'); else ok('Ctrl+Z after the import does nothing');

// 4. Restore previous document: the message button (shown after the import), then the File menu entry
const toastBtn = page.locator('.toast-enter button:has-text("Restore previous document")');
if (!(await toastBtn.count())) fail('no "Restore previous document" button after the import');
else {
  await toastBtn.click();
  await waitText(OLD);
  if ((await editorText()).includes('Aims Overview')) fail('the imported text is still there after restoring');
  const restored = await idb('documents');
  if (restored.importId) fail('the restored (non-imported) document still has an importId');
  if ((await idb('docxPackages')) !== null) fail('the imported package is still current after restoring a document that is not an import');
  ok('Restore previous document brought the replaced document back and took its package away');
}
// the File menu entry (the menu opens on hover)
await page.hover('button:has(svg.lucide-download)');
await page.click('.group button:has-text("Restore previous document")', { timeout: 5000 }).catch((e) => fail('no File menu entry: ' + e.message));
await waitText('Aims Overview');
const swapped = await idb('documents');
if (swapped.importId !== row.importId) fail('restoring again did not bring the import (and its identity) back');
else ok('File menu "Restore previous document" brought the import back');

// 5. headings: all start rejected, evidence shown, only the accepted one applied
await pick(fx('unstyled-sections.docx'));
const boxes = page.locator(`${dialog} input[type="checkbox"]`);
const nBoxes = await boxes.count();
if (nBoxes < 2) fail('expected several heading candidates, saw ' + nBoxes);
for (let i = 0; i < nBoxes; i++) if (await boxes.nth(i).isChecked()) fail('a candidate started accepted');
if ((await page.locator(`${dialog} [data-testid="evidence"] li`).count()) < nBoxes) fail('a candidate has no evidence');
await boxes.nth(0).check();
await page.click(`${dialog} button:has-text("Import with 1 heading")`);
await page.waitForSelector(dialog, { state: 'detached' });
await page.waitForFunction(() => document.querySelectorAll('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3').length >= 1);
const headings = await page.evaluate(() => document.querySelectorAll('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3').length);
if (headings !== 1) fail(`expected exactly the 1 accepted heading, the editor has ${headings}`); else ok(`${nBoxes} candidates shown rejected with evidence; 1 accepted, 1 heading in the editor`);

// 6. New Manuscript detaches the package
page.on('dialog', (d) => d.accept());
await page.click('button[title="New Manuscript"]');
await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent.includes('Abstract'));
await page.waitForTimeout(500);
await page.keyboard.press('Control+s').catch(() => {});
await page.evaluate(() => document.querySelector('input[placeholder], input')?.blur());
await page.waitForTimeout(31_000); // autosave interval
if ((await idb('docxPackages')) !== null) fail('New Manuscript left the imported package behind'); else ok('New Manuscript detached the package');
if ((await idb('documents')).importId) fail('New Manuscript kept the importId');

// 7. a reload shows what is stored
await page.reload();
await page.waitForSelector('.ProseMirror');
await waitText('Abstract');
ok('reload shows the stored document');

// 8. a real, large document does not freeze the page
if (existsSync(PRIVATE_R01)) {
  await page.evaluate(() => {
    window.__gaps = { max: 0, last: performance.now() };
    const tick = (t) => { window.__gaps.max = Math.max(window.__gaps.max, t - window.__gaps.last); window.__gaps.last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const t0 = Date.now();
  await page.setInputFiles('input[type="file"][accept*=".docx"]', PRIVATE_R01);
  await page.waitForSelector(dialog, { timeout: 120_000 });
  const readMs = Date.now() - t0;
  const gap = await page.evaluate(() => window.__gaps.max);
  const rows = await page.locator(`${dialog} [data-testid^="row-"]`).evaluateAll((els) => els.map((e) => e.textContent));
  console.log(`r01.docx: report after ${readMs} ms; longest gap between animation frames while reading ${Math.round(gap)} ms; rows: ${JSON.stringify(rows)}`);
  const t1 = Date.now();
  await page.click(`${dialog} button:has-text("Import")`);
  await page.waitForSelector(dialog, { state: 'detached' });
  console.log(`r01.docx: committed and shown after a further ${Date.now() - t1} ms; longest frame gap overall ${Math.round(await page.evaluate(() => window.__gaps.max))} ms`);
}
if (errors.length) console.log('page errors (informational):', errors.slice(0, 5));
await browser.close();
