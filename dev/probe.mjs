#!/usr/bin/env node
// One-shot DOM probe: opens chatgpt.com headful (fresh or given profile), dumps structure.
// Usage: node probe.mjs [url] [profileDir] [outFile]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2] || 'https://chatgpt.com/?temporary-chat=true';
const profile = process.argv[3] || './profile-probe';
const out = process.argv[4] || './probe-out.json';
const PROXY = process.env.CHATGPT_PROXY || 'http://192.168.50.10:7890';

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  proxy: { server: PROXY },
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  args: [`--proxy-server=${PROXY}`, '--no-sandbox'],
});
const page = (await ctx.pages())[0] || (await ctx.newPage());
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);

const data = await page.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.top < window.innerHeight + 200 && r.bottom > -200; };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const els = [];
  const nodes = Array.from(document.querySelectorAll('a, button, textarea, input, [contenteditable="true"], [role="option"], [role="menuitem"], [role="listbox"], [role="dialog"], [role="combobox"], [role="switch"], select'));
  for (const el of nodes) {
    if (!vis(el)) continue;
    els.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      testid: el.getAttribute('data-testid') || '',
      aria: el.getAttribute('aria-label') || '',
      id: el.id || '',
      cls: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 80),
      text: clean(el.innerText || el.value || el.getAttribute('placeholder') || ''),
      href: el.tagName === 'A' ? el.getAttribute('href') || '' : '',
    });
    if (els.length > 200) break;
  }
  const imgs = Array.from(document.querySelectorAll('img')).filter(vis).slice(0, 30).map((i) => ({ alt: i.alt || '', src: (i.src || '').slice(0, 160) }));
  return {
    url: location.href,
    title: document.title,
    bodyText: clean(document.body ? document.body.innerText : '').slice(0, 1500),
    els,
    imgs,
  };
});

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(data, null, 2));
console.log('PROBE_WRITTEN', out);
await ctx.close();
process.exit(0);
