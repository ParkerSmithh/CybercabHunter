/* Community page, Progress section (#progress; worker/progression.js).
     - signed in: level, rank title, total XP and progress (GET /api/xp/me with
       the rider's session), daily and weekly missions, the rank ladder and
       recent XP activity
     - signed out: how XP, levels and ranks work (GET /api/xp/rules), the rank
       ladder, and a sign-in prompt; the public Top XP board is on Leaderboard
   Every number comes from the server; XP is the only reward (rank titles are
   text, never badges). Loads the first time the Progress tab is shown. */
(function () {
  const root = document.getElementById('progress');
  if (!root) return;
  const SESSION_KEY = 'teslaSessionId';
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = v => Number(v).toLocaleString('en-US');
  const session = () => { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } };
  const rankClass = key => `spotter-rank rank-${esc(key)}`;
  const when = iso => new Date(String(iso).replace(' ', 'T') + (/[zZ]$/.test(iso) ? '' : 'Z')).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let me = null, rules = null, state = 'idle', started = false;

  async function load() {
    const s = session();
    state = 'loading'; render();
    try {
      const rulesReq = fetch('/api/xp/rules').then(r => (r.ok ? r.json() : null)).catch(() => null);
      if (s) {
        const r = await fetch('/api/xp/me', { headers: { Authorization: 'Bearer ' + s } });
        if (r.ok) { me = await r.json(); state = 'ready'; }
        else state = r.status === 401 ? 'signed-out' : 'error';
      } else state = 'signed-out';
      rules = await rulesReq;
    } catch (e) { state = 'error'; }
    render();
  }

  const bar = (pct, label) => `<div class="xp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct * 100)}" aria-label="${esc(label)}"><i style="width:${Math.max(0, Math.min(100, pct * 100)).toFixed(1)}%"></i></div>`;

  function summary(m) {
    const L = m.level, R = m.rank;
    const pct = L.span ? L.into / L.span : 1;
    return `<div class="xp-hero">
      <div class="xp-hero-head">
        <p class="xp-hero-title">LEVEL ${L.n} <span aria-hidden="true">—</span> <span class="${rankClass(R.key)}">${esc(R.name.toUpperCase())}</span></p>
        <p class="xp-total"><span class="stat-value">${n(m.xp)}</span> XP</p>
      </div>
      ${bar(pct, `Level ${L.n} progress`)}
      <div class="xp-hero-meta">
        <span>${L.next != null ? `<b>${n(m.xp)} / ${n(L.next)} XP</b> · ${n(L.next - m.xp)} XP to level ${L.n + 1}` : '<b>Top level reached</b>'}</span>
        <span>${R.next ? `${n(R.next.needed)} XP to <span class="${rankClass(R.next.key)}">${esc(R.next.name)}</span>` : 'Highest rank reached'}</span>
      </div>
    </div>`;
  }

  const STATE = {
    not_started: 'Not started',
    in_progress: 'In progress',
    awaiting_verification: 'Awaiting verification',
    completing: 'Verified · XP on its way',
    completed: 'Completed'
  };
  function missionCard(m, big) {
    const done = m.state === 'completed';
    const pct = m.progress / m.required;
    const status = done
      ? `<span class="mission-status is-done">COMPLETED — +${n(m.reward)} XP EARNED</span>`
      : `<span class="mission-status">${m.state === 'awaiting_verification' ? `${m.pending} awaiting verification` : `${esc(STATE[m.state] || '')}${m.pending ? ` · ${m.pending} awaiting verification` : ''}`}</span>`;
    return `<li class="mission ${big ? 'is-weekly' : ''} ${done ? 'is-done' : ''}">
      <div class="mission-head"><h4>${esc(m.title.toUpperCase())}</h4><span class="mission-reward">+${n(m.reward)} XP</span></div>
      <p class="mission-desc">${esc(m.description)}</p>
      ${bar(pct, `${m.title} progress`)}
      <div class="mission-foot"><span>Progress: <b>${m.progress} / ${m.required}</b></span>${status}</div>
    </li>`;
  }
  function missions(m) {
    return `<section class="xp-block" aria-labelledby="xpDaily"><div class="xp-block-head"><h3 id="xpDaily">Daily missions</h3><span>Resets at midnight (CT)</span></div>
        <ul class="mission-grid">${m.missions.daily.map(x => missionCard(x, false)).join('')}</ul></section>
      <section class="xp-block" aria-labelledby="xpWeekly"><div class="xp-block-head"><h3 id="xpWeekly">Weekly missions</h3><span>Monday to Sunday (CT)</span></div>
        <ul class="mission-grid is-weekly">${m.missions.weekly.map(x => missionCard(x, true)).join('')}</ul></section>`;
  }

  // The five ranks, left to right, the rider's own highlighted (text only).
  function ladder(ranks, current, xp) {
    return `<section class="xp-block" aria-labelledby="xpRanks"><div class="xp-block-head"><h3 id="xpRanks">Spotter ranks</h3><span>By total XP</span></div>
      <ol class="rank-ladder">${ranks.map((r, i) => {
        const here = r.key === current, passed = xp != null && xp >= r.xp;
        return `<li class="rank-step ${here ? 'is-current' : ''} ${passed ? 'is-reached' : ''}">
          <span class="${rankClass(r.key)}">${esc(r.name)}</span><span class="rank-xp">${n(r.xp)} XP</span>${here ? '<span class="rank-you">You</span>' : ''}
        </li>${i < ranks.length - 1 ? '<li class="rank-arrow" aria-hidden="true">→</li>' : ''}`;
      }).join('')}</ol></section>`;
  }

  function activity(m) {
    const rows = m.recent.length
      ? `<ul class="xp-activity">${m.recent.map(r => `<li><span class="xp-activity-reason">${esc(r.reason)}</span><span class="xp-activity-when">${esc(when(r.at))}</span><span class="xp-activity-amt ${r.amount < 0 ? 'is-neg' : ''}">${r.amount < 0 ? '−' : '+'}${n(Math.abs(r.amount))} XP</span></li>`).join('')}</ul>`
      : `<p class="xp-empty">No XP yet. Submit a Cybercab sighting; when a moderator verifies it, you earn your first ${rules && rules.rewards ? n(rules.rewards.find(x => x.id === 'verified_sighting')?.xp || 25) : 25} XP.</p>`;
    return `<section class="xp-block" aria-labelledby="xpRecent"><div class="xp-block-head"><h3 id="xpRecent">Recent XP</h3><span>Latest ${m.recent.length || ''}</span></div>${rows}</section>`;
  }

  function how(r) {
    if (!r) return '';
    return `<details class="streak-how xp-how"><summary>How XP works</summary>
      <ul class="xp-rewards">${r.rewards.map(x => `<li><span>${esc(x.label)}</span><b>+${n(x.xp)} XP</b></li>`).join('')}</ul>
      <ol>
        <li><span>Only verified contributions earn XP.</span> A moderator approves each sighting first; pending and rejected ones earn nothing.</li>
        <li><span>Each one pays once.</span> The same Cybercab filed again the same day doesn't earn twice.</li>
        <li><span>Missions follow the day you submitted</span> (Austin time), so a late approval still counts for its own day or week, and pays when approved.</li>
        <li><span>If a verified contribution is later removed,</span> its XP (and any mission it completed) comes back off.</li>
        <li><span>Levels and ranks follow your total XP</span> and update by themselves. XP is the only reward.</li>
      </ol>
      <p class="streak-safety">Spot safely: never chase or follow a Cybercab, and never take photos while driving.</p>
    </details>`;
  }

  function render() {
    const head = `<div class="flex items-start gap-3 max-sm:gap-2.5">
        <span class="w-10 h-10 max-sm:w-8 max-sm:h-8 shrink-0 rounded-xl flex items-center justify-center text-gold" aria-hidden="true"><svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6 -6l4 4l8 -8"/><path d="M14 7l7 0l0 7"/></svg></span>
        <div class="min-w-0 flex-1"><h2 class="community-panel-title font-display font-bold">SPOTTER PROGRESS</h2>
        <p class="text-xs text-slate-500 mt-1 leading-relaxed max-sm:text-[11px]">XP for verified contributions, levels and spotter ranks. Missions reset daily and every Monday (Austin time).</p></div>
      </div>`;
    let body;
    if (state === 'loading' || state === 'idle') body = `<div class="xp-hero skeleton-block" style="height:150px"></div><div class="mission-grid"><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
    else if (state === 'error') body = `<p class="streak-error">Couldn't load your progress. Please try again in a moment.</p>`;
    else if (state === 'signed-out') {
      body = `<div class="streak-signin"><div><h3>Sign in to track your Spotter XP and missions.</h3>
          <p>Every verified sighting earns XP, missions add more, and your rank climbs from Bronze to Diamond Spotter.</p></div>
          <a href="signin.html?returnTo=${encodeURIComponent('/community?view=progress')}" class="streak-signin-btn">Sign in</a></div>
        ${rules ? ladder(rules.ranks, null, null) : ''}
        ${rules ? `<section class="xp-block" aria-labelledby="xpMissionsOut"><div class="xp-block-head"><h3 id="xpMissionsOut">Missions</h3><span>Optional</span></div>
          <ul class="mission-grid">${rules.missions.map(m => `<li class="mission ${m.period === 'week' ? 'is-weekly' : ''}"><div class="mission-head"><h4>${esc(m.title.toUpperCase())}</h4><span class="mission-reward">+${n(m.reward)} XP</span></div><p class="mission-desc">${esc(m.description)}</p><div class="mission-foot"><span>${m.period === 'week' ? 'Weekly' : 'Daily'}</span></div></li>`).join('')}</ul></section>` : ''}
        <p class="xp-board-link">See who leads in <a href="/community?view=leaderboard" data-to-leaderboard>Top XP on the Leaderboard</a>.</p>
        ${how(rules)}`;
    } else {
      body = `${summary(me)}${missions(me)}${ladder(me.ranks, me.rank.key, me.xp)}${activity(me)}${how(rules)}`;
    }
    root.innerHTML = head + `<div class="xp-body">${body}</div>`;
  }

  // "Top XP on the Leaderboard": switch tabs in place, then pick the board.
  root.addEventListener('click', e => {
    const a = e.target.closest('[data-to-leaderboard]');
    if (!a) return;
    e.preventDefault();
    document.getElementById('communityTabLeaderboard')?.click();
    setTimeout(() => document.querySelector('#boardTabs [data-board="xp"]')?.click(), 60);
  });
  function start() { if (started) return; started = true; load(); }
  document.addEventListener('cch:community-view', e => { if (e.detail && e.detail.view === 'progress') start(); });
  if (!document.getElementById('communityPanelProgress')?.classList.contains('hidden')) start();
  window.addEventListener('storage', e => { if (e.key === SESSION_KEY && started) load(); });
})();
