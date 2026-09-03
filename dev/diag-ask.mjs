#!/usr/bin/env node
// Diagnostic ask: replicate doAsk step by step with logging; 90s observation
// window after send; final screenshot.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PROFILE = process.argv[2] || './profile';
const PROXY = process.env.CHATGPT_PROXY || 'http://192.168.50.10:7890';
const CHROME_ARGS = [`--proxy-server=${PROXY}`, '--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-features=AutomationControllerForContentScripts', '--disable-infobars'];
const TASK = 'Reply with exactly this text and nothing else: OK-TEST-123';

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false, proxy: { server: PROXY }, viewport: { width: 1440, height: 900 }, locale: 'en-US',
  args: CHROME_ARGS, ignoreDefaultArgs: ['--enable-automation'],
});
const log = (...a) => console.log('[diag]', ...a);

const page = await ctx.newPage();
await page.goto('https://chatgpt.com/?temporary-chat=true', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);
log('url=', page.url(), 'title=', await page.title());

// composer
const comp = await page.evaluate(() => {
  const sels = ['div[role="textbox"][aria-label*="Chat with ChatGPT" i]', '[contenteditable="true"][aria-label*="ChatGPT" i]', '#mobile-composer-prompt', 'textarea.wm-composer-textarea', 'textarea[aria-label*="Chat with ChatGPT" i]', 'footer textarea', 'textarea'];
  for (const s of sels) {
    const el = document.querySelector(s);
    if (el) { const r = el.getBoundingClientRect(); if (r.width > 4 && r.height > 4) return { sel: s, w: Math.round(r.width), h: Math.round(r.height), tag: el.tagName, contenteditable: el.getAttribute('contenteditable') }; }
  }
  return null;
});
log('composer=', JSON.stringify(comp));

// model trigger
const trigger = await page.evaluate(() => {
  const send = document.querySelector('[data-testid="send-button"], button[aria-label*="Send" i]');
  if (send) {
    const sr = send.getBoundingClientRect();
    log2 = { sendAria: send.getAttribute('aria-label'), sendTid: send.getAttribute('data-testid'), sendTop: Math.round(sr.top) };
    let n = send.previousElementSibling, hops = 0;
    const chain = [];
    while (n && hops < 8) { chain.push({ tag: n.tagName, text: (n.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30), cls: (typeof n.className === 'string' ? n.className : '').slice(0, 50) }); n = n.previousElementSibling; hops++; }
    return { send: true, sendAria: send.getAttribute('aria-label'), chain };
  }
  return { send: false };
});
log('sendBtn/prevChain=', JSON.stringify(trigger).slice(0, 900));

// open picker
const trigPos = await page.evaluate(() => {
  const re = /^(pro|pro extended|instant|medium|high|extra high|极速)$/i;
  for (const b of Array.from(document.querySelectorAll('button'))) {
    const r = b.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
    if (t && re.test(t)) return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: t };
  }
  return null;
});
log('trigger=', JSON.stringify(trigPos));
if (trigPos) {
  await page.mouse.click(trigPos.x, trigPos.y);
  await page.waitForTimeout(1000);
  const pickerState = await page.evaluate(() => {
    const slider = document.querySelector('[role="slider"]');
    const menuitems = Array.from(document.querySelectorAll('[role="menuitem"]')).map((m) => (m.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50));
    return { sliderVisible: slider ? slider.getBoundingClientRect().width > 4 : false, valuenow: slider ? slider.getAttribute('aria-valuenow') : null, menuitems };
  });
  log('picker=', JSON.stringify(pickerState));
  // set instant (test) then back to pro
  const slider = page.locator('[role="slider"]').first();
  if (await slider.isVisible().catch(() => false)) {
    await slider.focus().catch(() => {});
    await page.keyboard.press('Home');
    await page.waitForTimeout(600);
    const afterHome = await page.evaluate(() => {
      const s = document.querySelector('[role="slider"]');
      const re = /^(pro|instant)$/i;
      let label = null;
      for (const b of Array.from(document.querySelectorAll('button'))) { const t = (b.innerText||'').trim(); if (t && re.test(t)) { label = t; break; } }
      return { valuenow: s ? s.getAttribute('aria-valuenow') : null, label };
    });
    log('after Home=', JSON.stringify(afterHome));
    await page.keyboard.press('End');
    await page.waitForTimeout(600);
    const afterEnd = await page.evaluate(() => {
      const s = document.querySelector('[role="slider"]');
      const re = /^(pro|instant)$/i;
      let label = null;
      for (const b of Array.from(document.querySelectorAll('button'))) { const t = (b.innerText||'').trim(); if (t && re.test(t)) { label = t; break; } }
      return { valuenow: s ? s.getAttribute('aria-valuenow') : null, label };
    });
    log('after End=', JSON.stringify(afterEnd));
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

// type + send
const compLoc = page.locator('div[role="textbox"][aria-label*="Chat with ChatGPT" i], textarea#mobile-composer-prompt, textarea').first();
await compLoc.click({ timeout: 5000 }).catch((e) => log('composer click fail', e.message));
await page.keyboard.type(TASK, { delay: 5 });
await page.waitForTimeout(500);
const typed = await page.evaluate(() => {
  const el = document.querySelector('div[role="textbox"][aria-label*="Chat with ChatGPT" i]') || document.querySelector('#mobile-composer-prompt');
  return el ? (el.innerText || el.value || '').slice(0, 80) : null;
});
log('typed=', JSON.stringify(typed));
const sendBtn = page.locator('[data-testid="send-button"], button[aria-label*="Send" i]').first();
const sendEnabled = await sendBtn.isEnabled().catch(() => false);
log('sendBtn enabled=', sendEnabled);
if (sendEnabled) { await sendBtn.click({ timeout: 3000 }).catch((e) => log('send click fail', e.message)); }
else { await page.keyboard.press('Enter'); log('pressed Enter instead'); }
await page.waitForTimeout(2000);
log('post-send url=', page.url());

// observe 90s
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(3000);
  const st = await page.evaluate(() => {
    const send = document.querySelector('[data-testid="send-button"]');
    const stop = Array.from(document.querySelectorAll('button')).find((b) => /stop/i.test(b.getAttribute('aria-label') || ''));
    const roleMsgs = document.querySelectorAll('[data-message-author-role]').length;
    const body = document.body ? document.body.innerText : '';
    const userBubbles = Array.from(document.querySelectorAll('div')).filter((d) => d.textContent && d.textContent.trim().startsWith('Reply with exactly') && d.getBoundingClientRect().width > 100).length;
    return {
      sendAria: send ? send.getAttribute('aria-label') : null,
      sendTid: send ? send.getAttribute('data-testid') : null,
      stopAria: stop ? stop.getAttribute('aria-label') : null,
      roleMsgCount: roleMsgs,
      bodyLen: body.length,
      bodyTail: body.slice(-220).replace(/\n/g, ' | '),
    };
  }).catch((e) => ({ err: e.message }));
  console.log(`obs${i}:`, JSON.stringify(st));
  if (st.stopAria === null && st.bodyLen > 0 && /OK-TEST-123/.test(st.bodyTail || '')) { console.log('LOOKS_DONE'); break; }
}

await page.screenshot({ path: '/home/dgx-sawata/.dsh/chatgpt-bridge/diag-ask.png' }).catch(() => {});
log('screenshot saved');
await ctx.close();
process.exit(0);
