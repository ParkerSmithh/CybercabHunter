export const metrics = ['registry', 'dmv', 'sightings', 'cameras'];
export const defaults = () => ({ version: 1, master: true, timezone: 'America/Chicago', quiet: false,
 quietStart: 1320, quietEnd: 420, majorDuringQuiet: false, group: true, frequency: 'standard',
 news: 'major', dmv: 'instant', daily: true, dailyTime: 480, dailyMetrics: [...metrics], comparison: false,
 registry: 'off', sightings: 'off', cameras: 'off', comments: true, replies: true, mentions: true, likes: true,
 weekly: false, weeklyDay: 0, weeklyTime: 540, weeklyMetrics: [...metrics] });
export function validatePreferences(value) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_preferences');
 const p = defaults();
 for (const [k,v] of Object.entries(value)) {
  if (!(k in p)) throw Error('unknown_preference');
  if (Array.isArray(p[k])) { if (!Array.isArray(v) || !v.length || v.some(x=>!metrics.includes(x)) || new Set(v).size!==v.length) throw Error('invalid_metrics'); }
  else if (typeof v !== typeof p[k]) throw Error('invalid_type');
  p[k]=v;
 }
 for (const k of ['quietStart','quietEnd','dailyTime','weeklyTime']) if (!Number.isInteger(p[k]) || p[k]<0 || p[k]>1439) throw Error('invalid_time');
 if (!Number.isInteger(p.weeklyDay) || p.weeklyDay<0 || p.weeklyDay>6 || p.version!==1) throw Error('invalid_version_or_day');
 if (!['major','all','off'].includes(p.news) || !['standard','reduced'].includes(p.frequency)) throw Error('invalid_mode');
 for (const k of ['dmv','registry','sightings','cameras']) if (!['instant','daily','off'].includes(p[k])) throw Error('invalid_mode');
 try { new Intl.DateTimeFormat('en-US',{timeZone:p.timezone}).format(); } catch { throw Error('invalid_timezone'); }
 return p;
}
const formatters=new Map();
export function clock(now, timezone) {
 if(!formatters.has(timezone)) { if(formatters.size>=128) formatters.clear(); formatters.set(timezone,new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})); }
 const parts=Object.fromEntries(formatters.get(timezone).formatToParts(now).map(p=>[p.type,p.value]));
 const date=`${parts.year}-${parts.month}-${parts.day}`;
 return {date, minute:Number(parts.hour)*60+Number(parts.minute), weekday:new Date(date+'T12:00:00Z').getUTCDay()};
}
export const shiftDate=(date,n)=>new Date(Date.parse(date+'T12:00:00Z')+n*864e5).toISOString().slice(0,10);
export function quietNow(p,now) {
 if (!p.quiet || p.quietStart===p.quietEnd) return false;
 const m=clock(now,p.timezone).minute;
 return p.quietStart<p.quietEnd ? m>=p.quietStart && m<p.quietEnd : m>=p.quietStart || m<p.quietEnd;
}
export function eligible(p,e) {
 if (!p.master) return false;
 if (e.category==='news') return p.news==='all' || (p.news==='major' && e.major);
 if (e.category==='community') return !!p[e.kind];
 return p[e.category] && p[e.category]!=='off';
}
export function reportBody(days,selected,previous) {
 if (!days.length || days.some(d=>!d || selected.some(k=>!Number.isInteger(d[k]) || d[k]<0))) return null;
 const labels={registry:'new Cybercabs',dmv:'DMV additions',sightings:'sightings',cameras:'camera detections'};
 return selected.map(k=>`${days.reduce((n,d)=>n+d[k],0)} ${labels[k]}${previous && Number.isInteger(previous[k]) ? ` (${days[0][k]-previous[k]>=0?'+':''}${days[0][k]-previous[k]} vs prior day)` : ''}`).join(', ')+'.';
}

// Resolve local midnight with the zone's offset at that boundary, rather
// than subtracting 24 hours (which is wrong on daylight-saving transitions).
export function localMidnight(now,timezone) {
 const local=clock(now,timezone), target=Date.parse(local.date+'T00:00:00Z');
 let result=target;
 for(let i=0;i<3;i++) {
  const p=clock(result,timezone);
  const wall=Date.parse(p.date+'T00:00:00Z')+p.minute*60000;
  result=target-(wall-Math.floor(result/60000)*60000);
 }
 return result;
}

// Earliest occurrence on a repeated clock; advance through a missing DST hour.
// Resolve offsets on both sides of the date, never assume a 24-hour local day.
export function scheduledInstant(date,minute,timezone) {
 const target=Date.parse(date+'T00:00:00Z')+minute*60000;
 const wall=t=>{const c=clock(t,timezone);return Date.parse(c.date+'T00:00:00Z')+c.minute*60000;};
 const offsets=new Set([-36,0,36].map(h=>{const t=target+h*3600e3;return wall(t)-t;}));
 const candidates=[...offsets].map(offset=>target-offset).sort((a,b)=>a-b);
 const exact=candidates.filter(t=>wall(t)===target);
 if(exact.length) return exact[0];
 // A gap is at most the separation between the candidate offsets.
 for(let t=candidates[0];t<=candidates.at(-1);t+=60000) if(wall(t)>=target && clock(t,timezone).date===date) return t;
 return null;
}
export const weekPeriod=date=>shiftDate(date,-((new Date(date+'T12:00:00Z').getUTCDay()+6)%7));
