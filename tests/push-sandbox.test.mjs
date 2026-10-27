import assert from 'node:assert/strict';
import {makeEnv} from './helpers/env.mjs';
import {defaults} from '../worker/push-policy.js';
import sandbox,{sandboxFetch,sandboxFixtures,tokenHash} from '../worker/push-sandbox.js';
let checks=0;
const now=Date.parse('2026-10-25T16:00Z'),device='12345678-1234-1234-1234-123456789abc';
async function setup(){
 const {env,d1}=await makeEnv({users:['u1','u2']});
 const run=(sql,...args)=>d1.prepare(sql).bind(...args)._exec();
 Object.assign(env,{SANDBOX_ONLY:'true',SANDBOX_RUN_ID:'approved-test-001',SANDBOX_ACCOUNT_ID:'u1',SANDBOX_DEVICE_ID:device,SANDBOX_TOKEN_SHA256:await tokenHash('a'.repeat(64)),SANDBOX_SEND_ARMED:'true',SANDBOX_APPROVAL_SECRET:'synthetic-approval-not-a-real-secret',APNS_TOPIC:'com.cybercabhunter.native',APNS_KEY_ID:'fake',APNS_TEAM_ID:'fake',APNS_PRIVATE_KEY:'fake'});
 run("CREATE TABLE push_sandbox_identity(id TEXT PRIMARY KEY CHECK(id='isolated'),run_id TEXT NOT NULL)");run("INSERT INTO push_sandbox_identity VALUES('isolated',?)",env.SANDBOX_RUN_ID);
 run('INSERT INTO push_devices VALUES(?,?,?,?,?,?)',device,'u1','a'.repeat(64),'sandbox',1,now);
 run('INSERT INTO push_preferences VALUES(?,?,?,?)','u1',JSON.stringify({...defaults(),registry:'instant',sightings:'instant',cameras:'instant',weekly:true}),now-864e5,now-864e5);
 await env.TESLA_SESSIONS.put('session:approved',JSON.stringify({user_id:'u1'}));await env.TESLA_SESSIONS.put('session:other',JSON.stringify({user_id:'u2'}));
 return {env,d1,run};
}
const req=(fixture='news',session='approved',extra={})=>new Request('https://sandbox.invalid/__sandbox/send',{method:'POST',headers:{Authorization:'Bearer '+session,'X-Sandbox-Approval':'synthetic-approval-not-a-real-secret'},body:JSON.stringify({fixture,...extra})});
async function check(name,fn){await fn();checks++;console.log('ok',name);}
await check('no scheduled handler or production entry-point import',async()=>{assert.equal(sandbox.scheduled,undefined);});
for(const [key,value] of [['SANDBOX_ONLY','false'],['SANDBOX_RUN_ID','wrong-run'],['SANDBOX_ACCOUNT_ID',''],['SANDBOX_DEVICE_ID',''],['PUSH_ENABLED','true'],['PUSH_DELIVERY_ENABLED','true'],['SANDBOX_SEND_ARMED','false'],['SANDBOX_APPROVAL_SECRET',''],['SANDBOX_TOKEN_SHA256',''],['APNS_TOPIC','wrong'],['APNS_PRIVATE_KEY','']]) await check('fail closed '+key,async()=>{
 const {env}=await setup();env[key]=value;let calls=0;const r=await sandboxFetch(req(),env,async()=>{calls++;return {ok:true};},now);assert(r.status>=400);assert.equal(calls,0);
});
await check('missing sentinel cannot touch device data or send',async()=>{const {env,run}=await setup();run('DROP TABLE push_sandbox_identity');assert.equal((await sandboxFetch(req(),env,async()=>assert.fail('send'),now)).status,503);});
await check('other account and missing approval cannot send',async()=>{
 const {env}=await setup();assert.equal((await sandboxFetch(req('news','other'),env,async()=>assert.fail('send'),now)).status,403);
 const r=req();r.headers.delete('X-Sandbox-Approval');assert.equal((await sandboxFetch(r,env,async()=>assert.fail('send'),now)).status,403);
});
for(const fixture of Object.keys(sandboxFixtures)) await check('synthetic '+fixture+' once to approved sandbox device',async()=>{
 const {env,d1,run}=await setup();
 run("INSERT INTO push_devices VALUES('unapproved','u1',?,'production',1,?)",'b'.repeat(64),now);
 let calls=0;const send=async(_,dev,d)=>{calls++;assert.equal(dev.id,device);assert.equal(dev.environment,'sandbox');const p=JSON.parse(d.payload);assert(p.title.startsWith('[SANDBOX]'));assert(p.link.startsWith('/'));return {outcome:'accepted',status:200,apnsId:'mock'};};
 assert.equal((await sandboxFetch(req(fixture),env,send,now)).status,200);await sandboxFetch(req(fixture),env,send,now+600e3);assert.equal(calls,1);
 assert.equal((await d1.prepare('SELECT COUNT(*) n FROM push_receipts').first()).n,1);
});
await check('native Community and sighting IDs have required 32-hex format',async()=>{for(const [category,key] of [['community','post'],['sightings','sighting']]) assert.match(new URL(sandboxFixtures[category].link,'https://cybercabhunter.com').searchParams.get(key),/^[a-f0-9]{32}$/);});
await check('payload injection is rejected',async()=>{const {env}=await setup();assert.equal((await sandboxFetch(req('news','approved',{token:'b',payload:{}}),env,async()=>assert.fail('send'),now)).status,400);});
await check('token/environment changes fail closed',async()=>{
 for(const sql of ["UPDATE push_devices SET token='changed'","UPDATE push_devices SET environment='production'","UPDATE push_devices SET authorized=0"]) {const {env,run}=await setup();run(sql);assert.equal((await sandboxFetch(req(),env,async()=>assert.fail('send'),now)).status,403);}
});
await check('master, category, and quiet-hour settings suppress manual fixture',async()=>{
 for(const p of [{master:false},{news:'off'},{quiet:true,quietStart:0,quietEnd:1439}]){const {env,run}=await setup();run('UPDATE push_preferences SET settings=?',JSON.stringify({...defaults(),...p}));assert.equal((await sandboxFetch(req(),env,async()=>assert.fail('send'),now)).status,409);}
});
await check('registration rejects other device and production environment',async()=>{
 const {env}=await setup();for(const body of [{id:device,environment:'production'},{id:'other',environment:'sandbox'}]) {const r=new Request('https://sandbox.invalid/api/push/device',{method:'PUT',headers:{Authorization:'Bearer approved'},body:JSON.stringify(body)});assert.equal((await sandboxFetch(r,env,async()=>assert.fail('send'),now)).status,403);}
});
await check('temporary retry uses same fixture ID and bounded device attempts',async()=>{
 const {env,d1}=await setup();let n=0;const send=async()=>{n++;return {outcome:'retry',status:503,reason:'ServiceUnavailable'};};
 for(let i=0;i<8;i++) await sandboxFetch(req(),env,send,now+i*3600e3);assert.equal(n,5);assert.equal((await d1.prepare('SELECT status FROM push_deliveries').first()).status,'failed');
});
await check('synthetic daily/weekly fixtures honor selected metrics and comparison',async()=>{
 for(const fixture of ['daily','weekly']) {const {env,run}=await setup();run('UPDATE push_preferences SET settings=?',JSON.stringify({...defaults(),weekly:true,dailyMetrics:['dmv'],weeklyMetrics:['cameras'],comparison:true}));
 let payload;await sandboxFetch(req(fixture),env,async(_,__,d)=>{payload=JSON.parse(d.payload);return {ok:true};},now);
 assert(!payload.body.includes('new Cybercabs'));
 if(fixture==='daily'){assert(payload.body.includes('2 DMV additions'));assert(payload.body.includes('+0 vs prior day'));}
 else assert(payload.body.includes('28 camera detections'));
 }
});
console.log(`${checks} sandbox isolation checks passed; no network requests`);
