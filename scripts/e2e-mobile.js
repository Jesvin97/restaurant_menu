// Drives the real app in a phone-sized browser and checks usability + CSP cleanliness.
// Needs Playwright (npx playwright install chromium). Usage: npm run e2e   [SHOTS=dir to save screenshots]
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
/* global document, innerWidth, getComputedStyle */ // the audit callback runs in the browser
const { chromium } = require('playwright');
const { Store } = require('../src/store');

const PORT = 3177, BASE = `http://localhost:${PORT}`, PW = 'e2e-pass-123';
const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-')), 'state.json');
const env = { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: PW, STATE_FILE: state, TABLE_COUNT: '4', GOOGLE_REVIEW_URL: 'https://g.page/r/demo/review', TRUST_PROXY: '' };
const shots = process.env.SHOTS;
const problems = [];
const fail = (m) => { problems.push(m); console.log('  ✗', m); };
const ok = (m) => console.log('  ✓', m);

async function audit(page, label) {
  const r = await page.evaluate(() => {
    const out = { overflow: document.scrollingElement.scrollWidth - innerWidth, small: [], zoom: [] };
    for (const el of document.querySelectorAll('button, a[href], input, label.chk, summary, select')) {
      const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (!b.width || !b.height || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
      if (el.type === 'checkbox' && el.closest('label')) continue; // the label is the tap target
      if (b.height < 36 || b.width < 36) out.small.push(`${el.tagName.toLowerCase()} "${(el.innerText || el.getAttribute('aria-label') || el.placeholder || '').trim().slice(0, 24)}" ${Math.round(b.width)}x${Math.round(b.height)}`);
      if (['INPUT'].includes(el.tagName) && !['checkbox', 'file'].includes(el.type) && parseFloat(cs.fontSize) < 16) out.zoom.push(el.placeholder || el.type);
    }
    return out;
  });
  if (r.overflow > 0) fail(`${label}: page scrolls sideways by ${r.overflow}px`);
  if (r.small.length) fail(`${label}: tap targets under 36px: ${r.small.slice(0, 4).join('; ')}`);
  if (r.zoom.length) fail(`${label}: inputs under 16px (iOS zooms): ${r.zoom.join(', ')}`);
  if (shots) await page.screenshot({ path: path.join(shots, `${label.replace(/\W+/g, '_')}.png`) });
}

(async () => {
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const sig = new Store(state).sign(2);
  const server = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1200));
  const browser = await chromium.launch();
  try {
    for (const vp of [{ width: 360, height: 640 }, { width: 390, height: 844 }]) {
      console.log(`\n== viewport ${vp.width}x${vp.height}`);
      const ctx = await browser.newContext({ viewport: vp, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
      const guest = await ctx.newPage(), staffCtx = await browser.newContext({ viewport: vp, hasTouch: true, isMobile: true });
      const staff = await staffCtx.newPage(), counter = await (await browser.newContext({ viewport: vp, isMobile: true })).newPage();
      for (const p of [guest, staff, counter]) {
        p.on('console', (m) => m.type() === 'error' && !/status of 401/.test(m.text()) && fail(`console error: ${m.text().slice(0, 140)}`));
        p.on('pageerror', (e) => fail(`page error: ${e.message}`));
        p.on('dialog', (d) => d.accept());
      }
      const tag = `${vp.width}`;

      await counter.goto(`${BASE}/menu`); await counter.waitForSelector('.item');
      await audit(counter, `${tag} counter menu`);

      await guest.goto(`${BASE}/t/2?s=${sig}`); await guest.waitForSelector('.pair');
      await audit(guest, `${tag} guest waiting`);
      const pair = await guest.locator('.pair').innerText();

      await staff.goto(`${BASE}/admin`); await staff.fill('input[type=password]', 'wrong'); await staff.click('button:has-text("Sign in")');
      await staff.waitForSelector('.err:has-text("Wrong password")'); ok('wrong password is refused');
      await staff.fill('input[type=password]', PW); await staff.click('button:has-text("Sign in")'); await staff.waitForSelector('.tabs');
      await staff.click('button.chip:has-text("Tables")'); await staff.waitForSelector(`button:has-text("Seat ${pair}")`);
      await audit(staff, `${tag} staff tables (guest waiting)`);
      await staff.click(`button:has-text("Seat ${pair}")`);

      await guest.waitForSelector('button.add', { timeout: 9000 }); await audit(guest, `${tag} guest menu`);
      await guest.click('button:has-text("Allergies")'); await guest.waitForSelector('.sheet'); await audit(guest, `${tag} allergy sheet`);
      await guest.click('.sheet button:has-text("Clear")');
      await guest.click('button.chip:has-text("Biryani")');
      const row = guest.locator('.item', { hasText: 'Chicken Dum Biryani' });
      await row.locator('.opt').nth(1).locator('button.add').click();
      await guest.click('button:has-text("Review order")'); await guest.waitForSelector('.sheet'); await audit(guest, `${tag} guest cart sheet`);
      await guest.click('button:has-text("Send to kitchen")'); await guest.waitForSelector('text=Ordered so far');
      if ((await guest.locator('body').innerText()).includes('₹240') && (await guest.locator('#ordered').innerText()).includes('₹')) fail('prices visible in guest order list'); else ok('guest order list shows no prices');
      await audit(guest, `${tag} guest after order`);

      await staff.click('button.chip:has-text("Orders")'); await staff.waitForSelector('text=Sent to kitchen'); await audit(staff, `${tag} staff live orders`);
      await staff.click('button:has-text("Sent to kitchen")'); await guest.waitForSelector('text=Being prepared', { timeout: 9000 }); ok('kitchen status reaches the guest');

      await guest.click('button:has-text("Ask for bill")'); await guest.waitForSelector('.sheet'); await audit(guest, `${tag} guest bill sheet`);
      await guest.fill('input[placeholder="Your name"]', '<b>Asha</b>'); await guest.fill('input[placeholder="Mobile number"]', '98765 43210');
      await guest.locator('label.chk input').first().check(); await guest.click('.sheet button:has-text("Ask for bill")');
      await guest.waitForSelector('text=Bill requested'); await audit(guest, `${tag} guest bill requested`);
      if (await guest.locator('#dock').isVisible()) fail('order dock still visible after the bill was requested'); else ok('dock hidden once the bill is requested');
      await staff.waitForSelector('button:has-text("Generate bill")', { timeout: 9000 }); await staff.click('button:has-text("Generate bill")');
      await guest.waitForSelector('text=Your bill', { timeout: 9000 }); await audit(guest, `${tag} guest bill`);
      if ((await guest.locator('body').innerText()).includes('<b>')) fail('markup in name rendered literally'); else ok('name with markup is inert');

      for (const t of ['Tables', 'Menu', 'Guests', 'Setup']) { await staff.click(`button.chip:has-text("${t}")`); await staff.waitForTimeout(700); await audit(staff, `${tag} staff ${t}`); }
      // table count: add one, QR appears
      await staff.click('button[aria-label="More tables"]'); await staff.click('button.btn:has-text("Save")'); await staff.waitForSelector('img[alt="QR code for Table 5"]'); ok('adding a table creates its QR');
      await staff.click('button.chip:has-text("Tables")'); await staff.click('button:has-text("Paid & close")'); await staff.waitForTimeout(500);
      await guest.reload(); await guest.waitForSelector('.pair'); ok('after payment the same URL only asks staff again (no ordering)');
      await ctx.close(); await staffCtx.close();
    }
  } finally { await browser.close(); server.kill(); }
  console.log(problems.length ? `\n${problems.length} problem(s)` : '\nAll mobile checks passed');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
