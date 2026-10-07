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
  // Zones (Dallas launch, 2026-10-07): the Dallas panel now states reported
  // real-world facts (launch date, hours, introductory fare, service area), so
  // the rule is that each is SOURCED on the panel itself; never the placeholder,
  // and still never an unsourced launch claim in the "has/hasn't launched" style.
  {
    const html = read('infrastructure.html');
    const start = html.indexOf('id="dallasContent"');
    check('infrastructure.html: has a #dallasContent Dallas panel', start !== -1);
    const panel = html.slice(start, html.indexOf('<!-- Map: a tall card on mobile', start));
    check('infrastructure.html: the Dallas panel is no longer a "not available" placeholder', !/isn'?t (available|built) in Cybercab Hunter/i.test(panel) && !/NOT YET AVAILABLE/.test(panel));
    check('infrastructure.html: the Dallas facts are shown with their sources linked (FOX 4, Dallas Innovates)', /In service since Apr 18, 2026/.test(panel) && /6 AM – 2 AM daily/.test(panel) && /href="https:\/\/www\.fox4news\.com\/[^"]+"/.test(panel) && /href="https:\/\/dallasinnovates\.com\/[^"]+"/.test(panel));
    check('infrastructure.html: no geofence size is claimed (Tesla has published none)', /Coverage size not published/.test(panel) && !/mi²/.test(panel));
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
    check('index.html: the Dallas strip has Dallas hours (6AM - 2AM), not Austin\'s', /6AM - 2AM/.test(strip) && !/11PM/.test(strip));
    for (const claim of LAUNCH_CLAIMS) {
      check(`index.html: the Dallas strip makes no unsourced launch claim (${claim})`, !claim.test(strip));
    }
    check('index.html: a Dallas minimap card links to the Dallas Zones map', /id="homeZoneDallas"[\s\S]*?href="infrastructure\.html\?city=dallas"/.test(html));
  }

  t.finish();
}

run();
