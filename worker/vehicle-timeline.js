// Vehicle timelines: /vehicle/<id> as a record, not just a card.
//
// REBUILD (once a day, FLEET_STATS_CRON — never a request): from records that
// are already public, one row per event in vehicle_history_events and one
// summary per public vehicle (migration 0061). Writes carry the run's stamp;
// rows from earlier runs are deleted after, so readers never see an empty table.
//
// EVENTS (only what the records say — nothing inferred, nothing invented):
//   first_seen  robotaxi_vehicles.first_seen_at   "First seen"
//   added       robotaxi_vehicles.created_at      "Added to the registry"
//   approved    approval_basis_set_at + basis     only when recorded (manual approvals)
//   sighting    an approved, VERIFIED vehicle sighting linked to this vehicle by
//               the site's existing rule (db.getPublicVehicleSightings): its
//               robotaxi_vehicle_id, or — when it has none — its normalized
//               plate matching exactly ONE registry vehicle. An ambiguous or
//               missing plate links to nothing (never a guess). Watch-camera
//               detections have no vehicle and are on no timeline.
//               Date: observed_at; when it equals the submission time (no
//               separate sighting time was recorded) it is shown as "submitted".
//               Photo + camera name only while the photo is in the public gallery
//               (the gallery's own rule: public id, photo held, within 30 days).
//   rides       ONE aggregate entry — ride count, first/last ride date, total
//               distance — exactly what the page already shows publicly.
//               Individual rides and fares are NOT public (the owner's call).
//   Status changes (in/out of service): the site records none — not shown.
//
// READ: GET /api/robotaxi-vehicles/:id/timeline?filter=all|sightings|rides|status&page=1
//   the public gate (getPublicRobotaxiVehicle: one indexed row) + the summary
//   row + one page of events by (vehicle_id, sort_key). Cache API 1 hour.
import { db } from './db.js';
import { publicVehicleEligibleSql, RIDES_FROM, COUNTED_RIDES_WHERE } from './ride-status.js';
import { normalizePlate } from './plate.js';
import { VEHICLE_ID_RE } from './vehicles.js';
import { serviceAreaFor } from './service-areas.js';
import { trafficCameraFor } from './traffic-cameras.js';

const PAGE_SIZE = 50;
const CACHE_SECONDS = 3600;
const PHOTO_DAYS = 30;
const FILTERS = { all: null, sightings: ['sighting'], rides: ['rides'], status: ['first_seen', 'added', 'approved'] };

const day = v => /^\d{4}-\d{2}-\d{2}(?:$|[ T])/.test(v ?? '') ? v.slice(0, 10) : null;
const cityOf = raw => serviceAreaFor(String(raw || '').split(',')[0])?.key ?? null;

export async function rebuildVehicleTimelines(env, now = Date.now()) {
  const sql = env.cybercabhunter_db;
  const stamp = new Date(now).toISOString();
  const photoCutoff = new Date(now - PHOTO_DAYS * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  const [pub, all, sig, rides] = await Promise.all([
    sql.prepare(`SELECT v.id, v.license_plate, v.service_area, v.first_seen_at, v.created_at, v.approval_basis, v.approval_basis_set_at
      FROM robotaxi_vehicles v WHERE ${publicVehicleEligibleSql('v')}`).all(),
    sql.prepare(`SELECT id, license_plate FROM robotaxi_vehicles`).all(),
    sql.prepare(`SELECT o.id, o.robotaxi_vehicle_id, o.license_plate, o.observed_at, o.service_area, o.camera_id,
        o.public_id, o.evidence_ref, s.submitted_at, s.evidence_type
      FROM vehicle_observations o JOIN submissions s ON s.id = o.submission_id
      WHERE s.submission_type = 'vehicle_sighting' AND s.status = 'approved' AND o.verification_status = 'verified'`).all(),
    sql.prepare(`SELECT vid, COUNT(*) AS n, MIN(d) AS first, MAX(d) AS last, SUM(dist) AS distance, GROUP_CONCAT(DISTINCT area) AS areas FROM (
        SELECT t.robotaxi_vehicle_id AS vid, MIN(t.ride_date) AS d, MAX(t.distance) AS dist, MIN(t.service_area) AS area FROM ${RIDES_FROM}
        WHERE t.robotaxi_vehicle_id IS NOT NULL AND ${COUNTED_RIDES_WHERE} GROUP BY t.robotaxi_vehicle_id, COALESCE(t.ride_key, t.id)
      ) GROUP BY vid`).all()
  ]);
  const vehicles = pub.results || [];
  const publicIds = new Set(vehicles.map(v => v.id));
  // The existing plate rule: a plate links only when exactly one registry vehicle has it.
  const byPlate = new Map();
  for (const v of all.results || []) { const p = normalizePlate(v.license_plate || ''); if (p) byPlate.set(p, byPlate.has(p) ? null : v.id); }
  const events = [];
  const counts = new Map(vehicles.map(v => [v.id, { sightings: 0, rides: 0, registry: 0 }]));
  const push = (vid, key, kind, date, dateKind, data, sortKey) => events.push({ vid, key, kind, date, dateKind, data: JSON.stringify(data), sortKey: sortKey || `${date || '0000-00-00'}|${kind}|${key}` });
  for (const v of vehicles) {
    const c = counts.get(v.id);
    if (v.first_seen_at) { push(v.id, 'first_seen', 'first_seen', day(v.first_seen_at), 'event', {}); c.registry++; }
    if (v.created_at) { push(v.id, 'added', 'added', day(v.created_at), 'event', {}); c.registry++; }
    if (v.approval_basis && v.approval_basis_set_at) { push(v.id, 'approved', 'approved', day(v.approval_basis_set_at), 'event', { basis: v.approval_basis }); c.registry++; }
  }
  for (const o of sig.results || []) {
    const vid = o.robotaxi_vehicle_id || byPlate.get(normalizePlate(o.license_plate || '')) || null;
    if (!vid || !publicIds.has(vid)) continue;
    const submittedOnly = !o.observed_at || o.observed_at === o.submitted_at;
    const inGallery = !!(o.public_id && o.evidence_ref && o.evidence_type === 'photo' && o.submitted_at > photoCutoff);
    const camera = o.camera_id ? trafficCameraFor(o.camera_id) : null;
    const data = {
      type: o.evidence_type === 'photo' ? 'image' : 'report',
      city: serviceAreaFor(String(o.service_area || '').split(',')[0])?.name ?? null,
      camera: inGallery && camera ? camera.name : null,
      photo: inGallery ? { id: o.public_id, image_url: `/api/sightings/${o.public_id}/photo` } : null
    };
    const date = day(submittedOnly ? o.submitted_at : o.observed_at);
    push(vid, `sighting:${o.id}`, 'sighting', date, submittedOnly ? 'submitted' : 'event', data, `${submittedOnly ? o.submitted_at : o.observed_at}|sighting|${o.id}`);
    counts.get(vid).sightings++;
  }
  for (const r of rides.results || []) {
    if (!publicIds.has(r.vid)) continue;
    push(r.vid, 'rides', 'rides', day(r.last), 'event', { count: Number(r.n), first: day(r.first), last: day(r.last), total_distance: r.distance == null ? null : Number(r.distance) });
    counts.get(r.vid).rides = Number(r.n);
  }
  // Previous / next within the same city, by plate.
  const cityKey = v => cityOf(v.service_area);
  const byCity = new Map();
  for (const v of vehicles) { const k = cityKey(v); if (!k) continue; if (!byCity.has(k)) byCity.set(k, []); byCity.get(k).push(v); }
  const neighbours = new Map();
  for (const list of byCity.values()) {
    list.sort((a, b) => String(a.license_plate || '').localeCompare(String(b.license_plate || '')) || a.id.localeCompare(b.id));
    list.forEach((v, i) => neighbours.set(v.id, { prev: i > 0 ? list[i - 1].id : null, next: i < list.length - 1 ? list[i + 1].id : null }));
  }
  const rideByVehicle = new Map((rides.results || []).map(r => [r.vid, r]));
  const summaries = vehicles.map(v => {
    const c = counts.get(v.id), n = neighbours.get(v.id) || {}, ride = rideByVehicle.get(v.id);
    const history = { trip_count: c.rides, first_ride_date: day(ride?.first), last_ride_date: day(ride?.last),
      total_distance: ride?.distance ?? null, service_areas: [...new Set(String(ride?.areas || '').split(',').map(cityOf).filter(Boolean))].map(key => serviceAreaFor(key).name).join(',') || null };
    return [v.id, cityKey(v), c.sightings, c.rides, c.registry, JSON.stringify(history), n.prev || null, n.next || null];
  });
  const writes = [];
  const chunks = (items, build) => {
    for (let start = 0; start < items.length; start += 100) writes.push(build(JSON.stringify(items.slice(start, start + 100))));
  };
  chunks(events.map(e => [e.vid, e.key, e.kind, e.date, e.dateKind, e.data, e.sortKey]), payload =>
    sql.prepare(`INSERT OR REPLACE INTO vehicle_history_events
      SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]'), json_extract(value,'$[3]'),
        json_extract(value,'$[4]'), json_extract(value,'$[5]'), json_extract(value,'$[6]'), ? FROM json_each(?)`).bind(stamp, payload));
  chunks(summaries, payload => sql.prepare(`INSERT OR REPLACE INTO vehicle_history_summary
      SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]'), json_extract(value,'$[3]'),
        json_extract(value,'$[4]'), json_extract(value,'$[5]'), json_extract(value,'$[6]'), json_extract(value,'$[7]'), ?
      FROM json_each(?)`).bind(stamp, payload));
  writes.push(sql.prepare('DELETE FROM vehicle_history_events WHERE stamp <> ?').bind(stamp),
    sql.prepare('DELETE FROM vehicle_history_summary WHERE stamp <> ?').bind(stamp));
  if (writes.length > 45) throw Error('Vehicle timeline rebuild exceeds batch budget');
  const stored = await sql.batch(writes);
  const rowsRead = [pub, all, sig, rides, ...stored].reduce((sum, r) => sum + (r.meta.rows_read ?? 0), 0);
  return { vehicles: vehicles.length, events: events.length, rows_read: rowsRead };
}

// GET /api/robotaxi-vehicles/:id/timeline
export async function apiVehicleTimeline(request, env, ctx, vehicleId) {
  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'all';
  const page = Number(url.searchParams.get('page') || '1');
  if (!VEHICLE_ID_RE.test(vehicleId)) return Response.json({ error: 'invalid_vehicle_id' }, { status: 400 });
  if (!Number.isInteger(page) || page < 1 || page > 10) return Response.json({ error: 'invalid_page' }, { status: 400 });
  if (!Object.prototype.hasOwnProperty.call(FILTERS, filter)) return Response.json({ success: false, error: 'invalid_filter' }, { status: 400 });
  const sql = env.cybercabhunter_db;
  const vehicle = await db.getPublicRobotaxiVehicle(sql, vehicleId);
  if (!vehicle) return Response.json({ success: false, error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const summary = await sql.prepare('SELECT * FROM vehicle_history_summary WHERE vehicle_id = ?').bind(vehicleId).first();
  const cache = globalThis.caches?.default;
  const key = new Request(new URL('/__cache/timeline/' + vehicleId + '/' + encodeURIComponent(summary?.stamp || 'pending') + '?filter=' + filter + '&page=' + page, url));
  let events = null;
  if (cache && summary) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) events = await hit.json().catch(() => null);
  }
  if (!events) {
    const kinds = FILTERS[filter];
    const rows = summary ? (await sql.prepare(`SELECT event_key, kind, event_date, date_kind, data FROM vehicle_history_events
      WHERE vehicle_id = ?${kinds ? ` AND kind IN (${kinds.map(() => '?').join(', ')})` : ''}
      ORDER BY sort_key DESC LIMIT ? OFFSET ?`).bind(vehicleId, ...(kinds || []), PAGE_SIZE + 1, (page - 1) * PAGE_SIZE).all()).results : [];
    events = { has_more: page < 10 && rows.length > PAGE_SIZE,
      events: rows.slice(0, PAGE_SIZE).map(row => ({ kind: row.kind, date: row.event_date, date_kind: row.date_kind, source_id: row.kind === 'sighting' ? row.event_key.slice('sighting:'.length) : null, ...JSON.parse(row.data) })) };
    if (cache && ctx && summary) ctx.waitUntil(cache.put(key, Response.json(events, { headers: { 'Cache-Control': 'public, max-age=3600' } })).catch(() => {}));
  }
  // Match the current moderation state by primary key. A retired photo can
  // lose its thumbnail between nightly rebuilds, and a reversed approval must
  // stop exposing the event even when its precomputed page is cached.
  const sourceIds = events.events.filter(event => event.source_id).map(event => event.source_id);
  if (sourceIds.length) {
    const current = await sql.prepare(`SELECT o.id, o.public_id, o.evidence_ref, o.robotaxi_vehicle_id
      FROM vehicle_observations o JOIN submissions s ON s.id = o.submission_id
      WHERE o.id IN (${sourceIds.map(() => '?').join(',')})
      AND s.status = 'approved' AND s.submission_type = 'vehicle_sighting' AND o.verification_status = 'verified'`)
      .bind(...sourceIds).all();
    const approved = new Map(current.results.map(row => [row.id, row]));
    events.events = events.events.flatMap(event => {
      const { source_id, ...visible } = event;
      if (!source_id) return [visible];
      const row = approved.get(source_id);
      if (!row || (row.robotaxi_vehicle_id && row.robotaxi_vehicle_id !== vehicleId)) return [];
      if (visible.photo?.id !== row.public_id || !row.evidence_ref) {
        visible.photo = null;
        visible.camera = null;
      }
      return [visible];
    });
  }
  else events.events = events.events.map(({ source_id, ...event }) => event);
  const neighbour = async id => {
    if (!id) return null;
    const v = await db.getPublicRobotaxiVehicle(sql, id);
    return v && cityOf(v.service_area) === cityOf(vehicle.service_area) ? { id, plate: v.license_plate } : null;
  };
  const [prev, next] = filter === 'all' && page === 1
    ? await Promise.all([neighbour(summary?.prev_id), neighbour(summary?.next_id)]) : [null, null];
  const body = {
    vehicle_id: vehicleId,
    updated_on: summary ? String(summary.stamp).slice(0, 10) : null,   // the rebuild's day (no times in public responses)
    counts: summary ? { sightings: summary.sightings, rides: summary.rides, status: summary.registry_events } : null,
    city: summary ? summary.city : null,
    prev, next,
    filter, page, page_size: PAGE_SIZE,
    ...(page === 1 && filter === 'all' ? {
      vehicle: { ...vehicle, first_seen_at: day(vehicle.first_seen_at), last_seen_at: day(vehicle.last_seen_at) },
      history: summary ? JSON.parse(summary.history) : { trip_count: null }
    } : {}),
    ...events
  };
  // The internal event cache lasts an hour, while callers revalidate the public gate.
  return Response.json(body, { headers: { 'Cache-Control': 'private, no-cache' } });
}

// /vehicle/<id>: a public vehicle's page with its own share/SEO tags and Car
// data server-rendered (crawlers and link previews run no JavaScript); any other
// id gets a 404 (the page shows "not found"), never a public page.
const SITE = 'https://cybercabhunter.com';
export async function serveVehiclePage(request, env, ctx, vehicleId) {
  const assetUrl = new URL(request.url); assetUrl.pathname = '/vehicle';
  const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
  const vehicle = VEHICLE_ID_RE.test(vehicleId) ? await db.getPublicRobotaxiVehicle(env.cybercabhunter_db, vehicleId) : null;
  if (!vehicle) return new Response(asset.body, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (typeof HTMLRewriter === 'undefined') return asset;
  const approved = vehicle.approval_basis === 'vin-verified' || vehicle.approval_basis === 'manual';
  const name = `${approved ? 'Cybercab' : 'Robotaxi'}${vehicle.license_plate ? ' ' + vehicle.license_plate : ''}`;
  const city = vehicle.service_area ? String(vehicle.service_area).split(',')[0].trim() : null;
  const url = `${SITE}/vehicle/${encodeURIComponent(vehicle.id)}`;
  const title = `${name} | Tesla Cybercab Registry`;
  const desc = `Tesla ${name}${city ? ` registered in ${city}` : ''}: its timeline of sightings and rides on Cybercab Hunter.`;
  // Car data from the record only; a field the site does not know is left out.
  const car = { '@type': 'Car', name: `Tesla ${name}`, url, manufacturer: { '@type': 'Organization', name: 'Tesla' } };
  if (approved) car.model = 'Cybercab';
  if (vehicle.color) car.color = vehicle.color;
  const set = (attr, value) => ({ element: el => el.setAttribute(attr, value) });
  const attr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const schema = JSON.stringify({ '@context': 'https://schema.org', ...car }).replace(/</g, '\\u003c');
  const cache = globalThis.caches?.default;
  const version = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([title, desc, car, asset.headers.get('etag')])));
  const etag = [...new Uint8Array(version)].slice(0, 12).map(byte => byte.toString(16).padStart(2, '0')).join('');
  const key = new Request(new URL('/__cache/vehicle/' + vehicleId + '/' + etag, request.url));
  const cached = cache ? await cache.match(key).catch(() => null) : null;
  const headers = new Headers(asset.headers);
  headers.delete('etag');
  headers.delete('content-length');
  headers.set('Cache-Control', 'private, no-cache');
  if (cached) return new Response(cached.body, { headers });
  const page = new HTMLRewriter()
    .on('head', { element: el => el.append(`<link rel="canonical" href="${attr(url)}"><meta property="og:url" content="${attr(url)}"><script type="application/ld+json">${schema}</script>`, { html: true }) })
    .on('title', { element: el => el.setInnerContent(title) })
    .on('meta[name="description"]', set('content', desc))
    .on('meta[property="og:title"]', set('content', title))
    .on('meta[property="og:description"]', set('content', desc))
    .on('meta[name="twitter:title"]', set('content', title))
    .on('meta[name="twitter:description"]', set('content', desc))
    .transform(new Response(asset.body, { headers }));
  if (cache && ctx) {
    const stored = page.clone();
    const cacheHeaders = new Headers(stored.headers);
    cacheHeaders.set('Cache-Control', 'public, max-age=3600');
    ctx.waitUntil(cache.put(key, new Response(stored.body, { headers: cacheHeaders })).catch(() => {}));
  }
  return page;
}
