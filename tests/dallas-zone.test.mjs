// The Dallas service zone (expanded Nov 2026, reconstructed from two reference
// images: docs/verification/dallas-zone-expansion/README.md). One boundary,
// shared by the website and the iOS app.
// Run: node tests/dallas-zone.test.mjs
import fs from 'node:fs';
import { makeCheck } from './helpers/env.mjs';
import { serviceAreaFor, isInServiceArea } from '../worker/service-areas.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(ROOT + f, 'utf8');
const ring = (src, name) => [...src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))[1].matchAll(/\[(-?\d+\.\d+),\s*(-?\d+\.\d+)\]/g)].map(m => [Number(m[1]), Number(m[2])]);

const dallas = ring(read('public/js/austin-map.js'), 'DALLAS_SERVICE_ZONE');
const austin = ring(read('public/js/austin-map.js'), 'SERVICE_ZONE');
const ios = JSON.parse(read('ios-native/CybercabHunter/Resources/WebData/zones.json')).cities;
const iosDallas = ios.find(c => c.key === 'dallas').zone, iosAustin = ios.find(c => c.key === 'austin').zone;

// The zone before the Nov 2026 expansion (for the "southern part unchanged" checks).
const PREVIOUS = [
  [-96.85815, 32.8603], [-96.84597, 32.86391], [-96.82591, 32.86737], [-96.77756, 32.86617],
  [-96.77756, 32.87189], [-96.76234, 32.87189], [-96.75249, 32.8749], [-96.74443, 32.87309],
  [-96.73905, 32.8609], [-96.73959, 32.84374], [-96.73601, 32.82447], [-96.72921, 32.81363],
  [-96.73726, 32.77976], [-96.75284, 32.76381], [-96.78562, 32.74318], [-96.81481, 32.73566],
  [-96.92172, 32.74695], [-96.92316, 32.81619], [-96.89665, 32.81965], [-96.87964, 32.83501],
  [-96.85421, 32.84208], [-96.84525, 32.84856], [-96.85815, 32.8603]
];

// Equal-area ring area on the WGS84 authalic sphere (mi²), as tests/austin-zone.test.mjs.
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
const key = p => JSON.stringify(p);

console.log('1. One boundary on both platforms');
{
  check('the iOS app uses the same ring as the website', key(dallas) === key(iosDallas));
  check('closed', key(dallas[0]) === key(dallas.at(-1)));
  let crossing = 0;
  for (let i = 0; i + 1 < dallas.length; i++) for (let j = i + 2; j + 1 < dallas.length; j++) if (!(i === 0 && j + 2 === dallas.length) && segmentsCross(dallas[i], dallas[i + 1], dallas[j], dallas[j + 1])) crossing++;
  check('a simple polygon: no edge crosses another', crossing === 0);
  check('15 vertices', dallas.length === 16);
}

console.log('2. Coverage is measured from the polygon');
{
  const measured = sqMi(dallas), before = sqMi(PREVIOUS);
  check(`measured area (${measured.toFixed(1)} mi²) is about 148`, Math.abs(measured - 147.9) < 0.5);
  check(`the previous zone measured about 80 mi² (${before.toFixed(1)})`, Math.abs(before - 80.1) < 0.5);
  check('the server reports the measured figure', serviceAreaFor('dallas').zone.square_miles === Math.round(measured));
  check('the app\'s wait-time model uses it', /"dallas": 148\.0/.test(read('ios-native/CybercabHunter/Features/Simulation/SimulationCalc.swift')));
  check('the website\'s wait-time model reads it from the shared config', /DALLAS_AREA_SQ_MI = cityFacts\('dallas'\)\?\.zone\.square_miles \?\? 148;/.test(read('public/js/calc.js')));
  check('the Zones page counts it up from the shared config', /countUp\(document\.getElementById\('dalCoverageOut'\), [^\n]+key === 'dallas'\)\.zone\.square_miles\)/.test(read('public/infrastructure.html')));
  // Both cities' areas are reconstructions, so every display says "est." and the Zones panels say why.
  const zonesPage = read('public/infrastructure.html');
  check('the Zones panels label both areas as estimates', (zonesPage.match(/>Coverage \(est\.\)</g) || []).length === 2 && (zonesPage.match(/Area estimated from Tesla's map; not an official Tesla figure\./g) || []).length === 2);
  check('the homepage tile labels the area as an estimate', /tile\('Coverage \(est\.\)'/.test(read('public/js/home-rows.js')) && /home-rows\.js\?v=19/.test(read('public/index.html')));
  check('the app labels the area as an estimate (Home, Zones, Tracker)', /tile\("Coverage \(est\.\)"/.test(read('ios-native/CybercabHunter/Features/Home/HomeSections.swift')) && /COVERAGE \(EST\.\)/.test(read('ios-native/CybercabHunter/Features/Zones/ZonesView.swift')) && /not an official Tesla figure/.test(read('ios-native/CybercabHunter/Features/Zones/ZonesView.swift')) && /mi² \(est\.\)/.test(read('ios-native/CybercabHunter/Features/History/TrackerExplorePanel.swift')));
  check('no "81 mi²" left', !/\b81 ?mi²/.test(read('public/js/calc.js') + read('public/infrastructure.html') + read('public/simulation.html') + read('public/js/austin-map.js')));
}

console.log('3. The expansion, as the reference images show it');
{
  // The southern part is the previous boundary, vertex for vertex (the east elbow
  // round to the west corner), so no area the zone covered is lost.
  const south = PREVIOUS.slice(11, 18).map(key), now = dallas.map(key);
  const at = now.indexOf(south[0]);
  check('the southern boundary is the previous one, unchanged', at !== -1 && south.every((p, k) => now[at + k] === p));
  check('every previous vertex is inside the new zone or on its boundary', PREVIOUS.every(p => now.includes(key(p)) || inside(p, dallas)));
  const added = { 'Love Field': [-96.8518, 32.8471], 'Galleria Dallas': [-96.8203, 32.9311], 'Medical City Dallas': [-96.7728, 32.9104], 'LBJ Fwy at the Tollway': [-96.8217, 32.9213], 'LBJ Fwy at US 75': [-96.7685, 32.9228] };
  for (const [name, p] of Object.entries(added)) check(`${name}: inside the new zone, outside the previous one`, inside(p, dallas) && !inside(p, PREVIOUS));
  for (const [name, p] of Object.entries({ 'Downtown Dallas': [-96.797, 32.7767], 'Highland Park': [-96.792, 32.8335], 'Deep Ellum': [-96.7836, 32.7845] })) check(`${name}: still inside`, inside(p, dallas));
  for (const [name, p] of Object.entries({ 'Plano': [-96.6989, 33.0198], 'Irving': [-96.9489, 32.814], 'Garland': [-96.6389, 32.9126], 'DFW Airport': [-97.0403, 32.8998], 'Addison Airport': [-96.8364, 32.9686], 'Mesquite': [-96.5992, 32.7668], 'Oak Cliff south of the zone': [-96.83, 32.70] })) check(`${name}: outside`, !inside(p, dallas));
}

console.log('4. Austin is unchanged; the boxes reach the new zone');
{
  check('Austin unchanged on both platforms', key(austin) === key(iosAustin) && austin.length === 32 && key(austin[0]) === '[-97.723472,30.452872]' && Math.abs(sqMi(austin) - 440.1) < 1);
  check('Austin still 440 mi²', serviceAreaFor('austin').zone.square_miles === 440);
  const area = serviceAreaFor('dallas');
  check('every vertex is inside the Dallas box (locations in the new areas can be picked)', dallas.every(([lon, lat]) => isInServiceArea(area, lon, lat)));
  const m = area.mapBounds, lons = dallas.map(p => p[0]), lats = dallas.map(p => p[1]);
  check('the Zones map search box covers the whole zone', lons.every(l => l >= m.minLon && l <= m.maxLon) && lats.every(l => l >= m.minLat && l <= m.maxLat));
  check('Replay\'s fallback box covers the whole zone', /\[\[-96\.93, 32\.73\], \[-96\.70, 32\.96\]\]/.test(read('public/js/replay.js')));
  check('map-search cache entries from the old box are skipped (v3)', /\/api\/places\/map\?v=3&area=/.test(read('worker/places.js')));
}

t.finish();
