// The sighting photo control in real Chromium (local server, real Worker):
// accessible name, keyboard (Tab + Enter/Space), mouse, programmatic file
// selection, drag and drop, a phone tap, and a real submission landing in the
// moderation queue. The control used to be a clipped 1px input behind a label,
// unreachable by keyboard and blocked for automated file selection (Oct 17).
// Run: node tests/e2e/sighting-upload-browser.mjs  (PW_PATH / E as in social-browser.mjs)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, startServer, newContext, loadPlaywright } from './harness.mjs';
const pw = loadPlaywright();
const app = await makeApp();
const { server, origin } = await startServer(app);
const browser = await pw.chromium.launch(process.env.E ? { executablePath: process.env.E } : fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
let failed = 0;
const out = (k, v) => { if (!v) failed++; console.log(`  ${v ? 'ok' : 'FAIL'} — ${k}`); };
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-upload-'));
const JPG = path.join(DIR, 'photo.jpg');
// A real, decodable JPEG (the browser re-encodes photos before upload): drawn on a canvas.
async function makeJpeg(page) {
  const b64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 800; c.height = 600; const g = c.getContext('2d'); g.fillStyle = '#28282f'; g.fillRect(0, 0, 800, 600); g.fillStyle = '#fae030'; g.fillRect(200, 220, 400, 160); return c.toDataURL('image/jpeg', 0.85).split(',')[1]; });
  fs.writeFileSync(JPG, Buffer.from(b64, 'base64'));
}
async function openDrawer(opts = {}) {
  const ctx = await newContext(browser, { session: 's-alice', origin, ...opts });
  const p = await ctx.newPage();
  await p.goto(origin + '/sightings.html'); await p.waitForTimeout(800);
  await p.click('#openSightingDrawer'); await p.waitForTimeout(500);
  return { ctx, p };
}
const previewShown = p => p.evaluate(() => !document.getElementById('sightingPhotoPreview').classList.contains('hidden') && document.getElementById('sightingPhotoPrompt').textContent === 'Change Photo');
const reset = p => p.evaluate(() => { const f = document.getElementById('sightingPhoto'); f.value = ''; f.dispatchEvent(new Event('change')); });

{
  const { ctx, p } = await openDrawer();
  await makeJpeg(p);
  // 1. Accessibility tree.
  const name = await p.locator('#sightingPhoto').evaluate(el => el.labels && el.labels[0] && el.labels[0].textContent.replace(/\s+/g, ' ').trim());
  const role = await p.getByRole('button', { name: /Upload Photo/ }).count().catch(() => 0);
  out(`accessible name from its label: "${name}"`, /Upload Photo/.test(name || ''));
  out(`exposed in the accessibility tree as a control named "Upload Photo…" (role queries find ${role})`, role >= 1);
  // 2. Keyboard: Tab to it, Enter / Space open the file dialog.
  await p.focus('#sightingServiceArea'); await p.keyboard.down('Shift'); await p.keyboard.press('Tab'); await p.keyboard.up('Shift');
  const focused = await p.evaluate(() => document.activeElement && document.activeElement.id);
  out(`Shift+Tab from City lands on the photo control (focused: ${focused})`, focused === 'sightingPhoto');
  const look = () => p.evaluate(() => { const z = getComputedStyle(document.getElementById('sightingPhoto').closest('label')); return `${z.boxShadow}|${z.borderTopColor}`; });
  const focusedLook = await look();
  await p.evaluate(() => document.activeElement.blur());
  const restingLook = await look();
  await p.focus('#sightingServiceArea'); await p.keyboard.down('Shift'); await p.keyboard.press('Tab'); await p.keyboard.up('Shift');
  out('a visible focus ring on the dropzone while keyboard-focused (gold ring and border), none at rest', focusedLook !== restingLook && /250, 224, 48/.test(focusedLook));
  for (const key of ['Enter', ' ']) {
    const [chooser] = await Promise.all([p.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null), p.keyboard.press(key === ' ' ? 'Space' : key)]);
    out(`${key === ' ' ? 'Space' : 'Enter'} opens the file dialog`, !!chooser);
    if (chooser && key === 'Enter') { await chooser.setFiles(JPG); await p.waitForTimeout(300); out('choosing an image in that dialog attaches it and shows the preview', await previewShown(p)); await reset(p); }
  }
  // 3. Mouse: a normal (non-forced) click on the dropzone's centre is not "covered" and opens the dialog.
  const [chooser2] = await Promise.all([p.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null), p.click('label[for="sightingPhoto"]', { timeout: 3000 }).catch(e => { console.log('   click error:', e.message.split('\n')[0]); })]);
  out('a mouse click on the dropzone opens the file dialog (actionability checks pass, nothing covers it)', !!chooser2);
  if (chooser2) await chooser2.setFiles([]);
  // 4. Programmatic selection, on the input and on the dropzone.
  await p.setInputFiles('#sightingPhoto', JPG); await p.waitForTimeout(300);
  out('setInputFiles on the input attaches the photo', await previewShown(p)); await reset(p);
  await p.locator('label[for="sightingPhoto"]').setInputFiles(JPG); await p.waitForTimeout(300);
  out('setInputFiles on the dropzone (label) attaches the photo', await previewShown(p)); await reset(p);
  // 5. Drag and drop.
  const bytes = [...fs.readFileSync(JPG)];
  await p.evaluate(b => {
    const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(b)], 'drop.jpg', { type: 'image/jpeg' }));
    const zone = document.querySelector('label[for="sightingPhoto"]');
    zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, bytes);
  await p.waitForTimeout(300);
  out('dropping an image on the dropzone attaches it and shows the preview', await previewShown(p));
  await reset(p);
  await p.evaluate(() => {
    const dt = new DataTransfer(); dt.items.add(new File(['x'], 'notes.txt', { type: 'text/plain' }));
    document.querySelector('label[for="sightingPhoto"]').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await p.waitForTimeout(200);
  out('dropping a non-image shows the usual error and attaches nothing', await p.evaluate(() => !document.getElementById('sightingPhotoError').classList.contains('hidden') && !document.getElementById('sightingPhoto').files.length));

  // 6. End to end: submit with a photo; it lands in the moderation Images queue.
  await p.selectOption('#sightingServiceArea', 'Austin');
  await p.setInputFiles('#sightingPhoto', JPG); await p.waitForTimeout(200);
  await p.click('#sightingSubmitBtn'); await p.waitForTimeout(1500);
  const success = await p.evaluate(() => !document.getElementById('sightingSuccess').classList.contains('hidden'));
  const queue = app.d1.query(`SELECT s.id, s.status, s.evidence_type FROM submissions s WHERE s.submission_type = 'vehicle_sighting' ORDER BY s.submitted_at DESC LIMIT 1`)[0];
  out('submitting with the photo succeeds', success);
  out(`and the sighting is in the moderation queue as a pending photo (${queue && queue.status}/${queue && queue.evidence_type})`, queue && queue.status === 'pending' && queue.evidence_type === 'photo');
  const mod = await (await fetch(origin + '/api/moderation/vehicle-sightings', { headers: { Authorization: 'Bearer s-mod' } })).json();
  out('the moderator API lists it (Images queue)', (mod.sightings || []).some(s => s.submission_id === queue.id && s.evidence_ref));
  await ctx.close();
}
{
  const { ctx, p } = await openDrawer({ width: 390, height: 844, mobile: true });
  const [chooser] = await Promise.all([p.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null), p.tap('label[for="sightingPhoto"]').catch(e => console.log('   tap error:', e.message.split('\n')[0]))]);
  out('phone: tapping the dropzone opens the picker', !!chooser);
  await ctx.close();
}
await browser.close(); server.close();
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} failed` : 'all passed'}`);
if (failed) process.exit(1);
