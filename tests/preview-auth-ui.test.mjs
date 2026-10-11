import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv } from './helpers/env.mjs';
import worker from '../worker/index.js';
const alias = 'https://backend-recovery-cybercabhunter.contactjoeclos.workers.dev';
const productionWorker = 'https://cybercabhunter.contactjoeclos.workers.dev';
const main = fs.readFileSync('public/js/main.js','utf8');
const calc = fs.readFileSync('public/js/calc.js','utf8');
const moderation = fs.readFileSync('public/js/moderation.js','utf8');

for (const [origin, expected] of [[alias,alias],['https://cybercabhunter.com',productionWorker],[productionWorker,productionWorker]]) {
  const {env,d1} = await makeEnv();
  d1.exec("UPDATE users SET role='moderator' WHERE id='u1'");
  await env.TESLA_SESSIONS.put('session:preview-test',JSON.stringify({user_id:'u1'}));
  const dom = new JSDOM(fs.readFileSync('public/moderation.html','utf8'),{runScripts:'outside-only',url:origin+'/moderation',pretendToBeVisual:true});
  const w=dom.window, calls=[];
  w.localStorage.setItem('teslaSessionId','preview-test');
  w.IntersectionObserver=class {observe(){} unobserve(){} disconnect(){}};
  w.fetch=async (url,init={})=>{calls.push(String(url));return worker.fetch(new Request(String(url),init),env,{});};
  w.eval(calc+'\n'+main+'\nCCC.init();\n'+moderation);
  await new Promise(resolve=>setTimeout(resolve,120));
  assert(calls.some(url=>url===expected+'/api/moderation/vehicle-sightings'));
  assert(calls.filter(url=>/\/api\/(me|moderation)/.test(url)).every(url=>url.startsWith(expected+'/')));
  assert(!w.document.getElementById('modQueue').classList.contains('hidden'));
  assert(w.document.getElementById('modError').classList.contains('hidden'));
  dom.window.close();
  const home = new JSDOM(fs.readFileSync('public/index.html','utf8'),{runScripts:'outside-only',url:origin+'/?signin=success#tesla_session=preview-test',pretendToBeVisual:true});
  const accountCalls=[];
  home.window.IntersectionObserver=class {observe(){} unobserve(){} disconnect(){}};
  home.window.fetch=async (url,init={})=>{accountCalls.push(String(url));return worker.fetch(new Request(String(url),init),env,{});};
  home.window.eval(calc+'\n'+main+'\nCCC.init();');
  await new Promise(resolve=>setTimeout(resolve,120));
  assert.equal(home.window.localStorage.getItem('teslaSessionId'),'preview-test');
  assert.equal(home.window.location.hash,'');
  assert(accountCalls.some(url=>url===expected+'/api/me'));
  assert(accountCalls.filter(url=>/\/api\/(me|moderation)/.test(url)).every(url=>url.startsWith(expected+'/')));
  home.window.close();
}
// The actual sign-in page must start on the same preview host too.
const signin=fs.readFileSync('public/signin.html','utf8');
for(const [origin,expected] of [[alias,alias],['https://cybercabhunter.com',productionWorker]]){
  const dom=new JSDOM(signin,{runScripts:'outside-only',url:origin+'/signin?returnTo=/moderation'});
  const script=[...dom.window.document.querySelectorAll('script:not([src])')].at(-1).textContent;
  dom.window.CCC={init(){}};
  dom.window.eval(script);
  const target=new URL(dom.window.document.getElementById('signInGoogle').href);
  assert.equal(target.origin,expected);
  assert.equal(target.pathname,'/oauth/google/start');
  assert.equal(target.searchParams.get('returnTo'),'/moderation');
  dom.window.close();
}
console.log('Preview sign-in, session checks and moderation use isolated APIs; production origins retain their existing behavior');
