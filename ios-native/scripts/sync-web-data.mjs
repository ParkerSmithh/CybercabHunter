// Copies the website's fixed map data into the native app, unchanged, so the
// two can't drift: run after editing the site's zones, Robotaxi facilities or
// US sightings map, then rebuild the app.
//   node ios-native/scripts/sync-web-data.mjs
// Reads (never writes) the website:
//   public/js/austin-map.js        SERVICE_ZONE, DALLAS_SERVICE_ZONE
//   public/data/facilities.json    Robotaxi facilities (copied byte for byte; the app
//                                  also refreshes it from cybercabhunter.com, so new
//                                  photos and facilities reach it without a new build)
//   public/js/us-sightings-data.js CCH_US_MAP (Census state paths, community city counts, sources)
// Writes ios-native/CybercabHunter/Resources/WebData/{zones,facilities,us-map}.json.
// ios-native/CybercabHunterTests/WebDataSyncTests.swift checks they still match.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const NATIVE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SITE = path.resolve(NATIVE, '..', 'public');
const OUT = path.join(NATIVE, 'CybercabHunter', 'Resources', 'WebData');

// The shared map module, run as-is (it only defines data and functions).
const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(SITE, 'js/austin-map.js'), 'utf8'), ctx);
const map = ctx.window.CCCAustinMap;
const facilities = fs.readFileSync(path.join(SITE, 'data/facilities.json'), 'utf8');
const facilityCount = JSON.parse(facilities).facilities.length;

const zones = {
  source: 'public/js/austin-map.js',
  cities: [
    { key: 'austin', name: 'Austin', state: 'TX', zone: map.SERVICE_ZONE },
    { key: 'dallas', name: 'Dallas', state: 'TX', zone: map.DALLAS_SERVICE_ZONE }
  ]
};

const usCtx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(SITE, 'js/us-sightings-data.js'), 'utf8'), usCtx);
const us = usCtx.window.CCH_US_MAP;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'zones.json'), JSON.stringify(zones, null, 1) + '\n');
fs.writeFileSync(path.join(OUT, 'facilities.json'), facilities);
fs.writeFileSync(path.join(OUT, 'us-map.json'), JSON.stringify(us) + '\n');
console.log(`zones.json: Austin ${zones.cities[0].zone.length} points; Dallas ${zones.cities[1].zone.length} points`);
console.log(`facilities.json: ${facilityCount} facilities (same bytes as public/data/facilities.json)`);
console.log(`us-map.json: ${us.states.length} states, ${us.cities.length} cities, ${us.sighted.length} sighted`);
