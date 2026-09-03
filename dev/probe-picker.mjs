#!/usr/bin/env node
// Dump the interactive elements INSIDE the composer model picker (after opening it).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PROFILE = process.argv[2] || './profile';
const out = process.argv[3] || './probe-picker-out.json';
const PROXY = process.env.CHATGPT_PROXY || 'http://192.168.50.10:7890';
const CHROME_ARGS = [`--proxy-server=${PROXY}`, '--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-features=AutomationControllerForContentScripts', '--disable-infobars'];

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false, proxy: { server: PROXY }, viewport: { width: 1440, height: 900 }, locale: 'en-US',
  args: CHROME_ARGS, ignoreDefaultArgs: ['--enable-automation'],
});
const page = (await ctx.pages())[0] || (await ctx.newPage());
await page.goto('https://chatgpt.com/?temporary-chat=true', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);

// Open the picker (click the "Pro" button)
const clicked = await page.evaluate(() => {
  const re = /^(pro|instant|ultra|fast|极速)$/i;
  for (const b of Array.from(document.querySelectorAll('button'))) {
    const r = b.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
    if (t && re.test(t)) {
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: t };
    }
  }
  return null;
});
if (clicked) { await page.mouse.click(clicked.x, clicked.y); await page.waitForTimeout(1500); }

// Dump all interactive elements inside the picker
const data = await page.evaluate(() => {
  const picker = document.querySelector('[data-testid="composer-model-picker"]') ||
    Array.from(document.querySelectorAll('div')).find((d) => (d.className || '').includes('d1BZWq') && d.getBoundingClientRect().width > 200);
  if (!picker) return { found: false };
  const items = [];
  for (const el of Array.from(picker.querySelectorAll('button, [role="slider"], [role="radio"], [role="option"], [role="menuitem"], input, [tabindex]'))) {
    const r = el.getBoundingClientRect();
    items.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      testid: el.getAttribute('data-testid') || '',
      aria: el.getAttribute('aria-label') || '',
      ariaValuenow: el.getAttribute('aria-valuenow') || '',
      ariaChecked: el.getAttribute('aria-checked') || '',
      ariaSelected: el.getAttribute('aria-selected') || '',
      tabindex: el.getAttribute('tabindex') || '',
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 90),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      visible: r.width > 4 && r.height > 4,
    });
    if (items.length > 80) break;
  }
  // full picker innerText for context
  return { found: true, items, text: (picker.innerText || '').replace(/\s+/g, ' ').slice(0, 600) };
});

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ clicked, ...data }, null, 2));
console.log('PICKER_PROBE_WRITTEN', out, 'found=', data && data.found);
await ctx.close();
process.exit(0);
