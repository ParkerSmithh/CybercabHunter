// Robotaxi facilities: the one shared list (public/data/facilities.json) that
// the Zones map (js/zones-facilities.js) and the iOS app (bundled copy,
// refreshed from the same URL) both read. Checks the records, the photos
// (present, optimized, no metadata), the owner's rules for Cedar Springs, and
// that nothing else keeps its own facility list.
// Run: node tests/facilities.test.mjs
import fs from 'node:fs';
import { makeCheck } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(ROOT + f, 'utf8');
const RAW = read('public/data/facilities.json');
const DATA = JSON.parse(RAW);
const F = DATA.facilities;
const byId = id => F.find(f => f.id === id);

console.log('1. Every record is complete, sourced and unique');
{
  const TYPES = Object.keys(DATA.labels.type), OPS = Object.keys(DATA.labels.operational), VER = Object.keys(DATA.labels.verification);
  check('labels: the three types, four operational states, four verification levels (observed is not confirmed)',
    TYPES.join() === 'charging,staging,combined' && OPS.join() === 'operating,reported,planned,unknown' && VER.join() === 'confirmed,observed,reported,unverified' && /not confirmed by Tesla/.test(DATA.labels.verificationHelp.observed) && /Tesla or in official records/.test(DATA.labels.verificationHelp.confirmed));
  check('labels: the shared wording', DATA.labels.type.charging === 'Charging Hub' && DATA.labels.type.staging === 'Staging Ground' && DATA.labels.operational.reported === 'Reported activity');
  check('ids are unique, lowercase slugs', new Set(F.map(f => f.id)).size === F.length && F.every(f => /^[a-z0-9-]+$/.test(f.id)));
  check('no two facilities share a name or sit within 150 m of each other', new Set(F.map(f => f.name)).size === F.length &&
    F.every((a, i) => F.every((b, j) => i === j || Math.hypot((a.lat - b.lat) * 111000, (a.lng - b.lng) * 95000) > 150)));
  for (const f of F) {
    const fields = ['id', 'name', 'city', 'address', 'lat', 'lng', 'type', 'operational', 'verification', 'summary', 'description', 'charging', 'staging', 'photos', 'sources', 'lastVerified'];
    check(`${f.id}: every field`, fields.every(k => f[k] !== undefined && f[k] !== ''), fields.filter(k => f[k] === undefined || f[k] === '').join());
    check(`${f.id}: a known type and statuses`, TYPES.includes(f.type) && OPS.includes(f.operational) && VER.includes(f.verification));
    check(`${f.id}: city is Austin or Dallas, coordinates in that metro`, (f.city === 'austin' && f.lat > 30 && f.lat < 30.6 && f.lng > -98 && f.lng < -97.4) || (f.city === 'dallas' && f.lat > 32.6 && f.lat < 33.1 && f.lng > -97.2 && f.lng < -96.5));
    check(`${f.id}: at least one https source, each with title and publisher`, f.sources.length > 0 && f.sources.every(s => /^https:\/\//.test(s.url) && s.title && s.publisher));
    check(`${f.id}: last verified is a date`, /^\d{4}-\d{2}-\d{2}$/.test(f.lastVerified));
    check(`${f.id}: details match the type (charging → charging details; staging → staging details; combined → both)`,
      (f.type === 'charging' && f.charging.length && !f.staging.length) || (f.type === 'staging' && f.staging.length && !f.charging.length) || (f.type === 'combined' && f.charging.length && f.staging.length));
  }
}

console.log('2. The inventory');
{
  check('Austin: St. Elmo and Ridgepoint (charging, planned)', ['austin-st-elmo', 'austin-ridgepoint'].every(id => byId(id) && byId(id).city === 'austin' && byId(id).type === 'charging' && byId(id).operational === 'planned'));
  check('…at their addresses and the coordinates the site has used', byId('austin-st-elmo').lat === 30.2149565 && byId('austin-st-elmo').lng === -97.7630241 && byId('austin-ridgepoint').lat === 30.3285815 && byId('austin-ridgepoint').lng === -97.6749944);
  check('Irving: charging and staging (16 V4 stalls, 212 storage spots), zoning approved', byId('irving-royal-lane').type === 'combined' && /16 V4/.test(byId('irving-royal-lane').charging.join()) && /212/.test(byId('irving-royal-lane').staging.join()) && /July 16, 2026/.test(byId('irving-royal-lane').description));
  check('four facilities, no more (nothing invented)', F.length === 4);
}

console.log('3. Dallas Cedar Springs Staging Ground (owner\'s rules)');
{
  const c = byId('dallas-cedar-springs');
  const all = JSON.stringify(c);
  check('named, in Dallas, located as the lot near Cedar Springs Rd & W Mockingbird Ln', c && c.name === 'Dallas Cedar Springs Staging Ground' && c.city === 'dallas' && /^Near Cedar Springs Rd & W Mockingbird Ln, Dallas, TX/.test(c.address));
  check('the lot is distinguished from the Tesla service center at 6500 Cedar Springs Rd', /service center \(6500 Cedar Springs Rd\), which is a separate site/.test(c.locationNote) && !/^6500/.test(c.address));
  check('observed Cybercabs, not an officially confirmed Tesla facility', c.verification === 'observed' && /Tesla hasn't confirmed that it runs the lot as a staging facility/.test(c.description) && c.operational === 'reported');
  check('a Staging Ground, not a charging site', c.type === 'staging' && c.charging.length === 0);
  check('never called a Supercharger; no charging equipment claimed', !/supercharg|charger|charging (equipment|stalls|posts)/i.test(all));
  check('no confirmed launch date; says none has been announced', !/launch(es|ing)? (on|date is)|confirmed launch/i.test(all) && /hasn't announced a public launch date/.test(c.description));
  check('the marker is on the lot (NW corner of Cedar Springs & Mockingbird), not the address point', c.lat === 32.8351 && c.lng === -96.8368 && /Mockingbird/.test(c.locationNote));
  check('the owner\'s three photographs: credited to the photographer (the site\'s owner), published with permission, captions and alt text', c.photos.length === 3 && c.photos.every(p => p.credit === "CybercabHunter's owner" && /published with the photographer's permission/.test(p.license) && p.caption && p.alt));
}

console.log('4. Photos: present, optimized, no metadata');
{
  for (const f of F) for (const p of f.photos) {
    for (const key of ['src', 'thumb']) {
      const file = ROOT + 'public' + p[key];
      check(`${p[key]} exists under /images/facilities/${f.id}/`, p[key].startsWith(`/images/facilities/${f.id}/`) && fs.existsSync(file));
      if (!fs.existsSync(file)) continue;
      const buf = fs.readFileSync(file);
      check(`${p[key]}: a WebP with no EXIF or XMP chunk (GPS and camera data stripped)`, buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && !buf.includes(Buffer.from('EXIF')) && !buf.includes(Buffer.from('XMP ')));
      check(`${p[key]}: small (${Math.round(buf.length / 1024)} KB)`, buf.length < (key === 'thumb' ? 60 : 400) * 1024);
    }
    check(`${f.id}: photo size recorded (${p.width}×${p.height}), at most 1600 px`, p.width > 0 && p.height > 0 && Math.max(p.width, p.height) <= 1600);
  }
  check('facilities without photos say why (sources recorded for review, nothing copied)', F.filter(f => !f.photos.length).every(f => f.photoReview && f.photoReview.length > 20));
  check('photo originals stay private (git-ignored inbox)', /^facility-photos\/$/m.test(read('.gitignore')));
}

console.log('5. One list for both platforms');
{
  check('the app bundles the very same file (byte for byte)', read('ios-native/CybercabHunter/Resources/WebData/facilities.json') === RAW);
  const zones = JSON.parse(read('ios-native/CybercabHunter/Resources/WebData/zones.json'));
  check('…and its zones carry no separate charging list', zones.cities.every(c => !('charging' in c)));
  const map = read('public/js/austin-map.js'), page = read('public/infrastructure.html'), mod = read('public/js/zones-facilities.js');
  check('the website keeps no hard-coded facility list (austin-map.js, infrastructure.html)', !/chargingLocations|St\. Elmo|Ridgepoint|Irving Robotaxi/.test(map) && !/dallasChargingLocations|Irving Robotaxi Hub/.test(page));
  check('the Zones page loads the facilities module and its stylesheet', /<script src="js\/zones-facilities\.js\?v=\d+"><\/script>/.test(page) && /<link rel="stylesheet" href="css\/zones-facilities\.css\?v=\d+">/.test(page));
  check('the module reads /data/facilities.json once (no polling) and only site images', /fetch\(DATA_URL\)/.test(mod) && !/setInterval/.test(mod) && /\^\\\/images\\\/facilities\\\//.test(mod));
  check('the panel lists each city\'s facilities', /data-facility-list="austin"/.test(page) && /data-facility-list="dallas"/.test(page));
  const swift = read('ios-native/CybercabHunter/Core/Geo/Facilities.swift');
  check('the app reads the bundled copy and refreshes from the same URL', /forResource: "facilities"/.test(swift) && /cybercabhunter\.com\/data\/facilities\.json/.test(swift));
}

t.finish();
