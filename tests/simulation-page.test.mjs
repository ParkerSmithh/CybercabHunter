// Tests for the Simulation page (public/simulation.html): Fleet ROI (the
// fleet investment calculator) and Fleet ETA (the dispatch comparison) on
// one page, switched by two buttons; both tools still work; the nav points
// to it; and the old page URLs redirect to it.
// Run: node tests/simulation-page.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}public/${f}`, 'utf8');
const HTML = read('simulation.html');
const INLINE = HTML.slice(HTML.lastIndexOf('<script>') + 8, HTML.lastIndexOf('</script>'));
const COMBINED = `${read('js/calc.js')}\n${read('js/main.js')}\n${INLINE}`;

function open(url) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url, pretendToBeVisual: true });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.fetch = async () => new Response('{}', { status: 404 });
  let error = null;
  try { w.eval(COMBINED); } catch (e) { error = e; }
  const d = w.document;
  const set = (id, value) => { const el = d.getElementById(id); el.value = String(value); el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  return { w, d, error, set, hidden: id => d.getElementById(id).classList.contains('hidden') };
}

async function run() {
  console.log('1. One page, two views');
  {
    const p = open('https://cybercabhunter.com/simulation');
    check('both tools\' scripts run together on one page without errors', p.error === null);
    check('the tab name is "Simulation"', p.d.title === 'Cybercab Hunter — Simulation');
    const tabs = [...p.d.querySelectorAll('#simTabs [role="tab"]')];
    check('two buttons: "Fleet ROI" and "Fleet ETA"', tabs.map(b => b.textContent.trim()).join('|') === 'Fleet ROI|Fleet ETA');
    check('Fleet ROI shows by default; Fleet ETA is hidden', !p.hidden('simPanelRoi') && p.hidden('simPanelEta') && p.d.getElementById('simTabRoi').getAttribute('aria-selected') === 'true');
    check('the Fleet ROI view is the fleet calculator (FLEET DASHBOARD, inputs, Export)', /FLEET\s*DASHBOARD/.test(p.d.getElementById('simPanelRoi').textContent) && !!p.d.getElementById('fleetSize') && !!p.d.getElementById('exportBtn'));
    check('the Fleet ETA view is the dispatch comparison', !!p.d.getElementById('simPanelEta').querySelector('#cybercabEta') && !!p.d.getElementById('tripMiles'));
    p.d.getElementById('simTabEta').click();
    check('clicking Fleet ETA switches views', p.hidden('simPanelRoi') && !p.hidden('simPanelEta') && p.d.getElementById('simTabEta').getAttribute('aria-selected') === 'true');
    check('...and the URL remembers it (?view=eta)', p.w.location.search === '?view=eta');
    p.d.getElementById('simTabRoi').click();
    check('clicking Fleet ROI switches back (and the URL is clean again)', !p.hidden('simPanelRoi') && p.hidden('simPanelEta') && p.w.location.search === '');
    const direct = open('https://cybercabhunter.com/simulation?view=eta');
    check('opening ?view=eta starts on Fleet ETA', !direct.hidden('simPanelEta') && direct.hidden('simPanelRoi'));
    const ids = [...HTML.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    check('no element id is used twice on the combined page', ids.length === new Set(ids).size);
  }

  console.log('2. Both tools still calculate');
  {
    const p = open('https://cybercabhunter.com/simulation');
    p.set('fleetSize', 10); p.set('dailyMiles', 200); p.set('electricityRate', 0.12);
    await new Promise(r => setTimeout(r, 900));
    const revenue = Number(p.d.getElementById('revenueOut').textContent.replace(/,/g, ''));
    check('Fleet ROI: changing the inputs recomputes the revenue', revenue > 0);
    p.d.getElementById('simTabEta').click();
    p.set('tripMiles', 6);
    check('Fleet ETA: changing trip distance recomputes the fare', /^\$\d+\.\d\d$/.test(p.d.getElementById('cybercabFare').textContent) && p.d.getElementById('cybercabFare').textContent !== '$0.00');
  }

  console.log('3. Navigation and old URLs');
  {
    const pages = fs.readdirSync(`${ROOT}public`).filter(f => f.endsWith('.html'));
    check('the old pages are gone', !pages.includes('dispatch-comparison.html') && !pages.includes('fleet-calculator.html'));
    check('no page links to them any more', pages.every(f => !/dispatch-comparison|fleet-calculator/.test(read(f))));
    const withNav = pages.filter(f => read(f).includes('id="navIndicator"'));
    check('every page with the header nav has one "Simulation" tab', withNav.length >= 8 && withNav.every(f => /<a href="\/simulation" data-nav="simulation"[^>]*>Simulation<\/a>/.test(read(f))));
    check('...and the mobile bottom nav has one "Simulation" item', withNav.every(f => (read(f).match(/data-nav="simulation"/g) || []).length === 2));
    const env = { ASSETS: { fetch: async () => new Response('static') } };
    for (const [path, dest] of [['/fleet-calculator', '/simulation'], ['/fleet-calculator.html', '/simulation'], ['/dispatch-comparison', '/simulation?view=eta'], ['/dispatch-comparison.html', '/simulation?view=eta']]) {
      const r = await worker.fetch(new Request(`https://cybercabhunter.com${path}`), env, {});
      check(`${path} permanently redirects to ${dest}`, r.status === 301 && r.headers.get('Location') === `https://cybercabhunter.com${dest}`);
    }
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
