// Run with:  node server/playerForm.test.mjs
import assert from "node:assert/strict";
import { buildForm, extractWeekly, priorSd } from "./playerForm.js";
import { createPlayerHistory } from "./playerHistory.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log("PASS", name); } catch (e) { fail++; console.log("FAIL", name, "\n     ", e.message); }
};
const form = (o) => buildForm({ lastWeek: 3, posId: 3, ...o });

await test("no history -> expectation is just the ESPN projection", () => {
  const f = form({ weeks: {}, pace: 12, proj: 12 });
  assert.equal(f.adj, 0);
  assert.equal(f.exp, 12);
  assert.equal(f.games, 0);
});
await test("a player scoring far above ESPN's pace is expected to score more", () => {
  const f = form({ weeks: { 1: 20, 2: 22, 3: 25 }, pace: 10, proj: 12 });
  assert.ok(f.adj > 1.5, `adj ${f.adj}`);
  assert.ok(f.exp > 12);
  assert.equal(f.trend, "hot");
});
await test("a player scoring far below ESPN's pace is expected to score less", () => {
  const f = form({ weeks: { 1: 3, 2: 4, 3: 2 }, pace: 15, proj: 14 });
  assert.ok(f.adj < -1.5, `adj ${f.adj}`);
  assert.ok(f.exp < 14);
  assert.equal(f.trend, "cold");
});
await test("more evidence moves the estimate more (1 game < 3 games), never past the cap", () => {
  const one = form({ weeks: { 3: 15 }, pace: 10, proj: 20 });
  const three = form({ weeks: { 1: 15, 2: 15, 3: 15 }, pace: 10, proj: 20 });
  assert.ok(one.adj > 0 && three.adj > one.adj, `${one.adj} vs ${three.adj}`);
  assert.ok(three.adj < 0.4 * 20, "stays under the 40% cap here, so the comparison is meaningful");
});
await test("one fluke week barely moves a player with a real track record", () => {
  const steady = form({ weeks: { 1: 12, 2: 12, 3: 12, 4: 12, 5: 12, 6: 40 }, lastWeek: 6, pace: 12, proj: 12 });
  assert.ok(Math.abs(steady.adj) < 2, `adj ${steady.adj}`);
  const withoutFluke = form({ weeks: { 1: 12, 2: 12, 3: 12, 4: 12, 5: 12, 6: 12 }, lastWeek: 6, pace: 12, proj: 12 });
  assert.ok(Math.abs(steady.adj - withoutFluke.adj) < 2, "a single 40-point week shifts it by under 2 points");
});
await test("the adjustment is capped (40% of projection, 8 points max)", () => {
  assert.equal(form({ weeks: { 1: 40, 2: 40, 3: 40 }, pace: 2, proj: 10 }).adj, 4);
  const big = form({ weeks: { 1: 60, 2: 60, 3: 60 }, pace: 5, proj: 40 });
  assert.ok(big.adj <= 8);
});
await test("weeks he didn't play (0 or negative) are ignored, not counted as busts", () => {
  const f = form({ weeks: { 1: 0, 2: 0, 3: 15 }, pace: 15, proj: 15 });
  assert.equal(f.games, 1);
  assert.ok(f.adj > -1, `adj ${f.adj}`);
  assert.equal(form({ weeks: { 1: -0.4, 2: 0, 3: 14 }, pace: 14, proj: 14 }).games, 1);
});
await test("a single game is trusted less than two (thin sample)", () => {
  const one = form({ weeks: { 3: 16 }, pace: 10, proj: 14 });
  const two = form({ weeks: { 2: 16, 3: 16 }, pace: 10, proj: 14 });
  assert.ok(one.adj > 0 && two.adj > one.adj * 1.4, `${one.adj} vs ${two.adj}`);
});
await test("a defense that scores 0 really did score 0", () => {
  const f = buildForm({ weeks: { 1: 0, 2: 12, 3: 10 }, pace: 8, proj: 8, posId: 16, lastWeek: 3 });
  assert.equal(f.games, 3);
});
await test("recent weeks count more than old ones", () => {
  const recentHot = form({ weeks: { 1: 5, 2: 6, 3: 25 }, pace: 12, proj: 12 });
  const recentCold = form({ weeks: { 1: 25, 2: 6, 3: 5 }, pace: 12, proj: 12 });
  assert.ok(recentHot.talent > recentCold.talent);
});
await test("weeks after the last completed one are never used", () => {
  const f = form({ weeks: { 1: 10, 2: 10, 3: 10, 4: 99 }, pace: 10, proj: 10 });
  assert.equal(f.games, 3);
});
await test("rookies and unknowns fall back sensibly (no pace, no history)", () => {
  const f = form({ weeks: {}, pace: null, prevPpg: null, proj: 9 });
  assert.equal(f.exp, 9);
  const g = form({ weeks: { 1: 14, 2: 15 }, pace: null, prevPpg: null, proj: 10 });
  assert.ok(g.adj > 0 && g.adj <= 4);
});
await test("last season's average is the fallback belief when ESPN has no pace", () => {
  const f = form({ weeks: {}, pace: null, prevPpg: 20, proj: 18 });
  assert.equal(f.adj, 0);
  assert.ok(f.talent < 20 && f.talent > 17, `talent ${f.talent}`);
});
await test("volatility: erratic players have a bigger spread than steady ones", () => {
  const steady = form({ weeks: { 1: 10, 2: 10.5, 3: 9.8 }, pace: 10, proj: 10 });
  const erratic = form({ weeks: { 1: 2, 2: 28, 3: 1 }, pace: 10, proj: 10 });
  assert.ok(erratic.sd > steady.sd + 1);
  assert.ok(Math.abs(form({ weeks: {}, pace: 10, proj: 10 }).sd - priorSd(10)) < 0.5);
});
await test("extractWeekly: reads this season's completed weeks, pace and last year's average", () => {
  const p = { stats: [
    { seasonId: 2026, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 1, appliedTotal: 11.5 },
    { seasonId: 2026, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: 9 },
    { seasonId: 2026, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 4, appliedTotal: 5 }, // in progress -> excluded
    { seasonId: 2025, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 17, appliedTotal: 99 }, // last year weekly -> excluded
    { seasonId: 2026, statSourceId: 1, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: 200, appliedAverage: 14.3 },
    { seasonId: 2025, statSourceId: 0, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: 280, appliedAverage: 16.5 },
  ] };
  const r = extractWeekly(p, 2026, 3);
  assert.deepEqual(r.weeks, { 1: 11.5, 3: 9 });
  assert.equal(r.pace, 14.3);
  assert.equal(r.prevPpg, 16.5);
});

/* ---- the persistent weekly tracker ---- */
const rawPlayer = (id, name, weeks, extra = {}) => ({ player: { id, fullName: name, defaultPositionId: 3, stats: [
  ...Object.entries(weeks).map(([w, t]) => ({ seasonId: 2026, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: Number(w), appliedTotal: t })),
  ...(extra.pace ? [{ seasonId: 2026, statSourceId: 1, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: 1, appliedAverage: extra.pace }] : []),
] } });
const memoryKv = () => { const m = {}; return { kvGet: async (k) => m[k] ?? null, kvSet: async (k, v) => { m[k] = JSON.parse(JSON.stringify(v)); }, m }; };

await test("tracker: stores week-by-week points, survives a restart", async () => {
  const kv = memoryKv();
  const h1 = createPlayerHistory({ season: 2026, ...kv });
  await h1.load();
  h1.ingest([rawPlayer(1, "A", { 1: 10, 2: 12 }, { pace: 11 })], 2);
  assert.equal(await h1.save(), true);
  const h2 = createPlayerHistory({ season: 2026, ...kv });
  await h2.load();
  assert.deepEqual(h2.get(1).a, { 1: 10, 2: 12 });
  assert.equal(h2.get(1).pace, 11);
});
await test("tracker: only asks ESPN for players it is missing or that are a week behind", () => {
  const h = createPlayerHistory({ season: 2026, ...memoryKv() });
  h.ingest([rawPlayer(1, "A", { 1: 10, 2: 12 }), rawPlayer(2, "B", { 1: 5 })], 2);
  assert.deepEqual(h.needsRefresh([1, 2, 3], 2), [3]); // 3 never seen
  assert.deepEqual(h.needsRefresh([1, 2, 3], 3).sort(), [1, 2, 3]); // a new week finished
});
await test("tracker: newer ESPN numbers (stat corrections) overwrite, new weeks are added", () => {
  const h = createPlayerHistory({ season: 2026, ...memoryKv() });
  h.ingest([rawPlayer(1, "A", { 1: 10, 2: 12 })], 2);
  h.ingest([rawPlayer(1, "A", { 1: 10.5, 2: 12, 3: 7 })], 3);
  assert.deepEqual(h.get(1).a, { 1: 10.5, 2: 12, 3: 7 });
});
await test("tracker: nothing is saved (no storage write) when nothing changed", async () => {
  const kv = memoryKv();
  const h = createPlayerHistory({ season: 2026, ...kv });
  h.ingest([rawPlayer(1, "A", { 1: 10 })], 1);
  assert.equal(await h.save(), true);
  h.ingest([rawPlayer(1, "A", { 1: 10 })], 1);
  assert.equal(await h.save(), false);
});
await test("tracker: records ESPN's pregame projection once per week", async () => {
  const h = createPlayerHistory({ season: 2026, ...memoryKv() });
  h.ingest([rawPlayer(1, "A", { 1: 10 })], 1);
  h.recordProjection(1, 2, 14.2);
  h.recordProjection(1, 2, 9.9); // later (post-injury) number must not overwrite the pregame one
  assert.equal(h.get(1).pr[2], 14.2);
});
await test("tracker: ignores history saved for a different season", async () => {
  const kv = memoryKv();
  kv.m.playerHistory = { season: 2025, players: { 1: { n: "Old", a: { 1: 5 } } } };
  const h = createPlayerHistory({ season: 2026, ...kv });
  await h.load();
  assert.equal(h.get(1), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
