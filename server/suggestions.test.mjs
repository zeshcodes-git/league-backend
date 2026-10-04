// Run with:  node server/suggestions.test.mjs
import assert from "node:assert/strict";
import { bestLineup, buildSuggestions } from "./suggestions.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log("PASS", name); } catch (e) { fail++; console.log("FAIL", name, "\n     ", e.message); }
};

const WEEK = 4;
const ELIG = { 1: [0, 7], 2: [2, 23, 7], 3: [4, 23, 7], 4: [6, 23, 7], 5: [17], 16: [16] };
// proTeamId -> abbreviation used by the app: 1 ATL, 2 BUF, 3 CHI, 4 CIN, 5 CLE, 6 DAL, 7 DEN, 8 DET
const allPre = { ATL: "pre", BUF: "pre", CHI: "pre", CIN: "pre", CLE: "pre", DAL: "pre", DEN: "pre", DET: "pre" };
const RULES = { lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 23: 2, 16: 1, 20: 7, 21: 1 }, positionLimits: { 1: 4, 2: 8, 3: 8, 4: 3, 5: 0, 16: 3 }, isBenchUnlimited: true };

let uid = 0;
const raw = ({ name, pos, slot, status, proj, actual = 0, team = 1, owned = 10, droppable = true, weeks = null, pace = null }) => ({
  id: ++uid,
  fullName: name,
  defaultPositionId: pos,
  proTeamId: team,
  injuryStatus: status,
  eligibleSlots: [...ELIG[pos], 20, 21],
  ownership: { percentOwned: owned },
  droppable,
  stats: [
    { statSourceId: 1, scoringPeriodId: WEEK, appliedTotal: proj },
    { statSourceId: 0, scoringPeriodId: WEEK, appliedTotal: actual },
    ...(weeks ? Object.entries(weeks).map(([w, pts]) => ({ seasonId: 2026, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: Number(w), appliedTotal: pts })) : []),
    ...(pace ? [{ seasonId: 2026, statSourceId: 1, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: pace * 14, appliedAverage: pace }] : []),
  ],
});
const rosterEntry = (o) => ({ lineupSlotId: o.slot, playerPoolEntry: { player: raw(o) } });
const faEntry = (o) => ({ player: raw(o) });

// A normal, healthy team. Slots: QB 0, RB 2, WR 4, TE 6, FLEX 23, DST 16, bench 20, IR 21
const baseTeam = (overrides = []) => {
  const players = [
    { name: "QB1", pos: 1, slot: 0, proj: 20 },
    { name: "RB1", pos: 2, slot: 2, proj: 15 },
    { name: "RB2", pos: 2, slot: 2, proj: 12 },
    { name: "WR1", pos: 3, slot: 4, proj: 14 },
    { name: "WR2", pos: 3, slot: 4, proj: 11 },
    { name: "TE1", pos: 4, slot: 6, proj: 9 },
    { name: "FLEX1", pos: 3, slot: 23, proj: 10 },
    { name: "FLEX2", pos: 2, slot: 23, proj: 9 },
    { name: "DST1", pos: 16, slot: 16, proj: 7 },
    { name: "BenchRB", pos: 2, slot: 20, proj: 5 },
    { name: "BenchWR", pos: 3, slot: 20, proj: 6 },
  ].map((p) => overrides.find((o) => o.name === p.name) || p);
  const extra = overrides.filter((o) => !players.some((p) => p.name === o.name));
  return { name: "Test Team", roster: { entries: [...players, ...extra].map(rosterEntry) } };
};
const run = (team, fas = [], extra = {}) => buildSuggestions({ team, freeAgents: fas.map(faEntry), week: WEEK, season: 2026, gameStateByTeam: allPre, rules: RULES, ...extra });

/* ---- the optimizer ---- */
test("bestLineup matches brute force on random cases", () => {
  const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  for (let t = 0; t < 300; t++) {
    const slots = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => [0, 2, 4, 23][Math.floor(rnd() * 4)]);
    const players = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) => {
      const pos = [1, 2, 3][Math.floor(rnd() * 3)];
      return { id: i, value: Math.round(rnd() * 20), eligible: new Set(ELIG[pos].filter((s) => [0, 2, 4, 23].includes(s))) };
    });
    // exhaustive search
    let best = 0;
    const go = (i, used, total) => {
      if (i === slots.length) { best = Math.max(best, total); return; }
      go(i + 1, used, total); // leave empty
      players.forEach((pl, k) => { if (!used.has(k) && pl.eligible.has(slots[i])) go(i + 1, new Set([...used, k]), total + pl.value); });
    };
    go(0, new Set(), 0);
    assert.equal(bestLineup(slots, players).total, best);
  }
});

/* ---- lineup swaps ---- */
test("an OUT starter is swapped for the best bench player, flagged high priority", () => {
  const r = run(baseTeam([{ name: "WR1", pos: 3, slot: 4, proj: 14, status: "OUT" }]));
  const s = r.suggestions.find((x) => x.type === "lineup");
  assert.ok(s, "expected a lineup swap");
  assert.equal(s.sit.name, "WR1");
  assert.equal(s.start.name, "BenchWR");
  assert.equal(s.priority, "high");
});
test("a starter on a bye is swapped out", () => {
  const team = baseTeam([{ name: "WR1", pos: 3, slot: 4, proj: 14, team: 8 }]);
  const gs = { ...allPre }; delete gs.DET; // DET has no game
  const r = run(team, [], { gameStateByTeam: gs });
  const s = r.suggestions.find((x) => x.type === "lineup");
  assert.ok(s && s.sit.name === "WR1" && /bye/i.test(s.reason));
});
test("a locked starter (game already started) is never swapped", () => {
  const team = baseTeam([{ name: "WR1", pos: 3, slot: 4, proj: 2, actual: 2, team: 8 }]);
  const r = run(team, [], { gameStateByTeam: { ...allPre, DET: "in" } });
  assert.ok(!r.suggestions.some((x) => x.sit && x.sit.name === "WR1"));
});
test("a good bench player beats a weak FLEX starter (FLEX accepts RB/WR/TE)", () => {
  const r = run(baseTeam([{ name: "BenchWR", pos: 3, slot: 20, proj: 18 }]));
  const s = r.suggestions.find((x) => x.type === "lineup");
  assert.ok(s && s.start.name === "BenchWR");
});

/* ---- pickups ---- */
test("a free agent who would NOT start is not suggested (bench-only upgrade is worthless)", () => {
  const r = run(baseTeam(), [{ name: "FA-WR-bench", pos: 3, proj: 8 }]); // beats BenchWR(6) but not any starter
  assert.ok(!r.suggestions.some((x) => x.type === "pickup"));
});
test("a free agent who would start is suggested, with no drop when roster room is open", () => {
  const r = run(baseTeam(), [{ name: "FA-WR-star", pos: 3, proj: 17 }]);
  const s = r.suggestions.find((x) => x.type === "pickup");
  assert.ok(s && s.add.name === "FA-WR-star" && !s.drop);
  assert.ok(s.gain >= 5 && s.gain <= 8, `gain was ${s.gain}`); // replaces the 9-pt FLEX2 -> ~+8 less rounding; must be marginal
});
test("a pickup's gain is the real marginal lineup gain (replaces the weakest eligible starter)", () => {
  const r = run(baseTeam(), [{ name: "FA-RB", pos: 2, proj: 13 }]);
  const s = r.suggestions.find((x) => x.type === "pickup");
  // lineup weakest eligible slot holder is FLEX2 (9) -> gain 13-9 = 4
  assert.equal(s.gain, 4);
});
test("at a position limit the drop must be the same position", () => {
  const eightWR = Array.from({ length: 6 }, (_, i) => ({ name: `ExtraWR${i}`, pos: 3, slot: 20, proj: 1 + i * 0.1 }));
  const r = run(baseTeam(eightWR), [{ name: "FA-WR-star", pos: 3, proj: 17 }]);
  const s = r.suggestions.find((x) => x.type === "pickup");
  assert.ok(s && s.drop && s.drop.pos === "WR", "should drop a WR to stay within the WR limit of 8");
});
test("a free agent whose game already started is not suggested", () => {
  const r = run(baseTeam(), [{ name: "Late-FA", pos: 3, proj: 25, team: 8 }], { gameStateByTeam: { ...allPre, DET: "in" } });
  assert.ok(!r.suggestions.some((x) => x.type === "pickup"));
});
test("a free agent on a bye is not suggested", () => {
  const gs = { ...allPre }; delete gs.DET;
  const r = run(baseTeam(), [{ name: "Bye-FA", pos: 3, proj: 25, team: 8 }], { gameStateByTeam: gs });
  assert.ok(!r.suggestions.some((x) => x.type === "pickup"));
});
test("injured free agents are handled: Out/Doubtful skipped, Questionable discounted with a caution", () => {
  const r = run(baseTeam(), [
    { name: "Out-FA", pos: 3, proj: 30, status: "OUT" },
    { name: "Doubtful-FA", pos: 3, proj: 30, status: "DOUBTFUL" },
    { name: "Q-FA", pos: 3, proj: 20, status: "QUESTIONABLE" },
  ]);
  const picks = r.suggestions.filter((x) => x.type === "pickup");
  assert.ok(picks.length === 1 && picks[0].add.name === "Q-FA" && picks[0].caution);
});
test("kickers are never suggested in a league with no kicker slot", () => {
  const r = run(baseTeam(), [{ name: "Kicker", pos: 5, proj: 15 }]);
  assert.ok(!r.suggestions.some((x) => x.add && x.add.pos === "K"));
});
test("a Defense upgrade is evaluated against the single DST slot", () => {
  const r = run(baseTeam(), [{ name: "Better-DST", pos: 16, proj: 12 }]);
  const s = r.suggestions.find((x) => x.type === "pickup");
  assert.ok(s && s.add.name === "Better-DST" && s.gain === 5);
});
test("two pickups don't both claim the same lineup slot", () => {
  const r = run(baseTeam(), [{ name: "DST-A", pos: 16, proj: 12 }, { name: "DST-B", pos: 16, proj: 11 }]);
  assert.equal(r.suggestions.filter((x) => x.type === "pickup").length, 1);
});

/* ---- IR ---- */
test("an OUT player is moved to an open IR slot", () => {
  const r = run(baseTeam([{ name: "BenchRB", pos: 2, slot: 20, proj: 5, status: "OUT" }]));
  assert.ok(r.suggestions.some((x) => x.type === "ir" && x.drop.name === "BenchRB"));
});
test("no IR suggestion when the IR slot is already full", () => {
  const r = run(baseTeam([{ name: "BenchRB", pos: 2, slot: 20, proj: 5, status: "OUT" }, { name: "AlreadyIR", pos: 2, slot: 21, proj: 0, status: "INJURY_RESERVE" }]));
  assert.ok(!r.suggestions.some((x) => x.type === "ir" && x.drop && x.drop.name === "BenchRB"));
});
test("a healthy player stuck on IR is flagged", () => {
  const r = run(baseTeam([{ name: "StuckIR", pos: 2, slot: 21, proj: 12 }]));
  assert.ok(r.suggestions.some((x) => x.type === "ir" && x.start && x.start.name === "StuckIR"));
});

/* ---- guard rails ---- */
test("no projections yet -> clear note, no suggestions", () => {
  const players = baseTeam().roster.entries.map((e) => ({ ...e }));
  const team = { name: "T", roster: { entries: players.map((e) => ({ ...e, playerPoolEntry: { player: { ...e.playerPoolEntry.player, stats: [] } } })) } };
  const r = run(team, [{ name: "X", pos: 3, proj: 20 }]);
  assert.equal(r.suggestions.length, 0);
  assert.match(r.note, /aren't published/);
});
test("week fully final -> clear note", () => {
  const gs = Object.fromEntries(Object.keys(allPre).map((k) => [k, "post"]));
  const r = run(baseTeam(), [{ name: "X", pos: 3, proj: 20 }], { gameStateByTeam: gs });
  assert.equal(r.suggestions.length, 0);
  assert.match(r.note, /final/);
});
test("a healthy, well-set lineup with nobody better available says so", () => {
  const r = run(baseTeam(), [{ name: "Meh", pos: 3, proj: 3 }]);
  assert.equal(r.suggestions.length, 0);
  assert.match(r.note, /already set up well/);
});
test("questionable starters are listed to watch", () => {
  const r = run(baseTeam([{ name: "RB1", pos: 2, slot: 2, proj: 15, status: "QUESTIONABLE" }]));
  assert.ok(r.watch.some((w) => w.name === "RB1"));
});
test("summary points are consistent (current <= after fixes <= after pickups)", () => {
  const r = run(baseTeam([{ name: "WR1", pos: 3, slot: 4, proj: 14, status: "OUT" }]), [{ name: "FA", pos: 3, proj: 17 }]);
  assert.ok(r.summary.current <= r.summary.afterLineupFixes && r.summary.afterLineupFixes <= r.summary.afterPickups);
});

/* ---- randomized stress test: invariants that must hold for ANY roster ---- */
test("300 random rosters: every suggestion obeys the rules", () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const STATUS = [undefined, undefined, undefined, "QUESTIONABLE", "DAY_TO_DAY", "DOUBTFUL", "OUT", "INJURY_RESERVE"];
  const SLOT_OK = { QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], FLEX: ["RB", "WR", "TE"], DST: ["DST"] };
  const posOf = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 16: "DST" };
  const covered = { lineupSwaps: 0, reshuffles: 0, pickups: 0, pickupsWithDrop: 0, irMoves: 0, empty: 0 };
  for (let iter = 0; iter < 300; iter++) {
    // 15-18 rostered players, a plausible starting lineup, rest on the bench / IR
    const slotPlan = [[0, 1], [2, 2], [4, 2], [6, 1], [23, 2], [16, 1]];
    const players = [];
    let id = 0;
    slotPlan.forEach(([slot, n]) => {
      for (let i = 0; i < n; i++) {
        const pos = slot === 0 ? 1 : slot === 2 ? 2 : slot === 4 ? 3 : slot === 6 ? 4 : slot === 16 ? 16 : pick([2, 3, 4]);
        players.push({ name: `R${id++}`, pos, slot, proj: Math.round(rnd() * 22), status: pick(STATUS), team: 1 + Math.floor(rnd() * 8) });
      }
    });
    for (let i = 0; i < 4 + Math.floor(rnd() * 5); i++) players.push({ name: `R${id++}`, pos: pick([1, 2, 3, 3, 4, 16]), slot: rnd() < 0.1 ? 21 : 20, proj: Math.round(rnd() * 18), status: pick(STATUS), team: 1 + Math.floor(rnd() * 8) });
    const team = { name: "T", roster: { entries: players.map(rosterEntry) } };
    const fas = Array.from({ length: 40 }, (_, i) => ({ name: `F${i}`, pos: pick([1, 2, 3, 3, 4, 5, 16]), proj: Math.round(rnd() * 24), status: pick(STATUS), team: 1 + Math.floor(rnd() * 8) }));
    const gs = { ...allPre };
    Object.keys(gs).forEach((k) => { const r = rnd(); if (r < 0.15) gs[k] = "in"; else if (r < 0.25) gs[k] = "post"; else if (r < 0.32) delete gs[k]; });
    const r = run(team, fas, { gameStateByTeam: gs });
    const tag = `iter ${iter}`;
    const rosterNames = new Set(players.map((p) => p.name));
    const seenAdds = new Set();
    let pickupGain = 0;
    if (r.suggestions.length === 0) covered.empty++;
    r.suggestions.forEach((s) => {
      if (s.type === "lineup") s.sit ? covered.lineupSwaps++ : covered.reshuffles++;
      if (s.type === "pickup") { covered.pickups++; if (s.drop) covered.pickupsWithDrop++; }
      if (s.type === "ir") covered.irMoves++;
      assert.ok(s.gain >= 0, `${tag}: negative gain`);
      assert.ok(["high", "medium", "low"].includes(s.priority), `${tag}: bad priority`);
      if (s.type === "lineup" && s.sit) {
        assert.ok(SLOT_OK[s.slot] && SLOT_OK[s.slot].includes(s.start.pos), `${tag}: ${s.start.pos} can't fill ${s.slot}`);
        assert.ok(rosterNames.has(s.start.name) && rosterNames.has(s.sit.name), `${tag}: swap uses non-rostered player`);
      }
      if (s.type === "pickup") {
        pickupGain += s.gain;
        assert.ok(!rosterNames.has(s.add.name), `${tag}: suggested a player already on the roster`);
        assert.ok(!seenAdds.has(s.add.name), `${tag}: same pickup suggested twice`);
        seenAdds.add(s.add.name);
        assert.notEqual(s.add.pos, "K", `${tag}: kicker suggested`);
        assert.ok(!/out|injured reserve|bye/i.test(s.add.status) || /questionable/i.test(s.add.status), `${tag}: unavailable player suggested (${s.add.status})`);
        assert.ok(s.gain >= 2, `${tag}: pickup below minimum gain`);
        if (s.drop) assert.ok(rosterNames.has(s.drop.name), `${tag}: dropped a non-rostered player`);
      }
    });
    if (r.summary) {
      assert.ok(r.summary.current <= r.summary.afterLineupFixes + 0.11, `${tag}: fixes lowered the score`);
      assert.ok(r.summary.afterLineupFixes <= r.summary.afterPickups + 0.11, `${tag}: pickups lowered the score`);
      assert.ok(Math.abs(r.summary.afterPickups - r.summary.afterLineupFixes - pickupGain) < 0.5, `${tag}: pickup gains (${pickupGain}) don't add up to the summary (${r.summary.afterPickups - r.summary.afterLineupFixes})`);
    }
  }
  console.log("      covered:", JSON.stringify(covered));
});

/* ---- real season performance (form) changes the decisions ---- */
test("a starter who has been scoring far below his projection is benched for a steadier bench player", () => {
  const cold = { name: "RB1", pos: 2, slot: 2, proj: 14, weeks: { 1: 2, 2: 2, 3: 2 }, pace: 14 };
  const steady = { name: "BenchRB", pos: 2, slot: 20, proj: 11.5, weeks: { 1: 12, 2: 12, 3: 12 }, pace: 11 };
  const withForm = run(baseTeam([cold, steady, { name: "FLEX1", pos: 3, slot: 23, proj: 12 }, { name: "FLEX2", pos: 2, slot: 23, proj: 12 }]));
  const swap = withForm.suggestions.find((x) => x.type === "lineup" && x.sit && x.sit.name === "RB1");
  assert.ok(swap && swap.start.name === "BenchRB", "expected RB1 to be benched");
  assert.match(swap.reason, /averaged/);
  // ...and WITHOUT the season history, nothing would change (14 beats 11.5) — proving the history is what drove it
  const noForm = run(baseTeam([{ ...cold, weeks: null, pace: null }, { ...steady, weeks: null, pace: null }, { name: "FLEX1", pos: 3, slot: 23, proj: 12 }, { name: "FLEX2", pos: 2, slot: 23, proj: 12 }]));
  assert.ok(!noForm.suggestions.some((x) => x.type === "lineup" && x.sit && x.sit.name === "RB1"));
});
test("a hot free agent is suggested even though ESPN projects him below your starter", () => {
  const hot = { name: "HotFA", pos: 3, proj: 8, weeks: { 1: 22, 2: 25, 3: 20 }, pace: 7 };
  const r = run(baseTeam(), [hot]);
  const s = r.suggestions.find((x) => x.type === "pickup");
  assert.ok(s && s.add.name === "HotFA", "expected the hot free agent to be added");
  assert.ok(s.add.exp > s.add.proj, "expected points should be above the raw projection");
  assert.equal(run(baseTeam(), [{ ...hot, weeks: null, pace: null }]).suggestions.filter((x) => x.type === "pickup").length, 0);
});
test("a cold free agent is NOT suggested even though ESPN projects him above your starter", () => {
  const cold = { name: "ColdFA", pos: 3, proj: 12.5, weeks: { 1: 2, 2: 2, 3: 2 }, pace: 12.5 };
  assert.equal(run(baseTeam(), [cold]).suggestions.filter((x) => x.type === "pickup").length, 0);
  assert.equal(run(baseTeam(), [{ ...cold, weeks: null, pace: null }]).suggestions.filter((x) => x.type === "pickup").length, 1);
});
test("when a drop is forced, the underperformer is the one cut", () => {
  const extras = [
    ...Array.from({ length: 4 }, (_, i) => ({ name: `FillWR${i}`, pos: 3, slot: 20, proj: 3 + i * 0.1, weeks: { 1: 3, 2: 3, 3: 3 }, pace: 3 })),
    { name: "ColdBench", pos: 3, slot: 20, proj: 3, weeks: { 1: 0.5, 2: 0.4, 3: 0.3 }, pace: 3.2 },
    { name: "SteadyBench", pos: 3, slot: 20, proj: 3, weeks: { 1: 6, 2: 6, 3: 6 }, pace: 3 },
  ];
  const r = run(baseTeam(extras), [{ name: "StarWR", pos: 3, proj: 18 }]);
  const s = r.suggestions.find((x) => x.type === "pickup");
  assert.ok(s && s.drop, "needs a drop at the WR limit");
  assert.equal(s.drop.name, "ColdBench", `should cut the player who has been scoring far below expectations (cut ${s.drop.name})`);
});
test("each card shows the player's real weekly points", () => {
  const r = run(baseTeam([{ name: "WR1", pos: 3, slot: 4, proj: 14, status: "OUT", weeks: { 1: 10, 2: 12, 3: 9 }, pace: 12 }]));
  const s = r.suggestions.find((x) => x.type === "lineup");
  assert.deepEqual(s.sit.form.weeks.map((w) => w.pts), [10, 12, 9]);
  assert.equal(s.sit.form.games, 3);
});
test("history saved by the backend is used when ESPN's own data lacks the weeks", () => {
  const cold = { name: "RB1", pos: 2, slot: 2, proj: 14, pace: 14 }; // no weekly stats on the player itself
  const steady = { name: "BenchRB", pos: 2, slot: 20, proj: 11.5, pace: 11 };
  const ids = {};
  const team = baseTeam([cold, steady, { name: "FLEX1", pos: 3, slot: 23, proj: 12 }, { name: "FLEX2", pos: 2, slot: 23, proj: 12 }]);
  team.roster.entries.forEach((e) => { ids[e.playerPoolEntry.player.fullName] = e.playerPoolEntry.player.id; });
  const history = (id) => (id === ids.RB1 ? { a: { 1: 2, 2: 2, 3: 2 } } : id === ids.BenchRB ? { a: { 1: 12, 2: 12, 3: 12 } } : null);
  const r = run(team, [], { history });
  assert.ok(r.suggestions.some((x) => x.type === "lineup" && x.sit && x.sit.name === "RB1"));
});

/* ---- win-driven decisions ---- */
// An opponent whose starters total roughly `total` points.
const oppTeam = (total) => ({ name: "Opponent", roster: { entries: [
  { name: "O-QB", pos: 1, slot: 0 }, { name: "O-RB1", pos: 2, slot: 2 }, { name: "O-RB2", pos: 2, slot: 2 }, { name: "O-WR1", pos: 3, slot: 4 }, { name: "O-WR2", pos: 3, slot: 4 },
  { name: "O-TE", pos: 4, slot: 6 }, { name: "O-F1", pos: 3, slot: 23 }, { name: "O-F2", pos: 2, slot: 23 }, { name: "O-DST", pos: 16, slot: 16 },
].map((p) => rosterEntry({ ...p, proj: total / 9 })) } });

test("with an opponent, results include win probability, and fixes never lower it", () => {
  const r = run(baseTeam([{ name: "WR1", pos: 3, slot: 4, proj: 14, status: "OUT" }]), [{ name: "FA", pos: 3, proj: 17 }], { opponent: { team: oppTeam(110) } });
  assert.ok(r.summary.win && r.summary.opponent.name === "Opponent");
  assert.ok(r.summary.win.current <= r.summary.win.afterLineupFixes + 1 && r.summary.win.afterLineupFixes <= r.summary.win.afterPickups + 1);
  r.suggestions.filter((x) => x.type !== "ir").forEach((x) => assert.ok(typeof x.winDelta === "number"));
  assert.ok(r.suggestions.find((x) => x.type === "lineup").winDelta > 0);
});
test("without an opponent, win probability is simply absent (no crash, no NaN)", () => {
  const r = run(baseTeam([{ name: "WR1", pos: 3, slot: 4, proj: 14, status: "OUT" }]));
  assert.equal(r.summary.win, null);
  assert.ok(r.suggestions.every((x) => x.winDelta == null));
});
test("an underdog takes the high-ceiling player, a favorite takes the safe floor", () => {
  // Two bench WRs with almost the same expected points; one is boom-or-bust, one is steady.
  const boom = { name: "Boom", pos: 3, slot: 20, proj: 10, weeks: { 1: 1, 2: 28, 3: 1 }, pace: 10 };
  const safe = { name: "Safe", pos: 3, slot: 20, proj: 10.3, weeks: { 1: 10, 2: 10.5, 3: 10 }, pace: 10.3 };
  const benchOnly = [{ name: "BenchWR", pos: 3, slot: 20, proj: 2 }, { name: "BenchRB", pos: 2, slot: 20, proj: 2 }];
  const weakFlex = [{ name: "FLEX1", pos: 3, slot: 23, proj: 6 }, { name: "FLEX2", pos: 2, slot: 23, proj: 6 }];
  const mk = () => baseTeam([boom, safe, ...benchOnly, ...weakFlex]);
  const underdog = run(mk(), [], { opponent: { team: oppTeam(170) } }); // opponent far stronger
  const favorite = run(mk(), [], { opponent: { team: oppTeam(70) } }); // opponent far weaker
  const started = (r) => r.suggestions.filter((x) => x.type === "lineup").flatMap((x) => (x.start ? [x.start.name] : x.moves ? x.moves.map((m) => m.start.name) : []));
  assert.ok(started(underdog).includes("Boom"), `underdog should start Boom: ${started(underdog)}`);
  assert.ok(started(favorite).includes("Safe") && !started(favorite).includes("Boom"), `favorite should start Safe: ${started(favorite)}`);
});
test("hot free agents who don't change your lineup yet show up in a 'rising' list", () => {
  const r = run(baseTeam(), [{ name: "Riser", pos: 3, proj: 5, weeks: { 1: 15, 2: 16, 3: 14 }, pace: 4 }, { name: "Plain", pos: 3, proj: 5 }]);
  assert.ok(r.rising.some((x) => x.name === "Riser") && !r.rising.some((x) => x.name === "Plain"));
});
test("'rising' only lists free agents close to cracking this team's lineup", () => {
  const r = run(baseTeam(), [
    { name: "Close", pos: 3, proj: 7, weeks: { 1: 14, 2: 15, 3: 14 }, pace: 5 }, // hot, expected ~9-10 vs weakest starter 9
    { name: "FarOff", pos: 3, proj: 2, weeks: { 1: 6, 2: 7, 3: 6 }, pace: 1 }, // hot but nowhere near a starting spot
  ]);
  assert.ok(r.rising.some((x) => x.name === "Close") || r.suggestions.some((x) => x.add && x.add.name === "Close"));
  assert.ok(!r.rising.some((x) => x.name === "FarOff"));
});
test("team names are trimmed (ESPN names often carry stray spaces)", () => {
  const team = baseTeam();
  team.name = "  Padded Name  ";
  const opp = oppTeam(110);
  opp.name = " Opp Padded ";
  const r = run(team, [], { opponent: { team: opp } });
  assert.equal(r.teamName, "Padded Name");
  assert.equal(r.summary.opponent.name, "Opp Padded");
});

/* ---- randomized stress test: with real-looking weekly history and opponents ---- */
test("200 random rosters with weekly history and opponents: every rule and number holds", () => {
  let seed = 987;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const STATUS = [undefined, undefined, undefined, "QUESTIONABLE", "DAY_TO_DAY", "DOUBTFUL", "OUT", "INJURY_RESERVE"];
  const hist = (proj) => (rnd() < 0.8 ? Object.fromEntries([1, 2, 3].filter(() => rnd() < 0.9).map((w) => [w, Math.round(Math.max(0, proj * (0.3 + rnd() * 1.6)) * 10) / 10])) : null);
  for (let iter = 0; iter < 200; iter++) {
    const plan = [[0, 1], [2, 2], [4, 2], [6, 1], [23, 2], [16, 1]];
    let id = 0;
    const mkTeam = (prefix) => {
      const players = [];
      plan.forEach(([slot, n]) => { for (let i = 0; i < n; i++) { const pos = slot === 0 ? 1 : slot === 2 ? 2 : slot === 4 ? 3 : slot === 6 ? 4 : slot === 16 ? 16 : pick([2, 3, 4]); const proj = Math.round(rnd() * 22); players.push({ name: `${prefix}${id++}`, pos, slot, proj, status: pick(STATUS), team: 1 + Math.floor(rnd() * 8), weeks: hist(proj), pace: proj * (0.7 + rnd() * 0.6) }); } });
      for (let i = 0; i < 5; i++) { const proj = Math.round(rnd() * 16); players.push({ name: `${prefix}${id++}`, pos: pick([1, 2, 3, 3, 4]), slot: 20, proj, status: pick(STATUS), team: 1 + Math.floor(rnd() * 8), weeks: hist(proj), pace: proj }); }
      return { name: prefix, roster: { entries: players.map(rosterEntry) } };
    };
    const team = mkTeam("T");
    const opponent = rnd() < 0.85 ? { team: mkTeam("O") } : null;
    const fas = Array.from({ length: 30 }, (_, i) => { const proj = Math.round(rnd() * 22); return { name: `F${i}`, pos: pick([1, 2, 3, 3, 4, 5, 16]), proj, status: pick(STATUS), team: 1 + Math.floor(rnd() * 8), weeks: hist(proj), pace: proj * (0.7 + rnd() * 0.6) }; });
    const gs = { ...allPre };
    Object.keys(gs).forEach((k) => { const r = rnd(); if (r < 0.15) gs[k] = "in"; else if (r < 0.25) gs[k] = "post"; else if (r < 0.32) delete gs[k]; });
    const r = run(team, fas, { gameStateByTeam: gs, opponent });
    const tag = `iter ${iter}`;
    const names = new Set(team.roster.entries.map((e) => e.playerPoolEntry.player.fullName));
    let pickupGain = 0;
    r.suggestions.forEach((s) => {
      assert.ok(Number.isFinite(s.gain) && s.gain >= 0, `${tag}: bad gain ${s.gain}`);
      if (s.winDelta != null) assert.ok(Number.isFinite(s.winDelta) && Math.abs(s.winDelta) <= 100, `${tag}: bad winDelta ${s.winDelta}`);
      if (s.type === "pickup") {
        pickupGain += s.gain;
        assert.ok(!names.has(s.add.name), `${tag}: suggested a rostered player`);
        assert.ok(s.add.pos !== "K", `${tag}: kicker`);
        assert.ok(s.gain >= 1, `${tag}: pickup below 1 point`);
        assert.ok(Number.isFinite(s.add.exp) && s.add.exp >= 0, `${tag}: bad expected points`);
        if (s.add.form) assert.ok(Math.abs(s.add.form.adj) <= Math.max(8, 0.4 * s.add.proj) + 1e-6, `${tag}: adjustment over cap`);
      }
    });
    if (r.summary) {
      assert.ok(r.summary.current <= r.summary.afterLineupFixes + 0.11 && r.summary.afterLineupFixes <= r.summary.afterPickups + 0.11, `${tag}: points went down`);
      assert.ok(Math.abs(r.summary.afterPickups - r.summary.afterLineupFixes - pickupGain) < 0.6, `${tag}: pickup gains don't add up`);
      if (r.summary.win) {
        const w = r.summary.win;
        [w.current, w.afterLineupFixes, w.afterPickups].forEach((x) => assert.ok(x >= 0 && x <= 100, `${tag}: win% out of range ${x}`));
        assert.ok(w.afterLineupFixes >= w.current - 2 && w.afterPickups >= w.afterLineupFixes - 2, `${tag}: win% dropped (${w.current} -> ${w.afterLineupFixes} -> ${w.afterPickups})`);
      }
    }
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
