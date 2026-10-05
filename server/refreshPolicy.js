// How often the server may call ESPN — and how long it may reuse what it has.
//
// REFRESH_MODE (an environment variable on Render, changeable without a code
// change) controls everything:
//
//   off       Never pulls on a timer, and only fetches from ESPN when it has
//             nothing at all saved. The site shows the last saved data. Zero
//             ongoing bandwidth. (The default.)
//   lowpower  No timer. A visit may trigger ONE refresh if the data is over
//             15 minutes old. Modest bandwidth, fine for casual use.
//   auto      Full live mode: every 2 minutes while NFL games are on (or about
//             to start), every hour otherwise. Best for game days.
//
// Pure functions, so every rule is tested.

export const MODES = ["off", "lowpower", "auto"];

export function getMode(value) {
  const m = String(value == null ? "off" : value).trim().toLowerCase();
  return MODES.includes(m) ? m : "off";
}

export const LIVE_REFRESH_MS = 2 * 60 * 1000;
export const QUIET_REFRESH_MS = 60 * 60 * 1000;
export const VISIT_REFRESH_MS = 15 * 60 * 1000; // lowpower: refresh on a visit if older than this
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

// The background timer (only runs in auto mode).
export function shouldRefreshNow({ hasData, lastRefreshAt, info, now = Date.now(), mode = "auto" }) {
  if (!hasData) return true;
  if (mode !== "auto") return false;
  const age = now - (lastRefreshAt || 0);
  return age >= (isLiveWindow(info, now) ? LIVE_REFRESH_MS : QUIET_REFRESH_MS);
}

// A visitor asking for data: should we go to ESPN first?
export function shouldRefreshOnVisit({ hasData, lastRefreshAt, now = Date.now(), mode = "off" }) {
  if (!hasData) return true; // never serve nothing
  if (mode === "lowpower") return now - (lastRefreshAt || 0) >= VISIT_REFRESH_MS;
  return false;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// How long the heavy roster/projection download may be reused.
export function rosterCacheMs(info, mode = "auto", now = Date.now()) {
  if (mode === "off") return Infinity;
  if (mode === "lowpower") return 2 * HOUR;
  return isLiveWindow(info, now) ? 30 * MIN : 6 * HOUR;
}

// Other caches, by mode.
export const CACHE_MS = {
  nflScoreboard: { auto: 60 * 1000, lowpower: 5 * MIN, off: 30 * MIN },
  freeAgents: { auto: 30 * MIN, lowpower: 2 * HOUR, off: 24 * HOUR },
  adviceRoster: { auto: 15 * MIN, lowpower: HOUR, off: Infinity },
};

// Browser/proxy cache lifetimes (seconds) for API responses, so repeat requests
// never reach the server at all.
export function clientCacheSeconds(path, mode = "off") {
  const table = {
    "/api/dashboard": { auto: 20, lowpower: 120, off: 600 },
    "/api/odds-history": { auto: 60, lowpower: 300, off: 900 },
    "/api/nfl-scoreboard": { auto: 60, lowpower: 300, off: 1800 },
    "/api/free-agents": { auto: 300, lowpower: 600, off: 1800 },
    "/api/season-history": { auto: 300, lowpower: 600, off: 1800 },
  };
  if (table[path]) return table[path][mode];
  if (/^\/api\/team\/\d+\/roster$/.test(path)) return { auto: 30, lowpower: 300, off: 900 }[mode];
  if (/^\/api\/team\/\d+\/suggestions$/.test(path)) return { auto: 120, lowpower: 600, off: 1800 }[mode];
  return 0;
}
