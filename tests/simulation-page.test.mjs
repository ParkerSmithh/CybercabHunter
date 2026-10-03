// Tests for the Fleet ROI page (public/simulation.html, served at /simulation):
// the fleet investment calculator on its own (the Fleet ETA tool and the
// Fleet ROI / Fleet ETA buttons were removed), the "Fleet ROI" label in every
// nav, and the old page URLs redirecting to it.
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

function open(url, registry = null) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url, pretendToBeVisual: true });
  const w = dom.window;
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
  console.log('1. One page: Fleet ROI');
  {
    const p = open('https://cybercabhunter.com/simulation');
    check('the page script runs without errors', p.error === null);
    check('the tab name is "Fleet ROI"', p.d.title === 'Cybercab Hunter | Fleet ROI');
    check('the Fleet ROI content is the page: FLEET ROI, its inputs and Export', /Fleet\s*ROI/.test(p.d.body.textContent) && !!p.d.getElementById('fleetSize') && !!p.d.getElementById('exportBtn'));
    check('no "Fleet ROI" / "Fleet ETA" buttons and no tab panels remain', !p.d.getElementById('simTabs') && !p.d.querySelector('[role="tab"], [role="tabpanel"]') && !/>\s*Fleet ETA\s*</.test(HTML));
    check('nothing from the Fleet ETA tool remains on the page', ['simPanelEta', 'cybercabEta', 'modelyEta', 'cybercabFare', 'tripMiles', 'cybercabCount', 'modelyCount', 'cybercabRadar'].every(id => !p.d.getElementById(id)) && !/radar-sweep|view=eta|fleet-stats/i.test(HTML));
    check('the page no longer asks for the fleet stats (that was the ETA page\'s)', !p.requests.some(u => u.includes('/api/fleet-stats')));
    const afterNav = p.d.querySelector('#mobileBottomNav').nextElementSibling;
    const firstContent = afterNav.tagName === 'MAIN' ? afterNav.firstElementChild : afterNav;   // the page's <main> landmark wraps it
    check('the Fleet ROI content starts right under the header (no empty gap left by the buttons)', firstContent.tagName === 'SECTION' && /FLEET\s*ROI/.test(firstContent.textContent));
    const old = open('https://cybercabhunter.com/simulation?view=eta');
    check('an old ?view=eta link still opens the Fleet ROI page', old.error === null && !!old.d.getElementById('fleetSize'));
    const ids = [...HTML.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    check('no element id is used twice', ids.length === new Set(ids).size);
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
    check('the old Fleet ROI page is gone; the fleet comparison is a page again', !pages.includes('fleet-calculator.html') && pages.includes('dispatch-comparison.html'));
    check('no page links to the old Fleet ROI URL any more', pages.every(f => !/fleet-calculator/.test(read(f))));
    check('no page says "Simulation" any more', pages.every(f => !/Simulation/.test(read(f))));
    const withNav = pages.filter(f => read(f).includes('id="navIndicator"'));
    check('every page with the header nav has one "Fleet ROI" tab (still /simulation)', withNav.length >= 8 && withNav.every(f => /<a href="\/simulation" data-nav="simulation"[^>]*>Fleet ROI<\/a>/.test(read(f))));
    check('...and the mobile bottom nav item reads "Fleet ROI"', withNav.every(f => (read(f).match(/data-nav="simulation"/g) || []).length === 2 && /data-nav="simulation"[^>]*>[\s\S]*?<span[^>]*>Fleet ROI<\/span>/.test(read(f).split('id="mobileBottomNav"')[1])));
    check('footers link to it as "Fleet ROI"', pages.filter(f => read(f).includes('<footer')).every(f => !/<a href="\/simulation" class="hover:text-white transition-colors">(?!Fleet ROI<)/.test(read(f))));
    const env = { ASSETS: { fetch: async () => new Response('static') } };
    for (const path of ['/fleet-calculator', '/fleet-calculator.html']) {
      const r = await worker.fetch(new Request(`https://cybercabhunter.com${path}`), env, {});
      check(`${path} permanently redirects to /simulation (the Fleet ROI page)`, r.status === 301 && r.headers.get('Location') === 'https://cybercabhunter.com/simulation');
    }
    for (const path of ['/dispatch-comparison', '/dispatch-comparison.html']) {
      const r = await worker.fetch(new Request(`https://cybercabhunter.com${path}`), env, {});
      check(`${path} is served as a page (the fleet comparison), not redirected`, r.status === 200 && (await r.text()) === 'static');
    }
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
