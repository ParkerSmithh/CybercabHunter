// The traffic cameras a sighting can be tagged with, per city (each entry's
// `city`): the 70 City of Austin cameras (the owner's camera watch + backups;
// coordinates from the city's public inventory) and 50 TxDOT Dallas-district
// cameras (ids txdot-dal-<OBJECTID>, names and coordinates from TxDOT's own
// ITS device layer, Existing_ITS_Device_Service_view/TxDOT_ITS_Device_locations,
// type CCTV, districts DAL1/DAL2). ONE list, public/data/traffic-cameras.json,
// shared by the Submit form and the moderation page (which fetch it) and the
// Worker (which imports it here), so the server always takes a camera's name
// and position from this list, never from the request.
import TRAFFIC_CAMERAS from '../public/data/traffic-cameras.json' with { type: 'json' };

const BY_ID = new Map(TRAFFIC_CAMERAS.map(c => [c.camera_id, c]));

export { TRAFFIC_CAMERAS };

// A camera's city key; an entry without one is an Austin camera.
export const cameraCity = camera => (camera && camera.city) || 'austin';

// The camera with this id, or null. Accepts the id as a string or an integer.
export function trafficCameraFor(id) {
  const key = typeof id === 'number' && Number.isInteger(id) ? String(id) : id;
  return typeof key === 'string' ? BY_ID.get(key.trim()) || null : null;
}
