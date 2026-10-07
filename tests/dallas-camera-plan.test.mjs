import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { execFileSync } from 'node:child_process';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const cameras = JSON.parse(read('public/data/traffic-cameras.json'));
const plan = read('docs/verification/dallas-zone-polish/dallas-camera-plan-50.txt').split('\n')
  .filter(line => line.startsWith('txdot-')).map(line => {
    const [camera_id, name, coords] = line.split('|').map(s => s.trim());
    const [lat, lng] = coords.split(',').map(Number);
    return { camera_id, name, lat, lng, city: 'dallas' };
  });

test('Dallas entries match all 50 final plan IDs, names and coordinates; Austin is unchanged', () => {
  assert.equal(plan.length, 50);
  assert.equal(new Set(plan.map(c => c.camera_id)).size, 50);
  assert.deepEqual(cameras.filter(c => c.city === 'dallas'), plan);
  const before = JSON.parse(execFileSync('git', ['show', 'HEAD:public/data/traffic-cameras.json'], { encoding: 'utf8' }));
  assert.deepEqual(cameras.filter(c => c.city !== 'dallas'), before.filter(c => c.city !== 'dallas'));
  assert.ok(!plan.some(c => /US175/.test(c.name)));
});

// Execute the actual dropdown renderers against DOM selects. Each renderer
// must show every Dallas ID/name, then remove them when switching to Austin.
for (const [file, fn, id] of [
  ['public/js/main.js', 'renderTrafficCameras', 'sightingCamera'],
  ['public/js/moderation.js', 'renderCameraOptions', 'modMapCamera']
]) {
  test(`${file}: city-filtered dropdown matches the final 50`, () => {
    const source = read(file);
    assert.ok(source.includes("fetch('data/traffic-cameras.json')"));
    const start = source.indexOf(`function ${fn}(`);
    const end = source.indexOf('\n    async function loadTrafficCameras', start);
    const modEnd = source.indexOf('\n\n  let mapTarget', start);
    const renderer = source.slice(start, fn === 'renderTrafficCameras' ? end : modEnd);
    const dom = new JSDOM(`<select id="${id}"><option value="">Choose</option></select>`, { runScripts: 'outside-only' });
    const w = dom.window;
    w.cameras = cameras;
    w.eval(`let allCameras = cameras; let chosenCity = 'dallas';
      const cameraField = document.getElementById('${id}');
      const cameraCityKey = () => chosenCity;
      const cameraHelp = null; const CAMERA_HELP = {}; const cameraHelpAustin = '';
      const $ = id => document.getElementById(id);
      ${renderer}
      window.renderCity = city => { chosenCity = city; ${fn}(city); };`);
    for (const city of ['dallas', 'austin', 'dallas']) {
      w.renderCity(city);
      const actual = Array.from(w.document.querySelector('select').options).filter(o => o.value)
        .map(o => [o.value, o.textContent]).sort();
      const expected = cameras.filter(c => c.city === city).map(c => [c.camera_id, `${c.name} (#${c.camera_id})`]).sort();
      assert.deepEqual(actual, expected);
      assert.equal(actual.length, city === 'dallas' ? 50 : 70);
    }
    w.close();
  });
}
