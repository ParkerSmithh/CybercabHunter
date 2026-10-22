// Copies the website's fixed map data into the native app, unchanged, so the
// two can't drift: run after editing the site's zones, charging locations or
// US sightings map, then rebuild the app.
//   node ios-native/scripts/sync-web-data.mjs
// Reads (never writes) the website:
//   public/js/austin-map.js        SERVICE_ZONE, DALLAS_SERVICE_ZONE, Austin chargingLocations
//   public/infrastructure.html     dallasChargingLocations (the Irving hub)
//   public/js/us-sightings-data.js CCH_US_MAP (Census state paths, community city counts, sources)
// Writes ios-native/CybercabHunter/Resources/WebData/{zones,us-map}.json.
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
const src = fs.readFileSync(path.join(SITE, 'js/austin-map.js'), 'utf8');
const austinCharging = vm.runInNewContext(src.slice(src.indexOf('const chargingLocations = [') + 'const chargingLocations = '.length, src.indexOf('];', src.indexOf('const chargingLocations = [')) + 1));
const page = fs.readFileSync(path.join(SITE, 'infrastructure.html'), 'utf8');
const dallasCharging = vm.runInNewContext(page.slice(page.indexOf('const dallasChargingLocations = [') + 'const dallasChargingLocations = '.length, page.indexOf('];', page.indexOf('const dallasChargingLocations = [')) + 1));

const zones = {
  source: 'public/js/austin-map.js, public/infrastructure.html',
  cities: [
    { key: 'austin', name: 'Austin', state: 'TX', zone: map.SERVICE_ZONE, charging: austinCharging },
    { key: 'dallas', name: 'Dallas', state: 'TX', zone: map.DALLAS_SERVICE_ZONE, charging: dallasCharging }
  ]
};

const usCtx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(SITE, 'js/us-sightings-data.js'), 'utf8'), usCtx);
const us = usCtx.window.CCH_US_MAP;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'zones.json'), JSON.stringify(zones, null, 1) + '\n');
fs.writeFileSync(path.join(OUT, 'us-map.json'), JSON.stringify(us) + '\n');
console.log(`zones.json: Austin ${zones.cities[0].zone.length} points, ${austinCharging.length} charging; Dallas ${zones.cities[1].zone.length} points, ${dallasCharging.length} charging`);
console.log(`us-map.json: ${us.states.length} states, ${us.cities.length} cities, ${us.sighted.length} sighted`);
