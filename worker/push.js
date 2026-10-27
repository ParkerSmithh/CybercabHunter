import { tesla } from './tesla.js';
import { buildDaily, localDate } from './daily.js';
import { defaults, validatePreferences, clock, shiftDate, quietNow, eligible, reportBody, scheduledInstant, weekPeriod } from './push-policy.js';
import { collectEvents, eventStillPublic, pushSighting, summarizeEvents } from './push-sources.js';
import { sendAPNs } from './apns.js';
import { deliver } from './push-delivery.js';
export const PUSH_CRON = '2-59/10 * * * *';
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
export async function apiPush(request,env) {
 const user=await tesla.requireUserId(request,env);
 if(!user) return json({error:'unauthenticated'},401);
 if(!request.headers.get('Authorization')?.startsWith('Bearer ')) return json({error:'native_bearer_required'},403);
 const origin=request.headers.get('Origin');
 if(origin && origin!=='https://cybercabhunter.com') return json({error:'forbidden'},403);
 if(env.PUSH_ENABLED!=='true') return json({error:'push_not_configured'},503);
 const db=env.cybercabhunter_db, url=new URL(request.url), path=url.pathname, now=Date.now();
 if (request.method==='GET' && path==='/api/push/report') {
  const date=url.searchParams.get('date'), days=url.searchParams.get('days')==='7'?7:1;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')) return json({error:'invalid_date'},400);
  const {results}=await db.prepare('SELECT date,metrics FROM push_daily WHERE date>=? AND date<=? ORDER BY date').bind(shiftDate(date,1-days),date).all();
  return json({days:(results||[]).map(r=>JSON.parse(r.metrics))});
 }
 if (request.method==='GET' && path==='/api/push/sighting') {
  const sighting=await pushSighting(db,url.searchParams.get('id'));
  return sighting?json(sighting):json({error:'unavailable'},404);
 }
 if (request.method==='GET' && path==='/api/push/news') {
  const article=await db.prepare('SELECT url FROM news_articles WHERE id=? AND hidden=0').bind(url.searchParams.get('article')).first();
  return article?json(article):json({error:'unavailable'},404);
 }
 if(request.method==='GET' && path==='/api/push/preferences') {
  const row=await db.prepare('SELECT settings FROM push_preferences WHERE user_id=?').bind(user).first();
  return json({preferences:row?JSON.parse(row.settings):null});
 }
 if(Number(request.headers.get('Content-Length'))>8192) return json({error:'body_too_large'},413);
 let body; try { const raw=await request.text(); if(raw.length>8192) return json({error:'body_too_large'},413); body=JSON.parse(raw); } catch { return json({error:'invalid_json'},400); }
 if(path==='/api/push/preferences' && request.method==='PUT') {
  let preferences; try { preferences=validatePreferences(body); } catch { return json({error:'invalid_preferences'},400); }
  // Reject excessive writes without trusting an arbitrary installation ID.
  const old=await db.prepare('SELECT updated_at FROM push_preferences WHERE user_id=?').bind(user).first();
  if(old && now-old.updated_at<1000) return json({error:'rate_limited'},429);
  await db.prepare('INSERT INTO push_preferences(user_id,settings,updated_at,initialized_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET settings=excluded.settings,updated_at=excluded.updated_at').bind(user,JSON.stringify(preferences),now,now).run();
  return json({preferences});
 }
 if(path==='/api/push/device' && ['PUT','DELETE'].includes(request.method)) {
  if(typeof body.id!=='string' || !/^[0-9a-f-]{36}$/i.test(body.id)) return json({error:'invalid_device'},400);
  if(request.method==='DELETE') { await db.prepare('DELETE FROM push_devices WHERE id=? AND user_id=?').bind(body.id,user).run(); return json({ok:true}); }
  const limit=await db.prepare(`INSERT INTO push_registration_limits(user_id,window,hits) VALUES(?,?,1)
    ON CONFLICT(user_id) DO UPDATE SET hits=CASE WHEN window=excluded.window THEN hits+1 ELSE 1 END,window=excluded.window RETURNING hits`).bind(user,Math.floor(now/60000)).first();
  if(limit.hits>20) return json({error:'rate_limited'},429);
  if(typeof body.token!=='string' || !/^[a-f0-9]{32,512}$/.test(body.token) || !['sandbox','production'].includes(body.environment) || typeof body.authorized!=='boolean') return json({error:'invalid_token'},400);
  if(body.timezone!==undefined) { try { validatePreferences({timezone:body.timezone}); } catch { return json({error:'invalid_timezone'},400); } }
  const {results:matches}=await db.prepare('SELECT id,user_id,refreshed_at FROM push_devices WHERE id=? OR (token=? AND environment=?) LIMIT 2').bind(body.id,body.token,body.environment).all();
  const device=matches?.[0];
  if(matches?.some(device=>device.user_id!==user)) return json({error:'device_owned_by_other_account'},409);
  const count=await db.prepare('SELECT COUNT(*) AS n FROM push_devices WHERE user_id=?').bind(user).first();
  if(!device && count.n>=5) return json({error:'device_limit'},429);
  const writes=(matches||[]).filter(device=>device.id!==body.id).map(device=>db.prepare('DELETE FROM push_devices WHERE id=? AND user_id=?').bind(device.id,user));
  writes.push(db.prepare('INSERT INTO push_devices(id,user_id,token,environment,authorized,refreshed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,environment=excluded.environment,authorized=excluded.authorized,refreshed_at=excluded.refreshed_at').bind(body.id,user,body.token,body.environment,body.authorized?1:0,now));
  if(body.timezone) writes.push(db.prepare("UPDATE push_preferences SET settings=json_set(settings,'$.timezone',?) WHERE user_id=?").bind(body.timezone,user));
  await db.batch(writes);
  return json({ok:true});
 }
 return json({error:'not_found'},404);
}
async function enqueue(db,user,id,category,payload,events,now,merge=false,period=null) {
 if(merge && events.length) {
  const pending=await db.prepare("SELECT id,payload,event_ids FROM push_deliveries WHERE user_id=? AND category=? AND status='pending' AND period_key IS NULL AND attempts=0 AND expires_at>? AND json_array_length(event_ids)<=? AND (?<>'news' OR json_extract(payload,'$.major')=?) ORDER BY due_at LIMIT 1").bind(user,category,now,60-events.length,category,payload.major?1:0).first();
  if(pending) {
   const previous=JSON.parse(pending.payload), count=(previous.count||1)+(payload.count||1);
   const title=category==='dmv'?`${count} New DMV Entries`:`${count} Cybercab Updates`;
   const combined={...payload,title,count,major:!!(previous.major||payload.major),body:category==='community'?'There are new interactions with your Community content.':`${count} new ${category==='dmv'?'Tesla/Cybercab DMV records':category==='news'?'news stories':category==='cameras'?'camera detections':category==='registry'?'public Cybercabs':'approved public sightings'} are available.`};
   await db.batch([db.prepare('UPDATE push_deliveries SET payload=?,event_ids=? WHERE id=?').bind(JSON.stringify(combined),JSON.stringify([...new Set([...JSON.parse(pending.event_ids),...events.map(e=>e.id)])]),pending.id),...events.map(e=>db.prepare('INSERT OR IGNORE INTO push_consumed(user_id,event_id) VALUES(?,?)').bind(user,e.id))]);
   return;
  }
 }
 await db.batch([db.prepare('INSERT OR IGNORE INTO push_deliveries(id,user_id,category,payload,event_ids,due_at,expires_at,period_key) VALUES(?,?,?,?,?,?,?,?)').bind(id,user,category,JSON.stringify(payload),JSON.stringify(events.map(e=>e.id)),now,now+864e5,period),...events.map(e=>db.prepare('INSERT OR IGNORE INTO push_consumed(user_id,event_id) VALUES(?,?)').bind(user,e.id))]);
}
async function plan(db,row,now) {
 const p=validatePreferences(JSON.parse(row.settings)), user=row.user_id;
 if(!p.master) return;
 const local=clock(now,p.timezone);
 // Freeze the website reporting date at the configured local delivery instant.
 const dailyAt=scheduledInstant(local.date,p.dailyTime,p.timezone);
 const weeklyAt=scheduledInstant(local.date,p.weeklyTime,p.timezone);
 const reportDate=at=>shiftDate(clock(at,'America/Chicago').date,-1);
 const get=async date=>{const r=await db.prepare('SELECT metrics FROM push_daily WHERE date=?').bind(date).first();return r?JSON.parse(r.metrics):null;};
 if(p.daily && dailyAt!==null && now>=dailyAt) {
  const date=reportDate(dailyAt), period=shiftDate(local.date,-1);
  const day=await get(date), previous=p.comparison?await get(shiftDate(date,-1)):null;
  const body=reportBody([day],p.dailyMetrics,previous);
  if(body && (!p.comparison || reportBody([previous],p.dailyMetrics))) await enqueue(db,user,`${user}:daily:${period}`,'daily',{title:'Your Cybercab Daily Report',body:`${date}: ${body}`,link:'/?daily='+date},[],now,false,period);
 }
 if(p.weekly && local.weekday===p.weeklyDay && weeklyAt!==null && now>=weeklyAt) {
  const date=reportDate(weeklyAt), period=weekPeriod(local.date);
  const days=await Promise.all(Array.from({length:7},(_,n)=>get(shiftDate(date,-n))));
  const body=reportBody(days,p.weeklyMetrics);
  if(body) await enqueue(db,user,`${user}:weekly:${period}`,'weekly',{title:'Your Weekly Cybercab Recap',body:`Previous seven days: ${body}`,link:'/?daily='+date+'&days=7'},[],now,false,period);
 }
 const active=['news','dmv','registry','sightings','cameras','community'].filter(category=>eligible(p,{category,major:true,kind:'comments'}) || (category==='community' && (p.replies||p.mentions||p.likes)));
 if(!active.length) return;
 const summary=active.filter(category=>p[category]==='daily');
 if(dailyAt!==null && now>=dailyAt) for(const category of summary) {
  const period=shiftDate(local.date,-1), start=scheduledInstant(period,0,p.timezone), end=scheduledInstant(local.date,0,p.timezone);
  if(start===null || end===null) continue;
  const aggregate=await summarizeEvents(db,user,category,start,end,row.initialized_at);
  if(!aggregate.count) continue;
  const id=await digest(`${user}:${category}:summary:${period}`);
  const payload=summaryPayload(category,aggregate);
  await db.prepare('INSERT OR IGNORE INTO push_deliveries(id,user_id,category,payload,event_ids,due_at,expires_at,period_key,summary_start,summary_end,summary_initialized) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,user,category,JSON.stringify(payload),'[]',now,now+864e5,period,start,end,row.initialized_at).run();
 }
 const instant=active.filter(category=>!summary.includes(category));
 if(!instant.length) return;
 const {results}=await db.prepare(`SELECT e.* FROM push_events e WHERE e.created_at>? AND e.created_at>=? AND e.category IN (${instant.map(()=>'?').join(',')}) AND (e.recipient IS NULL OR e.recipient=?) AND NOT EXISTS(SELECT 1 FROM push_consumed c WHERE c.user_id=? AND c.event_id=e.id) AND NOT EXISTS(SELECT 1 FROM push_deliveries d WHERE d.user_id=? AND d.category=e.category AND d.summary_start IS NOT NULL AND e.created_at>=d.summary_start AND e.created_at<d.summary_end AND e.created_at>=d.summary_initialized) ORDER BY e.created_at,e.id LIMIT 60`).bind(now-2*864e5,row.initialized_at,...instant,user,user,user).all();
 const discard=[];
 const groups=new Map();
 for(const e of results||[]) {
  const data=JSON.parse(e.payload); if(!eligible(p,{...data,category:e.category})) { discard.push(e.id); continue; }
  if(!await eventStillPublic(db,e)) { discard.push(e.id); continue; }
  const key=(p.group || p[e.category]==='daily' || e.category==='dmv' || e.category==='cameras' || p.frequency==='reduced')?(e.category==='news'?e.category+':'+(data.major?'major':'ordinary'):e.category):e.id;
  if(!groups.has(key)) groups.set(key,[]); groups.get(key).push(e);
 }
 if(discard.length) await db.batch(discard.map(id=>db.prepare('INSERT OR IGNORE INTO push_consumed(user_id,event_id) VALUES(?,?)').bind(user,id)));
 for(const events of groups.values()) {
  const e=events[0], data=JSON.parse(e.payload), n=events.reduce((sum,event)=>sum+(JSON.parse(event.payload).count||1),0);
  const title=e.category==='dmv'?`${n} New DMV ${n===1?'Entry':'Entries'}`:n>1?`${n} Cybercab ${e.category==='cameras'?'Detections':e.category==='sightings'?'Sightings':'Updates'}`:e.category==='news'?(data.major?'Major Cybercab News':'Cybercab News'):data.title;
  const body=e.category==='news'?(n===1?data.title:`${n} new stories are available.`):e.category==='community'?'There is a new interaction with your Community content.':`${n} new ${e.category==='registry'?'public Cybercabs':e.category==='dmv'?'Tesla/Cybercab DMV records':e.category==='cameras'?'camera detections':'approved public sightings'} added to Cybercab Hunter.`;
  const id=await digest(user+':'+events.map(e=>e.id).join(','));
  await enqueue(db,user,id,e.category,{title,body,count:n,link:data.link,major:events.some(e=>JSON.parse(e.payload).major)},events,now,p.group || quietNow(p,now) || p.frequency==='reduced');
 }
}
function summaryPayload(category,{count,link}) { return {title:`${count} Cybercab ${category==='dmv'?'DMV Entries':category==='cameras'?'Detections':category==='sightings'?'Sightings':'Updates'}`,body:`${count} new ${category==='registry'?'public Cybercabs':category==='dmv'?'Tesla/Cybercab DMV records':category==='cameras'?'camera detections':'approved public sightings'} added to Cybercab Hunter.`,count,link}; }
async function digest(text) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join(''); }
export async function runPushTick(env,now=Date.now(),sender=sendAPNs) {
 // Two independent opt-in switches. Never run against production by accident.
 if(env.PUSH_ENABLED!=='true') return;
 const db=env.cybercabhunter_db;
 await db.prepare("INSERT OR IGNORE INTO push_state(key,value) VALUES('activated',?)").bind(String(now)).run();
 const activation=Number((await db.prepare("SELECT value FROM push_state WHERE key='activated'").first()).value);
 // One short global lease avoids overlapping cron invocations and fan-out races.
 await db.prepare("INSERT OR IGNORE INTO push_state(key,value) VALUES('lease','0')").run();
 const lease=await db.prepare("UPDATE push_state SET value=? WHERE key='lease' AND CAST(value AS INTEGER)<?").bind(String(now+300000),now).run();
 if(!lease.meta?.changes) return;
 try {
  await collectEvents(db,activation,now);
  const date=shiftDate(localDate(now),-1);
  const attempted=Number((await db.prepare("SELECT value FROM push_state WHERE key='report_attempt'").first())?.value||0);
  if(now-attempted>=3600e3 && !await db.prepare('SELECT date FROM push_daily WHERE date=?').bind(date).first()) {
   await db.prepare("INSERT INTO push_state(key,value) VALUES('report_attempt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(now)).run();
   const report=await buildDaily(db,now);
   if(reportBody([report.previous],['registry','dmv','sightings','cameras'])) await db.prepare('INSERT OR IGNORE INTO push_daily(date,metrics) VALUES(?,?)').bind(date,JSON.stringify(report.previous)).run();
  }
  // Paginate users fairly with a persistent cursor; bounded work per invocation.
  const cursor=(await db.prepare("SELECT value FROM push_state WHERE key='user_cursor'").first())?.value||'';
  const {results:users}=await db.prepare(`SELECT p.* FROM push_preferences p WHERE p.user_id>? AND EXISTS(SELECT 1 FROM push_devices d WHERE d.user_id=p.user_id AND d.authorized=1 AND d.refreshed_at>?) ORDER BY p.user_id LIMIT 5`).bind(cursor,now-30*864e5).all();
  for(const row of users||[]) await plan(db,row,now);
  await db.prepare("INSERT INTO push_state(key,value) VALUES('user_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(users?.length===5?users.at(-1).user_id:'').run();
  if(env.PUSH_DELIVERY_ENABLED!=='true' || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_PRIVATE_KEY || !env.APNS_TOPIC) return;
  const {results:deliveries}=await db.prepare("SELECT * FROM push_deliveries WHERE status='pending' AND due_at<=? AND lease_until<? ORDER BY due_at LIMIT 5").bind(now,now).all();
  for(const d of deliveries||[]) {
   const row=await db.prepare('SELECT settings FROM push_preferences WHERE user_id=?').bind(d.user_id).first();
   const p=row?validatePreferences(JSON.parse(row.settings)):defaults();
   let payload=JSON.parse(d.payload);
   if(d.summary_start!==null) {
    const aggregate=await summarizeEvents(db,d.user_id,d.category,d.summary_start,d.summary_end,d.summary_initialized);
    if(!aggregate.count || (d.attempts>0 && (aggregate.count!==payload.count || aggregate.link!==payload.link))) { await db.prepare("UPDATE push_deliveries SET status='cancelled' WHERE id=?").bind(d.id).run(); continue; }
    payload=summaryPayload(d.category,aggregate); d.payload=JSON.stringify(payload);
    await db.prepare('UPDATE push_deliveries SET payload=? WHERE id=?').bind(d.payload,d.id).run();
   }
   if(!row || d.expires_at<=now || !(d.category==='community'?p.master:eligible(p,{category:d.category,...payload})) || (d.category==='community' && !JSON.parse(d.event_ids).length)) { await db.prepare("UPDATE push_deliveries SET status='cancelled' WHERE id=?").bind(d.id).run(); continue; }
   if(quietNow(p,now) && !(d.category==='news' && payload.major && p.majorDuringQuiet)) { await db.prepare('UPDATE push_deliveries SET due_at=? WHERE id=?').bind(now+600e3,d.id).run(); continue; }
   const ids=JSON.parse(d.event_ids); let valid=true;
   for(const id of ids) { const e=await db.prepare('SELECT * FROM push_events WHERE id=?').bind(id).first(); if(!e || !eligible(p,{category:e.category,...JSON.parse(e.payload)}) || !await eventStillPublic(db,e)) {valid=false;break;} }
   if(!valid) { await db.prepare("UPDATE push_deliveries SET status='cancelled' WHERE id=?").bind(d.id).run(); continue; }
   if(p.frequency==='reduced' && ['news','community'].includes(d.category) && !(d.category==='news' && payload.major)) {
    const recent=await db.prepare("SELECT id FROM push_deliveries WHERE user_id=? AND category=? AND status IN ('accepted','partial','sent') AND due_at>? LIMIT 1").bind(d.user_id,d.category,now-3600e3).first();
    if(recent) { await db.prepare('UPDATE push_deliveries SET due_at=? WHERE id=?').bind(now+3600e3,d.id).run(); continue; }
   }
   const claim=await db.prepare("UPDATE push_deliveries SET lease_until=? WHERE id=? AND lease_until<? AND status='pending'").bind(now+120000,d.id,now).run(); if(!claim.meta?.changes) continue;
   const configuration=await deliver(db,env,d,now,sender);
   if(configuration) break;
  }
  await db.prepare("UPDATE push_deliveries SET status='expired',payload='{}',event_ids='[]' WHERE expires_at<? AND status='pending'").bind(now).run();
  await db.prepare("UPDATE push_deliveries SET payload='{}',event_ids='[]' WHERE expires_at<? AND status<>'pending' AND payload<>'{}'").bind(now-7*864e5).run();
  await db.prepare('DELETE FROM push_events WHERE created_at<?').bind(now-7*864e5).run();
  // Short-lived previews/tokens; retain delivery IDs to prevent report replay.
  await db.prepare('DELETE FROM push_devices WHERE refreshed_at<?').bind(now-30*864e5).run();
 } finally { await db.prepare("UPDATE push_state SET value='0' WHERE key='lease' AND value=?").bind(String(now+300000)).run(); }
}
