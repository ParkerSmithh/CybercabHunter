import assert from 'node:assert/strict';
import {makeEnv} from './helpers/env.mjs';
import {createTestD1,seedUser} from './helpers/d1-sqlite.mjs';
import {readFileSync} from 'node:fs';
import {defaults,clock,scheduledInstant,shiftDate,weekPeriod,reportBody,eligible} from '../worker/push-policy.js';
import {runPushTick} from '../worker/push.js';
import {sendAPNs} from '../worker/apns.js';
import {deliver} from '../worker/push-delivery.js';
let checks=0;
async function check(name,fn) {await fn(); checks++; console.log('ok',name);}
const base=Date.parse('2026-10-25T16:00Z');
async function setup(p={},at=base) {
 const {env,d1}=await makeEnv();
 Object.assign(env,{PUSH_ENABLED:'true',PUSH_DELIVERY_ENABLED:'true',APNS_KEY_ID:'test',APNS_TEAM_ID:'test',APNS_PRIVATE_KEY:'test',APNS_TOPIC:'test'});
 const run=(q,...args)=>d1.prepare(q).bind(...args)._exec();
 run('INSERT INTO push_preferences VALUES(?,?,?,?)','u1',JSON.stringify({...defaults(),...p}),at-10*864e5,at-10*864e5);
 run("INSERT INTO push_devices VALUES('device','u1',?,'sandbox',1,?)",'a'.repeat(64),at);
 for(let n=-10;n<=10;n++) {const date=shiftDate(clock(at,'America/Chicago').date,n);run('INSERT INTO push_daily VALUES(?,?)',date,JSON.stringify({registry:1,dmv:2,sightings:3,cameras:4}));}
 return {env,d1,run};
}
const accepted=async()=>({ok:true});
for(const timezone of ['Asia/Tokyo','Asia/Kolkata','Pacific/Honolulu','UTC','America/Chicago','America/New_York','Europe/London','Australia/Sydney','Australia/Lord_Howe']) {
 await check('one report per local date/week: '+timezone,async()=>{
  const date='2026-10-25',at=scheduledInstant(date,480,timezone),{env,d1}=await setup({timezone,weekly:true},at);let sends=0;
  const sender=async()=>{sends++;return {ok:true};};
  for(let t=at-60000;t<scheduledInstant(shiftDate(date,1),0,timezone);t+=600000) await runPushTick(env,t,sender);
  assert.equal(sends,2);const rows=(await d1.prepare('SELECT * FROM push_deliveries').all()).results;
  assert.equal(rows.filter(r=>r.category==='daily').length,1);assert.equal(rows.filter(r=>r.category==='weekly').length,1);
  assert.equal(rows.find(r=>r.category==='daily').period_key,'2026-10-24');
  assert.equal(rows.find(r=>r.category==='weekly').period_key,'2026-10-19');
 });
}
for(const [date,zone,minute,expected] of [
 ['2026-03-08','America/Chicago',150,'2026-03-08T08:00:00.000Z'],
 ['2026-11-01','America/Chicago',90,'2026-11-01T06:30:00.000Z'],
 ['2026-03-29','Europe/London',90,'2026-03-29T01:00:00.000Z'],
 ['2026-10-04','Australia/Lord_Howe',135,'2026-10-03T15:30:00.000Z']]) {
 await check('DST configured time '+date+' '+zone,async()=>{
  const at=scheduledInstant(date,minute,zone);assert.equal(new Date(at).toISOString(),expected);
  const {env,d1}=await setup({timezone:zone,dailyTime:minute},at);let n=0;
  for(const t of [at-60000,at,at+3600e3,at+7200e3]) await runPushTick(env,t,async()=>{n++;return {ok:true};});
  assert.equal(n,1);assert.equal((await d1.prepare('SELECT count(*) n FROM push_deliveries').first()).n,1);
 });
}
await check('23/25-hour previous-day boundaries and year rollover',async()=>{
 for(const [date,hours] of [['2026-03-08',23],['2026-11-01',25]]) assert.equal((scheduledInstant(shiftDate(date,1),0,'America/Chicago')-scheduledInstant(date,0,'America/Chicago'))/3600e3,hours);
 assert.equal(weekPeriod('2027-01-01'),'2026-12-28');
});
await check('overlapping workers and database period uniqueness',async()=>{
 const {env,d1,run}=await setup({weekly:true});let n=0;
 await Promise.all(Array.from({length:8},()=>runPushTick(env,base,async()=>{n++;await Promise.resolve();return {ok:true};})));
 assert.equal(n,2);
 const d=await d1.prepare('SELECT * FROM push_deliveries LIMIT 1').first();
 assert.throws(()=>run('INSERT INTO push_deliveries(id,user_id,category,payload,event_ids,due_at,expires_at,period_key) VALUES(?,?,?,?,?,?,?,?)','other',d.user_id,d.category,d.payload,'[]',base,base+864e5,d.period_key),/UNIQUE/);
});
async function cameras(ctx,n,date='2026-10-24') {
 const {run}=ctx,start=scheduledInstant(date,0,'America/Chicago');
 for(let i=0;i<n;i++) {
  run('INSERT INTO camera_detections(id,camera_id,camera_name,lat,lng,city,observed_at,created_at) VALUES(?,?,?,30,-97,?,?,?)','c'+i,'cam'+i,'Camera','Austin',new Date(start).toISOString(),new Date(start).toISOString());
  run('INSERT INTO push_events VALUES(?,?,?,?,?)','cameras:c'+i,'cameras',null,JSON.stringify({source:'c'+i,link:'/heatmap?city=Austin'}),start+i+1);
 }
}
for(const n of [0,1,60,61,100,1000]) await check('one complete summary for '+n+' events',async()=>{
 const ctx=await setup({daily:false,dmv:'off',cameras:'daily',group:false});await cameras(ctx,n);const sent=[];
 await runPushTick(ctx.env,base,async(_,__,d)=>{sent.push(JSON.parse(d.payload));return {ok:true};});
 await runPushTick(ctx.env,base+600e3,async()=>assert.fail('duplicate summary'));
 assert.equal(sent.length,n?1:0);if(n) {assert.equal(sent[0].count,n);const d=await ctx.d1.prepare('SELECT * FROM push_deliveries').first();assert.equal(d.event_ids,'[]');}
});
await check('summary excludes current day, consumed, missing source and pre-enrollment',async()=>{
 const ctx=await setup({daily:false,dmv:'off',cameras:'daily'});await cameras(ctx,4);
 ctx.run("INSERT INTO push_consumed VALUES('u1','cameras:c0')");ctx.run("DELETE FROM camera_detections WHERE id='c1'");
 ctx.run("UPDATE push_events SET created_at=? WHERE id='cameras:c2'",base);
 ctx.run("UPDATE push_events SET created_at=? WHERE id='cameras:c3'",base-20*864e5);
 await runPushTick(ctx.env,base,async()=>assert.fail('ineligible summary'));
 assert.equal((await ctx.d1.prepare('SELECT COUNT(*) n FROM push_deliveries').first()).n,0);
});
await check('summary cannot merge with instant queue or replay when preference changes',async()=>{
 const ctx=await setup({daily:false,dmv:'off',cameras:'daily'});await cameras(ctx,61);
 ctx.env.PUSH_DELIVERY_ENABLED='false';await runPushTick(ctx.env,base,accepted);
 ctx.run('UPDATE push_preferences SET settings=?',JSON.stringify({...defaults(),daily:false,dmv:'off',cameras:'instant'}));
 await runPushTick(ctx.env,base+600e3,accepted);assert.equal((await ctx.d1.prepare('SELECT COUNT(*) n FROM push_deliveries').first()).n,1);
});
const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const pem='-----BEGIN PRIVATE KEY-----\n'+Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64')+'\n-----END PRIVATE KEY-----';
for(const [status,reason,outcome] of [[200,null,'accepted'],[400,'BadDeviceToken','rejected'],[400,'DeviceTokenNotForTopic','rejected'],[403,'Forbidden','rejected'],[403,'ExpiredProviderToken','retry'],[410,'Unregistered','rejected'],[413,'PayloadTooLarge','rejected'],[429,'TooManyRequests','retry'],[500,'InternalServerError','retry'],[503,'ServiceUnavailable','retry']]) await check('mock APNs '+status+' '+reason,async()=>{
 const {env,d1}=await setup();env.APNS_PRIVATE_KEY=pem;
 const device=await d1.prepare('SELECT * FROM push_devices').first();
 const delivery={id:'a'.repeat(150),category:'daily',expires_at:base+864e5,payload:'{}'};
 const result=await sendAPNs(env,device,delivery,async(url,init)=>{assert.equal(init.headers['apns-collapse-id'].length,64);return new Response(status===200?null:JSON.stringify({reason,timestamp:base}),{status,headers:{'apns-id':'mock-id'}});},base);
 assert.equal(result.outcome,outcome);assert.equal(result.status,status);assert.equal(result.apnsId,'mock-id');
});
for(const [name,result,expected,max] of [
 ['accepted',{ok:true,outcome:'accepted',status:200},'accepted',1],
 ['permanent',{outcome:'rejected',status:413,reason:'PayloadTooLarge'},'failed',1],
 ['invalid',{outcome:'rejected',status:410,reason:'Unregistered',invalid:true,timestamp:base},'failed',1],
 ['exhausted',{outcome:'retry',status:503,reason:'ServiceUnavailable'},'failed',5],
 ['ambiguous',{outcome:'unknown',reason:'TransportOutcomeUnknown'},'failed',1]]) await check('durable '+name,async()=>{
 const {env,d1}=await setup();let n=0;
 for(let i=0;i<8;i++) await runPushTick(env,base+i*3600e3,async()=>{n++;return result;});
 // Repeated hours remain the same local reporting day.
 assert.equal(n,max);const d=await d1.prepare("SELECT * FROM push_deliveries WHERE category='daily'").first();assert.equal(d.status,expected);
 const o=await d1.prepare('SELECT * FROM push_device_outcomes').first();assert.equal(o.attempts,max);assert.equal(o.http_status,result.status||null);
 assert.equal((await d1.prepare('SELECT count(*) n FROM push_receipts').first()).n,name==='accepted'?1:0);
 if(name==='invalid') assert.equal((await d1.prepare('SELECT authorized FROM push_devices').first()).authorized,0);
});
await check('partial fanout never retries accepted or permanently rejected devices',async()=>{
 const {env,d1,run}=await setup();
 for(const id of ['second','third']) run('INSERT INTO push_devices VALUES(?,?,?,\'sandbox\',1,?)',id,'u1',id.repeat(20),base);
 const calls={};const sender=async(_,dev)=>{calls[dev.id]=(calls[dev.id]||0)+1;return dev.id==='device'?{ok:true}:dev.id==='second'?{outcome:'rejected',reason:'Forbidden'}:calls.third===1?{retry:true}:{ok:true};};
 await runPushTick(env,base,sender);await runPushTick(env,base+3600e3,sender);await runPushTick(env,base+7200e3,sender);
 assert.deepEqual(calls,{device:1,second:1,third:2});assert.equal((await d1.prepare('SELECT status FROM push_deliveries').first()).status,'partial');
});
await check('stale Unregistered does not disable refreshed token',async()=>{
 const {env,d1}=await setup();await runPushTick(env,base,async()=>({outcome:'rejected',invalid:true,timestamp:base-1,reason:'Unregistered'}));
 assert.equal((await d1.prepare('SELECT authorized FROM push_devices').first()).authorized,1);
});
await check('transport exception remains unknown without retry',async()=>{
 const {env,d1}=await setup();env.APNS_PRIVATE_KEY=pem;
 const r=await sendAPNs(env,await d1.prepare('SELECT * FROM push_devices').first(),{id:'x',category:'daily',expires_at:base,payload:'{}'},async()=>{throw Error('timeout');},base);assert.equal(r.outcome,'unknown');
 let n=0;for(let i=0;i<2;i++) await runPushTick(env,base+i*3600e3,async()=>{n++;throw Error('timeout');});assert.equal(n,1);
});
await check('interrupted send is unknown and not automatically repeated',async()=>{
 const {env,d1,run}=await setup();env.PUSH_DELIVERY_ENABLED='false';await runPushTick(env,base,accepted);
 const d=await d1.prepare('SELECT * FROM push_deliveries').first();run("INSERT INTO push_device_outcomes VALUES(?,?,'sending',1,NULL,NULL,NULL,?)",d.id,'device',base);
 await deliver(d1,env,d,base+3600e3,async()=>assert.fail('ambiguous replay'));
 assert.equal((await d1.prepare('SELECT status FROM push_device_outcomes').first()).status,'unknown');
});
await check('all eight categories and selected report arithmetic preserved',async()=>{
 const p={...defaults(),news:'all',registry:'instant',sightings:'instant',cameras:'instant',weekly:true};
 for(const category of ['news','dmv','registry','sightings','cameras','community','daily','weekly']) {assert(eligible(p,{category,kind:'comments'}));assert(!eligible({...p,master:false},{category,kind:'comments'}));}
 assert.equal(reportBody(Array(7).fill({dmv:2,cameras:100}),['dmv','cameras']),'14 DMV additions, 700 camera detections.');
 assert.equal(reportBody([{dmv:5}],['dmv'],{dmv:2}),'5 DMV additions (+3 vs prior day).');
});
await check('both delivery gates fail closed',async()=>{
 const {env,d1}=await setup();delete env.PUSH_ENABLED;await runPushTick(env,base,async()=>assert.fail('disabled'));assert.equal((await d1.prepare('SELECT COUNT(*) n FROM push_deliveries').first()).n,0);
 env.PUSH_ENABLED='true';delete env.PUSH_DELIVERY_ENABLED;await runPushTick(env,base,async()=>assert.fail('delivery disabled'));assert.equal((await d1.prepare('SELECT COUNT(*) n FROM push_receipts').first()).n,0);
});
await check('temporary failures respect backoff and recover without duplicate acceptance',async()=>{
 const {env,d1}=await setup();let n=0;
 const sender=async()=>{n++;return n===1?{outcome:'retry',status:503,reason:'ServiceUnavailable'}:{ok:true};};
 await runPushTick(env,base,sender);
 assert.equal((await d1.prepare('SELECT due_at FROM push_deliveries').first()).due_at,base+15*60000);
 await runPushTick(env,base+10*60000,sender);assert.equal(n,1);
 await runPushTick(env,base+15*60000,sender);await runPushTick(env,base+30*60000,sender);assert.equal(n,2);
 assert.equal((await d1.prepare('SELECT status FROM push_deliveries').first()).status,'accepted');
});
await check('local upgrade preserves receipts and removes unconfirmed legacy sent claims',async()=>{
 const d1=createTestD1({migrateThrough:'0049_push_notifications.sql'});seedUser(d1,'u1');
 d1.exec("INSERT INTO push_devices VALUES('d','u1','token','sandbox',1,0)");
 for(const id of ['confirmed','rejected']) d1.prepare("INSERT INTO push_deliveries(id,user_id,category,payload,event_ids,due_at,expires_at,status) VALUES(?,'u1','daily','{}','[]',0,1,'sent')").bind(id)._exec();
 d1.exec("INSERT INTO push_receipts VALUES('confirmed','d')");
 d1.exec(readFileSync(new URL('../migrations/0050_push_delivery_safety.sql',import.meta.url),'utf8'));
 assert.equal((await d1.prepare("SELECT status FROM push_deliveries WHERE id='confirmed'").first()).status,'accepted');
 assert.equal((await d1.prepare("SELECT last_error FROM push_deliveries WHERE id='rejected'").first()).last_error,'LegacyUnconfirmedSend');
 assert.equal((await d1.prepare('SELECT status FROM push_device_outcomes').first()).status,'accepted');
});
await check('signing failures are explicit permanent configuration errors without HTTP',async()=>{
 const {env,d1}=await setup();env.APNS_PRIVATE_KEY='invalid-local-key';
 const r=await sendAPNs(env,await d1.prepare('SELECT * FROM push_devices').first(),{id:'x',category:'daily',expires_at:base,payload:'{}'},async()=>assert.fail('must not fetch'),base);
 assert.equal(r.outcome,'rejected');assert.equal(r.reason,'ProviderSigningFailed');assert(r.configuration);
});
await check('revocation during retry terminates unavailable target',async()=>{
 const {env,d1,run}=await setup();let n=0;
 await runPushTick(env,base,async()=>{n++;return {retry:true};});
 run('UPDATE push_devices SET authorized=0');
 await runPushTick(env,base+3600e3,async()=>assert.fail('revoked target'));
 assert.equal(n,1);assert.equal((await d1.prepare('SELECT status FROM push_deliveries').first()).status,'failed');
 assert.equal((await d1.prepare('SELECT reason FROM push_device_outcomes').first()).reason,'DeviceUnavailable');
});
console.log(`${checks} notification blocker regression checks passed; synthetic SQLite and mocked APNs only`);
