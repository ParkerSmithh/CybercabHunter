// Placeholder interface for a future Tesla ride-history data source.
//
// No implementation exists here on purpose. Every ride-history mechanism
// investigated for this project (Tesla's Owner API / `ownerapi` client,
// `/mobile-app/ride/history`, and whatever "Tesla Ride Sync" third-party
// trackers use internally) is either currently non-functional or has
// never been established as an officially documented, authorized Tesla
// endpoint. Fleet API — the one official, currently-working Tesla OAuth
// mechanism — has no ride-history capability at all.
//
// worker/tesla-rides.js's OAuth/token foundation is deliberately built
// against Tesla's real, current, documented OAuth flow so that if a
// legitimate ride-history source is ever identified (an official Fleet
// API scope, or another documented mechanism), it can be plugged in here
// without redoing authentication. Until then, calling this throws rather
// than silently returning nothing or calling an unverified endpoint.

export const teslaRideProvider = {
  async fetchRides(_accessToken) {
    throw new Error(
      'TeslaRideProvider is not implemented yet — no verified, legitimate ' +
      'Tesla ride-history data source has been established for this project.'
    );
  }
};
