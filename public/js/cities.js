// Shared city data for classic browser scripts and the Worker bundle.
(function (root) {
  const HOURS = { open: '00:00', close: '24:00', all_day: true };
  const hoursAsOf = '2026-11-11';
  const DEFAULT_CITY = 'austin';
  const SERVICE_AREAS = [
    {
      key: 'austin', slug: 'austin', name: 'Austin', state: 'TX', timeZone: 'America/Chicago',
      center: { lat: 30.27, lon: -97.74 }, mapBounds: { minLon: -97.87, minLat: 30.14, maxLon: -97.55, maxLat: 30.46 },
      status: 'live', cameraSource: 'City of Austin', cybercabSince: '2026-09-03',
      bbox: { minLon: -98.05, minLat: 30.00, maxLon: -97.45, maxLat: 30.60 },
      zone: { square_miles: 440, in_service_since: '2025-06-22', hours: HOURS, hoursAsOf,
        description: 'First Robotaxi market. Launched as an invite pilot, now unsupervised.' }
    },
    {
      key: 'dallas', slug: 'dallas', name: 'Dallas', state: 'TX', timeZone: 'America/Chicago',
      center: { lat: 32.80, lon: -96.80 }, mapBounds: { minLon: -96.93, minLat: 32.73, maxLon: -96.70, maxLat: 32.96 },
      status: 'live', cameraSource: 'TxDOT', cybercabSince: '2026-11-19',
      bbox: { minLon: -97.20, minLat: 32.55, maxLon: -96.45, maxLat: 33.15 },
      zone: { square_miles: 148, in_service_since: '2026-04-18', hours: HOURS, hoursAsOf,
        description: 'Dallas from downtown north past I-635 to the edges of Carrollton, Farmers Branch, Addison and Richardson, including Highland Park and Love Field.' }
    }
  ];
  const config = { DEFAULT_CITY, SERVICE_AREAS };
  if (typeof module === 'object' && module.exports) module.exports = config;
  else root.CCH_CITIES = config;
})(globalThis);
