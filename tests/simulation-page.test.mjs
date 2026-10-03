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
const COMBINED = `${read('js/calc.js')}\n${read('js/main.js')}\n${INLINE}\n${read('js/fleet-compare.js')}`;

// Every window opened; closed at the end so the Fleet ETA view's refresh timers
// (js/fleet-compare.js) don't keep the test process alive.
const windows = [];

function open(url, registry = null) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url, pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
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
    check('the tab name is "Simulation"', p.d.title === 'Cybercab Hunter | Simulation');
    const tabs = [...p.d.querySelectorAll('#simTabs [role="tab"]')];
    check('two buttons: "FLEET ROI" and "FLEET ETA"', tabs.map(b => b.textContent.trim()).join('|') === 'FLEET ROI|FLEET ETA');
    check('the buttons come first, right under the header', (() => { const afterNav = p.d.querySelector('#mobileBottomNav').nextElementSibling; const first = afterNav.tagName === 'MAIN' ? afterNav.firstElementChild : afterNav; return first.tagName === 'SECTION' && !!first.querySelector('#simTabs'); })());
    check('Fleet ROI shows by default; Fleet ETA is hidden', !hidden('simPanelRoi') && hidden('simPanelEta') && p.d.getElementById('simTabRoi').getAttribute('aria-selected') === 'true');
    check('the Fleet ROI view is the fleet calculator (FLEET ROI, inputs, Export)', /FLEET\s*ROI/.test(p.d.getElementById('simPanelRoi').textContent) && !!p.d.getElementById('fleetSize') && !!p.d.getElementById('exportBtn'));
    check('the Fleet ETA view is the fleet comparison (fares, hours, pickup wait)', /FLEET\s*ETA/.test(p.d.getElementById('simPanelEta').textContent) && ['etaCybercab', 'etaModelY', 'tripMiles', 'fleetLive'].every(id => p.d.getElementById('simPanelEta').querySelector('#' + id)));
    check('the page asks for the live fleet stats (Fleet ETA)', p.requests.some(u => u.includes('/api/fleet-stats')));
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
    check('Fleet ETA: one scenario button is selected at a time', busy.getAttribute('aria-pressed') === 'true' && p.d.querySelectorAll('[data-scenario][aria-pressed="true"]').length === 1);
    check('Fleet ETA: the old dispatch-comparison page is folded in (no separate page)', !fs.existsSync(`${ROOT}public/dispatch-comparison.html`));
    const ids = [...HTML.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    check('no element id is used twice on the combined page', ids.length === new Set(ids).size);
  }

  console.log('2. Fleet ROI still calculates');
  {
    const p = open('https://cybercabhunter.com/simulation');
    p.set('fleetSize', 10); p.set('dailyMiles', 200); p.set('electricityRate', 0.12);
    await new Promise(r => setTimeout(r, 900));
    const revenue = Number(p.d.getElementById('revenueOut').textContent.replace(/,/g, ''));
    check('changing the inputs recomputes the revenue', revenue > 0);
  }

  console.log('2b. Starting values: the live registry count and labeled examples');
  {
    const p = open('https://cybercabhunter.com/simulation', { public_vehicles: 45, recorded_rides: 3 });
    await new Promise(r => setTimeout(r, 900));
    const note = p.d.getElementById('roiStartNote').textContent;
    check('fleet size starts at the live registry count (45)', p.d.getElementById('fleetSize').value === '45' && p.d.getElementById('fleetSizeLabel').value === '45');
    check('electricity starts at $0.12/kWh and daily miles at 150, labeled as examples', p.d.getElementById('electricityRate').value === '0.12' && p.d.getElementById('dailyMiles').value === '150' && /live registry count \(45 public Cybercabs\)/.test(note) && /example values/.test(note));
    check('so the page opens on a real projection, not $0', Number(p.d.getElementById('revenueOut').textContent.replace(/,/g, '')) > 0);
    const down = open('https://cybercabhunter.com/simulation');
    await new Promise(r => setTimeout(r, 300));
    check('if the count can\'t load, fleet size stays 0 and the note says so', down.d.getElementById('fleetSize').value === '0' && /Couldn't load the live registry count/.test(down.d.getElementById('roiStartNote').textContent));
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
