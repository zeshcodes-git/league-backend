import { shouldRefreshNow, isLiveWindow, rosterCacheMs } from "./refreshPolicy.js";
const MIN = 60000, H = 60 * MIN, now = Date.parse("2026-10-06T14:00:00Z"); // a Tuesday
const t = (name, got, want) => console.log((got === want ? "PASS" : "FAIL"), name, got);
t("no data yet -> refresh", shouldRefreshNow({ hasData: false, lastRefreshAt: now, info: null, now }), true);
t("Tuesday quiet, 2 min since last -> skip", shouldRefreshNow({ hasData: true, lastRefreshAt: now - 2 * MIN, info: { anyLive: false, nextKickoffMs: now + 40 * H }, now }), false);
t("Tuesday quiet, 11 min since last -> refresh", shouldRefreshNow({ hasData: true, lastRefreshAt: now - 11 * MIN, info: { anyLive: false, nextKickoffMs: now + 40 * H }, now }), true);
t("game live, 1 min since last -> refresh", shouldRefreshNow({ hasData: true, lastRefreshAt: now - 60000, info: { anyLive: true, nextKickoffMs: null }, now }), true);
t("game live, 20s since last -> skip", shouldRefreshNow({ hasData: true, lastRefreshAt: now - 20000, info: { anyLive: true, nextKickoffMs: null }, now }), false);
t("kickoff in 15 min -> live window", isLiveWindow({ anyLive: false, nextKickoffMs: now + 15 * MIN }, now), true);
t("kickoff in 3 hours -> not live", isLiveWindow({ anyLive: false, nextKickoffMs: now + 3 * H }, now), false);
t("kickoff 6h ago still 'pre' (postponed) -> not live", isLiveWindow({ anyLive: false, nextKickoffMs: now - 6 * H }, now), false);
t("roster cache live=10min", rosterCacheMs({ anyLive: true }, now), 10 * MIN);
t("roster cache quiet=60min", rosterCacheMs({ anyLive: false, nextKickoffMs: null }, now), 60 * MIN);
t("unknown info -> quiet pace (10 min)", shouldRefreshNow({ hasData: true, lastRefreshAt: now - 5 * MIN, info: null, now }), false);
process.exit(0);
