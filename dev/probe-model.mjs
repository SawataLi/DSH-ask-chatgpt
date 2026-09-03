#!/usr/bin/env node
// Probe the model/effort picker: open temp chat (logged-in profile), click the
// model/effort button near the composer, dump the resulting dialog structure.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PROFILE = process.argv[2] || './profile';
const out = process.argv[3] || './probe-model-out.json';
const PROXY = process.env.CHATGPT_PROXY || 'http://192.168.50.10:7890';
const CHROME_ARGS = [`--proxy-server=${PROXY}`, '--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-features=AutomationControllerForContentScripts', '--disable-infobars'];

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false, proxy: { server: PROXY }, viewport: { width: 1440, height: 900 }, locale: 'en-US',
  args: CHROME_ARGS, ignoreDefaultArgs: ['--enable-automation'],
});
const page = (await ctx.pages())[0] || (await ctx.newPage());
await page.goto('https://chatgpt.com/?temporary-chat=true', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);

// Find the model/effort button: a visible button in the composer/footer region
// whose text looks like a model or effort label (Pro, Instant, gpt-..., o..., Sol...).
const candidates = await page.evaluate(() => {
  const out = [];
  const btns = Array.from(document.querySelectorAll('button'));
  for (const b of btns) {
    const r = b.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
    const aria = b.getAttribute('aria-label') || '';
    const cls = (typeof b.className === 'string' ? b.className : '');
    // composer footer buttons are near the bottom of the viewport
    const nearBottom = r.top > window.innerHeight * 0.6;
    const interesting = /pro|instant|ultra|fast|gpt|o\d|sol|reason|effort|chat|work|temporary/i.test(t + ' ' + aria);
    if (nearBottom && (interesting || t.length < 20)) {
      out.push({ text: t.slice(0, 60), aria, cls: cls.slice(0, 70), top: Math.round(r.top), testid: b.getAttribute('data-testid') || '' });
    }
  }
  return out;
});

// Click the most likely model/effort button: prefer one whose text matches an
// effort/model label; else the one just left of the send button.
let clicked = null;
// The model/effort button is the composer-footer button whose text is an effort
// label (Pro/Instant/极速) or a model name (GPT-5.6 / Sol). Click the exact match.
clicked = await page.evaluate(() => {
  const re = /^(pro|instant|ultra|fast|极速|gpt[- ]?[\d.]+(sol)?|sol)$/i;
  const btns = Array.from(document.querySelectorAll('button'));
  for (const b of btns) {
    const r = b.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
    if (t && re.test(t)) { b.click(); return { text: t, by: 'effort-or-model-label' }; }
  }
  // fallback: button immediately before the send button
  const send = document.querySelector('[data-testid="send-button"], button[aria-label*="Send" i]');
  if (send) {
    let n = send.previousElementSibling;
    let hops = 0;
    while (n && hops < 6) {
      if (n.tagName === 'BUTTON') { n.click(); return { by: 'before-send', text: (n.innerText||'').trim().slice(0,40) }; }
      n = n.previousElementSibling; hops++;
    }
  }
  return null;
});
await page.waitForTimeout(1800);

// Dump the open dialog/picker: prefer an actual dialog/popover container;
// otherwise collect all visible option/radio/menuitem/switch elements anywhere.
const picker = await page.evaluate(() => {
  const out = { containers: [], items: [] };
  const containers = Array.from(document.querySelectorAll('[role="dialog"],[role="listbox"],[role="menu"],[role="listbox"] > *,[data-testid*="popover"],[class*="popover"],[class*="Popover"],[class*="menu"],[class*="dropdown"]'));
  for (const c of containers) {
    const r = c.getBoundingClientRect();
    if (r.width < 100 || r.height < 40) continue;
    out.containers.push({ tag: c.tagName.toLowerCase(), role: c.getAttribute('role') || '', testid: c.getAttribute('data-testid') || '', cls: (typeof c.className==='string'?c.className:'').slice(0,80), w: Math.round(r.width), h: Math.round(r.height) });
  }
  const sels = '[role="option"],[role="menuitem"],[role="radio"],[role="switch"],[role="tab"],select option';
  for (const el of Array.from(document.querySelectorAll(sels))) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    out.items.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      testid: el.getAttribute('data-testid') || '',
      aria: el.getAttribute('aria-label') || '',
      ariaSelected: el.getAttribute('aria-selected') || '',
      ariaChecked: el.getAttribute('aria-checked') || '',
      value: el.getAttribute('value') || '',
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90),
    });
    if (out.items.length > 120) break;
  }
  return out;
});

const result = { url: page.url(), title: await page.title(), candidates, clicked, picker };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log('MODEL_PROBE_WRITTEN', out);
await ctx.close();
process.exit(0);
