// Tests for the Simulation page (public/simulation.html, served at /simulation):
// two tools on one page behind FLEET ROI / FLEET ETA buttons (Fleet ROI first),
// the "Simulation" label in every nav, and the old page URLs redirecting to it.
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
const INLINE = HTML.slice(HTML.lastIndexOf('<script>') + 8, HTML.indexOf('</script>', HTML.lastIndexOf('<script>')));
// In the page's order: calc.js, fleet-roi.js (the Fleet ROI model), main.js,
// the inline scripts, the Fleet ROI UI, then Fleet ETA.
const COMBINED = `${read('js/calc.js')}\n${read('js/fleet-roi.js')}\n${read('js/main.js')}\n${INLINE}\n${read('js/fleet-roi-ui.js')}\n${read('js/fleet-compare.js')}`;

// Every window opened; closed at the end so the Fleet ETA view's refresh timers
// (js/fleet-compare.js) don't keep the test process alive.
const windows = [];

function open(url, registry = null, saved = null) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url, pretendToBeVisual: true });
  const w = dom.window;
  if (saved) w.localStorage.setItem('cchFleetRoiSaved.v1', JSON.stringify(saved));
  windows.push(w);
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.Element.prototype.scrollIntoView = () => {};   // jsdom has no layout
  const requests = [];
  w.fetch = async u => { requests.push(String(u)); return registry && String(u).endsWith('/api/registry/stats') ? Response.json(registry) : new Response('{}', { status: 404 }); };
  let error = null;
  try { w.eval(COMBINED); } catch (e) { error = e; }
  const d = w.document;
  const set = (id, value) => { const el = d.getElementById(id); el.value = String(value); el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  return { w, d, error, set, requests };
}

async function run() {
  console.log('1. One page, two views: Fleet ROI and Fleet ETA');
  {
    const p = open('https://cybercabhunter.com/simulation');
    const hidden = id => p.d.getElementById(id).classList.contains('hidden');
    check('both tools\' scripts run together on one page without errors', p.error === null);
    check('the tab name is "CybercabHunter"', p.d.title === 'CybercabHunter');
    const tabs = [...p.d.querySelectorAll('#simTabs [role="tab"]')];
    check('two buttons: "FLEET ROI" and "FLEET ETA"', tabs.map(b => b.textContent.trim()).join('|') === 'FLEET ROI|FLEET ETA');
    check('the buttons come first, right under the header', (() => { const afterNav = p.d.querySelector('#mobileBottomNav').nextElementSibling; const first = afterNav.tagName === 'MAIN' ? afterNav.firstElementChild : afterNav; return first.tagName === 'SECTION' && !!first.querySelector('#simTabs'); })());
    check('Fleet ROI shows by default; Fleet ETA is hidden', !hidden('simPanelRoi') && hidden('simPanelEta') && p.d.getElementById('simTabRoi').getAttribute('aria-selected') === 'true');
    const roi = p.d.getElementById('simPanelRoi');
    check('the Fleet ROI view is the simulator: inputs, results, timeline, saved configurations', /FLEET\s*ROI/.test(roi.textContent) && ['roi2Mode', 'roi2Inputs', 'roi2Metrics', 'roi2Chart', 'roi2Saved'].every(id => roi.querySelector('#' + id)));
    check('the purchase card, the ownership breakdown, the old Fleet economics calculator and the scenario comparison are gone', !['roi2PurchaseHeading', 'roi2Breakdown', 'roi2Scenarios', 'roi2ScenReset', 'roiHeading', 'fleetSize', 'exportBtn', 'cashFlowChart', 'roiStartNote'].some(id => p.d.getElementById(id)) && !/Order terms|Scenario comparison|Fleet economics|Purchase &amp; ownership|Conservative|Optimistic/i.test(roi.innerHTML));
    check('the Fleet ETA view is the fleet comparison (fares, hours, pickup wait)', /FLEET\s*ETA/.test(p.d.getElementById('simPanelEta').textContent) && ['etaCybercab', 'etaModelY', 'tripMiles', 'fleetLive'].every(id => p.d.getElementById('simPanelEta').querySelector('#' + id)));
    check('the page asks for the precomputed Fleet ETA estimates, and no live registry count', p.requests.some(u => u.includes('/api/fleet-eta?city=austin')) && !p.requests.some(u => u.includes('/api/fleet-stats')));
    p.d.getElementById('simTabEta').click();
    check('clicking Fleet ETA switches views', hidden('simPanelRoi') && !hidden('simPanelEta') && p.d.getElementById('simTabEta').getAttribute('aria-selected') === 'true');
    check('...and the URL remembers it (?view=eta)', p.w.location.search === '?view=eta');
    p.d.getElementById('simTabRoi').click();
    check('clicking Fleet ROI switches back (and the URL is clean again)', !hidden('simPanelRoi') && hidden('simPanelEta') && p.w.location.search === '');
    const direct = open('https://cybercabhunter.com/simulation?view=eta');
    check('opening ?view=eta starts on Fleet ETA', direct.error === null && !direct.d.getElementById('simPanelEta').classList.contains('hidden') && direct.d.getElementById('simPanelRoi').classList.contains('hidden'));
    const dallas = p.d.querySelector('#simPanelEta [data-city="dallas"]');
    dallas.click();
    check('Fleet ETA: Dallas shows the "not yet available" note', p.d.getElementById('austinContent').classList.contains('hidden') && !p.d.getElementById('dallasContent').classList.contains('hidden') && dallas.getAttribute('aria-pressed') === 'true');
    const busy = p.d.querySelector('[data-scenario="busy"]');
    busy.click();
    const pressed = [...p.d.querySelectorAll('[data-scenario][aria-pressed="true"]')];
    check('Fleet ETA: one scenario selected at a time, the same in the Austin and Dallas sections', busy.getAttribute('aria-pressed') === 'true' && pressed.length === 2 && pressed.every(b => b.dataset.scenario === 'busy'));
    check('Fleet ETA Dallas: no Fleet card; the pickup wait has a live Cybercab and a fixed 65 Model Y estimate', !p.d.getElementById('dalFleetHeading') && !!p.d.getElementById('dalEtaCybercab') && !!p.d.getElementById('dalEtaModelY') && !/isn't modelled for Dallas/.test(p.d.getElementById('dallasContent').textContent));
    check('Fleet ETA: the old dispatch-comparison page is folded in (no separate page)', !fs.existsSync(`${ROOT}public/dispatch-comparison.html`));
    const ids = [...HTML.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    check('no element id is used twice on the combined page', ids.length === new Set(ids).size);
  }

  console.log('2. Fleet ROI: the simulator calculates, with five fixed values');
  {
    const p = open('https://cybercabhunter.com/simulation');
    const UI = p.w.CCC_FLEET_ROI_UI;
    UI.set('vehicles', 10);
    await new Promise(r => setTimeout(r, 900));
    check('10 Cybercabs: $30,438 operating profit a month (10 × $3,043.76)', p.d.querySelector('[data-m="op"]').textContent === '$30,438');
    const fixed = { price: '$29,990', deposit: '$1,000', subscriptionMonthly: '$300/mo', subscriptionIncludedMonths: '1 month', platformSharePct: '25%' };
    const row = k => p.d.querySelector(`#roi2Inputs [data-row="${k}"]`);
    check('the five fixed values are shown, read-only, with a lock', Object.entries(fixed).every(([k, v]) => row(k) && row(k).classList.contains('roi2-locked') && row(k).querySelector('.roi2-fixed').textContent.trim() === v && row(k).querySelector('.roi2-lock') && /fixed$/.test(row(k).getAttribute('aria-label'))));
    check('…with no field or slider to change them', Object.keys(fixed).every(k => !row(k).querySelector('input') && !p.d.querySelector(`[data-field="${k}"],[data-range="${k}"]`)));
    check('renamed: "Free Autonomy" and "Tesla Revenue Share"; no "Platform" or "Subscription months included"', /Free Autonomy/.test(row('subscriptionIncludedMonths').textContent) && /Tesla Revenue Share/.test(row('platformSharePct').textContent) && !/Platform revenue share|Subscription months included/i.test(p.d.getElementById('simPanelRoi').textContent));
    UI.set('price', 50000); UI.set('platformSharePct', 0); UI.set('subscriptionMonthly', 1);
    check('even set directly, they stay fixed', UI.input.price === 29990 && UI.input.platformSharePct === 25 && UI.input.subscriptionMonthly === 300);
    check('the editable inputs still work (financing reveals its fields)', (UI.set('purchase', 'finance'), !p.d.querySelector('[data-row="aprPct"]').classList.contains('is-off')));
    check('Tesla Revenue Share shows only in Fleet mode', (UI.set('mode', 'personal'), p.d.querySelector('[data-row="platformSharePct"]').classList.contains('is-off')) && (UI.set('mode', 'fleet'), !p.d.querySelector('[data-row="platformSharePct"]').classList.contains('is-off')));
    check('the earnings say Tesla\'s terms are unconfirmed', /25% Tesla Revenue Share is a fixed modeling assumption, not a confirmed agreement/.test(p.d.getElementById('roi2ModeNote').textContent));
  }

  console.log('2b. Saved configurations made before the values were fixed');
  {
    const old = [{ id: 'cfg-old', name: 'Old plan', savedAt: '2026-11-13T20:00:00.000Z', input: { mode: 'fleet', vehicles: 7, price: 31000, deposit: 1500, subscriptionMonthly: 299, subscriptionIncludedMonths: 2, platformSharePct: 30, farePerRide: 13, ridesPerDay: 18 } }];
    const p = open('https://cybercabhunter.com/simulation', null, old);
    check('the older configuration is still listed (nothing deleted)', p.d.querySelectorAll('#roi2Saved li').length === 1 && /Old plan/.test(p.d.getElementById('roi2Saved').textContent));
    p.d.querySelector('#roi2Saved [data-act="load"]').click();
    const x = p.w.CCC_FLEET_ROI_UI.input;
    check('loading it enforces $29,990, $1,000, $300, 1 month free and 25%', x.price === 29990 && x.deposit === 1000 && x.subscriptionMonthly === 300 && x.subscriptionIncludedMonths === 1 && x.platformSharePct === 25);
    check('…and keeps its own values', x.vehicles === 7 && x.farePerRide === 13 && x.ridesPerDay === 18);
  }

  console.log('3. Navigation and old URLs');
  {
    const pages = fs.readdirSync(`${ROOT}public`).filter(f => f.endsWith('.html'));
    check('the old pages are gone', !pages.includes('dispatch-comparison.html') && !pages.includes('fleet-calculator.html'));
    check('no page links to them any more', pages.every(f => !/dispatch-comparison|fleet-calculator/.test(read(f))));
    const withNav = pages.filter(f => read(f).includes('id="navIndicator"'));
    check('every page with the header nav has one "Simulation" tab (/simulation)', withNav.length >= 8 && withNav.every(f => /<a href="\/simulation" data-nav="simulation"[^>]*>Simulation<\/a>/.test(read(f))));
    check('...and the mobile bottom nav item reads "Simulation"', withNav.every(f => (read(f).match(/data-nav="simulation"/g) || []).length === 2 && /data-nav="simulation"[^>]*>[\s\S]*?<span[^>]*>Simulation<\/span>/.test(read(f).split('id="mobileBottomNav"')[1])));
    check('footers link to it as "Simulation"', pages.filter(f => read(f).includes('<footer')).every(f => !/<a href="\/simulation" class="hover:text-white transition-colors">(?!Simulation<)/.test(read(f))));
    const env = { ASSETS: { fetch: async () => new Response('static') } };
    for (const path of ['/fleet-calculator', '/fleet-calculator.html', '/dispatch-comparison', '/dispatch-comparison.html']) {
      const r = await worker.fetch(new Request(`https://cybercabhunter.com${path}`), env, {});
      const to = path.startsWith('/dispatch-comparison') ? 'https://cybercabhunter.com/simulation?view=eta' : 'https://cybercabhunter.com/simulation';
      check(`${path} permanently redirects to ${to.replace('https://cybercabhunter.com', '')}`, r.status === 301 && r.headers.get('Location') === to);
    }
  }

  windows.forEach(w => w.close());
  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
