// Serves docs/ locally and saves a screenshot of the dashboard into assets/dashboard.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('assets', { recursive: true });

const PORT = 4173;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', 'docs'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1.5 });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('body[data-ready]');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(3500); // let the intro animations finish
  await page.screenshot({ path: 'assets/dashboard.png', fullPage: true });
  console.log('Saved assets/dashboard.png');
} finally {
  await browser.close();
  server.kill();
}
