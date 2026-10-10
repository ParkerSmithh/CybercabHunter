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
// Cybercab sighting cities: [name, state, lat, lon, sightings, note]. Two
// community sources: the MyCybercab.com city leaderboard (approved sightings,
// early Oct 2026; the count is theirs) and @CuriousPejjy's map on X (Sept
// 2026; no counts — null). Duplicates and typos in the leaderboard merged.
const CITIES = [
  // California
  ['San Diego', 'CA', 32.7157, -117.1611, 31], ['San Francisco', 'CA', 37.7749, -122.4194, 14], ['San Jose', 'CA', 37.3382, -121.8863, 13],
  ['Sacramento', 'CA', 38.5816, -121.4944, 10], ['Palo Alto', 'CA', 37.4419, -122.1430, 7], ['Mountain View', 'CA', 37.3861, -122.0839, 4],
  ['Fremont', 'CA', 37.5485, -121.9886, 4], ['Dublin', 'CA', 37.7022, -121.9358, 3], ['Oakland', 'CA', 37.8044, -122.2712, 3],
  ['Antelope', 'CA', 38.7082, -121.3300, 3], ['San Mateo', 'CA', 37.5630, -122.3255, 3], ['Cupertino', 'CA', 37.3230, -122.0322, 3],
  ['Roseville', 'CA', 38.7521, -121.2880, 2], ['El Monte', 'CA', 34.0686, -118.0276, 2], ['Chula Vista', 'CA', 32.6401, -117.0842, 2],
  ['El Cajon', 'CA', 32.7948, -116.9625, 2], ['Berkeley', 'CA', 37.8715, -122.2730, 2], ['Diamond Bar', 'CA', 34.0286, -117.8103, 1],
  ['Brea', 'CA', 33.9167, -117.9001, 1], ['Coronado', 'CA', 32.6859, -117.1831, 1], ['Placentia', 'CA', 33.8722, -117.8703, 1],
  ['Rocklin', 'CA', 38.7907, -121.2358, 1], ['Encinitas', 'CA', 33.0370, -117.2920, 1], ['Spring Valley', 'CA', 32.7448, -116.9989, 1],
  ['Santee', 'CA', 32.8384, -116.9739, 1], ['Pasadena', 'CA', 34.1478, -118.1445, 1], ['Carlsbad', 'CA', 33.1581, -117.3506, 1],
  ['Los Gatos', 'CA', 37.2358, -121.9624, 1], ['National City', 'CA', 32.6781, -117.0992, 1], ['Los Angeles', 'CA', 34.0522, -118.2437, 1],
  ['Union City', 'CA', 37.5934, -122.0438, 1], ['San Bruno', 'CA', 37.6305, -122.4111, 1], ['Sunnyvale', 'CA', 37.3688, -122.0363, 1],
  ['Concord (East Bay)', 'CA', 37.9780, -122.0311, null], ['Daly City', 'CA', 37.6879, -122.4702, null], ['Montebello', 'CA', 34.0165, -118.1138, null],
  // Pennsylvania
  ['Pittsburgh', 'PA', 40.4406, -79.9959, 31], ['Philadelphia', 'PA', 39.9526, -75.1652, 4], ['Wexford', 'PA', 40.6262, -80.0559, 2],
  ['Springfield', 'PA', 39.9301, -75.3202, 2], ['Bridgeville', 'PA', 40.3562, -80.1101, 2], ['Devon', 'PA', 40.0490, -75.4293, 1],
  ['Wyndmoor', 'PA', 40.0815, -75.1893, 1], ['Penn Hills', 'PA', 40.5012, -79.8392, 1], ['Cranberry Township', 'PA', 40.6848, -80.1067, 1],
  ['Broomall', 'PA', 39.9815, -75.3566, 1], ['Newtown Square', 'PA', 39.9868, -75.4010, 1], ['Gladwyne', 'PA', 40.0390, -75.2768, 1],
  // Utah
  ['Salt Lake City', 'UT', 40.7608, -111.8910, 28], ['Draper', 'UT', 40.5247, -111.8638, 4], ['South Jordan', 'UT', 40.5622, -111.9297, 4],
  ['Lehi', 'UT', 40.3916, -111.8508, 4], ['Pleasant Grove', 'UT', 40.3641, -111.7385, 3], ['West Jordan', 'UT', 40.6097, -111.9391, 2],
  ['Orem', 'UT', 40.2969, -111.6946, 1], ['Vineyard', 'UT', 40.2972, -111.7466, 1], ['Murray', 'UT', 40.6669, -111.8880, 1],
  ['Millcreek', 'UT', 40.6869, -111.8755, 1], ['Taylorsville', 'UT', 40.6677, -111.9388, 1], ['Provo', 'UT', 40.2338, -111.6585, 1],
  ['South Salt Lake', 'UT', 40.7188, -111.8883, null],
  // Texas
  ['Houston', 'TX', 29.7604, -95.3698, 26], ['Austin', 'TX', 30.2672, -97.7431, 24], ['Dallas', 'TX', 32.7767, -96.7970, 13],
  ['North Richland Hills', 'TX', 32.8343, -97.2289, 5], ['Fort Worth', 'TX', 32.7555, -97.3308, 3], ['Arlington', 'TX', 32.7357, -97.1081, 2],
  ['Aledo', 'TX', 32.6957, -97.6022, 2], ['Hurst', 'TX', 32.8235, -97.1706, 1], ['Flower Mound', 'TX', 33.0146, -97.0970, 1],
  ['Cypress', 'TX', 29.9691, -95.6972, 1], ['New Caney', 'TX', 30.1527, -95.2063, 1], ['Keller', 'TX', 32.9346, -97.2292, 1],
  ['Lantana', 'TX', 33.0907, -97.1242, 1], ['River Oaks', 'TX', 32.7768, -97.3945, 1], ['San Antonio', 'TX', 29.4241, -98.4936, 1],
  ['Jersey Village', 'TX', 29.8877, -95.5633, 1], ['Highland Park', 'TX', 32.8335, -96.7920, 1], ['Johnson City', 'TX', 30.2768, -98.4119, 1],
  ['Round Rock', 'TX', 30.5083, -97.6789, 1], ['Seguin', 'TX', 29.5688, -97.9647, 1], ['Georgetown', 'TX', 30.6333, -97.6770, 1],
  ['Lakeway', 'TX', 30.3638, -97.9795, 1], ['Plano', 'TX', 33.0198, -96.6989, 1], ['Katy', 'TX', 29.7858, -95.8245, 1],
  ['Bellaire', 'TX', 29.7058, -95.4588, null],
  // Tennessee
  ['Memphis', 'TN', 35.1495, -90.0490, 15], ['Nashville', 'TN', 36.1627, -86.7816, 5], ['Bartlett', 'TN', 35.2045, -89.8740, 3],
  ['Germantown', 'TN', 35.0868, -89.8101, 2], ['Franklin', 'TN', 35.9251, -86.8689, 2], ['Cordova', 'TN', 35.1556, -89.7762, 1],
  ['Mt. Juliet', 'TN', 36.2001, -86.5186, null],
  // Florida
  ['Jacksonville', 'FL', 30.3322, -81.6557, 11], ['Tampa', 'FL', 27.9506, -82.4572, 10], ['Orlando', 'FL', 28.5383, -81.3792, 8],
  ['Miami', 'FL', 25.7617, -80.1918, 3], ['St. Petersburg', 'FL', 27.7676, -82.6403, 3], ['Coral Gables', 'FL', 25.7215, -80.2684, 2],
  ['Miami Beach', 'FL', 25.7907, -80.1300, 1], ['Spring Hill', 'FL', 28.4769, -82.5300, 1], ['Live Oak', 'FL', 30.2949, -82.9840, 1],
  ['Winter Garden', 'FL', 28.5653, -81.5862, 1], ['Jacksonville Beach', 'FL', 30.2947, -81.3931, 1], ['Clermont', 'FL', 28.5494, -81.7729, 1],
  ['Lutz', 'FL', 28.1511, -82.4615, 1], ['Sunrise', 'FL', 26.1670, -80.2560, 1], ['Fort Myers', 'FL', 26.6406, -81.8723, 1],
  ['Celebration', 'FL', 28.3253, -81.5334, null, 'near Orlando'],
  // Maryland
  ['Baltimore', 'MD', 39.2904, -76.6122, 18], ['Owings Mills', 'MD', 39.4195, -76.7803, 3], ['Hyattsville', 'MD', 38.9559, -76.9455, 2],
  ['Silver Spring', 'MD', 38.9907, -77.0261, 1], ['Gaithersburg', 'MD', 39.1434, -77.2014, 1], ['Bethesda', 'MD', 38.9847, -77.0947, 1],
  ['Derwood', 'MD', 39.1173, -77.1611, 1], ['Chevy Chase', 'MD', 38.9940, -77.0730, 1], ['Halethorpe', 'MD', 39.2309, -76.6825, 1],
  ['Pikesville', 'MD', 39.3743, -76.7225, 1], ['Windsor Mill', 'MD', 39.3332, -76.7836, 1],
  // Missouri
  ['Kansas City', 'MO', 39.0997, -94.5786, 10], ['St. Louis', 'MO', 38.6270, -90.1994, 8], ['North Kansas City', 'MO', 39.1300, -94.5622, 2],
  ['Rock Hill', 'MO', 38.6075, -90.3793, 1], ['Clayton', 'MO', 38.6426, -90.3237, 1], ['Kirkwood', 'MO', 38.5834, -90.4068, 1],
  ['Afton', 'MO', 38.5506, -90.3343, 1], ['Independence', 'MO', 39.0911, -94.4155, 1], ['Gladstone', 'MO', 39.2039, -94.5547, 1],
  // Washington
  ['Bellevue', 'WA', 47.6101, -122.2015, 9], ['Redmond', 'WA', 47.6740, -122.1215, 7], ['Seattle', 'WA', 47.6062, -122.3321, 5],
  ['Auburn', 'WA', 47.3073, -122.2285, 3], ['Kirkland', 'WA', 47.6815, -122.2087, 2], ['Renton', 'WA', 47.4829, -122.2171, 2],
  ['Edmonds', 'WA', 47.8107, -122.3774, 1], ['Lynnwood', 'WA', 47.8209, -122.3151, 1], ['Federal Way', 'WA', 47.3223, -122.3126, 1],
  ['Newcastle', 'WA', 47.5390, -122.1557, 1], ['Woodinville', 'WA', 47.7543, -122.1635, 1],
  // Georgia, Illinois, Louisiana
  ['Atlanta', 'GA', 33.7490, -84.3880, 8],
  ['Chicago', 'IL', 41.8781, -87.6298, 7], ['Skokie', 'IL', 42.0324, -87.7416, 1], ['Evanston', 'IL', 42.0451, -87.6877, 1], ['Granite City', 'IL', 38.7014, -90.1487, 1],
  ['New Orleans', 'LA', 29.9511, -90.0715, 6], ['Metairie', 'LA', 29.9841, -90.1529, 2], ['Kenner', 'LA', 29.9941, -90.2417, 1], ['Jefferson', 'LA', 29.9660, -90.1531, 1],
  // Arizona, Kansas, Nevada
  ['Phoenix', 'AZ', 33.4484, -112.0740, 6], ['Tempe', 'AZ', 33.4255, -111.9400, 5], ['Mesa', 'AZ', 33.4152, -111.8315, 3],
  ['Apache Junction', 'AZ', 33.4151, -111.5496, 1], ['Queen Creek', 'AZ', 33.2487, -111.6343, 1], ['Scottsdale', 'AZ', 33.4942, -111.9261, 1],
  ['Chandler', 'AZ', 33.3062, -111.8413, null],
  ['Lenexa', 'KS', 38.9536, -94.7336, 6], ['Overland Park', 'KS', 38.9822, -94.6708, 5], ['Olathe', 'KS', 38.8814, -94.8191, 4],
  ['Kansas City', 'KS', 39.1141, -94.6275, 3], ['Merriam', 'KS', 39.0236, -94.6936, 2], ['Shawnee', 'KS', 39.0228, -94.7152, 1], ['Mission', 'KS', 39.0278, -94.6558, 1],
  ['Reno', 'NV', 39.5296, -119.8138, 5], ['Las Vegas', 'NV', 36.1699, -115.1398, 4], ['Pahrump', 'NV', 36.2083, -115.9839, 1],
  // New Jersey, Virginia, New York, DC
  ['Teaneck', 'NJ', 40.8976, -74.0160, 5], ['Clifton', 'NJ', 40.8584, -74.1638, 3], ['Lodi', 'NJ', 40.8823, -74.0832, 2],
  ['Oradell', 'NJ', 40.9587, -74.0368, 2], ['River Edge', 'NJ', 40.9287, -74.0399, 2], ['Cinnaminson', 'NJ', 40.0026, -74.9930, 1],
  ['Englewood', 'NJ', 40.8929, -73.9726, null],
  ['Arlington', 'VA', 38.8816, -77.0910, 4], ['McLean', 'VA', 38.9339, -77.1773, 4], ['Falls Church', 'VA', 38.8823, -77.1711, 4],
  ['Annandale', 'VA', 38.8304, -77.1964, null],
  ['Manhattan', 'NY', 40.7549, -73.9840, 4], ['Buffalo', 'NY', 42.8864, -78.8784, 2], ['Brooklyn', 'NY', 40.6782, -73.9442, 1],
  ['Queens', 'NY', 40.7282, -73.7949, 1], ['Great Neck', 'NY', 40.8007, -73.7285, 1], ['South Bronx', 'NY', 40.8163, -73.9165, null],
  ['Washington', 'DC', 38.9072, -77.0369, 3],
  // North Carolina, Massachusetts, Michigan, Minnesota
  ['Charlotte', 'NC', 35.2271, -80.8431, 2], ['Concord', 'NC', 35.4088, -80.5795, 1],
  ['Peabody', 'MA', 42.5279, -70.9287, 2], ['Boston', 'MA', 42.3601, -71.0589, 2], ['Woburn', 'MA', 42.4793, -71.1523, 1], ['Everett', 'MA', 42.4084, -71.0537, 1],
  ['Farmington Hills', 'MI', 42.4989, -83.3677, 4], ['Livonia', 'MI', 42.3684, -83.3527, 2], ['Royal Oak', 'MI', 42.4895, -83.1446, 1],
  ['St. Clair Shores', 'MI', 42.4970, -82.8888, 1], ['Detroit', 'MI', 42.3314, -83.0458, 1], ['Canton', 'MI', 42.3087, -83.4822, 1],
  ['Ann Arbor', 'MI', 42.2808, -83.7430, 1], ['Southfield', 'MI', 42.4734, -83.2219, 1], ['Northville', 'MI', 42.4311, -83.4833, 1],
  ['Minneapolis', 'MN', 44.9778, -93.2650, 2], ['New Brighton', 'MN', 45.0655, -93.2016, 1], ['Maple Grove', 'MN', 45.0725, -93.4558, 1],
  ['Plymouth', 'MN', 45.0105, -93.4555, 1], ['Brooklyn Center', 'MN', 45.0761, -93.3327, 1],
  // Colorado, South Carolina, Oklahoma, New Hampshire
  ['Colorado Springs', 'CO', 38.8339, -104.8214, 3], ['Arvada', 'CO', 39.8028, -105.0875, 1], ['Westminster', 'CO', 39.8367, -105.0372, 1],
  ['Greenwood Village', 'CO', 39.6172, -104.9508, 1],
  ['Gaffney', 'SC', 35.0718, -81.6498, 1], ['Lawton', 'OK', 34.6036, -98.3959, 1], ['Seabrook', 'NH', 42.8948, -70.8712, null]
];
const cities = CITIES.map(([name, st, lat, lon, n, note]) => {
  const p = proj([lon, lat]);
  if (!p) throw new Error('unprojectable ' + name);
  return { name, st, x: Math.round(p[0] * 10) / 10, y: Math.round(p[1] * 10) / 10, ...(n ? { n } : {}), ...(note ? { note } : {}) };
});
const seen = new Set();
for (const c of cities) { const k = c.name + '|' + c.st; if (seen.has(k)) throw new Error('duplicate ' + k); seen.add(k); }
// States with reported sightings (community reports, Sept 2026).
const SIGHTED = ['AZ', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA', 'ID', 'IL', 'KS', 'LA', 'MA', 'MD', 'MI', 'MN', 'MO', 'NC', 'NH', 'NJ', 'NV', 'NY', 'OH', 'OK', 'PA', 'SC', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA'];
for (const c of cities) if (!SIGHTED.includes(c.st)) throw new Error('city in unsighted state ' + c.name);
for (const s of SIGHTED) if (!states.some(x => x.id === s)) throw new Error('unknown state ' + s);

const js = `/* Static data for the homepage "Cybercab sightings across the US" map
   (js/us-sightings-map.js). GENERATED once from public-domain US Census state
   boundaries (us-atlas states-albers-10m: Albers USA, 975 x 610, simplified)
   — no map service is called at runtime. Sightings are community reports:
   the MyCybercab.com city leaderboard (Oct 2026; n = its approved sightings)
   and @CuriousPejjy's map on X (Sept 2026), the cities placed with the same
   projection. To add a city, add it to scripts/build-us-map.mjs and rerun. */
window.CCH_US_MAP = ${JSON.stringify({ viewBox: '0 0 975 610', sources: [{ name: 'MyCybercab.com', what: 'city leaderboard', date: 'Oct 2026', url: 'https://mycybercab.com' }, { name: '@CuriousPejjy on X', what: 'sightings map', date: 'Sept 2026', url: 'https://x.com/CuriousPejjy' }], sighted: SIGHTED, states, cities })};
`;
fs.writeFileSync(out, js);
console.log('states', states.length, 'cities', cities.length, 'sighted', SIGHTED.length, 'bytes', js.length);
