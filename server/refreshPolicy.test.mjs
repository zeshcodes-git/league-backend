// Run with:  node server/refreshPolicy.test.mjs
import assert from "node:assert/strict";
import { isPostWeekHold, pacificParts, getMode, shouldRefreshNow, shouldRefreshOnVisit, isLiveWindow, rosterCacheMs, CACHE_MS, clientCacheSeconds, LIVE_REFRESH_MS, QUIET_REFRESH_MS } from "./refreshPolicy.js";

let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; console.log("PASS", name); } catch (e) { fail++; console.log("FAIL", name, "\n     ", e.message); } };
const MIN = 60000, H = 60 * MIN, now = Date.parse("2026-10-06T14:00:00Z"); // a Tuesday
const quiet = { anyLive: false, nextKickoffMs: now + 40 * H };
const live = { anyLive: true, nextKickoffMs: null };

/* ---- the mode switch ---- */
test("the default (nothing set) is OFF — no pulling", () => assert.equal(getMode(undefined), "off"));
test("typos and junk fall back to OFF, never to full-speed pulling", () => { assert.equal(getMode("fast"), "off"); assert.equal(getMode(""), "off"); assert.equal(getMode(null), "off"); });
test("modes parse case-insensitively", () => { assert.equal(getMode("AUTO"), "auto"); assert.equal(getMode(" LowPower "), "lowpower"); assert.equal(getMode("off"), "off"); });

/* ---- OFF: nothing ongoing ---- */
test("OFF: the timer never refreshes, however old the data (when there is data)", () => {
  assert.equal(shouldRefreshNow({ hasData: true, lastRefreshAt: now - 30 * 24 * H, info: live, now, mode: "off" }), false);
});
test("OFF: a visitor never triggers a refresh when data exists", () => {
  assert.equal(shouldRefreshOnVisit({ hasData: true, lastRefreshAt: now - 99 * H, now, mode: "off" }), false);
});
test("OFF: with NO data at all it still fetches once, so the site isn't empty", () => {
  assert.equal(shouldRefreshOnVisit({ hasData: false, lastRefreshAt: 0, now, mode: "off" }), true);
  assert.equal(shouldRefreshNow({ hasData: false, lastRefreshAt: 0, info: null, now, mode: "off" }), true);
});

/* ---- LOWPOWER: only on a visit, at most every 15 minutes ---- */
test("LOWPOWER: no background timer", () => {
  assert.equal(shouldRefreshNow({ hasData: true, lastRefreshAt: now - 5 * H, info: live, now, mode: "lowpower" }), false);
});
test("LOWPOWER: a visit refreshes only when data is over 15 minutes old", () => {
  assert.equal(shouldRefreshOnVisit({ hasData: true, lastRefreshAt: now - 5 * MIN, now, mode: "lowpower" }), false);
  assert.equal(shouldRefreshOnVisit({ hasData: true, lastRefreshAt: now - 16 * MIN, now, mode: "lowpower" }), true);
});

/* ---- AUTO: game windows vs quiet ---- */
test("AUTO: during games, refresh every 2 minutes (not every minute)", () => {
  assert.equal(LIVE_REFRESH_MS, 2 * MIN);
  assert.equal(shouldRefreshNow({ hasData: true, lastRefreshAt: now - 90000, info: live, now, mode: "auto" }), false);
  assert.equal(shouldRefreshNow({ hasData: true, lastRefreshAt: now - 125000, info: live, now, mode: "auto" }), true);
});
test("AUTO: when nothing is on, refresh only hourly", () => {
  assert.equal(QUIET_REFRESH_MS, 60 * MIN);
  assert.equal(shouldRefreshNow({ hasData: true, lastRefreshAt: now - 30 * MIN, info: quiet, now, mode: "auto" }), false);
  assert.equal(shouldRefreshNow({ hasData: true, lastRefreshAt: now - 61 * MIN, info: quiet, now, mode: "auto" }), true);
});
test("AUTO: a visit never adds its own refresh (the timer owns it)", () => {
  assert.equal(shouldRefreshOnVisit({ hasData: true, lastRefreshAt: now - 5 * H, now, mode: "auto" }), false);
});
test("a game 20 minutes from kickoff counts as live; a postponed one doesn't linger", () => {
  assert.equal(isLiveWindow({ anyLive: false, nextKickoffMs: now + 15 * MIN }, now), true);
  assert.equal(isLiveWindow({ anyLive: false, nextKickoffMs: now + 3 * H }, now), false);
  assert.equal(isLiveWindow({ anyLive: false, nextKickoffMs: now - 6 * H }, now), false);
});

/* ---- heavy downloads ---- */
test("the big roster download: never in OFF, 2h in LOWPOWER, 30min/6h in AUTO", () => {
  assert.equal(rosterCacheMs(live, "off", now), Infinity);
  assert.equal(rosterCacheMs(live, "lowpower", now), 2 * H);
  assert.equal(rosterCacheMs(live, "auto", now), 30 * MIN);
  assert.equal(rosterCacheMs(quiet, "auto", now), 6 * H);
});
test("every cache gets longer as the mode gets quieter", () => {
  Object.entries(CACHE_MS).forEach(([name, c]) => assert.ok(c.auto <= c.lowpower && c.lowpower <= c.off, `${name} should grow auto -> lowpower -> off`));
});

/* ---- browser caching ---- */
test("API responses are cacheable by the browser, longer when quieter", () => {
  ["/api/dashboard", "/api/odds-history", "/api/nfl-scoreboard", "/api/free-agents", "/api/season-history", "/api/team/5/roster", "/api/team/5/suggestions"].forEach((p) => {
    const a = clientCacheSeconds(p, "auto"), l = clientCacheSeconds(p, "lowpower"), o = clientCacheSeconds(p, "off");
    assert.ok(a > 0 && a <= l && l <= o, `${p}: ${a}/${l}/${o}`);
  });
  assert.equal(clientCacheSeconds("/api/health", "off"), 0, "the health check must never be cached");
});

/* ---- the "last week's results" hold: only Tuesday through Wednesday noon (Pacific) ---- */
// 2026-10-18 is a Sunday. Times below are Pacific (PDT = UTC-7 until Nov 1).
const pt = (iso) => Date.parse(iso + "-07:00");
test("Sunday and Monday (the new week's games) are NEVER held — this was the bug", () => {
  assert.equal(isPostWeekHold(pt("2026-10-18T10:00:00")), false); // Sunday morning
  assert.equal(isPostWeekHold(pt("2026-10-18T20:00:00")), false); // Sunday night
  assert.equal(isPostWeekHold(pt("2026-10-19T11:57:00")), false); // Monday morning (when it was reported)
  assert.equal(isPostWeekHold(pt("2026-10-19T22:30:00")), false); // Monday night football
});
test("Tuesday all day, and Wednesday until noon, ARE held", () => {
  assert.equal(isPostWeekHold(pt("2026-10-20T00:30:00")), true);
  assert.equal(isPostWeekHold(pt("2026-10-20T15:00:00")), true);
  assert.equal(isPostWeekHold(pt("2026-10-21T09:00:00")), true);
  assert.equal(isPostWeekHold(pt("2026-10-21T11:59:00")), true);
});
test("from Wednesday noon through Saturday the current week shows", () => {
  assert.equal(isPostWeekHold(pt("2026-10-21T12:00:00")), false);
  assert.equal(isPostWeekHold(pt("2026-10-21T18:00:00")), false);
  assert.equal(isPostWeekHold(pt("2026-10-22T20:15:00")), false); // Thursday night kickoff
  assert.equal(isPostWeekHold(pt("2026-10-24T12:00:00")), false); // Saturday
});
test("Pacific time is used regardless of server timezone, including after daylight saving ends", () => {
  assert.deepEqual(pacificParts(Date.parse("2026-10-20T07:00:00Z")), { day: 2, hour: 0 }); // PDT
  assert.deepEqual(pacificParts(Date.parse("2026-11-03T08:00:00Z")), { day: 2, hour: 0 }); // PST (after Nov 1)
  assert.equal(isPostWeekHold(Date.parse("2026-11-04T19:59:00Z")), true); // Wed 11:59 PST
  assert.equal(isPostWeekHold(Date.parse("2026-11-04T20:00:00Z")), false); // Wed 12:00 PST
});
test("every hour of every day gives a clean answer (only Tue + Wed AM are held)", () => {
  let held = 0;
  for (let h = 0; h < 24 * 7; h++) if (isPostWeekHold(pt("2026-10-18T00:00:00") + h * 3600000)) held++;
  assert.equal(held, 24 + 12, "24 hours of Tuesday + 12 hours of Wednesday morning");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
