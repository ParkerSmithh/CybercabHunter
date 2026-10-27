// Durable per-device outcomes: acceptance is an APNs acknowledgement, never
// evidence that an alert reached a device. Ambiguous transport/crash outcomes
// are terminal: automatically repeating them could produce duplicate alerts.
export async function deliver(db,env,d,now,sender) {
 const {results:devices}=await db.prepare(`SELECT * FROM push_devices WHERE user_id=? AND authorized=1 AND refreshed_at>? LIMIT 5`).bind(d.user_id,now-30*864e5).all();
 let configuration=false, retryFloor=0;
 for(const device of devices||[]) {
  const old=await db.prepare('SELECT * FROM push_device_outcomes WHERE delivery_id=? AND device_id=?').bind(d.id,device.id).first();
  if(old && !['retry','sending'].includes(old.status)) continue;
  if(old?.status==='sending') {
   await db.prepare("UPDATE push_device_outcomes SET status='unknown',reason='InterruptedRequest',updated_at=? WHERE delivery_id=? AND device_id=?").bind(now,d.id,device.id).run(); continue;
  }
  if(await db.prepare('SELECT 1 FROM push_receipts WHERE delivery_id=? AND device_id=?').bind(d.id,device.id).first()) continue;
  const claimed=await db.prepare(`INSERT INTO push_device_outcomes(delivery_id,device_id,status,attempts,updated_at) VALUES(?,?,'sending',1,?) ON CONFLICT(delivery_id,device_id) DO UPDATE SET status='sending',attempts=push_device_outcomes.attempts+1,updated_at=excluded.updated_at WHERE push_device_outcomes.status='retry' RETURNING attempts`).bind(d.id,device.id,now).first();
  if(!claimed) continue;
  const attempts=claimed.attempts;
  let r;
  try { r=await sender(env,device,d,undefined,now); }
  catch { r={outcome:'unknown',reason:'TransportOutcomeUnknown'}; }
  let status=r.outcome || (r.ok?'accepted':r.retry?'retry':'rejected');
  if(!['accepted','retry','rejected','unknown'].includes(status)) status='unknown';
  if(status==='retry' && attempts>=5) status='exhausted';
  configuration ||= !!r.configuration;
  if(r.status>=500 && status==='retry') retryFloor=15*60000;
  const reason=String(r.reason|| (status==='accepted'?'Accepted':status==='exhausted'?'RetryExhausted':'UnspecifiedRejection')).slice(0,128);
  const writes=[db.prepare('UPDATE push_device_outcomes SET status=?,http_status=?,reason=?,apns_id=?,updated_at=? WHERE delivery_id=? AND device_id=?').bind(status,r.status||null,reason,r.apnsId||null,now,d.id,device.id)];
  if(status==='accepted') writes.push(db.prepare('INSERT OR IGNORE INTO push_receipts(delivery_id,device_id) VALUES(?,?)').bind(d.id,device.id));
  // A stale 410 must not invalidate a registration refreshed since rejection.
  if(r.invalid && (r.timestamp==null || Number(r.timestamp)>=device.refreshed_at)) writes.push(db.prepare('UPDATE push_devices SET authorized=0 WHERE id=? AND token=? AND refreshed_at=?').bind(device.id,device.token,device.refreshed_at));
  await db.batch(writes);
 }
 await db.prepare("UPDATE push_device_outcomes SET status='cancelled',reason='DeviceUnavailable',updated_at=? WHERE delivery_id=? AND status='retry' AND NOT EXISTS(SELECT 1 FROM push_devices d WHERE d.id=push_device_outcomes.device_id AND d.user_id=? AND d.authorized=1 AND d.refreshed_at>?)").bind(now,d.id,d.user_id,now-30*864e5).run();
 const {results:outcomes}=await db.prepare('SELECT status,reason FROM push_device_outcomes WHERE delivery_id=?').bind(d.id).all();
 const pending=outcomes.some(r=>r.status==='retry'), accepted=outcomes.some(r=>r.status==='accepted');
 const failed=outcomes.some(r=>r.status!=='accepted');
 const status=pending?'pending':accepted?(failed?'partial':'accepted'):outcomes.length?'failed':'cancelled';
 await db.prepare('UPDATE push_deliveries SET status=?,attempts=attempts+1,due_at=?,lease_until=0,last_error=? WHERE id=?').bind(status,now+Math.max(retryFloor,Math.min(3600e3,60000*2**(d.attempts+1))),outcomes.filter(r=>r.status!=='accepted').map(r=>r.reason).join(';').slice(0,512)||null,d.id).run();
 return configuration;
}
