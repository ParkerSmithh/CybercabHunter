// Separate preparation-only entry point. NOT imported by worker/index.js.
// No scheduled handler, collector, user fanout, production token lookup or
// caller-supplied payload. Requires an isolated DB sentinel and explicit arming.
import {apiPush} from './push.js';
import {tesla} from './tesla.js';
import {sendAPNs} from './apns.js';
import {deliver} from './push-delivery.js';
import {validatePreferences,eligible,quietNow,reportBody} from './push-policy.js';
const response=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export const sandboxFixtures=Object.freeze({
 news:{title:'[SANDBOX] Major Cybercab News',body:'Synthetic major story for the approved test device.',link:'/news?article=sandbox-news',major:true},
 dmv:{title:'[SANDBOX] 2 New DMV Entries',body:'2 synthetic Tesla/Cybercab DMV records.',link:'/dmv',count:2},
 daily:{title:'[SANDBOX] Your Cybercab Daily Report',body:'Synthetic report: 1 new Cybercabs, 2 DMV additions, 3 sightings, 4 camera detections.',link:'/?daily=2026-10-24'},
 registry:{title:'[SANDBOX] New Cybercab Identified',body:'1 synthetic public Cybercab.',link:'/vehicles/a1b2c3d4-0000-4000-8000-000000000001'},
 sightings:{title:'[SANDBOX] New Cybercab Sighting',body:'1 synthetic approved public sighting.',link:'/sightings?sighting=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},
 cameras:{title:'[SANDBOX] New Cybercab Detection',body:'1 synthetic camera detection.',link:'/heatmap?city=austin'},
 community:{title:'[SANDBOX] Community Interaction',body:'Synthetic interaction with the test account content.',link:'/community?post=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',kind:'comments'},
 weekly:{title:'[SANDBOX] Your Weekly Cybercab Recap',body:'Synthetic seven-day recap: 7 new Cybercabs, 14 DMV additions, 21 sightings, 28 camera detections.',link:'/?daily=2026-10-24&days=7'}
});
export const tokenHash=async token=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');
async function isolated(env) {
 if(env.SANDBOX_ONLY!=='true' || !/^[a-zA-Z0-9-]{8,80}$/.test(env.SANDBOX_RUN_ID||'') || !env.SANDBOX_ACCOUNT_ID || !/^[a-f0-9-]{36}$/i.test(env.SANDBOX_DEVICE_ID||'') || env.PUSH_ENABLED==='true' || env.PUSH_DELIVERY_ENABLED==='true') return false;
 try { const row=await env.cybercabhunter_db.prepare("SELECT run_id FROM push_sandbox_identity WHERE id='isolated'").first();return row?.run_id===env.SANDBOX_RUN_ID; } catch {return false;}
}
export async function sandboxFetch(request,env,sender=sendAPNs,now=Date.now()) {
 if(!await isolated(env)) return response({error:'sandbox_not_configured'},503);
 const path=new URL(request.url).pathname;
 if(path==='/__sandbox/health' && request.method==='GET') return response({sandbox:true,armed:env.SANDBOX_SEND_ARMED==='true'});
 // Isolated TESLA_SESSIONS only: never production sessions or account lists.
 const user=await tesla.requireUserId(request,env);
 if(!user || user!==env.SANDBOX_ACCOUNT_ID || !request.headers.get('Authorization')?.startsWith('Bearer ')) return response({error:'test_account_required'},403);
 if(path.startsWith('/api/push/')) {
  if(path==='/api/push/device' && ['PUT','DELETE'].includes(request.method)) {
   let body;try {const raw=await request.clone().text();if(raw.length>8192) throw Error();body=JSON.parse(raw);}catch{return response({error:'invalid_device'},400);}
   if(body.id!==env.SANDBOX_DEVICE_ID || (request.method==='PUT' && body.environment!=='sandbox')) return response({error:'test_device_required'},403);
  }
  // Enables preference/registration API only. Global delivery remains OFF.
  return apiPush(request,{...env,PUSH_ENABLED:'true',PUSH_DELIVERY_ENABLED:'false'});
 }
 if(path!=='/__sandbox/send' || request.method!=='POST') return response({error:'not_found'},404);
 if(env.SANDBOX_SEND_ARMED!=='true' || !env.SANDBOX_APPROVAL_SECRET || env.SANDBOX_APPROVAL_SECRET.length<32 || request.headers.get('X-Sandbox-Approval')!==env.SANDBOX_APPROVAL_SECRET || !/^[a-f0-9]{64}$/.test(env.SANDBOX_TOKEN_SHA256||'') || env.APNS_TOPIC!=='com.cybercabhunter.native' || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_PRIVATE_KEY) return response({error:'send_not_approved'},403);
 let body;try {const raw=await request.text();if(raw.length>128) throw Error();body=JSON.parse(raw);}catch{return response({error:'invalid_fixture'},400);}
 if(Object.keys(body||{}).length!==1 || !Object.hasOwn(sandboxFixtures,body.fixture)) return response({error:'invalid_fixture'},400);
 const category=body.fixture,db=env.cybercabhunter_db;
 const payload={...sandboxFixtures[category]};
 const device=await db.prepare('SELECT * FROM push_devices WHERE id=? AND user_id=? AND environment=\'sandbox\' AND authorized=1 AND refreshed_at>?').bind(env.SANDBOX_DEVICE_ID,user,now-30*864e5).first();
 if(!device || await tokenHash(device.token)!==env.SANDBOX_TOKEN_SHA256) return response({error:'approved_token_required'},403);
 const row=await db.prepare('SELECT settings FROM push_preferences WHERE user_id=?').bind(user).first();
 const p=row?validatePreferences(JSON.parse(row.settings)):null;
 if(!p || !eligible(p,{category,...payload}) || (quietNow(p,now) && !(category==='news' && p.majorDuringQuiet))) return response({error:'preferences_suppress_fixture'},409);
 const metrics={registry:1,dmv:2,sightings:3,cameras:4};
 if(category==='daily') payload.body='Synthetic report: '+reportBody([metrics],p.dailyMetrics,p.comparison?metrics:undefined);
 if(category==='weekly') payload.body='Synthetic seven-day recap: '+reportBody(Array(7).fill(metrics),p.weeklyMetrics);
 const id=`sandbox:${env.SANDBOX_RUN_ID}:${category}`;
 await db.prepare('INSERT OR IGNORE INTO push_deliveries(id,user_id,category,payload,event_ids,due_at,expires_at,period_key) VALUES(?,?,?,?,?,?,?,?)').bind(id,user,category,JSON.stringify(payload),'[]',now,now+864e5,id).run();
 const claimed=await db.prepare("UPDATE push_deliveries SET lease_until=? WHERE id=? AND status='pending' AND due_at<=? AND lease_until<? AND expires_at>? RETURNING *").bind(now+120000,id,now,now,now).first();
 if(claimed) await deliver(db,env,claimed,now,async(e,target,d,...args)=>{
  // Final transport boundary: even poisoned rows or extra devices cannot fan out.
  if(target.id!==env.SANDBOX_DEVICE_ID || target.user_id!==user || target.environment!=='sandbox' || await tokenHash(target.token)!==env.SANDBOX_TOKEN_SHA256) return {outcome:'rejected',reason:'SandboxTargetDenied'};
  return sender(e,target,d,...args);
 });
 const result=await db.prepare('SELECT status,attempts,due_at,last_error FROM push_deliveries WHERE id=?').bind(id).first();
 return response({fixture:category,...result});
}
export default {fetch:(request,env)=>sandboxFetch(request,env)};
