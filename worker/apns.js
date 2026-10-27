// Web Crypto only; no Node API or embedded credentials. Provider JWT reused
// for 50 minutes to avoid APNs TooManyProviderTokenUpdates.
let cached;
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const enc=x=>b64(new TextEncoder().encode(JSON.stringify(x)));
export async function providerToken(env,now=Date.now()) {
 if(cached && cached.key===env.APNS_KEY_ID && cached.team===env.APNS_TEAM_ID && cached.pem===env.APNS_PRIVATE_KEY && now-cached.at<3000e3) return cached.jwt;
 const bytes=Uint8Array.from(atob(env.APNS_PRIVATE_KEY.replace(/-----[^-]+-----/g,'').replace(/\s/g,'')),x=>x.charCodeAt(0));
 const key=await crypto.subtle.importKey('pkcs8',bytes,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
 const message=enc({alg:'ES256',kid:env.APNS_KEY_ID})+'.'+enc({iss:env.APNS_TEAM_ID,iat:Math.floor(now/1000)});
 const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(message));
 const jwt=message+'.'+b64(new Uint8Array(signature)); cached={key:env.APNS_KEY_ID,team:env.APNS_TEAM_ID,pem:env.APNS_PRIVATE_KEY,at:now,jwt}; return jwt;
}
export async function sendAPNs(env,device,delivery,fetcher=fetch,now=Date.now()) {
 const payload=JSON.parse(delivery.payload);
 const host=device.environment==='sandbox'?'api.sandbox.push.apple.com':'api.push.apple.com';
 let jwt;
 try { jwt=await providerToken(env,now); } catch { return {ok:false,outcome:'rejected',configuration:true,reason:'ProviderSigningFailed'}; }
 let response;
 try { response=await fetcher(`https://${host}/3/device/${device.token}`,{method:'POST',signal:AbortSignal.timeout(10000),headers:{authorization:'bearer '+jwt,'apns-topic':env.APNS_TOPIC,'apns-push-type':'alert','apns-priority':'10','apns-expiration':String(Math.floor(delivery.expires_at/1000)),'apns-collapse-id':Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(delivery.id))),b=>b.toString(16).padStart(2,'0')).join(''),'content-type':'application/json'},body:JSON.stringify({aps:{alert:{title:String(payload.title||'Cybercab Hunter').slice(0,160),body:String(payload.body||'').slice(0,512)},sound:'default','thread-id':delivery.category},link:payload.link})}); } catch { return {ok:false,outcome:'unknown',reason:'TransportOutcomeUnknown'}; }
 let reason, timestamp; if(response.status!==200) { try { const body=await response.json(); reason=body.reason; timestamp=body.timestamp; } catch {} }
 const retry=response.status===429 || response.status>=500;
 if(reason==='ExpiredProviderToken') cached=undefined;
 return {outcome:response.status===200?'accepted':retry || reason==='ExpiredProviderToken'?'retry':'rejected',status:response.status,reason:reason|| (response.status===200?'Accepted':'UnknownAPNsReason'),timestamp,apnsId:response.headers.get('apns-id'),ok:response.status===200,invalid:response.status===410 || (response.status===400 && ['BadDeviceToken','DeviceTokenNotForTopic'].includes(reason)),retry:retry || reason==='ExpiredProviderToken',configuration:[401,403].includes(response.status)};
}
