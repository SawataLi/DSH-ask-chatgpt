#!/usr/bin/env node
// Diff-based probe: snapshot visible text elements, click the Pro button,
// snapshot again, report NEW elements (the picker content).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PROFILE = process.argv[2] || './profile';
const out = process.argv[3] || './probe-diff-out.json';
const PROXY = process.env.CHATGPT_PROXY || 'http://192.168.50.10:7890';
const CHROME_ARGS = [`--proxy-server=${PROXY}`, '--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-features=AutomationControllerForContentScripts', '--disable-infobars'];

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false, proxy: { server: PROXY }, viewport: { width: 1440, height: 900 }, locale: 'en-US',
  args: CHROME_ARGS, ignoreDefaultArgs: ['--enable-automation'],
});
const page = (await ctx.pages())[0] || (await ctx.newPage());
await page.goto('https://chatgpt.com/?temporary-chat=true', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);

const snapshot = () => page.evaluate(() => {
  const out = [];
  const els = Array.from(document.querySelectorAll('div,span,button,a,li,p,h1,h2,h3,h4,svg'));
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6 || r.top < -50 || r.top > window.innerHeight + 50) continue;
    // only leaf-ish text (few text nodes directly)
    const directText = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    const t = (directText || (el.innerText || '').trim()).replace(/\s+/g, ' ');
    if (!t || t.length > 100) continue;
    const tag = el.tagName.toLowerCase();
    out.push(`${tag}|${el.getAttribute('data-testid')||''}|${el.getAttribute('aria-label')||''}|${el.getAttribute('role')||''}|${el.className && typeof el.className==='string' ? el.className.slice(0,60) : ''}|${t}`);
  }
  return out;
});

const before = await snapshot();
const beforeSet = new Set(before);

// Click the Pro button with a real mouse event (playwright pointer), not el.click()
const clicked = await page.evaluate(() => {
  const re = /^(pro|instant|ultra|fast|极速)$/i;
  const btns = Array.from(document.querySelectorAll('button'));
  for (const b of btns) {
    const r = b.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
    if (t && re.test(t)) {
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: t };
    }
  }
  return null;
});
let clickResult = null;
if (clicked) {
  await page.mouse.click(clicked.x, clicked.y);
  clickResult = clicked;
  await page.waitForTimeout(2000);
}

const after = await snapshot();
const fresh = after.filter((line) => !beforeSet.has(line));

// Also: did the button label change (instant toggle)?
const proNow = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  return btns.map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 30).slice(0, 60);
});

const result = { clicked: clickResult, freshCount: fresh.length, fresh: fresh.slice(0, 120), buttonTextsNow: proNow };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log('DIFF_PROBE_WRITTEN', out, 'fresh=', fresh.length);
await ctx.close();
process.exit(0);
