// Texas DMV history from before Cybercab Hunter polled TxDMV itself (our first
// snapshot: 2026-10-09). TxDMV publishes no registration dates, so this period
// can't be rebuilt from the source. These counts were read off Robotaxi
// Tracker's public "Texas DMV registrations · Tesla" chart (a screenshot of
// https://robotaxitracker.com, 2026-10-09), one step per change, so they are
// APPROXIMATE (about ±2 vehicles) and are always labeled and credited as such.
// Never extended: every day from 2026-10-09 on comes from worker/txdmv.js.
//   [date (the count holds from this day), cybercab, model_y]
export const DMV_HISTORY_SOURCE = {
  name: 'Robotaxi Tracker',
  url: 'https://robotaxitracker.com',
  note: 'approximate, read from their public chart'
};
export const DMV_HISTORY = [
  ['2026-06-12', 0, 67],
  ['2026-06-28', 0, 81],
  ['2026-07-02', 0, 99],
  ['2026-07-15', 0, 115],
  ['2026-07-16', 0, 172],
  ['2026-07-30', 0, 178],
  ['2026-08-19', 0, 183],
  ['2026-08-23', 0, 188],
  ['2026-08-27', 0, 268],
  ['2026-08-31', 43, 268],
  ['2026-09-02', 43, 312],
  ['2026-09-03', 43, 374],
  ['2026-09-05', 43, 387],
  ['2026-09-09', 48, 387],
  ['2026-09-11', 48, 389],
  ['2026-09-19', 56, 389],
  ['2026-09-22', 67, 409],
  ['2026-09-24', 67, 420],
  ['2026-09-25', 87, 420],
  ['2026-09-26', 124, 420],
  ['2026-10-02', 167, 420],
].map(([date, cybercab, model_y]) => ({ date, cybercab, model_y, total: cybercab + model_y }));
