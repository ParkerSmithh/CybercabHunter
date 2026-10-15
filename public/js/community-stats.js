/* Community page: the at-a-glance band and the hero intro.
   - CommunityStats.set(id, n): a tile's number, counted up as it comes into
     view (CCC.countUp; instant with reduced motion); null keeps the em dash.
   - Sightings, photos, cities and the streak tiles come from GET
     /api/community/summary (worker/community-summary.js, precomputed once a
     day — one row read), with a 14-day sparkline where there's a daily series.
   - The intro under COMMUNITY follows the selected section.
   Loaded before js/community.js, js/social.js and js/streaks.js, which fill
   their own tiles through set(). Never a made-up number. */
window.CommunityStats = (function () {
  const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sub = id => document.querySelector(`[data-sub="${id}"]`);
  function set(id, value, { decimals = 0, note } = {}) {
    const el = document.getElementById(id);
    if (!el) return;
    if (value == null || !Number.isFinite(value)) {
      if (typeof CCC !== 'undefined' && CCC.countUp) CCC.countUp(el, null);
      el.textContent = '—';
    } else if (typeof CCC !== 'undefined' && CCC.countUp) {
      CCC.countUp(el, value, { format: v => fmt(decimals ? v : Math.round(v), decimals) });
    } else el.textContent = fmt(value, decimals);
    if (note != null && sub(id)) sub(id).textContent = note;
  }

  // A tiny 14-day area line under a tile (decorative; the number says it).
  function spark(id, series) {
    const box = document.querySelector(`[data-spark="${id}"]`);
    if (!box || !Array.isArray(series) || series.length < 2) return;
    const w = 120, h = 26, max = Math.max(1, ...series.map(p => p.n));
    const x = i => (i / (series.length - 1)) * w, y = n => h - 2 - (n / max) * (h - 6);
    const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.n).toFixed(1)}`).join(' ');
    const last = series[series.length - 1];
    box.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Verified sightings per day, the last ${series.length} days">
      <defs><linearGradient id="spk-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(var(--gold))" stop-opacity=".35"/><stop offset="1" stop-color="rgb(var(--gold))" stop-opacity="0"/></linearGradient></defs>
      <path d="${line} L${w} ${h} L0 ${h} Z" fill="url(#spk-${id})"/>
      <path d="${line}" fill="none" stroke="rgb(var(--gold))" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      <circle cx="${x(series.length - 1).toFixed(1)}" cy="${y(last.n).toFixed(1)}" r="2.2" fill="rgb(var(--gold))"/>
    </svg>`;
  }

  let summary = null;
  async function loadSummary() {
    try {
      const r = await fetch('/api/community/summary');
      summary = r.ok ? await r.json() : null;
    } catch (e) { summary = null; }
    const s = summary && summary.sightings, st = summary && summary.streaks;
    set('statSightings', s ? s.verified : null);
    set('statPhotos', s ? s.photos_submitted : null);
    set('statCities', s ? s.cities : null, { note: s ? `With a verified sighting` : undefined });
    if (s) spark('statSightings', s.last_14_days);
    set('statStreakWeekly', st ? st.active_weekly : null, { note: st ? `${st.active_weekly === 1 ? 'Spotter' : 'Spotters'} on a weekly run` : undefined });
    set('statStreakDaily', st ? st.active_daily : null, { note: st ? `${st.active_daily === 1 ? 'Spotter' : 'Spotters'} on a daily run` : undefined });
    set('statStreakRecord', st ? st.record_daily : null, { note: st ? `${st.record_daily === 1 ? 'Day' : 'Days'} in a row, all-time` : undefined });
    set('statStreakWeek', st ? st.verified_this_week : null);
    if (s) spark('statStreakWeek', s.last_14_days.slice(-7));
    // Progress tab: XP totals (precomputed with the rest, once a day).
    const x = summary && summary.xp;
    set('statXpTotal', x ? x.total : null);
    set('statXpSpotters', x ? x.spotters : null);
    set('statXpMissions', x ? x.missions_this_week : null);
    const top = document.getElementById('statXpTopRank');
    if (top) {
      top.textContent = x && x.spotters ? x.top_rank.replace(' Spotter', '') : '—';
      top.className = `stat-value ${x && x.spotters ? 'spotter-rank rank-' + x.top_rank.split(' ')[0].toLowerCase() : ''}`;
    }
    document.dispatchEvent(new CustomEvent('cch:community-summary', { detail: summary }));
  }

  // The hero intro, per section.
  const INTRO = {
    social: 'Posts, photos, questions and ride reviews from the people tracking Tesla\'s Cybercab.',
    streaks: 'Spot Cybercabs on consecutive days or weeks. Every verified sighting keeps your streak alive.',
    leaderboard: 'The spotters and riders who found each Cybercab first, and who have ridden the most.',
    progress: 'Earn XP for verified contributions, level up and climb from Bronze to Diamond Spotter.'
  };
  document.addEventListener('cch:community-view', e => {
    const el = document.getElementById('communityIntro');
    const v = e.detail && e.detail.view;
    if (el && INTRO[v] && el.textContent !== INTRO[v]) {
      el.classList.remove('is-swapping'); void el.offsetWidth; el.classList.add('is-swapping');
      el.textContent = INTRO[v];
    }
  });

  if (document.getElementById('communityStats')) loadSummary();
  return { set, spark, get summary() { return summary; } };
})();
