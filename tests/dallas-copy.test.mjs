// Dallas copy on infrastructure.html and the homepage. Before the Dallas
// launch the app had no authoritative source for real-world launch status, so
// placeholders described only the app's own missing functionality. Since the
// launch (2026-10-07) the Zones panel states reported facts WITH their sources
// linked; neither page may make an unsourced launch claim.
// Plain static-file checks — no DB, no jsdom needed.
// Run: node tests/dallas-copy.test.mjs

import fs from 'node:fs';
import { makeCheck } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}public/${f}`, 'utf8');

// Claims about real-world launch status — must never appear anywhere in either file.
const LAUNCH_CLAIMS = [
  /Cybercab service hasn'?t launched/i,
  /dispatch data[^.]*hasn'?t launched/i,
  /service goes live/i,
  /dispatch data is live/i,
  /has(?:n'?t)? launched/i   // catches "launched"/"hasn't launched" in either direction
];

function run() {
  // Zones (Dallas zone polish): the Dallas panel mirrors Austin's (zone name,
  // Operating, map key, Coverage in mi², the area and launch date); never the
  // placeholder, and never an unsourced launch claim.
  {
    const html = read('infrastructure.html');
    const start = html.indexOf('id="dallasContent"');
    check('infrastructure.html: has a #dallasContent Dallas panel', start !== -1);
    const panel = html.slice(start, html.indexOf('<!-- Map: a tall card on mobile', start));
    check('infrastructure.html: the Dallas panel is no longer a "not available" placeholder', !/isn'?t (available|built) in Cybercab Hunter/i.test(panel) && !/NOT YET AVAILABLE/.test(panel));
    const order = ['Service Zone', 'DALLAS, TX', 'Operating', 'Charging Locations', 'Cybercabs', 'Coverage', 'mi²', 'Dallas • Live fleet', 'Central Dallas, from downtown north to Northwest Highway, including Highland Park.', 'In service since April 18, 2026', 'Fleet &amp; Fares'];
    const at = order.map(x => panel.indexOf(x));
    check('infrastructure.html: the Dallas panel has Austin\'s structure, in order', at.every((i, k) => i !== -1 && (k === 0 || i > at[k - 1])));
    check('infrastructure.html: the Dallas coverage is 81 mi² (counted up like Austin\'s)', /id="dalCoverageOut"/.test(panel) && /countUp\(document\.getElementById\('dalCoverageOut'\), 81\)/.test(html));
    check('infrastructure.html: no 2 AM, "not published" or "TxDOT cameras" left in the Dallas panel', !/2 AM|not published|TxDOT cameras/i.test(panel));
    for (const claim of LAUNCH_CLAIMS) {
      check(`infrastructure.html: the Dallas panel makes no unsourced launch claim (${claim})`, !claim.test(panel));
    }
  }

  // Homepage (Dallas launch): the "not available" note is replaced by Dallas's
  // own facts strip, minimap and the fleet chart; its hours are Dallas's own.
  {
    const html = read('index.html');
    check('index.html: the Dallas "not available" placeholder is gone', !/homeZoneDallasNote/.test(html) && !/isn'?t (available|built) in Cybercab Hunter/i.test(html));
    const start = html.indexOf('id="homeZoneDallasInfo"');
    check('index.html: a Dallas facts strip exists', start !== -1);
    const strip = html.slice(start, html.indexOf('<!-- Austin mini map -->', start));
    check('index.html: the Dallas strip has Dallas hours (6AM - 11PM)', /6AM - 11PM/.test(strip) && !/2AM/.test(strip));
    check('index.html: the Dallas minimap draws the Dallas service zone', /initZoneMap\('zoneMap-dallas', 'Dallas', \[[^\]]+\], CCCAustinMap\.DALLAS_SERVICE_ZONE\)/.test(html));
    for (const claim of LAUNCH_CLAIMS) {
      check(`index.html: the Dallas strip makes no unsourced launch claim (${claim})`, !claim.test(strip));
    }
    check('index.html: a Dallas minimap card links to the Dallas Zones map', /id="homeZoneDallas"[\s\S]*?href="infrastructure\.html\?city=dallas"/.test(html));
  }

  // The Dallas service zone (js/austin-map.js): a closed ring inside the Dallas
  // metro, about Tesla's 81 mi²; Fleet ETA shows 6 AM - 11 PM.
  {
    const src = fs.readFileSync(new URL('../public/js/austin-map.js', import.meta.url), 'utf8');
    const ring = JSON.parse(src.match(/const DALLAS_SERVICE_ZONE = (\[[\s\S]*?\]);/)[1].replace(/\s/g, ''));
    const closed = JSON.stringify(ring[0]) === JSON.stringify(ring.at(-1));
    const inDallas = ring.every(([lng, lat]) => lng > -97 && lng < -96.6 && lat > 32.7 && lat < 32.9);
    const k = Math.cos(32.8 * Math.PI / 180) * 111.32 * 110.57;
    let a2 = 0;
    for (let i = 0; i < ring.length - 1; i++) a2 += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    const mi2 = Math.abs(a2 / 2) * k / 2.58999;
    check(`the Dallas zone is a closed ring in Dallas, ~81 mi² (${mi2.toFixed(1)})`, closed && inDallas && ring.length > 10 && mi2 > 75 && mi2 < 87);
    const sim = read('simulation.html');
    const dal = sim.slice(sim.indexOf('<div id="dallasContent"'), sim.indexOf('<div id="accountBackdrop"'));
    check('simulation.html: Dallas hours are 6:00 AM - 11:00 PM; no 2 AM, "not published" or TxDOT cameras', /6:00 AM - 11:00 PM/.test(dal) && !/\b2:00 AM|\b2 AM|not published|TxDOT cameras|hasn't published/i.test(dal));
  }

  t.finish();
}

run();
