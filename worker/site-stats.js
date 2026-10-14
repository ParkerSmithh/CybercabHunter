// Headline totals only. Lists, maps and time-window statistics stay live.
const KEYS = ['sightings_all_time', 'cybercabs_spotted', 'rides_total'];
export async function getSiteStatCounters(sql) {
  await sql.prepare(`INSERT OR IGNORE INTO site_stat_counters(key, value, updated_at)
    VALUES ('sightings_all_time', 0, datetime('now')),
           ('cybercabs_spotted', 0, datetime('now')),
           ('rides_total', 0, datetime('now'))`).run();
  const { results } = await sql.prepare('SELECT key, value FROM site_stat_counters').all();
  const counters = Object.fromEntries(KEYS.map(key => [key, 0]));
  for (const { key, value } of results) {
    if (KEYS.includes(key)) {
      if (!Number.isInteger(value) || value < 0) throw new Error('invalid site counter');
      counters[key] = value;
    }
  }
  return counters;
}

// A city's lifetime approved photo sightings ('sightings_all_time:<city>',
// migrations/0042): one row, 0 before the city's first.
export async function getCitySightingsAllTime(sql, cityKey) {
  const row = await sql.prepare('SELECT value FROM site_stat_counters WHERE key = ?').bind(`sightings_all_time:${String(cityKey).toLowerCase()}`).first();
  const v = row ? row.value : 0;
  if (!Number.isInteger(v) || v < 0) throw new Error('invalid site counter');
  return v;
}
