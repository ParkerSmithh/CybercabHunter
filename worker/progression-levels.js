// Spotter levels and ranks from total XP (pure; worker/progression-config.js
// holds the numbers). Shared by worker/progression.js and the leaderboard.
import { LEVEL_ANCHORS, LEVEL_STEP_AFTER, LEVEL_STEP_GROWTH, MAX_LEVEL, RANKS } from './progression-config.js';

let levelTable = null;
export function levelThresholds() {
  if (levelTable) return levelTable;
  const t = [0];   // t[n - 1] = XP where level n starts
  for (let i = 1; i < LEVEL_ANCHORS.length; i++) {
    const [l0, x0] = LEVEL_ANCHORS[i - 1], [l1, x1] = LEVEL_ANCHORS[i];
    for (let l = l0 + 1; l <= l1; l++) t[l - 1] = Math.round(x0 + ((x1 - x0) * (l - l0)) / (l1 - l0));
  }
  let step = LEVEL_STEP_AFTER;
  for (let l = LEVEL_ANCHORS[LEVEL_ANCHORS.length - 1][0] + 1; l <= MAX_LEVEL; l++, step += LEVEL_STEP_GROWTH) t[l - 1] = t[l - 2] + step;
  return (levelTable = t);
}
export function levelFor(xp) {
  const t = levelThresholds(), x = Math.max(0, Math.floor(Number(xp) || 0));
  let n = 1;
  while (n < t.length && x >= t[n]) n++;
  const floor = t[n - 1], next = n < t.length ? t[n] : null;
  return { n, floor, next, into: x - floor, span: next == null ? null : next - floor };
}
export function rankFor(xp) {
  const x = Math.max(0, Number(xp) || 0);
  let i = 0;
  while (i + 1 < RANKS.length && x >= RANKS[i + 1].xp) i++;
  const next = RANKS[i + 1] || null;
  return { key: RANKS[i].key, name: RANKS[i].name, next: next ? { key: next.key, name: next.name, xp: next.xp, needed: next.xp - x } : null };
}

