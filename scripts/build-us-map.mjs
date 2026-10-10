// Run: npm i --no-save us-atlas@3 topojson-client@3 topojson-simplify@3 d3-geo@3
//      node scripts/build-us-map.mjs public/js/us-sightings-data.js
// Builds public/js/us-sightings-data.js: static SVG paths for the 50 states +
// DC (US Census boundaries via us-atlas, pre-projected Albers USA, 975x610,
// simplified) and the sighting cities placed with the same projection.
// Run once; the site ships the output, never a map service.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';
import { presimplify, simplify } from 'topojson-simplify';
import { geoPath, geoAlbersUsa } from 'd3-geo';

const require = createRequire(import.meta.url);
const topo = require('us-atlas/states-albers-10m.json');
const out = process.argv[2];

const FIPS = { '01': ['AL', 'Alabama'], '02': ['AK', 'Alaska'], '04': ['AZ', 'Arizona'], '05': ['AR', 'Arkansas'], '06': ['CA', 'California'], '08': ['CO', 'Colorado'], '09': ['CT', 'Connecticut'], '10': ['DE', 'Delaware'], '11': ['DC', 'District of Columbia'], '12': ['FL', 'Florida'], '13': ['GA', 'Georgia'], '15': ['HI', 'Hawaii'], '16': ['ID', 'Idaho'], '17': ['IL', 'Illinois'], '18': ['IN', 'Indiana'], '19': ['IA', 'Iowa'], '20': ['KS', 'Kansas'], '21': ['KY', 'Kentucky'], '22': ['LA', 'Louisiana'], '23': ['ME', 'Maine'], '24': ['MD', 'Maryland'], '25': ['MA', 'Massachusetts'], '26': ['MI', 'Michigan'], '27': ['MN', 'Minnesota'], '28': ['MS', 'Mississippi'], '29': ['MO', 'Missouri'], '30': ['MT', 'Montana'], '31': ['NE', 'Nebraska'], '32': ['NV', 'Nevada'], '33': ['NH', 'New Hampshire'], '34': ['NJ', 'New Jersey'], '35': ['NM', 'New Mexico'], '36': ['NY', 'New York'], '37': ['NC', 'North Carolina'], '38': ['ND', 'North Dakota'], '39': ['OH', 'Ohio'], '40': ['OK', 'Oklahoma'], '41': ['OR', 'Oregon'], '42': ['PA', 'Pennsylvania'], '44': ['RI', 'Rhode Island'], '45': ['SC', 'South Carolina'], '46': ['SD', 'South Dakota'], '47': ['TN', 'Tennessee'], '48': ['TX', 'Texas'], '49': ['UT', 'Utah'], '50': ['VT', 'Vermont'], '51': ['VA', 'Virginia'], '53': ['WA', 'Washington'], '54': ['WV', 'West Virginia'], '55': ['WI', 'Wisconsin'], '56': ['WY', 'Wyoming'] };

const simple = simplify(presimplify(topo), 0.6);
const path = geoPath();   // the topology is already projected
const round = d => d.replace(/(\d+\.\d)\d+/g, '$1');
const states = feature(simple, simple.objects.states).features
  .filter(f => FIPS[f.id])
  .map(f => ({ id: FIPS[f.id][0], name: FIPS[f.id][1], d: round(path(f)), c: path.centroid(f).map(v => Math.round(v)) }))
  .sort((a, b) => a.id.localeCompare(b.id));

// The projection us-atlas uses for its *-albers-10m files.
const proj = geoAlbersUsa().scale(1300).translate([487.5, 305]);
// Cybercab sighting cities (community reports, Sept 2026).
const CITIES = [
  ['Woodinville', 'WA', 47.7543, -122.1635],
  ['Sacramento', 'CA', 38.5816, -121.4944], ['Roseville', 'CA', 38.7521, -121.2880], ['Concord (East Bay)', 'CA', 37.9780, -122.0311],
  ['Oakland', 'CA', 37.8044, -122.2712], ['Daly City', 'CA', 37.6879, -122.4702], ['Montebello', 'CA', 34.0165, -118.1138],
  ['El Cajon', 'CA', 32.7948, -116.9625], ['Chula Vista', 'CA', 32.6401, -117.0842],
  ['South Salt Lake', 'UT', 40.7188, -111.8883],
  ['Apache Junction', 'AZ', 33.4151, -111.5496], ['Chandler', 'AZ', 33.3062, -111.8413], ['Queen Creek', 'AZ', 33.2487, -111.6343],
  ['Austin', 'TX', 30.2672, -97.7431], ['Fort Worth / North Richland Hills', 'TX', 32.8343, -97.2289], ['Bellaire', 'TX', 29.7058, -95.4588],
  ['Merriam', 'KS', 39.0236, -94.6936],
  ['St. Louis / Afton', 'MO', 38.5506, -90.3343],
  ['New Orleans', 'LA', 29.9511, -90.0715, 'driving / transport'],
  ['Maple Grove', 'MN', 45.0725, -93.4558],
  ['Skokie', 'IL', 42.0324, -87.7416],
  ['Nashville', 'TN', 36.1627, -86.7816], ['Mt. Juliet', 'TN', 36.2001, -86.5186], ['Franklin', 'TN', 35.9251, -86.8689], ['Memphis', 'TN', 35.1495, -90.0490],
  ['Buffalo', 'NY', 42.8864, -78.8784], ['South Bronx', 'NY', 40.8163, -73.9165], ['Brooklyn', 'NY', 40.6782, -73.9442], ['Midtown Manhattan', 'NY', 40.7549, -73.9840, 'driving'],
  ['Seabrook', 'NH', 42.8948, -70.8712],
  ['Everett', 'MA', 42.4084, -71.0537],
  ['Englewood', 'NJ', 40.8929, -73.9726], ['Teaneck', 'NJ', 40.8976, -74.0160], ['Oradell', 'NJ', 40.9587, -74.0368], ['River Edge', 'NJ', 40.9287, -74.0399],
  ['Devon / Philadelphia area', 'PA', 40.0490, -75.4293],
  ['Hyattsville', 'MD', 38.9559, -76.9455],
  ['Annandale', 'VA', 38.8304, -77.1964],
  ['Charlotte', 'NC', 35.2271, -80.8431],
  ['Celebration', 'FL', 28.3253, -81.5334, 'near Orlando']
];
const cities = CITIES.map(([name, st, lat, lon, note]) => {
  const p = proj([lon, lat]);
  if (!p) throw new Error('unprojectable ' + name);
  return { name, st, x: Math.round(p[0] * 10) / 10, y: Math.round(p[1] * 10) / 10, ...(note ? { note } : {}) };
});
// States with reported sightings (community reports, Sept 2026).
const SIGHTED = ['AZ', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA', 'ID', 'IL', 'KS', 'LA', 'MA', 'MD', 'MI', 'MN', 'MO', 'NC', 'NH', 'NJ', 'NV', 'NY', 'OH', 'OK', 'PA', 'SC', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA'];
for (const c of cities) if (!SIGHTED.includes(c.st)) throw new Error('city in unsighted state ' + c.name);
for (const s of SIGHTED) if (!states.some(x => x.id === s)) throw new Error('unknown state ' + s);

const js = `/* Static data for the homepage "Cybercab sightings across the US" map
   (js/us-sightings-map.js). GENERATED once from public-domain US Census state
   boundaries (us-atlas states-albers-10m: Albers USA, 975 x 610, simplified)
   — no map service is called at runtime. Sightings are community reports
   compiled by @CuriousPejjy on X (Sept 2026): the states with a reported
   Cybercab sighting, and the named cities, placed with the same projection.
   To add a city, add [name, state, lat, lon] to the generator's list (or a
   {name, st, x, y} entry here, x/y in the 975 x 610 frame). */
window.CCH_US_MAP = ${JSON.stringify({ viewBox: '0 0 975 610', source: { name: '@CuriousPejjy on X', date: 'Sept 2026', url: 'https://x.com/CuriousPejjy' }, sighted: SIGHTED, states, cities })};
`;
fs.writeFileSync(out, js);
console.log('states', states.length, 'cities', cities.length, 'sighted', SIGHTED.length, 'bytes', js.length);
