// Lineup & pickup advisor.
//
// Every suggestion is judged the same way: "how many more points does your
// BEST possible starting lineup score this week if you make this move?" That
// one yardstick is what keeps the advice honest — a pickup who would only ever
// sit on your bench is worth zero, no matter how good he looks on paper.
//
// It understands, from ESPN's own data and this league's real settings:
//   - the exact starting slots (e.g. 2 FLEX, no kicker) and who may fill each
//   - injuries (Out/IR = 0, Doubtful, Questionable, Day-to-Day are discounted)
//   - bye weeks
//   - games already started: those players are locked in place and can't be
//     moved, started, or usefully picked up for this week
//   - IR slots, position limits, and roster-size limits
//
// Pure functions (no network), so every rule is covered by tests.

import { PRO_TEAM_ABBREV, projectedTotal, actualTotal } from "./normalize.js";

const BENCH = 20;
const IR = 21;
const POS_LABEL = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };
const SLOT_LABEL = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 7: "OP", 16: "DST", 17: "K", 23: "FLEX" };

// How much of a player's projection to trust given his injury designation.
const STATUS_FACTOR = {
  ACTIVE: 1,
  QUESTIONABLE: 0.85,
  DAY_TO_DAY: 0.9,
  DOUBTFUL: 0.25,
  OUT: 0,
  INJURY_RESERVE: 0,
  SUSPENSION: 0,
  PUP: 0,
  NFI: 0,
};
const statusFactor = (s) => (s == null ? 1 : s in STATUS_FACTOR ? STATUS_FACTOR[s] : 0.9);
const prettyStatus = (s) => (s == null || s === "ACTIVE" ? "Healthy" : String(s).replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()));

export const MIN_PICKUP_GAIN = 2.0; // points this week; below this a move isn't worth the hassle
export const MIN_SWAP_GAIN = 1.0;
const round1 = (n) => Math.round(n * 10) / 10;

export const DEFAULT_RULES = {
  lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 16: 1, 17: 1, 23: 1, 20: 6, 21: 1 },
  positionLimits: {},
  isBenchUnlimited: true,
};

/* ---------------- optimal assignment (Hungarian algorithm) ---------------- */

// Minimum-cost assignment of n rows to m >= n columns. Returns the column per row.
function hungarian(cost) {
  const n = cost.length;
  const m = cost[0].length;
  const u = Array(n + 1).fill(0);
  const v = Array(m + 1).fill(0);
  const p = Array(m + 1).fill(0);
  const way = Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = Array(m + 1).fill(Infinity);
    const used = Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const rowToCol = Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) rowToCol[p[j] - 1] = j - 1;
  return rowToCol;
}

// Best way to fill `slots` (array of slot ids) from `players`. A slot nobody
// can fill scores 0. Returns { total, picks: [{ slot, player|null }] }.
export function bestLineup(slots, players) {
  if (slots.length === 0) return { total: 0, picks: [] };
  const BIG = 1e6;
  const cost = slots.map((slot) => [
    ...players.map((pl) => (pl.eligible.has(slot) ? -pl.value : BIG)),
    ...slots.map(() => 0), // "empty slot" placeholders
  ]);
  const cols = hungarian(cost);
  let total = 0;
  const picks = slots.map((slot, i) => {
    const pl = cols[i] < players.length ? players[cols[i]] : null;
    if (pl) total += pl.value;
    return { slot, player: pl };
  });
  return { total, picks };
}

/* ---------------- turning ESPN's raw entries into simple players ---------------- */

function makePlayer(entry, ctx) {
  const pp = entry.playerPoolEntry || entry;
  const p = pp.player || pp;
  const abbrev = PRO_TEAM_ABBREV[p.proTeamId];
  let game = "pre";
  if (ctx.hasSchedule) game = ctx.gameStateByTeam[abbrev] || "bye";
  const factor = game === "bye" ? 0 : statusFactor(p.injuryStatus);
  const proj = projectedTotal(p.stats, ctx.week, 0);
  const actual = actualTotal(p.stats, ctx.week);
  const locked = game === "in" || game === "post";
  const value = game === "post" ? actual : game === "in" ? Math.max(actual, proj * factor) : proj * factor;
  const eligible = new Set((p.eligibleSlots || []).filter((s) => ctx.slotCounts[s] > 0 && s !== BENCH && s !== IR));
  return {
    id: p.id,
    name: p.fullName,
    posId: p.defaultPositionId,
    pos: POS_LABEL[p.defaultPositionId] || "FLEX",
    team: abbrev || "FA",
    slotId: entry.lineupSlotId == null ? null : entry.lineupSlotId,
    status: p.injuryStatus,
    statusText: game === "bye" ? "Bye week" : prettyStatus(p.injuryStatus),
    factor,
    game,
    locked,
    proj: round1(proj),
    actual: round1(actual),
    value,
    eligible,
    owned: p.ownership ? p.ownership.percentOwned : 0,
    droppable: p.droppable !== false,
  };
}

// "is ___" wording for reasons
const isPhrase = (pl) =>
  pl.game === "bye" ? "on a bye" :
  pl.status === "INJURY_RESERVE" ? "on injured reserve" :
  pl.status === "OUT" ? "out" :
  pl.status === "DOUBTFUL" ? "doubtful" :
  pl.status === "QUESTIONABLE" ? "questionable" :
  pl.status === "DAY_TO_DAY" ? "day-to-day" :
  pl.status === "SUSPENSION" ? "suspended" : pl.statusText.toLowerCase();

const card = (pl) => ({ name: pl.name, pos: pl.pos, team: pl.team, proj: pl.proj, status: pl.statusText });
const isStarterSlot = (slotId) => slotId != null && slotId !== BENCH && slotId !== IR;

/* ---------------- the advisor ---------------- */

export function buildSuggestions({ team, freeAgents, week, gameStateByTeam = {}, rules = DEFAULT_RULES }) {
  const counts = rules.lineupSlotCounts;
  const ctx = {
    week,
    gameStateByTeam,
    hasSchedule: Object.keys(gameStateByTeam).length > 0,
    slotCounts: counts,
  };
  const entries = team.roster?.entries || [];
  let roster = entries.map((e) => makePlayer(e, ctx));
  const fas = freeAgents.map((e) => makePlayer(e, ctx));

  const lineupSlotIds = Object.keys(counts).map(Number).filter((s) => s !== BENCH && s !== IR && counts[s] > 0);
  const irCapacity = counts[IR] || 0;
  const leagueDescription =
    lineupSlotIds.map((s) => `${counts[s] > 1 ? counts[s] + " " : ""}${SLOT_LABEL[s] || "?"}`).join(", ") +
    ` · ${rules.isBenchUnlimited ? "unlimited bench" : (counts[BENCH] || 0) + " bench"}` +
    (irCapacity ? ` · ${irCapacity} IR` : "");

  const base = { teamName: team.name, week, league: leagueDescription };

  if (roster.every((p) => p.proj === 0)) {
    return { ...base, summary: null, suggestions: [], watch: [], note: `Projections for Week ${week} aren't published yet — check back once ESPN posts them.` };
  }
  if (ctx.hasSchedule && Object.values(gameStateByTeam).every((s) => s === "post")) {
    return { ...base, summary: null, suggestions: [], watch: [], note: `Every Week ${week} game is final, so there are no lineup moves left to make.` };
  }

  // Slots still open to change: all slots minus those held by locked starters.
  const slotsToFill = (players) => {
    const open = [];
    lineupSlotIds.forEach((s) => {
      const lockedHere = players.filter((p) => p.slotId === s && p.locked).length;
      for (let i = 0; i < Math.max(0, counts[s] - lockedHere); i++) open.push(s);
    });
    return open;
  };
  const fixedValue = (players) => players.filter((p) => isStarterSlot(p.slotId) && p.locked).reduce((a, p) => a + p.value, 0);
  const movable = (players) => players.filter((p) => !p.locked && p.slotId !== IR);
  const optimal = (players) => bestLineup(slotsToFill(players), movable(players));
  const currentValue = (players) =>
    players.filter((p) => isStarterSlot(p.slotId) && !p.locked).reduce((a, p) => a + p.value, 0);

  const suggestions = [];
  const priorityFor = (gain, forced) => (forced || gain >= 6 ? "high" : gain >= 3 ? "medium" : "low");

  /* 1) Free lineup swaps — no waiver claim needed */
  const best0 = optimal(roster);
  const currentStarters = roster.filter((p) => isStarterSlot(p.slotId) && !p.locked);
  const bestStarters = new Set(best0.picks.filter((x) => x.player).map((x) => x.player.id));
  // Who the best lineup adds (with the slot they'd take) and who it removes.
  const ins = best0.picks
    .filter((x) => x.player && !currentStarters.some((c) => c.id === x.player.id))
    .map((x) => ({ player: x.player, slot: x.slot }))
    .sort((a, b) => b.player.value - a.player.value);
  const outs = currentStarters.filter((c) => !bestStarters.has(c.id)).sort((a, b) => a.value - b.value);

  const reasonFor = (out) => (out.factor < 1 ? `${out.name} is ${isPhrase(out)}` : `${out.name} projects for just ${out.proj}`);
  const pairs = [];
  const freeOuts = outs.slice();
  let direct = true;
  ins.forEach(({ player: inn }) => {
    // Direct swap: the new player can sit in the exact spot the benched player vacates.
    const k = freeOuts.findIndex((o) => inn.eligible.has(o.slotId));
    if (k < 0) { direct = false; return; }
    pairs.push({ inn, out: freeOuts.splice(k, 1)[0] });
  });

  if (ins.length > 0 && direct && freeOuts.length === 0) {
    pairs.forEach(({ inn, out }) => {
      const gain = inn.value - out.value;
      if (gain < MIN_SWAP_GAIN) return;
      suggestions.push({
        type: "lineup",
        priority: priorityFor(gain, out.factor === 0),
        gain: round1(gain),
        title: `Start ${inn.name} over ${out.name}`,
        reason: `${reasonFor(out)}. ${inn.name} (${inn.pos}, ${inn.proj} proj${inn.factor < 1 ? `, ${isPhrase(inn)}` : ""}) can take his ${SLOT_LABEL[out.slotId] || "lineup"} spot — a free move from your bench.`,
        start: card(inn),
        sit: card(out),
        slot: SLOT_LABEL[out.slotId] || "lineup",
      });
    });
  } else if (ins.length > 0) {
    // The improvement needs a few players shifting between spots (e.g. a WR into a FLEX
    // while a TE moves up), so show the moves as one combined lineup change.
    const gain = best0.total - currentValue(roster);
    if (gain >= MIN_SWAP_GAIN) {
      const forced = outs.some((o) => o.factor === 0);
      suggestions.push({
        type: "lineup",
        priority: priorityFor(gain, forced),
        gain: round1(gain),
        title: `Re-set your lineup (+${round1(gain)} pts)`,
        reason:
          `${ins.map(({ player: p, slot }) => `Start ${p.name} (${p.pos}, ${p.proj}) at ${SLOT_LABEL[slot] || "lineup"}`).join("; ")}. ` +
          `${outs.length ? `Bench ${outs.map((o) => `${o.name} (${o.factor < 1 ? isPhrase(o) : o.proj + " proj"})`).join(", ")}.` : ""}`,
        moves: ins.map(({ player: p, slot }) => ({ start: card(p), slot: SLOT_LABEL[slot] || "lineup" })),
        bench: outs.map(card),
      });
    }
  }

  /* 2) IR housekeeping */
  const irUsed = roster.filter((p) => p.slotId === IR).length;
  let irFree = Math.max(0, irCapacity - irUsed);
  roster
    .filter((p) => p.slotId !== IR && !p.locked && (p.status === "OUT" || p.status === "INJURY_RESERVE"))
    .sort((a, b) => b.proj - a.proj)
    .forEach((p) => {
      if (irFree <= 0) return;
      irFree -= 1;
      suggestions.push({
        type: "ir",
        priority: "low",
        gain: 0,
        title: `Move ${p.name} to IR`,
        reason: `${p.name} is ${isPhrase(p)}. Moving him to your open IR slot frees a roster spot at no cost (if your league allows ${p.status === "OUT" ? "players listed out" : "injured reserve players"} on IR).`,
        drop: card(p),
      });
    });
  roster
    .filter((p) => p.slotId === IR && p.factor >= 0.85 && p.game !== "bye" && p.proj > 0)
    .forEach((p) => {
      suggestions.push({
        type: "ir",
        priority: "medium",
        gain: 0,
        title: `${p.name} looks healthy — he's still on your IR`,
        reason: `${p.name} is no longer listed as injured (${p.proj} proj) but is parked in an IR slot where he can't score. Move him to your bench or lineup.`,
        start: card(p),
      });
    });

  /* 3) Pickups — each judged by how much it improves the best lineup */
  const limitFor = (posId) => (rules.positionLimits && rules.positionLimits[posId] != null ? rules.positionLimits[posId] : -1);
  const rosterLimit = rules.isBenchUnlimited ? Infinity : Object.entries(counts).filter(([s]) => Number(s) !== IR).reduce((a, [, n]) => a + n, 0);

  let working = roster.slice();
  let baseline = optimal(working).total;
  const usedFa = new Set();
  const pool = fas
    .filter((f) => f.game === "pre" && f.factor >= 0.85 && f.eligible.size > 0 && f.value > 0 && limitFor(f.posId) !== 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 60);

  for (let round = 0; round < 4; round++) {
    const nonIr = working.filter((p) => p.slotId !== IR);
    let bestMove = null;
    pool.forEach((c) => {
      if (usedFa.has(c.id)) return;
      const posLimit = limitFor(c.posId);
      const samePos = nonIr.filter((p) => p.posId === c.posId);
      const mustDrop = (posLimit > 0 && samePos.length >= posLimit) || nonIr.length >= rosterLimit;
      const addedRoster = [...working, { ...c, slotId: BENCH }];
      const options = [];
      if (!mustDrop) options.push({ drop: null, players: addedRoster });
      else {
        nonIr
          .filter((d) => d.droppable && !(isStarterSlot(d.slotId) && d.locked))
          .filter((d) => !(posLimit > 0 && samePos.length >= posLimit) || d.posId === c.posId)
          .forEach((d) => options.push({ drop: d, players: addedRoster.filter((x) => x.id !== d.id) }));
      }
      options.forEach((o) => {
        const gain = optimal(o.players).total - baseline;
        const keep = o.drop ? o.drop.owned * 0.05 + o.drop.proj * 0.1 : 0; // tie-break: drop the least valuable player
        const score = gain - keep * 0.01;
        if (!bestMove || score > bestMove.score) bestMove = { c, drop: o.drop, gain, score, players: o.players };
      });
    });
    if (!bestMove || bestMove.gain < MIN_PICKUP_GAIN) break;

    const before = optimal(working);
    const after = optimal(bestMove.players);
    const took = after.picks.find((x) => x.player && x.player.id === bestMove.c.id);
    const displaced = before.picks.map((x) => x.player).find((pl) => pl && !after.picks.some((y) => y.player && y.player.id === pl.id));
    const c = bestMove.c;
    const spot = took ? SLOT_LABEL[took.slot] || "lineup" : "lineup";
    suggestions.push({
      type: "pickup",
      priority: priorityFor(bestMove.gain, false),
      gain: round1(bestMove.gain),
      title: bestMove.drop ? `Add ${c.name}, drop ${bestMove.drop.name}` : `Add ${c.name}`,
      reason:
        `${c.name} (${c.pos}, ${c.team}) is projected for ${c.proj} points this week and would start in your ${spot} spot` +
        `${displaced ? `, replacing ${displaced.name} (${displaced.proj})` : ""} — ${round1(bestMove.gain)} more points than your best current lineup. ` +
        (bestMove.drop
          ? `${bestMove.drop.name} (${bestMove.drop.pos}) is the least costly player to cut${limitFor(c.posId) > 0 && working.filter((p) => p.slotId !== IR && p.posId === c.posId).length >= limitFor(c.posId) ? ` — your roster is at the ${limitFor(c.posId)}-${c.pos} limit` : ""}.`
          : "You have open roster room, so no drop is required."),
      add: { ...card(c), owned: round1(c.owned) },
      ...(bestMove.drop ? { drop: card(bestMove.drop) } : {}),
      ...(c.factor < 1 ? { caution: `Listed ${c.statusText.toLowerCase()} — check his status before kickoff.` } : {}),
    });
    usedFa.add(c.id);
    working = bestMove.players.map((p) => (p.id === c.id ? { ...p, slotId: BENCH } : p));
    baseline = after.total;
  }

  /* 4) Starters to keep an eye on */
  const watch = roster
    .filter((p) => isStarterSlot(p.slotId) && !p.locked && p.factor > 0 && p.factor < 1)
    .map((p) => ({ ...card(p), note: `Listed ${p.statusText.toLowerCase()} — check his status before kickoff and have a backup ready.` }));

  const fixed = fixedValue(roster);
  const order = { high: 0, medium: 1, low: 2 };
  const typeOrder = { lineup: 0, ir: 1, pickup: 2 };
  suggestions.sort((a, b) => order[a.priority] - order[b.priority] || typeOrder[a.type] - typeOrder[b.type] || b.gain - a.gain);

  return {
    ...base,
    summary: {
      current: round1(fixed + currentValue(roster)),
      afterLineupFixes: round1(fixed + best0.total),
      afterPickups: round1(fixed + baseline),
      irOpen: irFree,
    },
    suggestions,
    watch,
    note: suggestions.length === 0 ? "Your lineup is already set up well — no worthwhile moves right now." : null,
  };
}
