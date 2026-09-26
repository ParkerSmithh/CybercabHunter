// Dallas placeholder copy on infrastructure.html and dispatch-comparison.html
// must describe only Cybercab Hunter's own missing functionality — never make
// a claim about whether Tesla/Cybercab service has (or hasn't) actually
// launched in Dallas. The app has no authoritative source for real-world
// launch status; a receipt-derived Dallas ride in the registry doesn't prove
// one either way, so the copy must not assert either direction.
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
  for (const [file, panelId] of [['infrastructure.html', 'dallasContent'], ['dispatch-comparison.html', 'dallasContent'], ['index.html', 'homeZoneDallasNote']]) {
    const html = read(file);
    const panelStart = html.indexOf(`id="${panelId}"`);
    check(`${file}: has a #${panelId} Dallas placeholder panel`, panelStart !== -1);
    // The panel is a short block; slicing a generous window after its opening tag
    // is enough to capture its heading + paragraph without pulling in the rest of the page.
    const panel = html.slice(panelStart, panelStart + 700);

    for (const claim of LAUNCH_CLAIMS) {
      check(`${file}: the Dallas panel makes no real-world launch claim (${claim})`, !claim.test(panel));
    }
    check(`${file}: the Dallas panel says nothing is available in CYBERCAB HUNTER (app-scoped, not a claim about Tesla)`, /isn'?t (available|built) in Cybercab Hunter/i.test(panel));
  }

  t.finish();
}

run();
