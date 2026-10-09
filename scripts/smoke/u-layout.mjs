// Throwaway: the single sanctioned browser run for sub-project U (layout restructure).
// Usage: npm run dev   (in one shell, port 3000)
//        node scripts/smoke/u-layout.mjs
// Needs Playwright. The repo does not depend on it: install it outside the project and point at it, e.g.
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright-core/index.mjs [CHROME_PATH=/path/to/chrome] node scripts/smoke/u-layout.mjs
// Checks: the four rail panels open; the page canvas renders at a width in inches; the status bar shows an
// approximate page count; at rest the top bar holds no more than 8 controls; the console is clean; and, at 50% and
// 200% zoom (CSS `zoom` on the canvas), ProseMirror's coordsAtPos/posAtCoords still agree and the fixed-position
// citation picker still opens beside the caret.
const USAGE = 'Usage: npm run dev (port 3000) in one shell, then\n  PLAYWRIGHT_MODULE=/path/to/node_modules/playwright-core/index.mjs [CHROME_PATH=/path/to/chrome] [APP_URL=http://localhost:3000] node scripts/smoke/u-layout.mjs';
const die = (msg) => { console.error(`${msg}\n${USAGE}`); process.exit(2); };
let chromium;
try { ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')); }
catch (e) { die(`Cannot load Playwright (${e.code ?? e.message}). It is not a repo dependency.`); }

const URL = process.env.APP_URL ?? 'http://localhost:3000';
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await browser.newPage({ viewport: { width: 2600, height: 1300 } });
let failed = 0;
const ok = (msg) => console.log(`ok   ${msg}`);
const fail = (msg) => { failed++; console.log(`FAIL ${msg}`); };
const check = (cond, pass, bad) => (cond ? ok(pass) : fail(bad ?? pass));

const BENIGN = [/favicon/i, /Failed to load resource/i, /net::ERR_/i, /fonts\.(googleapis|gstatic)/i];
const errors = [];
const benign = [];
const note = (t) => (BENIGN.some(re => re.test(t)) ? benign : errors).push(t);
page.on('pageerror', (e) => note(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') note(`console.error: ${m.text()}`); });

try { await page.goto(URL); }
catch (e) { await browser.close(); die(`Cannot reach ${URL} (${e.message.split('\n')[0]}). Is the dev server running?`); }
await page.waitForSelector('.ProseMirror');
await page.waitForSelector('[data-testid="page-canvas"]');

// 1. The four rail panels open (the active one is skipped: clicking it closes the panel).
const VIEW = { write: 'write-view', cite: 'cite-view', review: 'review-view', format: 'format-view' };
for (const task of ['write', 'cite', 'review', 'format']) {
  const btn = page.locator(`nav[aria-label="Tasks"] button[aria-label^="${task[0].toUpperCase()}${task.slice(1)} "]`);
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click();
  const panel = page.locator(`.u-shell-panel[data-task="${task}"]`);
  // The panel's tab follows the rail one render later, so wait for the content rather than sampling it.
  const content = await page.getByTestId(VIEW[task]).waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
  const visible = await panel.isVisible();
  check(visible && content, `rail: ${task} panel opens`, `rail: ${task} panel did not open (panel ${visible}, content ${content})`);
}

// 2. The page canvas has a width in inches.
const canvasWidth = await page.getByTestId('page-canvas').evaluate(el => el.style.width);
check(/^\d+(\.\d+)?in$/.test(canvasWidth), `page canvas renders at ${canvasWidth}`, `page canvas width is "${canvasWidth}", not inches`);

// 3. The status bar shows an approximate page count.
const pages = await page.locator('.u-status-pages').innerText();
check(/~\d+/.test(pages), `status bar shows an approximate page count: "${pages}"`, `status bar page count "${pages}" does not match /~\\d+/`);

// 4. At rest the top bar holds no more than 8 controls.
const controls = await page.locator('.u-shell-top').locator('button, input, select, textarea, [role="combobox"]').evaluateAll(els => els.filter(e => e.offsetParent !== null).map(e => e.getAttribute('data-testid') || e.getAttribute('aria-label') || e.textContent.trim().slice(0, 20)));
check(controls.length <= 8, `top bar at rest holds ${controls.length} controls (${controls.join(', ')})`, `top bar at rest holds ${controls.length} controls (> 8): ${controls.join(', ')}`);

// 5. Zoom. Close the panel so the canvas has room, then drive the zoom through the overflow menu.
const open = await page.locator('nav[aria-label="Tasks"] button[aria-pressed="true"]').count();
if (open) await page.locator('nav[aria-label="Tasks"] button[aria-pressed="true"]').click();
await page.locator('.ProseMirror').click();
await page.keyboard.press('Control+End');
await page.keyboard.type('Zoom probe sentence one. Zoom probe sentence two.');

const setZoom = async (target) => {
  await page.getByTestId('topbar-overflow').click();
  const label = () => page.getByTestId('item-zoom-in').innerText();
  for (let i = 0; i < 30; i++) {
    const cur = Number((await label()).match(/\((\d+)%\)/)[1]);
    if (cur === target) break;
    await page.getByTestId(cur < target ? 'item-zoom-in' : 'item-zoom-out').click();
  }
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 650);
  await page.waitForTimeout(300);
};

const zoomProbe = async (target) => {
  await setZoom(target);
  const applied = await page.getByTestId('page-canvas').evaluate(el => Number(getComputedStyle(el).zoom));
  check(Math.abs(applied - target / 100) < 0.01, `zoom ${target}%: canvas CSS zoom is ${applied}`, `zoom ${target}%: canvas CSS zoom is ${applied}, not ${target / 100} (fit-to-width is capping the request)`);
  // coordsAtPos <-> posAtCoords round trip, at the start, middle and end of the last paragraph.
  const trip = await page.evaluate(() => {
    const view = document.querySelector('.ProseMirror').editor?.view;
    if (!view) return { error: 'no editor view on the .ProseMirror element' };
    const end = view.state.doc.content.size - 1;
    const out = [];
    for (const pos of [end - 40, end - 20, end - 1]) {
      const c = view.coordsAtPos(pos);
      const hit = view.posAtCoords({ left: c.left + 0.5, top: (c.top + c.bottom) / 2 });
      out.push({ pos, hit: hit?.pos ?? null });
    }
    return { out };
  });
  if (trip.error) fail(`zoom ${target}%: ${trip.error}`);
  else check(trip.out.every(t => t.hit !== null && Math.abs(t.hit - t.pos) <= 1), `zoom ${target}%: posAtCoords(coordsAtPos(p)) returns p within 1 (${trip.out.map(t => `${t.pos}->${t.hit}`).join(', ')})`,
    `zoom ${target}%: coordsAtPos/posAtCoords disagree (${trip.out.map(t => `${t.pos}->${t.hit}`).join(', ')})`);
  // A real click lands where the coordinates say it should.
  const click = await page.evaluate(() => {
    const view = document.querySelector('.ProseMirror').editor.view;
    const pos = view.state.doc.content.size - 10;
    const c = view.coordsAtPos(pos);
    return { x: c.left + 0.5, y: (c.top + c.bottom) / 2, pos };
  });
  await page.mouse.click(click.x, click.y);
  const sel = await page.evaluate(() => document.querySelector('.ProseMirror').editor.view.state.selection.from);
  check(Math.abs(sel - click.pos) <= 1, `zoom ${target}%: a mouse click at the coordinates of ${click.pos} puts the caret at ${sel}`, `zoom ${target}%: click aimed at ${click.pos} put the caret at ${sel}`);
  // The fixed-position citation picker opens beside the caret.
  await page.keyboard.press('End');
  await page.keyboard.type(' @');
  const picker = page.getByText('Insert Citation').first();
  await picker.waitFor({ timeout: 3000 }).catch(() => {});
  if (!(await picker.isVisible())) { fail(`zoom ${target}%: the @ citation picker did not open`); }
  else {
    const box = await picker.locator('xpath=ancestor::div[contains(@class,"fixed")][1]').boundingBox();
    const caret = await page.evaluate(() => { const v = document.querySelector('.ProseMirror').editor.view; const c = v.coordsAtPos(v.state.selection.from); return { left: c.left, bottom: c.bottom, top: c.top }; });
    const dx = Math.abs(box.x - caret.left), dy = box.y - caret.bottom;
    check(dx <= 60 && dy >= -10 && dy <= 60, `zoom ${target}%: citation picker sits beside the caret (dx ${dx.toFixed(0)}px, dy ${dy.toFixed(0)}px)`, `zoom ${target}%: citation picker is displaced from the caret (dx ${dx.toFixed(0)}px, dy ${dy.toFixed(0)}px)`);
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
};
await zoomProbe(50);
await zoomProbe(200);
await setZoom(100);

// 6. The console is clean.
if (benign.length) console.log(`note ${benign.length} benign console message(s) ignored (favicon / network / font loads)`);
check(errors.length === 0, 'console is clean', `console has ${errors.length} error(s):\n  ${errors.join('\n  ')}`);

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
