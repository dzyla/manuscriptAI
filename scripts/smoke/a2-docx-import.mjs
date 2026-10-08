// A2a smoke: open a Word document through the file input. The report dialog appears, Cancel leaves the open document untouched, Import
// replaces it, the editor shows the document's text, the stored row carries the document's font, Ctrl+Z does NOT bring the replaced
// document back (or blank the import), and a reload shows the imported document.
// NOT RUN as part of task 11 (that task had no dev server and no browser); run it before relying on it.
// Usage: npm run dev (port 3000) in another terminal, then:
//   npm i --no-save playwright && npx playwright install chromium && node scripts/smoke/a2-docx-import.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const URL = process.env.APP_URL ?? 'http://localhost:3000';
const FIXTURE = fileURLToPath(new globalThis.URL('../../src/test/fixtures/docx/body-basics.docx', import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage();
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

const readRow = () => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('ManuscriptAIEditor');
  req.onsuccess = () => {
    const get = req.result.transaction('documents').objectStore('documents').get('current');
    get.onsuccess = () => { resolve(get.result); req.result.close(); };
  };
}));
const editorText = () => page.evaluate(() => document.querySelector('.ProseMirror').textContent);

await page.goto(URL);
await page.waitForSelector('.ProseMirror');
await page.click('.ProseMirror p:last-of-type');
await page.keyboard.type('the document that is open before the import');

// 1. Cancel leaves everything as it was
await page.setInputFiles('input[type="file"][accept*=".docx"]', FIXTURE);
await page.waitForSelector('[data-testid="import-report-dialog"]');
await page.click('[data-testid="import-report-dialog"] button:has-text("Cancel")');
await page.waitForSelector('[data-testid="import-report-dialog"]', { state: 'detached' });
if (!(await editorText()).includes('the document that is open before the import')) fail('Cancel changed the open document');

// 2. Import replaces it
await page.setInputFiles('input[type="file"][accept*=".docx"]', FIXTURE);
await page.waitForSelector('[data-testid="import-report-dialog"]');
await page.click('[data-testid="import-report-dialog"] button:has-text("Import")');
await page.waitForSelector('[data-testid="import-report-dialog"]', { state: 'detached' });
await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent.includes('Aims Overview'));
if ((await editorText()).includes('the document that is open before the import')) fail('the replaced document is still in the editor');

const row = await readRow();
if (row.format?.defaults?.fontFamily !== 'Arial') fail('stored format lacks the fixture font: ' + JSON.stringify(row.format?.defaults));
if (!JSON.stringify(row.docJson).includes('Aims Overview')) fail('stored row lacks the imported text');

// 3. Ctrl+Z neither restores the replaced document nor blanks the import
await page.click('.ProseMirror');
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
if (!(await editorText()).includes('Aims Overview')) fail('Ctrl+Z after the import changed the imported document');
if ((await editorText()).includes('the document that is open before the import')) fail('Ctrl+Z brought the replaced document back');

// 4. It is what a reload shows
await page.reload();
await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent.includes('Aims Overview'));
if (errors.length) console.log('page errors (informational):', errors.slice(0, 5));
await browser.close();
