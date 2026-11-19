(() => {
  const { DEFAULT_CITY, SERVICE_AREAS } = window.CCH_CITIES;
  const key = 'cch.preferredCity';
  const valid = city => city === 'all' || SERVICE_AREAS.some(area => area.key === city);
  const stored = name => { try { return localStorage.getItem(name); } catch { return null; } };
  const url = new URL(location.href);
  const explicit = url.searchParams.get('city');
  let city = valid(explicit) ? explicit : stored(key);
  if (!valid(city)) city = DEFAULT_CITY;
  const pathFor = next => {
    const target = new URL(location.href);
    target.searchParams.set('city', next);
    return target;
  };
  if (!explicit && city !== DEFAULT_CITY) history.replaceState(history.state, '', pathFor(city));

  function mount() {
    const path = url.pathname.replace(/\.html$/, '');
    const singleCityPage = ['/', '/index', '/infrastructure', '/replay', '/simulation'].includes(path);
    const supported = city === DEFAULT_CITY || city === 'dallas';
    if (singleCityPage && !supported) {
      const area = SERVICE_AREAS.find(record => record.key === city);
      const main = document.querySelector('main');
      if (main) {
        const message = document.createElement('section');
        message.className = 'mx-auto max-w-7xl px-6 py-12';
        const heading = document.createElement('h1');
        heading.className = 'font-display text-3xl font-bold';
        heading.textContent = area?.name || 'All cities';
        const links = document.createElement('p');
        links.className = 'mt-4 text-sm';
        links.textContent = area ? 'This city has no map or fleet model yet. ' : 'View the combined registry or sightings, or choose a city for maps and fleet models. ';
        for (const [name, href] of [['Cars', '/vehicles'], ['Sightings', '/sightings']]) {
          const link = document.createElement('a');
          link.className = 'ml-3 text-gold underline';
          link.textContent = name;
          link.href = href + '?city=' + encodeURIComponent(city);
          links.append(link);
        }
        message.append(heading, links);
        main.hidden = true;
        main.before(message);
      }
    }

    // No control in the site header (owner, 2026-11-19): the city is chosen with
    // each page's own city buttons ([data-city]: /vehicles, /sightings, the
    // homepage, Zones, Replay, Simulation). Choosing one there is remembered:
    // this browser (cch.preferredCity) for everyone, and the account
    // (PATCH /api/me/city) when signed in, so the next page opens on it.
    const session = stored('teslaSessionId');
    const headers = session ? { Authorization: 'Bearer ' + session } : null;
    let changed = false;
    if (headers && !explicit && sessionStorage.getItem('cch.cityLoaded') !== session) {
      fetch('/api/me/city', { headers }).then(async response => {
        if (!response.ok) return;
        const saved = (await response.json()).city;
        sessionStorage.setItem('cch.cityLoaded', session);
        if (!changed && valid(saved) && saved !== city) {
          localStorage.setItem(key, saved);
          location.replace(pathFor(saved));
        }
      }).catch(() => {});
    }
    document.addEventListener('click', event => {
      const choice = event.target.closest('button[data-city], a[data-city]');
      const next = choice && choice.dataset.city;
      if (!valid(next)) return;   // only real city choices (not e.g. the US map's city index)
      changed = true;
      try { localStorage.setItem(key, next); } catch {}
      if (headers) {
        // keepalive: Replay's city buttons are links, so the page may navigate at once.
        fetch('/api/me/city', { method: 'PATCH', keepalive: true,
          headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ city: next }) })
          .then(response => { if (response.ok) sessionStorage.setItem('cch.cityLoaded', session); }).catch(() => {});
      }
    }, true);
  }
  document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
