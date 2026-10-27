import { publicSightingJson } from './sightings-public.js';
import { PUBLIC_PHOTO_SIGHTING_SQL } from './db.js';
import { publicVehicleEligibleSql } from './ride-status.js';
// Match the existing gallery and Social visibility predicates. No private text
// or actor names ever enter an event or an APNs preview.
const vehicle=publicVehicleEligibleSql('v');
const social=`p.status='visible' AND (p.legacy_review_id IS NULL OR (v.id IS NOT NULL AND ${vehicle})) AND (n.comment_id IS NULL OR c.status='visible') AND n.actor_user_id<>n.user_id`;
const fromSocial=`FROM social_notifications n JOIN social_posts p ON p.id=n.post_id LEFT JOIN robotaxi_vehicles v ON v.id=p.robotaxi_vehicle_id LEFT JOIN social_comments c ON c.id=n.comment_id`;
const fromSighting=`FROM submissions s JOIN vehicle_observations o ON o.submission_id=s.id LEFT JOIN robotaxi_vehicles v ON v.id=o.robotaxi_vehicle_id`;
const sighting=`${PUBLIC_PHOTO_SIGHTING_SQL} AND (o.robotaxi_vehicle_id IS NULL OR ${vehicle})`;
export async function collectEvents(db, activated, now) {
 activated=Math.max(activated,now-864e5);
 const start=new Date(activated).toISOString().slice(0,19).replace('T',' ');
 const sources=[
  ['news',`SELECT id, title, importance, url FROM news_articles WHERE created_at>=? AND julianday(published_at)>=julianday(?) AND hidden=0 AND NOT EXISTS(SELECT 1 FROM push_events e WHERE e.id='news:'||news_articles.id) ORDER BY created_at,id LIMIT 25`,[start,start],r=>({major:r.importance>=2,title:r.title,link:'/news?article='+encodeURIComponent(r.id),source:r.id})],
  ['registry',`SELECT v.id FROM robotaxi_vehicles v WHERE v.id IN (SELECT id FROM robotaxi_vehicles WHERE created_at>=? UNION SELECT review.robotaxi_vehicle_id FROM robotaxi_vehicle_reviews review WHERE review.action='approved_public' AND review.created_at>=? AND NOT EXISTS(SELECT 1 FROM robotaxi_vehicle_reviews earlier WHERE earlier.robotaxi_vehicle_id=review.robotaxi_vehicle_id AND earlier.action='approved_public' AND earlier.created_at<review.created_at)) AND ${vehicle} AND lower(trim(COALESCE(v.model,''))) NOT IN ('model y','model_y','modely') AND (lower(trim(v.model))='cybercab' OR v.approval_basis IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM push_events e WHERE e.id='registry:'||v.id) ORDER BY v.created_at,v.id LIMIT 25`,[start,start],r=>({title:'New Cybercab Identified',link:'/vehicles/'+encodeURIComponent(r.id),source:r.id})],
  ['sightings',`SELECT o.public_id AS id ${fromSighting} WHERE s.reviewed_at>=? AND ${sighting} AND NOT EXISTS(SELECT 1 FROM push_events e WHERE e.id='sightings:'||o.public_id) ORDER BY s.reviewed_at,o.public_id LIMIT 25`,[start],r=>({title:'New Cybercab Sighting',link:'/sightings?sighting='+encodeURIComponent(r.id),source:r.id})],
  ['cameras',`SELECT id,city FROM camera_detections WHERE created_at>=? AND observed_at>=? AND NOT EXISTS(SELECT 1 FROM push_events e WHERE e.id='cameras:'||camera_detections.id) ORDER BY created_at,id LIMIT 25`,[new Date(activated).toISOString(),new Date(activated).toISOString()],r=>({title:'New Cybercab Detection',link:'/heatmap?city='+encodeURIComponent(r.city),source:r.id})],
  ['community',`SELECT n.id,n.type,n.user_id,n.post_id,n.comment_id ${fromSocial} WHERE n.created_at>=? AND ${social} AND NOT EXISTS(SELECT 1 FROM push_events e WHERE e.id='community:'||n.id) ORDER BY n.created_at,n.id LIMIT 25`,[start],r=>({title:'Community Interaction',kind:({comment:'comments',reply:'replies',mention:'mentions',like:'likes'})[r.type],recipient:r.user_id,link:'/community?post='+encodeURIComponent(r.post_id)+(r.comment_id?'&comment='+encodeURIComponent(r.comment_id):''),source:r.id})]
 ];
 for (const [category,query,binds,map] of sources) {
  const {results}=await db.prepare(query).bind(...binds).all();
  if (results?.length) await db.batch(results.map(r=>{ const payload=map(r); return db.prepare('INSERT OR IGNORE INTO push_events(id,category,recipient,payload,created_at) VALUES(?,?,?,?,?)').bind(category+':'+r.id,category,payload.recipient||null,JSON.stringify(payload),now); }));
 }
}
export async function eventStillPublic(db,event) {
 const e=JSON.parse(event.payload), id=e.source;
 if(event.category==='news') return !!await db.prepare('SELECT id FROM news_articles WHERE id=? AND hidden=0').bind(id).first();
 if(event.category==='registry') return !!await db.prepare(`SELECT v.id FROM robotaxi_vehicles v WHERE v.id=? AND ${vehicle}`).bind(id).first();
 if(event.category==='sightings') return !!await db.prepare(`SELECT o.public_id ${fromSighting} WHERE o.public_id=? AND ${sighting}`).bind(id).first();
 if(event.category==='cameras') return !!await db.prepare('SELECT id FROM camera_detections WHERE id=?').bind(id).first();
 if(event.category==='community') return !!await db.prepare(`SELECT n.id ${fromSocial} WHERE n.id=? AND n.user_id=? AND ${social}`).bind(id,event.recipient).first();
 return event.category==='dmv' && !!await db.prepare('SELECT snapshot_date FROM dmv_snapshots WHERE snapshot_date=?').bind(id).first();
}

export async function pushSighting(db,id) {
 if(!/^[a-f0-9]{32}$/.test(id||'')) return null;
 const row=await db.prepare(`SELECT o.public_id,o.service_area,o.approx_location,o.observed_at,
 v.license_plate AS public_plate,(v.approval_basis IS NOT NULL) AS public_cybercab
 FROM submissions s JOIN vehicle_observations o ON o.submission_id=s.id
 LEFT JOIN robotaxi_vehicles v ON v.id=o.robotaxi_vehicle_id AND ${vehicle}
 WHERE o.public_id=? AND ${PUBLIC_PHOTO_SIGHTING_SQL}`).bind(id).first();
 return row?publicSightingJson(row):null;
}

// One indexed range aggregate, with the same live visibility gates as instant
// delivery. Return a single sample for navigation, never thousands of event IDs.
export async function summarizeEvents(db,user,category,start,end,initialized) {
 const source="json_extract(e.payload,'$.source')";
 const predicates={
  registry:`EXISTS(SELECT 1 FROM robotaxi_vehicles v WHERE v.id=${source} AND ${vehicle})`,
  sightings:`EXISTS(SELECT 1 ${fromSighting} WHERE o.public_id=${source} AND ${sighting})`,
  cameras:`EXISTS(SELECT 1 FROM camera_detections c WHERE c.id=${source})`,
  dmv:`EXISTS(SELECT 1 FROM dmv_snapshots d WHERE d.snapshot_date=${source})`
 };
 if(!predicates[category]) throw Error('invalid_summary_category');
 const row=await db.prepare(`SELECT COALESCE(SUM(CASE WHEN json_type(e.payload,'$.count')='integer' AND json_extract(e.payload,'$.count')>0 THEN json_extract(e.payload,'$.count') ELSE 1 END),0) AS count, MIN(e.id) AS sample FROM push_events e WHERE e.category=? AND e.created_at>=? AND e.created_at<? AND e.created_at>=? AND (e.recipient IS NULL OR e.recipient=?) AND NOT EXISTS(SELECT 1 FROM push_consumed c WHERE c.user_id=? AND c.event_id=e.id) AND ${predicates[category]}`).bind(category,start,end,initialized,user,user).first();
 const event=row.sample?await db.prepare('SELECT payload FROM push_events WHERE id=?').bind(row.sample).first():null;
 return {count:row.count,link:event?JSON.parse(event.payload).link:null};
}
