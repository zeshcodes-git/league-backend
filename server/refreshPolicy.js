// Decides when the background refresh should actually call ESPN.
//
// Scores and odds only change while NFL games are being played (or about to
// start). Pulling ~2 MB of league data from ESPN every minute around the
// clock — including Tuesday morning when nothing is happening — is wasted
// work and bandwidth. So: every minute while games are live (or kicking off
// within 20 minutes), and every 10 minutes the rest of the time (enough to
// notice a new week, a finished week, or a stat correction).

export const LIVE_REFRESH_MS = 55 * 1000;
export const QUIET_REFRESH_MS = 10 * 60 * 1000;
const KICKOFF_LEAD_MS = 20 * 60 * 1000;
const KICKOFF_GRACE_MS = 4 * 60 * 60 * 1000; // ignore a "scheduled" game that never started (postponed)

// info = { anyLive: boolean, nextKickoffMs: number | null }
export function isLiveWindow(info, now = Date.now()) {
  if (!info) return false;
  if (info.anyLive) return true;
  if (info.nextKickoffMs == null) return false;
  const untilKickoff = info.nextKickoffMs - now;
  return untilKickoff < KICKOFF_LEAD_MS && untilKickoff > -KICKOFF_GRACE_MS;
}

export function shouldRefreshNow({ hasData, lastRefreshAt, info, now = Date.now() }) {
  if (!hasData) return true;
  const age = now - (lastRefreshAt || 0);
  return age >= (isLiveWindow(info, now) ? LIVE_REFRESH_MS : QUIET_REFRESH_MS);
}

// How long the heavy roster/projection download may be reused.
export function rosterCacheMs(info, now = Date.now()) {
  return isLiveWindow(info, now) ? 10 * 60 * 1000 : 60 * 60 * 1000;
}
