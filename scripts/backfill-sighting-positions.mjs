// One-off, run by hand, only with the owner's approval: gives older approved
// photo sightings a Following-map position (migrations/0052). Writes nothing to
// the database. It reads a list of rows and writes a SQL file to review first.
//
// A position is set ONLY when the place search returns a place inside the
// sighting's service area with exactly the stored label, at one spot
// (worker/places.js positionForStoredLabel). Anything else stays unplaced and is
// counted, not guessed. The stored label is Photon's own, chosen at submission.
//
//   npx wrangler d1 execute cybercabhunter-db --remote --json --command \
//     "SELECT o.id, o.service_area, o.approx_location FROM vehicle_observations o JOIN submissions s ON s.id = o.submission_id WHERE s.status = 'approved' AND s.evidence_type = 'photo' AND o.map_lat IS NULL AND o.approx_location IS NOT NULL" > rows.json
//   node scripts/backfill-sighting-positions.mjs rows.json positions.sql
//   (read positions.sql, back up, then) npx wrangler d1 execute cybercabhunter-db --remote --file positions.sql
//
// Sends only the place labels to Photon, one request a second, as the site does.
import fs from 'node:fs';
import { positionForStoredLabel } from '../worker/places.js';
import { serviceAreaFor } from '../worker/service-areas.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) { console.error('usage: backfill-sighting-positions.mjs <rows.json> <out.sql>'); process.exit(1); }
const parsed = JSON.parse(fs.readFileSync(input, 'utf8'));
const rows = Array.isArray(parsed) ? (parsed[0].results || parsed) : parsed.results;
const ID = /^[A-Za-z0-9-]{1,64}$/;
const lines = [];
let unplaced = 0;
for (const row of rows) {
  const area = serviceAreaFor(row.service_area);
  let position = null;
  if (area && ID.test(row.id)) {
    try { position = await positionForStoredLabel(row.approx_location, area); } catch (e) { console.error(`search failed for ${row.id}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (position) lines.push(`UPDATE vehicle_observations SET map_lat = ${position.lat}, map_lng = ${position.lng} WHERE id = '${row.id}' AND map_lat IS NULL;`);
  else unplaced++;
}
fs.writeFileSync(output, lines.join('\n') + '\n');
console.log(`${lines.length} positions written to ${output}; ${unplaced} left unplaced. Nothing was changed.`);
