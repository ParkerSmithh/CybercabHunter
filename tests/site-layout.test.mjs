// Guards the project layout: everything a visitor can download lives under
// public/ (the folder wrangler.jsonc publishes), nothing else does, every file
// the pages reference exists, and the old root image URLs still redirect.
// Static-file checks plus the real Worker router — no DB needed beyond the shared env.
// Run: node tests/site-layout.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const PUBLIC = `${ROOT}public/`;
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const rel = f => path.relative(PUBLIC, f);

const pages = fs.readdirSync(PUBLIC).filter(f => f.endsWith('.html')).sort();
const publicFiles = walk(PUBLIC).filter(f => !f.endsWith('.DS_Store')).map(rel);

console.log('1. What is published');
check('wrangler.jsonc publishes ./public and nothing else', /"assets":\s*\{[^}]*"directory":\s*"\.\/public"/.test(fs.readFileSync(`${ROOT}wrangler.jsonc`, 'utf8')));
check('all 11 pages live in public/', pages.length === 11 && ['index', 'vehicles', 'vehicle', 'infrastructure', 'community', 'moderation', 'signin', 'profile', 'rider-data', 'fleet-calculator', 'dispatch-comparison'].every(n => pages.includes(`${n}.html`)));
check('no page is left at the repository root (it would not be published)', fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).length === 0);
check('css/, js/ and images/ are inside public/', ['css', 'js', 'images'].every(d => fs.statSync(`${PUBLIC}${d}`).isDirectory()));
check('the Tesla key is still served from its required path (.well-known/appspecific/...)', fs.existsSync(`${PUBLIC}.well-known/appspecific/com.tesla.3p.public-key.pem`));
check('no image, script or stylesheet is left loose at the repository root', fs.readdirSync(ROOT).filter(f => /\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(f)).length === 0);

console.log('2. Nothing private is published');
check('the only key material under public/ is the Tesla PUBLIC key', publicFiles.filter(f => /\.pem$/i.test(f)).join() === '.well-known/appspecific/com.tesla.3p.public-key.pem');
check('no private key, env file, wrangler config or source is under public/', !publicFiles.some(f => /private|\.env|wrangler|\.dev\.vars|package(-lock)?\.json|^worker\/|^migrations\/|^tests\//i.test(f)));
check('the private key lives outside public/ and is git-ignored', !fs.existsSync(`${PUBLIC}private-key.pem`) && /^keys\/private-key\.pem$/m.test(fs.readFileSync(`${ROOT}.gitignore`, 'utf8')));
check('public/ has no documents, notes or videos (docs/ is not published)', !publicFiles.some(f => /\.(md|mp4|mov|txt)$/i.test(f)));

console.log('3. Every file the pages point at exists');
const missing = [];
const checkRef = (from, ref) => {
  const clean = ref.split('#')[0].split('?')[0];
  if (!clean || /^(https?:|\/\/|mailto:|tel:|data:|javascript:|blob:)/i.test(clean)) return;
  if (/^\/(api|oauth)\b/.test(clean) || /\$\{|\+|\{\{/.test(clean)) return;      // Worker routes / templated strings
  const p = clean.replace(/^\//, '');
  if (p === '') return;                                                        // "/" is index.html
  if (fs.existsSync(`${PUBLIC}${p}`) && fs.statSync(`${PUBLIC}${p}`).isFile()) return;
  if (!path.extname(p) && fs.existsSync(`${PUBLIC}${p}.html`)) return;          // extensionless page URL
  if (/^vehicle\//.test(p)) return;                                            // /vehicle/:id is served by the Worker from vehicle.html
  missing.push(`${from} -> ${ref}`);
};
for (const page of pages) {
  const html = fs.readFileSync(`${PUBLIC}${page}`, 'utf8');
  for (const m of html.matchAll(/\b(?:src|href)="([^"]*)"/g)) checkRef(page, m[1]);
  for (const m of html.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) checkRef(page, m[1]);
}
check(`every src/href/url() in all ${pages.length} pages resolves inside public/ (${missing.length ? 'missing: ' + missing.slice(0, 5).join('; ') : 'none missing'})`, missing.length === 0);
const jsMissing = [];
for (const f of publicFiles.filter(f => /^js\/.*\.js$/.test(f))) {
  const src = fs.readFileSync(`${PUBLIC}${f}`, 'utf8');
  for (const m of src.matchAll(/['"`](images\/[\w.-]+)['"`]/g)) if (!fs.existsSync(`${PUBLIC}${m[1]}`)) jsMissing.push(`${f} -> ${m[1]}`);
}
check(`every images/... path named in the scripts exists (${jsMissing.length ? jsMissing.join('; ') : 'none missing'})`, jsMissing.length === 0);
const css = fs.readFileSync(`${PUBLIC}css/style.css`, 'utf8');
check('style.css names no missing local file', [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].every(m => /^(https?:|data:)/.test(m[1]) || fs.existsSync(path.join(PUBLIC, 'css', m[1]))));
check('no page still points at an image by its old root path', !pages.some(p => /(["'(])(Cybercab2?|CybercabFlipped|HeroImage|RedModelY)\.png/.test(fs.readFileSync(`${PUBLIC}${p}`, 'utf8'))));

console.log('4. Old image URLs still work (301 to /images/)');
{
  const ctx = await makeEnv({ users: [] });
  const seen = [];
  ctx.env.ASSETS = { fetch: async req => { seen.push(new URL(req.url).pathname); return new Response('asset', { status: 200 }); } };
  const get = (p, method = 'GET') => worker.fetch(new Request(`https://cybercabhunter.com${p}`, { method }), ctx.env, {});
  for (const name of ['Cybercab', 'Cybercab2', 'CybercabFlipped', 'HeroImage', 'RedModelY']) {
    const r = await get(`/${name}.png`);
    check(`/${name}.png -> 301 https://cybercabhunter.com/images/${name}.png`, r.status === 301 && r.headers.get('Location') === `https://cybercabhunter.com/images/${name}.png` && fs.existsSync(`${PUBLIC}images/${name}.png`));
  }
  check('HEAD is redirected too', (await get('/Cybercab2.png', 'HEAD')).status === 301);
  seen.length = 0;
  const other = await get('/images/Cybercab2.png');
  check('the new path is served by the static assets, not redirected', other.status === 200 && seen.join() === '/images/Cybercab2.png');
  seen.length = 0;
  const unknown = await get('/SomethingElse.png');
  check('any other .png at the root is NOT redirected (falls through to the static site)', unknown.status === 200 && seen.join() === '/SomethingElse.png');
  const post = await worker.fetch(new Request('https://cybercabhunter.com/Cybercab2.png', { method: 'POST' }), ctx.env, {});
  check('only GET/HEAD are redirected', post.status !== 301);
}

t.finish();
