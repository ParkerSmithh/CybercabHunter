// Builds app/www, the files bundled inside the iOS app. The app itself loads
// https://cybercabhunter.com (capacitor.config.json server.url), so the live
// site, its Worker routes and its API are used unchanged; www only holds what
// must work with no connection: the offline page (server.errorPath) and the
// icon it shows. Run: npm run build (or npm run sync, which also copies it
// into the Xcode project).
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SITE = path.resolve(APP, '..', 'public');
const OUT = path.join(APP, 'www');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(SITE, 'images', 'icons', 'cybercab-ico-logo.png'), path.join(OUT, 'icon.png'));

const offline = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Cybercab Hunter</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #090B0F; color: #e2e8f0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
  main { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; box-sizing: border-box; text-align: center; }
  img { width: 88px; height: 88px; }
  h1 { margin: 6px 0 0; font-size: 20px; letter-spacing: 0.08em; color: #fff; }
  p { margin: 0; max-width: 300px; color: #94a3b8; }
  button { margin-top: 10px; min-height: 44px; padding: 0 22px; border: 0; border-radius: 10px; font: inherit; font-weight: 700; color: #1a1204; background: linear-gradient(90deg, #f5d76e, #FAE030); }
</style>
</head>
<body>
<main>
  <img src="icon.png" alt="">
  <h1>YOU'RE OFFLINE</h1>
  <p>Cybercab Hunter needs a connection to load live sightings, the map and Social. Check your connection and try again.</p>
  <button type="button" onclick="location.href = 'https://cybercabhunter.com/'">Try again</button>
</main>
</body>
</html>
`;
fs.writeFileSync(path.join(OUT, 'offline.html'), offline);
// Capacitor needs an index.html in webDir; with server.url set it is only a
// fallback, so it is the same offline page.
fs.writeFileSync(path.join(OUT, 'index.html'), offline);
console.log(`Built ${path.relative(process.cwd(), OUT) || 'www'}: offline.html, index.html, icon.png`);
