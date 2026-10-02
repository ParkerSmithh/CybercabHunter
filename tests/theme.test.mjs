// The site theme (public/js/theme.js): dark by default for everyone, whatever
// the device's setting; Light, or System (follow the device), can be chosen
// from the footer's Appearance switch and is remembered.
// Run: node tests/theme.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeCheck } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const THEME = fs.readFileSync(`${ROOT}public/js/theme.js`, 'utf8');
const FOOTER = '<div class="theme-switch"><button data-theme-set="system"></button><button data-theme-set="light"></button><button data-theme-set="dark"></button></div>';

// A page on a device whose system setting is light or dark, with whatever the
// visitor chose last time already in storage.
async function open({ systemLight, stored }) {
  const dom = new JSDOM(`<!doctype html><html><body>${FOOTER}</body></html>`, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/' });
  const w = dom.window;
  w.matchMedia = q => ({ matches: /light/.test(q) ? systemLight : !systemLight, addEventListener() {}, removeEventListener() {} });
  if (stored) w.localStorage.setItem('cchTheme', stored);
  w.eval(THEME);
  await new Promise(r => setTimeout(r, 30));   // the switch is wired once the page has loaded
  return { w, theme: () => w.document.documentElement.getAttribute('data-theme'), pressed: () => [...w.document.querySelectorAll('[data-theme-set]')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.themeSet).join() };
}

{
  const p = await open({ systemLight: true });
  check('a first visit is dark, even on a device set to light', p.theme() === 'dark' && p.pressed() === 'dark');
  p.w.document.querySelector('[data-theme-set="light"]').click();
  check('choosing Light switches to light and remembers it', p.theme() === 'light' && p.w.localStorage.getItem('cchTheme') === 'light' && p.pressed() === 'light');
  p.w.document.querySelector('[data-theme-set="dark"]').click();
  check('choosing Dark again goes back to the default (nothing stored)', p.theme() === 'dark' && p.w.localStorage.getItem('cchTheme') === null);
}
{
  check('a returning visitor who chose Light still gets light', (await open({ systemLight: false, stored: 'light' })).theme() === 'light');
  check('System follows the device: light on a light device', (await open({ systemLight: true, stored: 'system' })).theme() === 'light');
  check('...and dark on a dark device', (await open({ systemLight: false, stored: 'system' })).theme() === 'dark');
  const sys = await open({ systemLight: true });
  sys.w.document.querySelector('[data-theme-set="system"]').click();
  check('choosing System is remembered as System', sys.w.localStorage.getItem('cchTheme') === 'system' && sys.theme() === 'light' && sys.pressed() === 'system');
}
{
  const pages = fs.readdirSync(`${ROOT}public`).filter(f => f.endsWith('.html')).map(f => `public/${f}`).concat('public/moderation/import-receipt.html');
  const html = pages.map(f => fs.readFileSync(`${ROOT}${f}`, 'utf8'));
  check('every page loads the theme script and colors the browser bar dark', html.every(s => /<script src="js\/theme\.js\?v=\d+"><\/script>/.test(s) && /<meta name="theme-color" content="#090B0F">/.test(s) && !/prefers-color-scheme: light\)" content/.test(s)));
}

t.finish();
