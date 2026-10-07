// Interactive Cybercab on Fleet ROI and Fleet ETA (simulation.html
// [data-cc-doors], public/js/cybercab-doors.js): the frames on disk, the
// markup on both views, and the behavior (lazy loading, toggling by click,
// button and keyboard, labels and ARIA, reduced motion). jsdom cannot paint a
// canvas, so the canvas and image loading are stubbed; the animation's look
// and frame rate are checked in a real browser, not here.
// Run: node tests/cybercab-doors.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeCheck } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const HTML = read('public/simulation.html');
const JS = read('public/js/cybercab-doors.js');

function openPage({ reduced = false } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/simulation', pretendToBeVisual: true });
  const w = dom.window;
  const loaded = [];
  const draws = [];
  w.matchMedia = q => ({ matches: reduced && /reduce/.test(q), addEventListener() {}, removeEventListener() {} });
  w.HTMLCanvasElement.prototype.getContext = function () {
    return { globalAlpha: 1, drawImage(img) { if (this.globalAlpha === 1) draws.push(img.src.split('/').pop()); } };
  };
  // Images "load" at once, with a natural size, and record what was fetched.
  w.Image = class {
    constructor() { this.naturalWidth = 800; this.naturalHeight = 438; }
    set src(v) { this._src = v; loaded.push(v); setTimeout(() => this.onload && this.onload(), 0); }
    get src() { return this._src; }
  };
  w.eval(JS);
  const d = w.document;
  const roots = [...d.querySelectorAll('[data-cc-doors]')];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  return { w, d, roots, loaded, draws, wait };
}
const state = root => ({
  label: root.querySelector('[data-cc-label]').textContent,
  stage: root.querySelector('[data-cc-stage]').getAttribute('aria-expanded'),
  button: root.querySelector('[data-cc-button]').getAttribute('aria-expanded'),
  aria: root.querySelector('[data-cc-button]').getAttribute('aria-label')
});

async function run() {
  console.log('1. Frames on disk');
  {
    for (const set of ['d', 'm']) {
      const files = fs.readdirSync(`${ROOT}public/images/cybercab-doors/${set}`).filter(f => f.endsWith('.webp')).sort();
      check(`${set}: 108 WebP frames, 000-107`, files.length === 108 && files[0] === '000.webp' && files[107] === '107.webp');
      const bytes = files.reduce((n, f) => n + fs.statSync(`${ROOT}public/images/cybercab-doors/${set}/${f}`).size, 0);
      check(`${set}: under the weight budget (${Math.round(bytes / 1024)} KB)`, bytes < (set === 'd' ? 1900 : 1000) * 1024);
    }
  }

  console.log('2. Both views use the component in place of the car image');
  {
    check('no static car image left in the two headers', !/<img src="images\/Cybercab2\.png"[^>]*class="sim-hero-car"/.test(HTML));
    check('Fleet ROI and Fleet ETA each have one', /id="simPanelRoi"[\s\S]*data-cc-doors[\s\S]*id="simPanelEta"[\s\S]*data-cc-doors/.test(HTML) && (HTML.match(/data-cc-doors>/g) || []).length === 2);
    check('the page loads js/cybercab-doors.js', /<script src="js\/cybercab-doors\.js[^"]*"><\/script>/.test(HTML));
    check('the first frame is a plain <img> with its size, so the box is reserved before any script runs', /<img src="images\/cybercab-doors\/m\/000\.webp"[^>]*width="800" height="438"/.test(HTML) && /\.cc-doors-stage\{[^}]*aspect-ratio:800\/438/.test(HTML));
    check('once the canvas is live the still image is hidden (under lighten blending both would show, ghosting the closed doors)', /\.cc-doors\.is-live \.cc-doors-stage img\{visibility:hidden;\}/.test(HTML));
    check('only frame 00 is referenced by the page itself (the rest load on intent)', !/cybercab-doors\/[dm]\/(00[1-9]|0[1-9]\d|10[0-7])\.webp/.test(HTML));
  }

  console.log('3. Behavior');
  {
    const p = openPage();
    const [roi, eta] = p.roots;
    check('starts closed: "Open doors", aria-expanded false on the car and the button', JSON.stringify(state(roi)) === JSON.stringify({ label: 'Open doors', stage: 'false', button: 'false', aria: "Open the Cybercab's doors" }));
    check('the car is keyboard-focusable and announced as a button', roi.querySelector('[data-cc-stage]').getAttribute('role') === 'button' && roi.querySelector('[data-cc-stage]').getAttribute('tabindex') === '0');
    check('no frames are fetched until someone shows intent', p.loaded.length === 0);
    roi.dispatchEvent(new p.w.Event('pointerenter'));
    await p.wait(10);
    check('hover intent preloads all 108 frames of one size', p.loaded.length === 108 && p.loaded.every(u => /cybercab-doors\/[dm]\/\d{3}\.webp$/.test(u)));
    roi.querySelector('[data-cc-stage]').click();
    check('clicking the car opens: "Close doors", aria-expanded true on both', JSON.stringify(state(roi)) === JSON.stringify({ label: 'Close doors', stage: 'true', button: 'true', aria: "Close the Cybercab's doors" }));
    await p.wait(1800);
    check('the animation runs and ends on the last frame (doors fully open)', p.draws.length > 10 && p.draws.at(-1) === '107.webp' && roi.classList.contains('is-live'));
    roi.querySelector('[data-cc-button]').click();
    await p.wait(1800);
    check('the button closes it again, ending on the first frame', state(roi).label === 'Open doors' && p.draws.at(-1) === '000.webp');
    const stage = roi.querySelector('[data-cc-stage]');
    stage.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    check('Enter on the car toggles it', state(roi).label === 'Close doors');
    stage.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    check('Space on the car toggles it', state(roi).label === 'Open doors');
    check('the Fleet ETA car is independent (still closed)', state(eta).label === 'Open doors');
    p.w.close();
  }

  console.log('4. Reduced motion: straight to the end frame, no animation');
  {
    const p = openPage({ reduced: true });
    const [roi] = p.roots;
    roi.querySelector('[data-cc-stage]').click();
    await p.wait(60);
    check('one paint, of the last frame', p.draws.length === 1 && p.draws[0] === '107.webp' && state(roi).label === 'Close doors');
    roi.querySelector('[data-cc-stage]').click();
    await p.wait(60);
    check('closing paints the first frame once', p.draws.length === 2 && p.draws[1] === '000.webp');
    p.w.close();
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
