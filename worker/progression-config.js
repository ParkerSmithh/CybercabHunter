// Spotter XP, levels, ranks and missions: the numbers, in one place
// (worker/progression.js applies them). Change a value here and redeploy;
// the daily reconcile then brings every rider's XP in line with it.
//
// XP is the ONLY reward. No badges, trophies or collectibles anywhere.

// XP per approved contribution. `enabled: false` = no approval workflow for
// that contribution exists on the site yet (only moderator-approved sightings
// and discovery credit do), so it awards nothing until one does.
export const XP_REWARDS = {
  verified_sighting:  { xp: 25,  enabled: true,  label: 'Verified sighting' },
  first_discovery:    { xp: 100, enabled: true,  label: 'First discovery of an undocumented Cybercab' },
  vehicle_evidence:   { xp: 15,  enabled: false, label: 'Evidence approved for an existing vehicle', why: 'no evidence-submission workflow yet' },
  vin_identified:     { xp: 75,  enabled: false, label: 'Helped identify a missing VIN', why: 'no VIN-submission workflow yet' },
  record_correction:  { xp: 20,  enabled: false, label: 'Approved correction to a vehicle record', why: 'no correction workflow yet' },
  daily_mission:      { xp: 30,  enabled: true,  label: 'Daily mission completed' },
  weekly_mission:     { xp: 100, enabled: true,  label: 'Weekly mission completed' }
};

// Levels: the total XP each level starts at. Anchors from the owner's table;
// between anchors the levels are evenly spaced, so each step costs a little
// more than the one before. Past the last anchor every level costs
// LEVEL_STEP_AFTER more than the previous step did (+ LEVEL_STEP_GROWTH).
export const LEVEL_ANCHORS = [[1, 0], [2, 100], [3, 250], [4, 450], [5, 700], [10, 2500], [20, 7500], [30, 15000], [40, 25000], [50, 40000]];
export const LEVEL_STEP_AFTER = 1600;
export const LEVEL_STEP_GROWTH = 100;
export const MAX_LEVEL = 100;

// Ranks: titles by total XP (text labels, never badges).
export const RANKS = [
  { key: 'bronze', name: 'Bronze Spotter', xp: 0 },
  { key: 'silver', name: 'Silver Spotter', xp: 1000 },
  { key: 'gold', name: 'Gold Spotter', xp: 3000 },
  { key: 'platinum', name: 'Platinum Spotter', xp: 8000 },
  { key: 'diamond', name: 'Diamond Spotter', xp: 20000 }
];

// Missions. Periods are America/Chicago days and Monday-Sunday weeks, counted
// by when the contribution was SUBMITTED (a late approval still counts for its
// own period). `counts` = which verified contributions advance it; only types
// with a real approval workflow are listed, so every mission can be completed.
// Disabled missions (their contribution type has no workflow yet) are kept
// here so they can be switched on later, and are never shown.
export const MISSIONS = [
  { id: 'daily_contribution', period: 'day', title: 'Daily Contribution', description: 'Submit 1 sighting that a moderator verifies.', required: 1, counts: ['sighting'], reward: 'daily_mission', enabled: true },
  { id: 'daily_evidence', period: 'day', title: 'Evidence Contributor', description: 'Add 1 piece of approved evidence to a vehicle record.', required: 1, counts: ['evidence'], reward: 'daily_mission', enabled: false },
  { id: 'daily_registry', period: 'day', title: 'Registry Helper', description: 'Submit 1 approved vehicle record correction.', required: 1, counts: ['correction'], reward: 'daily_mission', enabled: false },
  { id: 'weekly_spotter', period: 'week', title: 'Weekly Spotter', description: 'Submit 3 sightings that moderators verify this week.', required: 3, counts: ['sighting'], reward: 'weekly_mission', enabled: true },
  { id: 'weekly_contributor', period: 'week', title: 'Community Contributor', description: 'Complete 5 verified contributions this week (verified sightings count).', required: 5, counts: ['sighting', 'evidence', 'correction', 'vin'], reward: 'weekly_mission', enabled: true },
  { id: 'weekly_research', period: 'week', title: 'Fleet Researcher', description: 'Submit 3 approved evidence contributions this week.', required: 3, counts: ['evidence'], reward: 'weekly_mission', enabled: false },
  { id: 'weekly_vin', period: 'week', title: 'VIN Investigator', description: 'Help identify 1 previously missing VIN this week.', required: 1, counts: ['vin'], reward: 'weekly_mission', enabled: false }
];
