// Capture a clean product screenshot of the noxed UI mockup that lives in the
// landing page (docs/index.html — the same thing served at noxed.app).
//
// It renders the interactive `.appwin` mockup in headless Chrome and saves an
// element-only PNG with transparent corners, so there is no real server data,
// no animated starfield, and nothing to redact.
//
// Usage:
//   npm i -D puppeteer-core          # one-off; uses your installed Chrome
//   node scripts/capture-screenshot.mjs [view] [outfile]
//
//   view    one of: terminal (default), dashboard, database, k8s, sftp
//   outfile default: docs/screenshot.png
//
// Point CHROME_PATH at a Chrome/Chromium binary if the default below is wrong.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const VIEW = process.argv[2] || 'terminal';
const OUT = path.resolve(process.argv[3] || path.join(ROOT, 'docs/screenshot.png'));
const PAGE = pathToFileURL(path.join(ROOT, 'docs/index.html')).href;
const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1400, deviceScaleFactor: 2 });
await page.goto(PAGE, { waitUntil: 'networkidle0', timeout: 60000 });
await page.evaluate(() => document.fonts.ready);

// Strip everything behind the window so the rounded corners come out transparent.
await page.evaluate(() => {
  const c = document.getElementById('scene');
  if (c) c.style.display = 'none';
  for (const sel of ['html', 'body', '.hero', '.hero-inner']) {
    const n = document.querySelector(sel);
    if (n) n.style.background = 'transparent';
  }
  const s = document.createElement('style');
  s.textContent = '.hero::after,.hero::before{display:none!important}';
  document.head.appendChild(s);
  document.querySelector('.appwin').scrollIntoView({ block: 'center' });
});

// Clicking a tab permanently stops the page's auto-rotation and activates the view.
await page.click(`.aw-tab[data-goto="${VIEW}"]`);
await sleep(400);

const el = await page.$('.appwin');

if (VIEW === 'terminal') {
  // The terminal types on a loop; sample a full cycle and keep the fullest frame.
  let maxLen = -1;
  for (let i = 0; i < 60; i++) {
    await sleep(350);
    const len = await page.evaluate(
      () => (document.getElementById('term-body')?.innerText || '').length,
    );
    if (len > maxLen) {
      maxLen = len;
      await el.screenshot({ path: OUT, omitBackground: true });
    }
  }
} else {
  await sleep(600);
  await el.screenshot({ path: OUT, omitBackground: true });
}

await browser.close();
console.log(`Wrote ${path.relative(ROOT, OUT)} (${VIEW} view)`);
