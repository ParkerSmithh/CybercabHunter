// The traffic cameras a sighting can be tagged with: the 50 City of Austin
// cameras in the owner's camera watch (camera_id, name, lat, lng; coordinates
// from the city's public inventory). ONE list, public/data/traffic-cameras.json,
// shared by the Submit form and the moderation page (which fetch it) and the
// Worker (which imports it here), so the server always takes a camera's name
// and position from this list, never from the request.
import TRAFFIC_CAMERAS from '../public/data/traffic-cameras.json' with { type: 'json' };

const BY_ID = new Map(TRAFFIC_CAMERAS.map(c => [c.camera_id, c]));

export { TRAFFIC_CAMERAS };

// The camera with this id, or null. Accepts the id as a string or an integer.
export function trafficCameraFor(id) {
  const key = typeof id === 'number' && Number.isInteger(id) ? String(id) : id;
  return typeof key === 'string' ? BY_ID.get(key.trim()) || null : null;
}
