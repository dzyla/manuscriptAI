// A1 smoke: legacy document migrates, edits persist across reload, row stores JSON not HTML.
// Usage: npm run dev (port 3000) in another terminal, then:
//   npm i --no-save playwright && npx playwright install chromium && node scripts/smoke/a1-persistence.mjs
import { chromium } from 'playwright';

const URL = process.env.APP_URL ?? 'http://localhost:3000';
const browser = await chromium.launch();
const page = await browser.newPage();
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };

await page.goto(URL);
// Seed a legacy v2 row directly, then reload so the app migrates it.
await page.evaluate(async () => {
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('ManuscriptAIEditor');
    req.onsuccess = () => {
      const tx = req.result.transaction('documents', 'readwrite');
      tx.objectStore('documents').put({ id: 'current', title: 'Smoke', content: '<h2>Aims</h2><p>legacy smoke text</p>', saveState: 'Saved', citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0, updatedAt: 1 });
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
});
await page.reload();
await page.waitForSelector('.ProseMirror');
if (!(await page.textContent('.ProseMirror')).includes('legacy smoke text')) fail('legacy text not shown after migration');

await page.click('.ProseMirror p:last-of-type');
await page.keyboard.press('End');
await page.keyboard.type(' plus an edit');
await page.waitForTimeout(31_000); // autosave interval

const row = await page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('ManuscriptAIEditor');
  req.onsuccess = () => {
    const get = req.result.transaction('documents').objectStore('documents').get('current');
    get.onsuccess = () => { resolve(get.result); req.result.close(); };
  };
}));
if (row.content !== undefined) fail('row still stores HTML content');
if (!JSON.stringify(row.docJson).includes('plus an edit')) fail('edit not persisted in docJson');

await page.reload();
await page.waitForSelector('.ProseMirror');
if (!(await page.textContent('.ProseMirror')).includes('plus an edit')) fail('edit lost after reload');

await browser.close();
if (!process.exitCode) console.log('A1 smoke: PASS');
