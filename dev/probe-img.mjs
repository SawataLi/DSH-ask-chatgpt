#!/usr/bin/env node
// Probe the real DOM of an image-generation message: send an image request in
// a REGULAR chat, wait for completion, then dump image/message structure.
import { chromium } from 'playwright';
import fs from 'node:fs';

const PROFILE = process.argv[2] || './profile';
const PROXY = process.env.CHATGPT_PROXY || 'http://192.168.50.10:7890';
const CHROME_ARGS = [`--proxy-server=${PROXY}`, '--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-features=AutomationControllerForContentScripts', '--disable-infobars'];
const TASK = 'Generate one image: a single red square on a white background. No text, no watermark.';

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false, proxy: { server: PROXY }, viewport: { width: 1440, height: 900 }, locale: 'en-US',
  args: CHROME_ARGS, ignoreDefaultArgs: ['--enable-automation'],
});
const log = (...a) => console.log('[imgprobe]', ...a);

const page = await ctx.newPage();
await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);
log('url=', page.url(), 'title=', await page.title());

// composer (visible one)
let composerSel = null;
for (const s of ['div[role="textbox"][aria-label*="Chat with ChatGPT" i]', '#mobile-composer-prompt', 'textarea']) {
  try {
    const loc = page.locator(s).first();
    if (await loc.isVisible().catch(() => false)) { composerSel = s; break; }
  } catch {}
}
log('composerSel=', composerSel);
const composer = page.locator(composerSel).first();
await composer.fill(TASK).catch(async () => { await composer.click().catch(()=>{}); await page.keyboard.type(TASK, { delay: 3 }); });
log('typed ok');

// picker → instant
const trig = await page.evaluate(() => {
  const re = /^(pro|instant)$/i;
  for (const b of Array.from(document.querySelectorAll('button'))) {
    const r = b.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
    if (t && re.test(t)) return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: t };
  }
  return null;
});
log('trigger=', JSON.stringify(trig));
if (trig) {
  await page.mouse.click(trig.x, trig.y);
  await page.waitForTimeout(1000);
  const slider = page.locator('[role="slider"]').first();
  if (await slider.isVisible().catch(() => false)) {
    await slider.focus().catch(() => {});
    await page.keyboard.press('Home'); // instant
    await page.waitForTimeout(600);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

// send
const sendBtn = page.locator('[data-testid="send-button"], button[aria-label="Send prompt"]').first();
if (await sendBtn.isVisible().catch(() => false)) await sendBtn.click({ timeout: 3000 }).catch((e) => log('send fail', e.message));
else await page.keyboard.press('Enter');
log('sent');

// wait up to 180s for completion: stop button gone + send button back
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(3000);
  const st = await page.evaluate(() => {
    const stop = Array.from(document.querySelectorAll('button')).find((b) => /stop/i.test(b.getAttribute('aria-label') || ''));
    const send = document.querySelector('[data-testid="send-button"]');
    const imgs = Array.from(document.querySelectorAll('img')).filter((im) => { const r = im.getBoundingClientRect(); return r.width > 60 && r.height > 60; });
    return {
      stop: stop ? stop.getAttribute('aria-label') : null,
      send: send ? send.getAttribute('aria-label') : null,
      bigImgs: imgs.length,
      bodyTail: (document.body ? document.body.innerText : '').slice(-160).replace(/\n/g, ' | '),
    };
  }).catch((e) => ({ err: e.message }));
  console.log('obs', i, JSON.stringify(st));
  if (st.stop === null && st.send === 'Send prompt' && st.bigImgs >= 1) { log('DONE with image'); break; }
  if (st.stop === null && st.send === 'Send prompt' && /smaller|again|text/i.test(st.bodyTail || '')) { log('DONE (refinement prompt)'); }
}

// dump structure
const dump = await page.evaluate(() => {
  const out = {};
  // assistant message candidates
  const roleMsgs = Array.from(document.querySelectorAll('[data-message-author-role]'));
  out.roleMsgCount = roleMsgs.length;
  const last = roleMsgs[roleMsgs.length - 1];
  if (last) {
    out.lastRole = last.getAttribute('data-message-author-role');
    const imgs = Array.from(last.querySelectorAll('img'));
    out.lastImgs = imgs.map((im) => ({ src: String(im.src || '').slice(0, 120), w: im.naturalWidth, cls: String(im.className || '').slice(0, 40) }));
    out.lastCanvas = last.querySelectorAll('canvas').length;
    out.lastText = (last.innerText || '').slice(0, 300).replace(/\n/g, ' | ');
    // parent chain with class hints
    let n = last; const chain = [];
    for (let h = 0; h < 5 && n; h++) { chain.push({ tag: n.tagName, cls: (typeof n.className === 'string' ? n.className : '').slice(0, 60), attr: n.getAttribute('data-message-author-role') || n.getAttribute('data-testid') || '' }); n = n.parentElement; }
    out.chain = chain;
  }
  // all big images anywhere
  out.allBigImgs = Array.from(document.querySelectorAll('img')).filter((im) => { const r = im.getBoundingClientRect(); return r.width > 60 && r.height > 60; }).map((im) => ({ src: String(im.src || '').slice(0, 120), alt: String(im.alt || '').slice(0, 40) }));
  return out;
});
console.log('DUMP:', JSON.stringify(dump, null, 1).slice(0, 4000));

await page.screenshot({ path: '/home/dgx-sawata/.dsh/chatgpt-bridge/probe-img.png' }).catch(() => {});
log('screenshot saved');
await ctx.close();
process.exit(0);
