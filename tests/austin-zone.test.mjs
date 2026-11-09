// The Austin service zone (expanded Nov 2026, measured from three reference
// images: docs/verification/austin-zone-expansion/README.md). One boundary,
// in four copies that must never drift apart.
// Run: node tests/austin-zone.test.mjs
import fs from 'node:fs';
import { makeCheck } from './helpers/env.mjs';
import { SERVICE_AREAS, serviceAreaFor, isInServiceArea } from '../worker/service-areas.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(ROOT + f, 'utf8');
const ring = (src, name) => [...src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))[1].matchAll(/\[(-?\d+\.\d+),\s*(-?\d+\.\d+)\]/g)].map(m => [Number(m[1]), Number(m[2])]);

const shared = ring(read('public/js/austin-map.js'), 'SERVICE_ZONE');
const dallas = ring(read('public/js/austin-map.js'), 'DALLAS_SERVICE_ZONE');
const zones = ring(read('public/infrastructure.html'), 'serviceZoneCoords');
const home = ring(read('public/index.html'), 'serviceZoneCoords');
const ios = JSON.parse(read('ios-native/CybercabHunter/Resources/WebData/zones.json')).cities;
const iosAustin = ios.find(c => c.key === 'austin').zone, iosDallas = ios.find(c => c.key === 'dallas').zone;

// Spherical-excess-free equal-area ring area on the WGS84 authalic sphere (mi²).
function sqMi(r) {
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), e = Math.sqrt(e2);
  const q = s => (1 - e2) * (s / (1 - e2 * s * s) - Math.log((1 - e * s) / (1 + e * s)) / (2 * e));
  const qp = q(1), R2 = a * a * qp / 2, b = lat => Math.asin(q(Math.sin(lat * Math.PI / 180)) / qp);
  let sum = 0;
  for (let i = 0; i + 1 < r.length; i++) sum += (r[i + 1][0] - r[i][0]) * Math.PI / 180 * (Math.sin(b(r[i][1])) + Math.sin(b(r[i + 1][1])));
  return Math.abs(sum / 2 * R2) / 2589988.110336;
}
const inside = (p, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) && p[0] < (r[j][0] - r[i][0]) * (p[1] - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) c = !c; return c; };
function segmentsCross(p1, p2, p3, p4) {
  const o = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return o(p1, p2, p3) * o(p1, p2, p4) < 0 && o(p3, p4, p1) * o(p3, p4, p2) < 0;
}

console.log('1. One boundary everywhere');
{
  check('the Zones page, homepage and Replay use the same ring', JSON.stringify(shared) === JSON.stringify(zones) && JSON.stringify(shared) === JSON.stringify(home));
  check('the iOS app uses the same ring', JSON.stringify(shared) === JSON.stringify(iosAustin));
  check('closed', JSON.stringify(shared[0]) === JSON.stringify(shared.at(-1)));
  let crossing = 0;
  for (let i = 0; i + 1 < shared.length; i++) for (let j = i + 2; j + 1 < shared.length; j++) if (!(i === 0 && j + 2 === shared.length) && segmentsCross(shared[i], shared[i + 1], shared[j], shared[j + 1])) crossing++;
  check('a simple polygon: no edge crosses another', crossing === 0);
}

console.log('2. Coverage is measured from the polygon');
{
  const measured = sqMi(shared);
  check(`measured area (${measured.toFixed(1)} mi²) is about 440`, Math.abs(measured - 440.1) < 1);
  check('the server reports the measured figure', serviceAreaFor('austin').zone.square_miles === Math.round(measured));
  check('the wait-time model uses it', /areaSqMi: 440\.1,/.test(read('public/js/calc.js')));
  check('the app\'s model uses it', /"austin": 440\.1/.test(read('ios-native/CybercabHunter/Features/Simulation/SimulationCalc.swift')));
  check('the Zones page shows it', /countUp\(document\.getElementById\('coverageOut'\), 440\)/.test(read('public/infrastructure.html')));
  check('the old figure is gone', !/\b272(\.4)?\b/.test(read('public/js/calc.js') + read('worker/service-areas.js')));
}

console.log('3. The expansion, as the reference images show it');
{
  // Places the images show inside the new area and outside the old one.
  const added = { 'Manor (NE)': [-97.56, 30.345], 'southwest, near Oak Hill / Hwy 45': [-97.89, 30.17], 'west, near West Lake': [-97.88, 30.3], 'southeast, past the airport': [-97.6, 30.09] };
  for (const [name, p] of Object.entries(added)) check(`${name}: inside the new zone`, inside(p, shared));
  for (const [name, p] of Object.entries({ 'Austin (downtown)': [-97.7431, 30.2672], 'the airport': [-97.6699, 30.1945], 'Wells Branch': [-97.68, 30.44], 'St. Elmo hub': [-97.7630241, 30.2149565], 'Ridgepoint site': [-97.6749944, 30.3285815] })) check(`${name}: still inside`, inside(p, shared));
  for (const [name, p] of Object.entries({ 'Round Rock': [-97.678, 30.508], 'Buda': [-97.84, 30.085], 'Cedar Park': [-97.82, 30.505], 'Lakeway': [-97.97, 30.365], 'Elgin': [-97.37, 30.35], 'Lockhart': [-97.67, 29.885] })) check(`${name}: outside`, !inside(p, shared));
}

console.log('4. Dallas and the service-area boxes');
{
  check('Dallas is unchanged, and still shared by both platforms', JSON.stringify(dallas) === JSON.stringify(iosDallas) && JSON.stringify(dallas[0]) === '[-96.85815,32.8603]' && dallas.length === iosDallas.length);
  check('Dallas still 81 mi² (Tesla\'s figure)', serviceAreaFor('dallas').zone.square_miles === 81);
  const austin = serviceAreaFor('austin');
  check('every vertex is inside the Austin box (locations in the new areas can be picked)', shared.every(([lon, lat]) => isInServiceArea(austin, lon, lat)));
  const b = austin.bbox, lons = shared.map(p => p[0]), lats = shared.map(p => p[1]);
  check('the box is wider than the zone on every side (at least 1 km)', lons.every(l => l - b.minLon > 0.01 && b.maxLon - l > 0.01) && lats.every(l => l - b.minLat > 0.01 && b.maxLat - l > 0.01));
  check('only two service areas exist', SERVICE_AREAS.length === 2);
}

t.finish();
