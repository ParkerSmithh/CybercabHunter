import assert from 'node:assert/strict';
import {makeEnv} from './helpers/env.mjs';
import {defaults,validatePreferences,clock,quietNow,reportBody,eligible} from '../worker/push-policy.js';
import {apiPush,runPushTick} from '../worker/push.js';
import {collectEvents,eventStillPublic} from '../worker/push-sources.js';
import {providerToken,sendAPNs} from '../worker/apns.js';
let checks=0;
const test=(name,fn)=>{fn();checks++;console.log('ok',name);};
const p=defaults();
test('defaults',()=>{assert(p.master&&p.daily&&p.comments&&p.replies&&p.mentions);assert.equal(p.news,'major');assert.equal(p.dmv,'instant');assert.equal(p.dailyTime,480);assert.equal(p.weeklyTime,540);assert.equal(p.weeklyDay,0);for(const k of ['registry','sightings','cameras']) assert.equal(p[k],'off');assert(!p.weekly&&!p.quiet&&!p.majorDuringQuiet);assert.equal(p.dailyMetrics.length,4);});
test('strict validation',()=>{for(const value of [{master:'yes'},{dailyTime:1440},{timezone:'Mars'},{news:'everything'},{dailyMetrics:['fake']},{weeklyDay:-1},{milestones:true}]) assert.throws(()=>validatePreferences(value));assert.deepEqual(validatePreferences(p),p);});
test('DST and quiet hours',()=>{const x={...p,quiet:true};assert(quietNow(x,Date.parse('2026-11-01T06:30Z')));assert(quietNow(x,Date.parse('2026-11-01T07:30Z')));assert.equal(clock(Date.parse('2026-03-08T08:30Z'),p.timezone).minute,210);assert(!quietNow(x,Date.parse('2026-03-08T13:00Z')));assert(!quietNow({...x,quietStart:420,quietEnd:420},Date.now()));});
test('metrics unavailable and comparison',()=>{assert.equal(reportBody([null],['dmv']),null);assert.equal(reportBody([{dmv:null}],['dmv']),null);assert.equal(reportBody(Array(7).fill({dmv:2}),['dmv']),'14 DMV additions.');assert.equal(reportBody([{dmv:4}],['dmv'],{dmv:2}),'4 DMV additions (+2 vs prior day).');});
test('independent settings',()=>{assert(!eligible(p,{category:'registry'}));assert(!eligible(p,{category:'news',major:false}));assert(eligible(p,{category:'news',major:true}));assert(!eligible({...p,master:false},{category:'daily'}));assert(!eligible({...p,replies:false},{category:'community',kind:'replies'}));});
const {env,d1}=await makeEnv({users:['u1','u2']});
const now=Date.now(), stamp=new Date(now).toISOString().slice(0,19).replace('T',' ');
const run=(s,...args)=>d1.prepare(s).bind(...args)._exec();
await env.TESLA_SESSIONS.put('session:alice',JSON.stringify({user_id:'u1'}));
await env.TESLA_SESSIONS.put('session:bob',JSON.stringify({user_id:'u2'}));
const request=(path,method='GET',body,session='alice')=>new Request('https://cybercabhunter.com/api/push/'+path,{method,headers:{...(session?{Authorization:'Bearer '+session}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
assert.equal((await apiPush(request('preferences','GET',null,null),env)).status,401);checks++;
assert.equal((await apiPush(request('preferences'),env)).status,503);checks++;
env.PUSH_ENABLED='true';
assert.equal((await (await apiPush(request('preferences'),env)).json()).preferences,null);checks++;
assert.equal((await apiPush(request('preferences','PUT',p),env)).status,200);checks++;
assert.equal((await apiPush(request('preferences','PUT',p),env)).status,429);checks++;
const device={id:'12345678-1234-1234-1234-123456789abc',token:'a'.repeat(64),environment:'sandbox',authorized:true};
assert.equal((await apiPush(request('device','PUT',device),env)).status,200);checks++;
assert.equal((await apiPush(request('device','PUT',device,'bob'),env)).status,409);checks++;
assert.equal((await apiPush(request('device','PUT',{...device,token:'not-token'}),env)).status,400);checks++;
assert.equal((await apiPush(request('device','DELETE',device,'bob'),env)).status,200);assert(await d1.prepare('SELECT id FROM push_devices').first());checks++;
run("INSERT INTO news_articles(id,title,url,source,published_at,created_at,importance) VALUES('old','old','https://old.test','test','2020-01-01','2020-01-01',2)");
let sends=0;
await runPushTick(env,now,async()=>{sends++;return {ok:true};});
assert.equal(sends,0);assert.equal((await d1.prepare('SELECT COUNT(*) AS n FROM push_events').first()).n,0);checks++;
run("INSERT INTO news_articles(id,title,url,source,published_at,created_at,importance) VALUES('new','Real new title','https://new.test','test',?,?,2)",stamp,stamp);
await collectEvents(d1,now-1000,now+1000);
assert.equal((await d1.prepare('SELECT COUNT(*) AS n FROM push_events').first()).n,1);checks++;
await collectEvents(d1,now-1000,now+2000);
assert.equal((await d1.prepare('SELECT COUNT(*) AS n FROM push_events').first()).n,1);checks++;
const event=await d1.prepare('SELECT * FROM push_events').first();
assert(await eventStillPublic(d1,event));run("UPDATE news_articles SET hidden=1 WHERE id='new'");assert(!await eventStillPublic(d1,event));checks++;
run("UPDATE news_articles SET hidden=0 WHERE id='new'");
env.PUSH_DELIVERY_ENABLED='true';env.APNS_KEY_ID='test';env.APNS_TEAM_ID='test';env.APNS_PRIVATE_KEY='test';env.APNS_TOPIC='com.test';
await runPushTick(env,now+600e3,async()=>{sends++;return {ok:true};});
assert.equal(sends,1);checks++;
await runPushTick(env,now+1200e3,async()=>{sends++;return {ok:true};});assert.equal(sends,1);checks++;
assert.equal((await d1.prepare("SELECT status FROM push_deliveries WHERE category='news'").first()).status,'accepted');checks++;
// APNs is always mocked, including cryptographically valid synthetic keys.
const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const bytes=new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey));
env.APNS_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n'+Buffer.from(bytes).toString('base64')+'\n-----END PRIVATE KEY-----';
const jwt=await providerToken(env,now);assert.equal(jwt.split('.').length,3);assert.equal(await providerToken(env,now+1000),jwt);checks++;
const delivery={id:'x',category:'news',expires_at:now+3600e3,payload:JSON.stringify({title:'Title',body:'Body',link:'/news'})};
for(const [status,reason,expected] of [[410,'Unregistered','invalid'],[400,'BadDeviceToken','invalid'],[429,'TooManyRequests','retry'],[503,'ServiceUnavailable','retry'],[403,'InvalidProviderToken','configuration']]) {
 const result=await sendAPNs(env,device,delivery,async(url,init)=>{assert(url.startsWith('https://api.sandbox.push.apple.com/'));assert(!init.body.includes(device.token));return Response.json({reason},{status});},now);
 assert(result[expected]);checks++;
}
assert((await sendAPNs(env,{...device,environment:'production'},delivery,async url=>{assert(url.startsWith('https://api.push.apple.com/'));return new Response(null,{status:200});},now)).ok);checks++;
console.log(`${checks} push checks passed; no real network deliveries`);

// Scheduled integration: actual D1 SQL, stable reporting dates, no network.
async function scheduledEnv(overrides={}) {
 const {env,d1}=await makeEnv();
 Object.assign(env,{PUSH_ENABLED:'true',PUSH_DELIVERY_ENABLED:'true',APNS_KEY_ID:'test',APNS_TEAM_ID:'test',APNS_PRIVATE_KEY:'test',APNS_TOPIC:'com.test'});
 const at=Date.parse('2026-10-25T16:00:00Z'); // Sunday, 11 AM Chicago
 const preferences={...defaults(),...overrides};
 d1.prepare('INSERT INTO push_preferences(user_id,settings,updated_at,initialized_at) VALUES(?,?,?,?)').bind('u1',JSON.stringify(preferences),at-864e5,at-864e5)._exec();
 d1.prepare('INSERT INTO push_devices(id,user_id,token,environment,authorized,refreshed_at) VALUES(?,?,?,?,?,?)').bind(device.id,'u1',device.token,'sandbox',1,at)._exec();
 for(let n=0;n<8;n++) {
  const date=new Date(Date.parse('2026-10-24T12:00Z')-n*864e5).toISOString().slice(0,10);
  d1.prepare('INSERT INTO push_daily(date,metrics) VALUES(?,?)').bind(date,JSON.stringify({date,registry:1,dmv:2,sightings:3,cameras:4}))._exec();
 }
 return {env,d1,at,preferences};
}
{
 const {env,d1,at}=await scheduledEnv({weekly:true,comparison:true});let sent=[];
 await runPushTick(env,at,async(_,__,d)=>{sent.push(JSON.parse(d.payload));return {ok:true};});
 assert.equal(sent.length,2);assert(sent.find(p=>p.title.includes('Daily')).body.includes('+0 vs prior day'));
 assert(sent.find(p=>p.title.includes('Weekly')).body.includes('14 DMV additions'));
 await runPushTick(env,at+600e3,async()=>{throw Error('duplicate report');});
 assert.equal((await d1.prepare('SELECT COUNT(*) n FROM push_deliveries').first()).n,2);checks++;
}
{
 const {env,d1,at}=await scheduledEnv({weekly:true});
 d1.prepare("DELETE FROM push_daily WHERE date='2026-10-21'")._exec();
 let count=0;await runPushTick(env,at,async()=>{count++;return {ok:true};});
 assert.equal(count,1,'missing weekly day safely defers weekly');checks++;
}
{
 const {env,d1,at}=await scheduledEnv({quiet:true,quietStart:600,quietEnd:720});
 let count=0;await runPushTick(env,at,async()=>{count++;return {ok:true};});assert.equal(count,0);
 await runPushTick(env,at+3600e3,async()=>{count++;return {ok:true};});assert.equal(count,1);checks++;
}
{
 const {env,d1,at}=await scheduledEnv();let count=0;
 await runPushTick(env,at,async()=>{count++;return {retry:true};});
 for(let n=1;n<=6;n++) await runPushTick(env,at+n*3600e3,async()=>{count++;return {retry:true};});
 assert.equal(count,5);assert.equal((await d1.prepare("SELECT status FROM push_deliveries WHERE category='daily'").first()).status,'failed');checks++;
}
{
 const {env,d1,at}=await scheduledEnv();
 await runPushTick(env,at,async()=>({invalid:true}));
 assert.equal((await d1.prepare('SELECT authorized FROM push_devices').first()).authorized,0);checks++;
}
{
 const {env,d1,at}=await scheduledEnv({master:false});
 await runPushTick(env,at,async()=>{throw Error('master switch ignored');});
 assert.equal((await d1.prepare('SELECT COUNT(*) n FROM push_deliveries').first()).n,0);checks++;
}
{
 const {env,d1,at}=await scheduledEnv();
 d1.prepare('UPDATE push_devices SET authorized=0')._exec();
 await runPushTick(env,at,async()=>{throw Error('authorization ignored');});
 assert.equal((await d1.prepare('SELECT COUNT(*) n FROM push_deliveries').first()).n,0);checks++;
}
{
 const {env,d1,at}=await scheduledEnv({daily:false,registry:'instant',sightings:'instant',cameras:'instant'});
 const date=new Date(at).toISOString().slice(0,19).replace('T',' ');
 d1.prepare("INSERT INTO social_posts(id,user_id,body,status) VALUES('post','u1','PRIVATE PREVIEW TEXT','visible')")._exec();
 // A self interaction should never be collected even if a bad source row exists.
 d1.prepare("INSERT INTO social_notifications(id,user_id,type,actor_user_id,post_id,dedupe_key,created_at) VALUES('self','u1','comment','u1','post','self',?)").bind(date)._exec();
 await collectEvents(d1,at-1000,at);
 assert.equal((await d1.prepare("SELECT COUNT(*) n FROM push_events WHERE category='community'").first()).n,0);checks++;
}
console.log(`${checks} total push checks passed, including scheduled delivery integration`);
{
 const {runTxdmvPoll,TESLA_AUTHORIZATION}=await import('../worker/txdmv.js');
 const {env,d1}=await makeEnv();env.PUSH_ENABLED='true';env.DMV_HISTORY_OVERRIDE=[];
 let roster=[{vin:'5YJAJEEU000000001',make:'TESLA',model:'Cybercab',modelYear:2026}];
 const fetchImpl=async raw=>new URL(raw).pathname==='/api/TruckStop/companies'?Response.json({results:[{businessEntityId:'company',companyName:'Tesla Robotaxi, LLC',autonomousVehicleAuthorizationNumber:TESLA_AUTHORIZATION,autonomousVehicleStatus:'authorized'}],total:1}):Response.json({vehicles:roster,total:roster.length});
 const first=await runTxdmvPoll(env,{fetchImpl,nowMs:Date.parse('2026-10-01T17:00Z')});assert(first.ok,JSON.stringify(first));
 assert.equal((await d1.prepare('SELECT COUNT(*) n FROM push_events').first()).n,0);
 roster.push({vin:'5YJAJEEU000000002',make:'TESLA',model:'Cybercab',modelYear:2026},{vin:'7SAYGDED000000003',make:'TESLA',model:'Model Y',modelYear:2026});
 const second=await runTxdmvPoll(env,{fetchImpl,nowMs:Date.parse('2026-10-02T17:00Z')});assert(second.ok,JSON.stringify(second));
 const e=await d1.prepare("SELECT payload FROM push_events WHERE category='dmv'").first();
 assert.equal(JSON.parse(e.payload).count,2,'batch grouped with exact new VIN count');
 assert(!e.payload.includes('5YJA'),'VIN excluded from preview event payload');
 roster[0].modelYear=2027;
 await runTxdmvPoll(env,{fetchImpl,nowMs:Date.parse('2026-10-03T17:00Z')});
 assert.equal((await d1.prepare('SELECT COUNT(*) n FROM push_events').first()).n,1,'corrections and reimports do not alert');checks++;
}
console.log(`${checks} total push checks passed, including DMV baseline/import grouping`);
{
 const {localMidnight}=await import('../worker/push-policy.js');
 assert.equal(new Date(localMidnight(Date.parse('2026-03-08T18:00Z'),'America/Chicago')).toISOString(),'2026-03-08T06:00:00.000Z');
 assert.equal(new Date(localMidnight(Date.parse('2026-11-01T18:00Z'),'America/Chicago')).toISOString(),'2026-11-01T05:00:00.000Z');checks++;
}
{
 const {env,d1,at,preferences}=await scheduledEnv({daily:false,quiet:true,quietStart:0,quietEnd:1439});
 const {seedUser}=await import('./helpers/d1-sqlite.mjs');seedUser(d1,'u2');
 const date=new Date(at).toISOString().slice(0,19).replace('T',' ');
 d1.prepare("INSERT INTO social_posts(id,user_id,body,status) VALUES('post','u1','PRIVATE POST PREVIEW','visible')")._exec();
 d1.prepare("INSERT INTO social_comments(id,post_id,user_id,body,status) VALUES('comment','post','u2','PRIVATE COMMENT PREVIEW','visible')")._exec();
 d1.prepare("INSERT INTO social_notifications(id,user_id,type,actor_user_id,post_id,comment_id,dedupe_key,created_at) VALUES('other','u1','comment','u2','post','comment','other',?)").bind(date)._exec();
 let sent=0;
 await runPushTick(env,at,async()=>{sent++;return {ok:true};});
 const queued=await d1.prepare("SELECT payload FROM push_deliveries WHERE category='community'").first();
 assert(queued);assert(!queued.payload.includes('PRIVATE'));assert.equal(sent,0);
 d1.prepare("UPDATE social_comments SET status='removed' WHERE id='comment'")._exec();
 d1.prepare('UPDATE push_preferences SET settings=?').bind(JSON.stringify({...preferences,quiet:false}))._exec();
 await runPushTick(env,at+600e3,async()=>{sent++;return {ok:true};});
 assert.equal(sent,0,'privacy rechecked after moderation, before delayed dispatch');
 assert.equal((await d1.prepare("SELECT status FROM push_deliveries WHERE category='community'").first()).status,'cancelled');checks++;
}
{
 const {env,d1,at}=await scheduledEnv({daily:false,dmv:'daily'});
 const localDate='2026-10-25';
 d1.prepare("INSERT INTO dmv_snapshots(snapshot_date,total,cybercab_count,model_y_count,authorization_number,raw_json,polled_at) VALUES(?,1,1,0,'test','[]',?)").bind(localDate,new Date(at).toISOString())._exec();
 d1.prepare("INSERT INTO push_events(id,category,payload,created_at) VALUES('dmv:batch','dmv',?,?)").bind(JSON.stringify({source:localDate,title:'New DMV Entries',count:3,link:'/dmv'}),at-3600e3)._exec();
 let sent=0;
 await runPushTick(env,at,async()=>{sent++;return {ok:true};});assert.equal(sent,0,'daily summaries exclude current partial day');
 // Keep source event and its device within their normal age windows.
 await runPushTick(env,at+864e5,async()=>{sent++;return {ok:true};});assert.equal(sent,1);checks++;
}
console.log(`${checks} total push checks passed, including privacy revalidation and DST summary boundaries`);
