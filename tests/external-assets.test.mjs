// docs/bugs.md "Offline / CDN dependency": the libraries every page needs are
// served by the site itself, pinned to one version, so a CDN outage or a
// silently changed "latest" can't break styling, maps or the PDF export.
// Map tiles are the one external piece left (CARTO): see docs/bugs.md.
// Run: node tests/external-assets.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeCheck } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('../public/', import.meta.url).pathname;
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === 'vendor' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
const pages = walk(ROOT).filter(f => f.endsWith('.html'));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(`${ROOT}vendor/${f}`)).digest('hex');

check('there are pages to check', pages.length >= 17);
for (const f of pages) {
  const html = fs.readFileSync(f, 'utf8');
  const name = path.relative(ROOT, f);
  const external = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1])
    .filter(u => !/^https:\/\/(?:www\.)?cybercabhunter\.com|^https:\/\/cybercabhunter\.contactjoeclos\.workers\.dev/.test(u));
  const code = html.match(/<script\b[^>]*\bsrc="https?:[^"]+"|<link\b[^>]*rel="stylesheet"[^>]*href="https?:[^"]+"/g) || [];
  check(`${name}: no script or stylesheet comes from another site`, code.length === 0 && !external.some(u => /tailwindcss|unpkg|jsdelivr|cdnjs|fonts\.g/.test(u)));
}
const uses = (name, re) => pages.filter(f => re.test(fs.readFileSync(f, 'utf8'))).length;
check('every page that styles with Tailwind uses the local copy', uses('tw', /src="\/vendor\/tailwindcss-3\.4\.17\.js"/) >= 17);
check('the maps use the local MapLibre (script and styles)', uses('ml', /\/vendor\/maplibre-gl-5\.24\.0\.js/) === 3 && uses('mlc', /\/vendor\/maplibre-gl-5\.24\.0\.css/) === 3);
check('the Fleet ROI PDF export uses the local jsPDF', /src="\/vendor\/jspdf-2\.5\.1\.umd\.min\.js"/.test(fs.readFileSync(`${ROOT}simulation.html`, 'utf8')));
check('the local copies are the exact files the CDNs served', sha('tailwindcss-3.4.17.js') === '176e894661aa9cdc9a5cba6c720044cbbf7b8bd80d1c9a142a7c24b1b6c50d15'
  && sha('maplibre-gl-5.24.0.js') === '45a9b07a9189ce56054c620a947ccf41e291e58c95e9b61533b740aaa65ee5cb'
  && sha('maplibre-gl-5.24.0.css') === 'ab1e70d59ec40465bae7e7030da2f3ccf28133fd502e62bd598eefbadfd7a732'
  && sha('jspdf-2.5.1.umd.min.js') === '98ccf17aa10c20bb1301762618fcc9b6ab3a4e7f26b6071d64d0b41154df3875');
t.finish();
