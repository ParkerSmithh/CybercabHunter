/* Community page, Streaks section (#streaks; worker/streaks.js):
     - signed in: the rider's daily and weekly streaks (GET /api/streaks/me,
       with their session), an activity calendar, milestones
     - signed out: what streaks are, and a sign-in prompt
     - everyone: "How Spotting Streaks Work" and the public streak rankings
       (GET /api/streaks/leaderboard?board=daily|weekly|longest)
   Every number comes from the server, which counts only moderator-approved
   sightings, each on the Austin day it was submitted. Nothing is stored in the
   browser. Loads the first time the Streaks tab is shown. */
(function () {
  const root = document.getElementById('streaks');
  if (!root) return;
  const SESSION_KEY = 'teslaSessionId';
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const session = () => { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const DAY = 864e5;
  const dateOf = key => new Date(`${key}T12:00:00Z`);
  const fmtDate = (key, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => dateOf(key).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
  const ICON = {
    flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 10.941c2.333 -3.308 .167 -7.823 -1 -8.941c0 3.395 -2.235 5.299 -3.667 6.706c-1.43 1.408 -2.333 3.621 -2.333 5.588c0 3.704 3.134 6.706 7 6.706s7 -3.002 7 -6.706c0 -1.712 -1.232 -4.403 -2.333 -5.588c-2.084 3.353 -3.257 3.353 -4.667 2.235"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12z"/><path d="M16 3v4"/><path d="M8 3v4"/><path d="M4 11h16"/><path d="M8 15h2v2h-2z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5l10 -10"/></svg>',
    crown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6l4 6l5 -4l-2 10h-14l-2 -10l5 4z"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z"/><path d="M8 11v-4a4 4 0 1 1 8 0v4"/></svg>'
  };
  let me = null, meState = 'idle', board = 'weekly', boardData = {}, loaded = false, selectedDay = null;

  // ---- the rider's own streaks ----
  async function loadMe() {
    const s = session();
    if (!s) { meState = 'signed-out'; render(); return; }
    meState = 'loading'; render();
    try {
      const r = await fetch('/api/streaks/me', { headers: { Authorization: 'Bearer ' + s } });
      if (r.status === 401) { meState = 'signed-out'; }
      else if (r.ok) { me = await r.json(); meState = 'ready'; }
      else meState = 'error';
    } catch (e) { meState = 'error'; }
    render();
  }
  async function loadBoard(id) {
    board = id;
    if (!boardData[id]) {
      boardData[id] = { state: 'loading' };
      renderBoard();
      try {
        const r = await fetch(`/api/streaks/leaderboard?board=${encodeURIComponent(id)}`);
        boardData[id] = r.ok ? { state: 'ready', ...(await r.json()) } : { state: 'error' };
      } catch (e) { boardData[id] = { state: 'error' }; }
    }
    renderBoard();
  }

  const DAILY_TIERS = [3, 7, 14, 30, 60, 100], WEEKLY_TIERS = [2, 4, 8, 12, 26, 52];
  // The next tier above the current streak, how far, and when at this pace
  // (only while a streak is alive; a streak that already counts today / this
  // week needs (n - current) more, otherwise (n - current - 1) after this one).
  function nextTier(kind, d, m) {
    const tiers = kind === 'weekly' ? WEEKLY_TIERS : DAILY_TIERS;
    const n = tiers.find(t => t > d.current);
    if (!n) return null;
    const done = kind === 'weekly' ? d.week_done : d.today_done;
    const left = n - d.current;
    const ahead = done ? left : left - 1;
    let when = null;
    if (d.current > 0) {
      const base = dateOf(kind === 'weekly' ? m.week_start : m.today).getTime();
      when = new Date(base + ahead * (kind === 'weekly' ? 7 : 1) * DAY).toISOString().slice(0, 10);
    }
    return { n, left, when };
  }
  function ring(pct, glow) {
    const r = 26, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(1, pct)));
    return `<svg class="streak-ring ${glow ? 'is-glow' : ''}" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="${r}" class="streak-ring-track"/>
      <circle cx="32" cy="32" r="${r}" class="streak-ring-fill" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
    </svg>`;
  }
  function statCard(kind, d, m) {
    const weekly = kind === 'weekly';
    const unit = weekly ? ['Week', 'Weeks'] : ['Day', 'Days'];
    const done = weekly ? d.week_done : d.today_done;
    const next = nextTier(kind, d, m);
    const tiers = weekly ? WEEKLY_TIERS : DAILY_TIERS;
    const prev = [...tiers].reverse().find(t => t <= d.current) || 0;
    const pct = next ? (d.current - prev) / (next.n - prev) : 1;
    const justHit = d.current > 0 && tiers.includes(d.current);
    const status = done
      ? `<span class="streak-status is-done">${ICON.check}${weekly ? 'This week counts' : 'Today counts'}</span>`
      : `<span class="streak-status">${d.current ? (weekly ? 'Keep it alive: a verified sighting by Sunday' : 'Keep it alive: a verified sighting today') : (weekly ? 'No verified sighting yet this week' : 'No verified sighting yet today')}</span>`;
    const countdown = next
      ? `<span class="streak-next"><b>${plural(next.left, unit[0].toLowerCase(), unit[1].toLowerCase())}</b> to your ${next.n}-${unit[0].toLowerCase()} streak${next.when ? ` · ${esc(fmtDate(next.when, { month: 'short', day: 'numeric' }))} at this pace` : ''}</span>`
      : `<span class="streak-next"><b>Every milestone unlocked.</b></span>`;
    return `<div class="streak-card ${weekly ? 'is-weekly' : ''}">
      <div class="streak-card-head"><span class="streak-icon">${weekly ? ICON.calendar : ICON.flame}</span><span>${weekly ? 'Weekly streak' : 'Daily streak'}</span>${weekly ? '<span class="streak-tag">Easiest to keep</span>' : ''}</div>
      <div class="streak-card-body">
        <div class="streak-ring-wrap" title="${next ? `${Math.round(pct * 100)}% of the way to ${next.n}` : 'Every milestone unlocked'}">${ring(pct, justHit)}<span class="streak-ring-num">${weekly ? ICON.calendar : ICON.flame}</span></div>
        <div class="min-w-0">
          <div class="streak-value"><span class="stat-value">${d.current}</span> ${d.current === 1 ? unit[0] : unit[1]}</div>
          <div class="streak-longest">Longest: ${plural(d.longest, unit[0], unit[1])}</div>
          ${countdown}
        </div>
      </div>
      ${status}
    </div>`;
  }

  // GitHub-style: a column per week (Monday on top), as many weeks as fit.
  function calendar(m) {
    const counts = new Map(m.calendar.days.map(d => [d.date, d.count]));
    const today = m.today, todayMs = dateOf(today).getTime();
    // Only the weeks the site has existed (from the first sighting anyone
    // submitted), at least 8, at most what fits and a year: never a wall of
    // empty weeks. Cells grow to fill the width when there are few weeks.
    const width = Math.max(240, (root.clientWidth || 640) - 48);
    const thisMonday = dateOf(m.week_start).getTime();
    const summary = window.CommunityStats && window.CommunityStats.summary;
    const start = summary && summary.sightings && summary.sightings.site_start ? dateOf(summary.sightings.site_start).getTime() : null;
    const lived = start ? Math.floor((thisMonday - (start - (((new Date(start).getUTCDay() + 6) % 7) * DAY))) / (7 * DAY)) + 1 : 53;
    const gap = 4;
    const fit = Math.floor((width - 28) / (11 + gap));
    const weeks = Math.max(4, Math.min(53, fit, lived));
    const cell = Math.max(11, Math.min(26, Math.floor((width - 28) / weeks) - gap));
    const firstMonday = thisMonday - (weeks - 1) * 7 * DAY;
    let cols = '', months = '', lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
      const monday = firstMonday + w * 7 * DAY;
      const mm = new Date(monday).getUTCMonth();
      months += `<span style="width:${cell + gap}px">${mm !== lastMonth && w < weeks - 1 ? new Date(monday).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) : ''}</span>`;
      lastMonth = mm;
      let col = '';
      for (let d = 0; d < 7; d++) {
        const t = monday + d * DAY;
        if (t > todayMs) { col += `<span class="streak-day is-future" style="width:${cell}px;height:${cell}px"></span>`; continue; }
        const key = new Date(t).toISOString().slice(0, 10), n = counts.get(key) || 0;
        const level = n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : 3;
        const label = `${fmtDate(key, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}: ${n ? plural(n, 'verified sighting', 'verified sightings') : 'no verified sightings'}`;
        col += `<button type="button" class="streak-day l${level}${key === today ? ' is-today' : ''}${key === selectedDay ? ' is-selected' : ''}" style="width:${cell}px;height:${cell}px" data-day="${key}" data-count="${n}" aria-label="${esc(label)}" title="${esc(label)}"></button>`;
      }
      cols += `<div class="streak-week" style="gap:${gap}px">${col}</div>`;
    }
    const dayLabels = ['Mon', '', 'Wed', '', 'Fri', '', ''].map(l => `<span style="height:${cell}px">${l}</span>`).join('');
    const sel = selectedDay ? (() => { const n = counts.get(selectedDay) || 0; return `<strong>${esc(fmtDate(selectedDay, { weekday: 'long', month: 'short', day: 'numeric' }))}</strong> · ${n ? plural(n, 'verified sighting', 'verified sightings') : 'no verified sightings'}`; })() : 'Tap or hover a day to see its verified sightings.';
    return `<div class="streak-calendar">
      <div class="streak-cal-head"><h3>Activity</h3><span>${plural(m.verified.sightings, 'verified sighting', 'verified sightings')} on ${plural(m.verified.days, 'day', 'days')}${start && lived <= 53 ? ` · since ${esc(fmtDate(summary.sightings.site_start, { month: 'short', day: 'numeric' }))}, when spotting began` : ''}</span></div>
      <div class="streak-cal-scroll"><div class="streak-cal-grid">
        <div class="streak-months" aria-hidden="true" style="padding-left:28px">${months}</div>
        <div class="streak-cal-body"><div class="streak-daylabels" style="gap:${gap}px" aria-hidden="true">${dayLabels}</div>
        <div class="streak-weeks" style="gap:${gap}px" role="group" aria-label="Verified sightings per day, the last ${weeks} weeks">${cols}</div></div>
      </div></div>
      <div class="streak-cal-foot"><p data-streak-day aria-live="polite">${sel}</p>
        <span class="streak-legend" aria-hidden="true">Less<i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i>More</span></div>
    </div>`;
  }

  function milestones(m) {
    // A locked tier's date if the current streak keeps going (none without one).
    const projected = (type, n) => {
      const d = type === 'daily' ? m.daily : m.weekly;
      if (!d.current) return '';
      const done = type === 'daily' ? d.today_done : d.week_done;
      const ahead = (n - d.current) - (done ? 0 : 1);
      const base = dateOf(type === 'daily' ? m.today : m.week_start).getTime();
      const when = new Date(base + Math.max(0, ahead) * (type === 'daily' ? 1 : 7) * DAY).toISOString().slice(0, 10);
      return `At this pace: ${type === 'weekly' ? 'week of ' : ''}${esc(fmtDate(when, { month: 'short', day: 'numeric' }))}`;
    };
    const group = (type, title) => {
      const list = m.milestones.filter(x => x.type === type);
      const best = type === 'daily' ? m.daily.longest : m.weekly.longest;
      return `<div class="streak-ms-group"><h4>${title}</h4><ul class="streak-ms-grid">${list.map(x => {
        const unit = type === 'daily' ? 'Day' : 'Week';
        return `<li class="streak-ms ${x.unlocked ? 'is-unlocked' : ''}">
          <span class="streak-ms-icon">${x.unlocked ? ICON.flame : ICON.lock}</span>
          <span class="streak-ms-name">${x.n}-${unit} Streak</span>
          <span class="streak-ms-sub">${x.unlocked ? `Unlocked ${esc(fmtDate(x.unlocked_on, { month: 'short', day: 'numeric', year: 'numeric' }))}` : projected(type, x.n) || `Best so far: ${best} / ${x.n}`}</span>
          ${x.unlocked ? '' : `<span class="streak-ms-bar" aria-hidden="true"><i style="width:${Math.min(100, Math.round(((type === 'daily' ? m.daily.current : m.weekly.current) / x.n) * 100))}%"></i></span>`}
        </li>`;
      }).join('')}</ul></div>`;
    };
    const count = m.milestones.filter(x => x.unlocked).length;
    return `<div class="streak-milestones"><div class="streak-cal-head"><h3>Milestones</h3><span>${count} of ${m.milestones.length} unlocked</span></div>
      ${group('weekly', 'Weekly')}${group('daily', 'Daily')}</div>`;
  }

  const HOW = `<details class="streak-how">
      <summary>How Spotting Streaks Work</summary>
      <ol>
        <li><span>Submit a Cybercab sighting</span> from the Submit button: a photo or the plate of a Cybercab you saw.</li>
        <li><span>Wait for a moderator to verify it.</span> Only approved sightings count; pending and rejected ones don't.</li>
        <li><span>It counts on the day you submitted it</span> (Austin time), even if it's approved days later.</li>
        <li><span>Keep it going:</span> one verified sighting a day builds your daily streak; one a week (Monday to Sunday) builds your weekly streak. More sightings on the same day or week don't add extra.</li>
        <li><span>Today isn't over yet:</span> your streak stays alive until the day (or week) ends.</li>
        <li><span>Unlock milestones</span> as your streaks grow. They stay unlocked even if a streak ends.</li>
      </ol>
      <p class="streak-safety">Spot safely: never chase or follow a Cybercab, never take photos while driving, and stay on public property. Weekly streaks are made for casual spotters.</p>
    </details>`;

  function mine() {
    if (meState === 'signed-out') {
      return `<div class="streak-signin">
        <div><h3>Sign in to track your Cybercab spotting streaks.</h3>
        <p>Every verified sighting you submit counts toward a daily and a weekly streak, with milestones to unlock along the way.</p></div>
        <a href="signin.html?returnTo=${encodeURIComponent('/community?view=streaks')}" class="streak-signin-btn">Sign in</a>
      </div>`;
    }
    if (meState === 'loading' || meState === 'idle') return `<div class="streak-cards"><div class="streak-card is-skeleton skeleton-block"></div><div class="streak-card is-skeleton skeleton-block"></div></div>`;
    if (meState === 'error') return `<div class="streak-error">Couldn't load your streaks. Please try again in a moment.</div>`;
    const m = me;
    const fresh = !m.verified.sightings ? `<p class="streak-empty">No verified sightings yet. Submit a Cybercab sighting; once a moderator approves it, your streaks start on the day you submitted it.</p>` : '';
    return `<div class="streak-cards">${statCard('weekly', m.weekly, m)}${statCard('daily', m.daily, m)}</div>${fresh}${calendar(m)}${milestones(m)}`;
  }

  function render() {
    root.innerHTML = `
      <div class="flex items-start gap-3 max-sm:gap-2.5">
        <span class="w-10 h-10 max-sm:w-8 max-sm:h-8 shrink-0 rounded-xl flex items-center justify-center text-gold" aria-hidden="true">${ICON.flame}</span>
        <div class="min-w-0 flex-1">
          <h2 class="community-panel-title font-display font-bold">SPOTTING STREAKS</h2>
          <p class="text-xs text-slate-500 mt-1 leading-relaxed max-sm:text-[11px]">Verified Cybercab sightings on consecutive days or weeks. Counted in Austin time (CT); weeks run Monday to Sunday.</p>
        </div>
      </div>
      <div class="streak-mine">${mine()}</div>
      ${HOW}
      <div class="streak-board" data-streak-board></div>`;
    renderBoard();
  }

  function renderBoard() {
    const el = root.querySelector('[data-streak-board]');
    if (!el) return;
    const d = boardData[board] || { state: 'loading' };
    const tabs = [['weekly', 'Top Weekly'], ['daily', 'Top Daily'], ['longest', 'Longest All-Time']];
    let body;
    if (d.state === 'loading') body = `<div class="space-y-2"><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
    else if (d.state === 'error') body = `<p class="streak-error">Couldn't load the streak rankings. Please try again in a moment.</p>`;
    else if (!d.entries.length) body = `<p class="streak-empty">No ${board === 'longest' ? '' : 'active '}streaks yet. Get a sighting verified to start one.</p>`;
    else body = `<ol class="streak-rank-list">${d.entries.map(e => {
      const lead = board === 'weekly' ? [e.weekly_current, e.weekly_current === 1 ? 'week' : 'weeks'] : board === 'daily' ? [e.daily_current, e.daily_current === 1 ? 'day' : 'days'] : [e.longest_daily, e.longest_daily === 1 ? 'day best' : 'days best'];
      const medal = ['gold', 'silver', 'bronze'][e.rank - 1];
      const inner = `<span class="streak-rank lb-rank ${medal ? `is-${medal}` : ''}"><span class="sr-only">Rank </span>${e.rank}${e.tied ? '<span class="sr-only">, tied</span>' : ''}</span>
        <span class="streak-avatar"><span class="block w-full h-full" data-avatar-url="${esc(e.avatar_url || '')}" data-avatar-name="${esc(e.name)}"></span></span>
        <span class="streak-who"><span class="streak-name">${esc(e.name)}</span>
          <span class="streak-sub">${plural(e.daily_current, 'day', 'days')} · ${plural(e.weekly_current, 'week', 'weeks')} now · best ${plural(e.longest_daily, 'day', 'days')} / ${plural(e.longest_weekly, 'week', 'weeks')}</span></span>
        <span class="streak-score"><span class="stat-value">${lead[0]}</span><span>${lead[1]}</span></span>`;
      return `<li>${e.profile && e.handle ? `<a class="streak-row" href="/rider/${encodeURIComponent(e.handle)}">${inner}</a>` : `<div class="streak-row">${inner}</div>`}</li>`;
    }).join('')}</ol>`;
    // The leader, as a challenge (a public, ranked row only).
    const lead = d.state === 'ready' && d.entries[0];
    const leadText = lead ? (board === 'weekly' ? plural(lead.weekly_current, 'week', 'weeks') : board === 'daily' ? plural(lead.daily_current, 'day', 'days') : plural(lead.longest_daily, 'day', 'days')) : '';
    const crown = lead ? `<div class="streak-crown"><span class="streak-crown-icon" aria-hidden="true">${ICON.crown}</span><p><b>${esc(lead.name)}</b> holds the crown${board === 'longest' ? ' for the longest streak' : ''}: <b>${leadText}</b>. Beat it.</p></div>` : '';
    const count = d.state === 'ready' ? (d.entries.length >= 10 ? 'Top 10' : `${d.entries.length} ranked`) : '';
    const asOf = d.state === 'ready' && d.computed_at ? `Updated ${new Date(d.computed_at).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} CT · daily` : '';
    el.innerHTML = `<div class="streak-cal-head"><h3>Community streaks</h3><span>${count}</span></div>${crown}
      <div class="streak-board-tabs" role="group" aria-label="Streak rankings">${tabs.map(([id, label]) => `<button type="button" data-streak-tab="${id}" aria-pressed="${id === board}">${label}</button>`).join('')}</div>
      ${body}
      ${asOf ? `<p class="streak-asof">${asOf}</p>` : ''}
      <p class="streak-privacy">Only spotters with <span>Community leaderboard &amp; public profile</span> turned on (on their <a href="profile.html">Profile</a>) are listed.</p>`;
    if (typeof CCC !== 'undefined' && CCC.renderAvatar) el.querySelectorAll('[data-avatar-name]').forEach(a => CCC.renderAvatar(a, { url: a.dataset.avatarUrl || null, name: a.dataset.avatarName, size: 96 }));
  }

  root.addEventListener('click', e => {
    const t = e.target.closest('[data-streak-tab]');
    if (t) { loadBoard(t.dataset.streakTab); return; }
    const day = e.target.closest('[data-day]');
    if (day) { selectedDay = day.dataset.day; root.querySelectorAll('.streak-day.is-selected').forEach(x => x.classList.remove('is-selected')); day.classList.add('is-selected'); showDay(day); }
  });
  root.addEventListener('mouseover', e => { const day = e.target.closest('[data-day]'); if (day) showDay(day); });
  root.addEventListener('focusin', e => { const day = e.target.closest('[data-day]'); if (day) showDay(day); });
  function showDay(day) {
    const out = root.querySelector('[data-streak-day]');
    const n = Number(day.dataset.count);
    if (out) out.innerHTML = `<strong>${esc(fmtDate(day.dataset.day, { weekday: 'long', month: 'short', day: 'numeric' }))}</strong> · ${n ? plural(n, 'verified sighting', 'verified sightings') : 'no verified sightings'}`;
  }

  // The calendar fits the width it has.
  let lastW = 0;
  if (window.ResizeObserver) new ResizeObserver(() => { if (meState === 'ready' && Math.abs(root.clientWidth - lastW) > 20) { lastW = root.clientWidth; render(); } }).observe(root);

  function start() {
    if (loaded) return;
    loaded = true;
    render();
    loadMe();
    loadBoard(board);
  }
  document.addEventListener('cch:community-summary', () => { if (meState === 'ready') render(); });
  document.addEventListener('cch:community-view', e => { if (e.detail && e.detail.view === 'streaks') start(); });
  if (!document.getElementById('communityPanelStreaks')?.classList.contains('hidden')) start();
  // Signing in or out in another tab: refresh the rider's own numbers.
  window.addEventListener('storage', e => { if (e.key === SESSION_KEY && loaded) { me = null; loadMe(); } });
})();
