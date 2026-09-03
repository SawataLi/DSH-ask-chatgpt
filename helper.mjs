#!/usr/bin/env node
// ChatGPT web bridge helper.
// Modes:
//   node helper.mjs login            one-shot headful login (waits for user, writes marker)
//   node helper.mjs serve            long-running headless stdio JSON bridge
//
// Protocol (serve): newline-delimited JSON on stdin/stdout.
//   req:  {id, op:"status"|"ask"|"probe"|"close", ...}
//   resp: {id, ok:true, result:{...}} | {id, ok:false, error:"..."}

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.CHATGPT_BRIDGE_ROOT || path.join(process.env.HOME || '/root', '.dsh', 'chatgpt-bridge');
const PROFILE = process.env.CHATGPT_PROFILE || path.join(ROOT, 'profile');
const MARKER = process.env.CHATGPT_MARKER || path.join(ROOT, '.logged-in');
// An explicitly empty CHATGPT_PROXY means direct connection. Omitted keeps the
// existing bridge default so standalone `login` continues to use the proxy.
const PROXY = process.env.CHATGPT_PROXY ?? 'http://192.168.50.10:7890';
const WORKSPACE = process.env.CHATGPT_WORKSPACE || process.env.HOME || '/root';
const IMG_DIR = process.env.CHATGPT_IMG_DIR || path.join(WORKSPACE, '.chatgpt-images');
const MODEL = 'gpt-5.6 sol';
const DEFAULT_TIMEOUT_MS = 1800_000;

// Launch args. `--disable-blink-features=AutomationControlled` is the key
// stealth flag: without it Chromium exposes `navigator.webdriver === true`,
// which Google's OAuth sign-in rejects with "This browser or app may not be
// secure". `--disable-features=...AutomationController...` drops the infobar.
const CHROME_ARGS = [
  ...(PROXY ? [`--proxy-server=${PROXY}`] : []),
  '--no-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=AutomationControllerForContentScripts',
  '--disable-infobars',
];
const PROXY_OPTIONS = PROXY ? { proxy: { server: PROXY } } : {};

const log = (...a) => { try { console.error('[chatgpt-bridge]', ...a); } catch {} };

// Ensure an X display exists for the headed Chromium (this box has no X server).
if (!process.env.DISPLAY) {
  try {
    const { spawn } = await import('node:child_process');
    const X11_DIR = process.env.CHATGPT_X11_DIR || path.join(ROOT, 'x11');
    const xvfb = process.env.XVFB_BIN || path.join(X11_DIR, 'usr', 'bin', 'Xvfb');
    const child = spawn(xvfb, [':99', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, LD_LIBRARY_PATH: `${path.join(X11_DIR, 'usr', 'lib')}${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''}` },
    });
    child.unref();
    process.env.DISPLAY = ':99';
    log('no $DISPLAY; spawned Xvfb on :99 (pid', child.pid + ')');
  } catch (e) { log('Xvfb bootstrap failed:', e.message); }
}

let context = null; // persistent BrowserContext (serve mode)

// ---------- selectors (adaptive; calibrated via probe) ----------
const SELECTORS = {
  composer: [
    'div[role="textbox"][aria-label*="Chat with ChatGPT" i]',
    '[contenteditable="true"][aria-label*="ChatGPT" i]',
    '#mobile-composer-prompt',
    'textarea.wm-composer-textarea',
    'textarea[aria-label*="Chat with ChatGPT" i]',
    'footer textarea',
    'textarea',
  ],
  sendBtn: [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="Send" i]',
  ],
  stopBtn: [
    'button[aria-label="Stop generating"]',
    'button[data-testid="stop-icon"]',
    '[data-testid="stop-icon"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="停止"]',
  ],
  modelBtn: [
    'button[data-testid="model-selector"]',
    'button[aria-label*="model" i]',
    'header button',
  ],
  assistantMsg: [
    '[data-message-author-role="assistant"]',
    'div[data-message-author-role="assistant"]',
    '[data-testid^="conversation-turn"]',
    '.markdown',
  ],
};

function loggedMarker() { try { return fs.existsSync(MARKER); } catch { return false; } }

// ---------- DOM -> markdown (best effort) ----------
function domToMarkdown(root) {
  const images = [];
  const walk = (node, out, ctx) => {
    if (node.nodeType === 3) { out.push(node.textContent); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') { out.push('\n'); return; }
    if (tag === 'img') {
      const src = node.getAttribute('src') || '';
      const abs = src.startsWith('//') ? 'https:' + src : src;
      if (abs && !abs.startsWith('data:')) { images.push(abs); out.push(`\n[IMAGE:${images.length - 1}]\n`); }
      return;
    }
    if (tag === 'pre') {
      out.push('\n```\n' + (node.innerText || '') + '\n```\n');
      return;
    }
    if (tag === 'a') {
      const t = innerTextOf(node);
      const href = node.getAttribute('href') || '';
      out.push(href && !href.startsWith('#') ? `[${t}](${href})` : t);
      return;
    }
    if (/^h[1-6]$/.test(tag)) { out.push('\n' + '#'.repeat(Number(tag[1])) + ' ' + innerTextOf(node) + '\n'); return; }
    if (tag === 'li') { out.push('\n- ' + innerTextOf(node)); return; }
    if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'blockquote') {
      // paragraph-ish: join children text with single newline, blank line after block
      const t = innerTextOf(node);
      if (t.trim()) out.push('\n' + t + '\n');
      return;
    }
    // inline containers (span, code, strong, em, table rows...) fall through to children
    if (tag === 'code' && !node.querySelector('pre')) { out.push('`' + innerTextOf(node) + '`'); return; }
    for (const child of node.childNodes) walk(child, out, ctx);
  };
  const innerTextOf = (el) => el.innerText != null ? el.innerText : el.textContent || '';
  const out = [];
  for (const child of root.childNodes) walk(child, out, null);
  let md = out.join('').replace(/\n{3,}/g, '\n\n').trim();
  return { md, images };
}

// ---------- page helpers ----------
// True if ANY composer candidate is visible (checks each selector individually;
// a comma-union + .first() would falsely report a hidden mobile composer).
async function anyComposerVisible(page) {
  for (const sel of SELECTORS.composer) {
    try {
      if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
    } catch {}
  }
  return false;
}

async function firstVisible(page, selectors, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) return { selector: sel, loc };
      } catch {}
    }
    await page.waitForTimeout(300);
  }
  return null;
}

// Cloudflare managed-challenge detection: the challenge page leaves a
// __cf_chl marker in the URL and "Just a moment"/verification copy in the body.
async function isCfChallenge(page) {
  try {
    if (page.url().includes('__cf_chl')) return true;
    const title = await page.title().catch(() => '');
    if (/just a moment/i.test(title || '')) return true;
    const body = await page.locator('body').innerText().catch(() => '');
    return /just a moment|verify you are human|checking your browser|cf-browser-verification/i.test(body || '');
  } catch { return false; }
}

// Logged out = the "Log in" CTA is present (or an auth URL). The composer
// textarea is visible even when logged out, so presence of the composer alone
// is NOT a login signal — the Log-in button is the discriminator.
async function isLoggedOut(page) {
  try {
    const url = page.url();
    if (/\/(auth|login)|account\.chatgpt\.com/i.test(url)) return true;
    const loginBtn = await page.locator('button:has-text("Log in"), a:has-text("Log in"), a[href*="login"]').first().isVisible().catch(() => false);
    return loginBtn;
  } catch { return true; }
}

async function isLoggedIn(page) { return !(await isLoggedOut(page)); }

async function ensureAppReady(page, timeoutMs = 30000) {
  // Iterate composer candidates individually and return the first VISIBLE one.
  // (A comma-union + .first() would return a hidden mobile composer in DOM order.)
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await firstVisible(page, SELECTORS.composer, 1500);
    if (found && !(await isLoggedOut(page))) return found;
    await page.waitForTimeout(500);
  }
  const out = await isLoggedOut(page);
  throw new Error(out ? 'login-required: not logged in (Log-in CTA present). url=' + page.url() : 'app-not-ready: composer never became visible. url=' + page.url());
}

// Calibrated against the live ChatGPT composer model picker (2026 UI):
//  - trigger: the composer-footer button just before [data-testid=send-button]
//    (or a button whose text is an effort label like "Pro"/"Instant").
//  - picker: `composer-model-picker` with an effort slider (role=slider,
//    "Power", 5 stops: Instant..Pro, Home=Instant, End=Pro) plus advanced
//    "Model <name>" / "Effort <name>" menuitem rows.
async function selectModelAndEffort(page, effort) {
  const info = { selectedModel: null, selectedEffort: null };
  const wantLabel = effort === 'instant' ? 'instant' : 'pro';

  // 1) locate the trigger button
  const trigger = await page.evaluate(() => {
    const send = document.querySelector('[data-testid="send-button"], button[aria-label*="Send" i]');
    if (send) {
      let n = send.previousElementSibling, hops = 0;
      while (n && hops < 6) {
        if (n.tagName === 'BUTTON') {
          const r = n.getBoundingClientRect();
          if (r.width > 4 && r.height > 4) return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (n.innerText || '').replace(/\s+/g, ' ').trim() };
        }
        n = n.previousElementSibling; hops++;
      }
    }
    const re = /^(pro|pro extended|instant|medium|high|extra high|极速|gpt[- ]?[\d.]+ ?sol?)$/i;
    for (const b of Array.from(document.querySelectorAll('button'))) {
      const r = b.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && re.test(t)) return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: t };
    }
    return null;
  });
  if (!trigger) { info.error = 'model trigger button not found'; return info; }
  info.openLabel = trigger.text;

  // 2) open the picker and set the slider (always: cheap, idempotent, and it
  //    lets us verify the model row every time)
  await page.mouse.click(trigger.x, trigger.y);
  await page.waitForTimeout(900);

  const slider = page.locator('[role="slider"]').first();
  if (await slider.isVisible().catch(() => false)) {
    await slider.focus().catch(() => {});
    await page.keyboard.press(effort === 'instant' ? 'Home' : 'End');
    await page.waitForTimeout(500);
    info.selectedEffort = effort;
  } else {
    info.error = 'effort slider not visible in picker';
  }

  // 4) verify/fix the model row
  const modelRow = await page.evaluate(() => {
    for (const it of Array.from(document.querySelectorAll('[role="menuitem"]'))) {
      const t = (it.innerText || '').replace(/\s+/g, ' ').trim();
      if (/^Model\b/i.test(t)) return t;
    }
    return null;
  });
  info.modelRow = modelRow;
  if (modelRow && !/gpt-5\.6\s+sol/i.test(modelRow)) {
    const pos = await page.evaluate(() => {
      for (const it of Array.from(document.querySelectorAll('[role="menuitem"]'))) {
        const t = (it.innerText || '').replace(/\s+/g, ' ').trim();
        if (/^Model\b/i.test(t)) {
          const r = it.getBoundingClientRect();
          if (r.width > 4) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    });
    if (pos) {
      await page.mouse.click(pos.x, pos.y);
      await page.waitForTimeout(800);
      const picked = await page.evaluate(() => {
        const re = /gpt[- ]?5\.6\s+sol/i;
        const els = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],button,div[role="button"],[class*="model-row"] *'));
        for (const el of els) {
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (t && re.test(t) && t.length < 40) {
            const r = el.getBoundingClientRect();
            if (r.width > 4 && r.height > 4) { el.click(); return t; }
          }
        }
        return null;
      });
      info.selectedModel = picked ? MODEL : null;
      if (!picked) info.error = (info.error ? info.error + '; ' : '') + 'could not select GPT-5.6 Sol in model list';
      await page.waitForTimeout(400);
    }
  } else if (modelRow) {
    info.selectedModel = 'GPT-5.6 Sol';
  }

  // 5) close the picker and report the resulting trigger label as verification
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  info.resultLabel = await page.evaluate(() => {
    const re = /^(pro|pro extended|instant|medium|high|extra high|极速)$/i;
    for (const b of Array.from(document.querySelectorAll('button'))) {
      const r = b.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && re.test(t)) return t;
    }
    return null;
  });
  return info;
}


// Calibrated against the live UI: while generating the composer's send button
// is replaced by a stop control with aria-label "Stop answering"; the send
// button (data-testid=send-button) returns when idle. Short final answers are
// common, so completion is: no stop control + non-empty assistant text stable.
async function waitResponseComplete(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  let stableSince = 0;
  const STOP = 'button[aria-label="Stop answering"], button[aria-label*="Stop" i], [data-testid="stop-icon"]';
  const SEND = '[data-testid="send-button"], button[aria-label="Send prompt"]';
  while (Date.now() < deadline) {
    await page.waitForTimeout(700);
    const stopping = await page.locator(STOP).first().isVisible().catch(() => false);
    const sendBack = await page.locator(SEND).first().isVisible().catch(() => false);
    const msg = await lastAssistantMsg(page);
    const text = msg ? (await msg.innerText().catch(() => '') || '') : '';
    if (!stopping && text) {
      if (text === lastText) {
        if (!stableSince) stableSince = Date.now();
        // Definite idle signal (send button back): short settle; else 3 polls.
        else if (Date.now() - stableSince >= (sendBack ? 800 : 2100)) return text;
      } else stableSince = 0;
    } else stableSince = 0;
    lastText = text;
  }
  throw new Error('timeout waiting for response (' + Math.round(timeoutMs / 1000) + 's)');
}

async function lastAssistantMsg(page) {
  for (const sel of SELECTORS.assistantMsg) {
    try {
      const locs = page.locator(sel);
      const n = await locs.count();
      if (n > 0) return locs.nth(n - 1);
    } catch {}
  }
  return null;
}

async function doAsk(req) {
  const task = String(req.task || '').trim();
  if (!task) throw new Error('task is required');
  const effort = req.effort === 'instant' ? 'instant' : 'pro'; // default Pro for text tasks
  const timeoutMs = Number(req.timeoutMs) > 0 ? Number(req.timeoutMs) : DEFAULT_TIMEOUT_MS;
  // temporary chat by default; req.temporary === false opens a regular chat
  // (needed for image generation, which ChatGPT blocks in temporary chats).
  const temporary = req.temporary !== false;
  const startUrl = temporary ? 'https://chatgpt.com/?temporary-chat=true' : 'https://chatgpt.com/';

  const page = await context.newPage();
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Give a managed CF challenge a few seconds to auto-resolve (it does not in
    // headless without a fresh clearance), then fail fast with a clear cause.
    await page.waitForTimeout(4000);
    if (await isCfChallenge(page)) throw new Error('cf-challenge: Cloudflare blocked this (headless) browser. Re-run the login flow to refresh the clearance cookie, then retry.');
    const composerInfo = await ensureAppReady(page, 30000); // throws login-required if not logged in

    // model + effort
    const selInfo = await selectModelAndEffort(page, effort);

    // type and send. The composer is a contenteditable div; fill() is fast and
    // reliable, with a click+type fallback. Verify the text actually landed.
    const composer = composerInfo.loc;
    await composer.fill(task).catch(async () => {
      await composer.click({ timeout: 5000 }).catch(() => {});
      await page.keyboard.type(task, { delay: 3 });
    });
    // verify; retry once if empty (focus race)
    let landed = (await composer.innerText().catch(() => '') || '').trim();
    if (!landed) {
      await composer.click({ timeout: 3000, force: true }).catch(() => {});
      await page.keyboard.type(task, { delay: 3 });
      landed = (await composer.innerText().catch(() => '') || '').trim();
    }
    if (!landed) throw new Error('could not enter text into the composer');
    await page.waitForTimeout(400);
    // prefer the explicit Send button; fall back to Enter
    let sent = false;
    for (const sel of SELECTORS.sendBtn) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false)) { await btn.click({ timeout: 2500 }); sent = true; break; }
      } catch {}
    }
    if (!sent) { await page.keyboard.press('Enter'); }
    await page.waitForTimeout(1500);

    const text = await waitResponseComplete(page, timeoutMs);

    // extract last assistant message
    const msg = await lastAssistantMsg(page);
    let md = '';
    let images = [];
    if (msg) {
      const handled = await msg.evaluate((el) => {
        const r = domToMarkdown(el);
        return r;
      }).catch(() => null);
      if (handled) { md = handled.md; images = handled.images; }
      else md = (await msg.innerText().catch(() => '')) || '';
    }
    // fallback: use waited text
    if (!md.trim() && text) md = text;

    // save images
    const saved = [];
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    for (let i = 0; i < images.length; i++) {
      try {
        const url = images[i];
        const abs = url.startsWith('//') ? 'https:' + url : url;
        const resp = await context.request.get(abs, { timeout: 60000 });
        if (!resp.ok()) { log('image fetch failed', resp.status(), abs); continue; }
        const buf = await resp.body();
        if (!buf.length) continue;
        fs.mkdirSync(IMG_DIR, { recursive: true });
        const ext = abs.match(/\.(png|jpeg|jpg|webp|gif)(\?|$)/i)?.[1] || 'png';
        const file = path.join(IMG_DIR, `chatgpt-${ts}-${i + 1}.${ext}`);
        fs.writeFileSync(file, buf);
        saved.push(file);
      } catch (e) { log('image save failed', e.message); }
    }

    // capture the "Worked for Xs" duration label if present
    const workedFor = await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('div,span'))) {
        const t = (el.innerText || '').trim();
        if (/^Worked for [\d.]+s$/.test(t)) return t;
      }
      return null;
    }).catch(() => null);

    return {
      ok: true,
      reply: md.slice(0, 200000),
      images: saved,
      model: selInfo.selectedModel || null,
      effort: selInfo.selectedEffort || null,
      effortLabel: selInfo.resultLabel || null,
      modelRow: selInfo.modelRow || null,
      workedFor,
      modelPicker: selInfo.error ? { error: selInfo.error, openLabel: selInfo.openLabel || null } : null,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function doStatus() {
  const pages = context ? context.pages() : [];
  return {
    ok: true,
    loggedMarker: loggedMarker(),
    pages: pages.map((p) => p.url()),
    pid: process.pid,
  };
}

async function doProbe() {
  // Open temp chat, open the model picker, dump candidate controls + screenshot.
  const page = await context.newPage();
  try {
    await page.goto('https://chatgpt.com/?temporary-chat=true', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await ensureAppReady(page, 30000);
    // try each model button candidate; open the first visible one
    const buttons = [];
    for (const sel of SELECTORS.modelBtn) {
      try {
        const locs = page.locator(sel);
        const n = await locs.count();
        for (let i = 0; i < Math.min(n, 10); i++) {
          const loc = locs.nth(i);
          if (!(await loc.isVisible().catch(() => false))) continue;
          buttons.push({
            selector: sel,
            index: i,
            text: (await loc.innerText().catch(() => '')) || '',
            ariaLabel: (await loc.getAttribute('aria-label').catch(() => '')) || '',
            testid: (await loc.getAttribute('data-testid').catch(() => '')) || '',
          });
        }
      } catch {}
    }
    // open the first candidate that has model-ish text, else the first
    let opened = null;
    for (const sel of SELECTORS.modelBtn) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) { await loc.click().catch(() => {}); opened = sel; break; }
    }
    await page.waitForTimeout(800);
    const items = await page.evaluate(() => {
      const out = [];
      const sels = '[role="option"],[role="menuitem"],[role="radiogroup"] label,[role="radiogroup"] button,[role="listbox"] [role="option"],[role="dialog"] button,select option,li button';
      for (const el of Array.from(document.querySelectorAll(sels))) {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        out.push({
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          testid: el.getAttribute('data-testid') || '',
          aria: el.getAttribute('aria-label') || '',
          text: (el.innerText || '').trim().slice(0, 120),
          value: el.getAttribute('value') || '',
        });
        if (out.length > 120) break;
      }
      return out;
    });
    const shot = path.join(IMG_DIR, `probe-${Date.now()}.png`);
    try { fs.mkdirSync(IMG_DIR, { recursive: true }); await page.screenshot({ path: shot, fullPage: false }); } catch { shot = null; }
    return { ok: true, opened, buttons, items: items.slice(0, 120), screenshot: shot };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- serve loop ----------
let busy = false;
async function handle(req) {
  const id = req.id;
  const resp = (obj, ok = true) => { try { process.stdout.write(JSON.stringify(ok ? { id, ok, result: obj } : { id, ok: false, error: obj && obj.error ? obj.error : String(obj) }) + '\n'); } catch {} };
  try {
    switch (req.op) {
      case 'ping': return resp({ pong: true, pid: process.pid });
      case 'status': return resp(await doStatus());
      case 'ask': {
        const r = await doAsk(req);
        try {
          if (r && r.ok) fs.writeFileSync(MARKER, new Date().toISOString());
          else if (/login-required/.test(String(r && r.error || ''))) fs.rmSync(MARKER, { force: true });
        } catch {}
        return resp(r);
      }
      case 'probe': return resp(await doProbe());
      case 'close': {
        if (context) { await context.close().catch(() => {}); context = null; }
        setTimeout(() => process.exit(0), 100);
        return resp({ closed: true });
      }
      default: return resp({ error: 'unknown op' }, false);
    }
  } catch (e) {
    log('op failed', req.op, e.message);
    const code = /login-required/.test(e.message) ? 'login-required' : /cf-challenge/.test(e.message) ? 'cf-challenge' : 'error';
    return resp({ error: e.message, code }, false);
  }
}

async function serve() {
  fs.mkdirSync(PROFILE, { recursive: true });
  // HEADED by default: Cloudflare blocks the headless fingerprint even when the
  // profile holds a valid clearance cookie, so the persistent bridge runs a
  // visible Chromium window (display :1). Set CHATGPT_HEADLESS=1 to force the
  // headless variant (works only if a CF clearance happens to carry over).
  const headless = process.env.CHATGPT_HEADLESS === '1';
  context = await chromium.launchPersistentContext(PROFILE, {
    headless,
    ...PROXY_OPTIONS,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    args: CHROME_ARGS,
    ignoreDefaultArgs: ['--enable-automation'],
  });
  log('serve context launched', headless ? 'headless' : 'headed');
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try { handle(JSON.parse(line)); } catch (e) { log('bad line', e.message); }
    }
  });
  process.stdin.on('end', async () => { try { if (context) await context.close(); } catch {} process.exit(0); });
  log('serve ready, pid', process.pid);
}

// ---------- login (one-shot, headful) ----------
async function login() {
  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    ...PROXY_OPTIONS,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    args: CHROME_ARGS,
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = (await ctx.pages())[0] || (await ctx.newPage());
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => log('goto', e.message));
  log('waiting for user login... (15 min max). A visible Chromium window is open on display :1 — complete login there.');
  const deadline = Date.now() + 15 * 60 * 1000;
  let loggedIn = false;
  let reloads = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    try {
      // Monitor ALL pages: OAuth may complete in a tab other than the one we opened.
      const pages = ctx.pages().filter((p) => !p.isClosed());
      let found = false;
      for (const p of pages) {
        try {
          const isApp = /chatgpt\.com/i.test(p.url());
          if (!isApp) continue;
          const composerVisible = await anyComposerVisible(p);
          if (composerVisible && (await isLoggedIn(p))) { found = true; break; }
        } catch {}
      }
      if (found) { loggedIn = true; break; }
      // The original tab can go stale after an OAuth round-trip; refresh it
      // every ~30s (capped) so the logged-in state lands somewhere we watch.
      reloads++;
      if (reloads % 15 === 0) {
        log('reloading watched tab to refresh auth state');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
    } catch {}
  }
  try {
    if (loggedIn) { fs.writeFileSync(MARKER, new Date().toISOString()); console.log('LOGIN_OK'); }
    else { console.log('LOGIN_TIMEOUT'); }
  } finally {
    await ctx.close().catch(() => {});
  }
  process.exit(loggedIn ? 0 : 1);
}

// One-shot ask: read a single JSON request from stdin, run doAsk in a fresh
// headed browser (reusing the persistent profile), print one JSON result line
// to stdout, and exit. This is what the DSH plugin spawns per tool call.
async function askOnce(req) {
  fs.mkdirSync(PROFILE, { recursive: true });
  context = await chromium.launchPersistentContext(PROFILE, {
    headless: process.env.CHATGPT_HEADLESS === '1',
    ...PROXY_OPTIONS,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    args: CHROME_ARGS,
    ignoreDefaultArgs: ['--enable-automation'],
  });
  let result;
  try {
    result = await doAsk(req);
  } catch (e) {
    const code = /login-required/.test(e.message) ? 'login-required' : /cf-challenge/.test(e.message) ? 'cf-challenge' : 'error';
    result = { ok: false, error: e.message, code };
  }
  // keep the login marker self-maintaining: a successful ask proves the
  // profile cookies are live; a login-required failure clears it.
  try {
    if (result && result.ok) fs.writeFileSync(MARKER, new Date().toISOString());
    else if (result && result.code === 'login-required') fs.rmSync(MARKER, { force: true });
  } catch {}
  try { process.stdout.write(JSON.stringify(result) + '\n'); } catch {}
  try { if (context) await context.close(); } catch {}
  process.exit(result && result.ok ? 0 : 1);
}

const mode = process.argv[2] || 'serve';
if (mode === 'login') login().catch((e) => { log('login failed', e.message); process.exit(1); });
else if (mode === 'ask') {
  let buf = '';
  process.stdin.on('data', (c) => { buf += c.toString('utf8'); });
  process.stdin.on('end', () => {
    let req;
    try {
      const line = buf.trim().split('\n').pop();
      req = JSON.parse(line || '{}');
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, error: 'bad request json', code: 'error' }) + '\n');
      process.exit(2);
    }
    askOnce(req).catch((e) => {
      try { process.stdout.write(JSON.stringify({ ok: false, error: e.message, code: 'error' }) + '\n'); } catch {}
      process.exit(1);
    });
  });
} else serve().catch((e) => { log('serve failed', e.message); process.exit(1); });
