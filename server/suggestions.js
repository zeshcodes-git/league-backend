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
// What a player is expected to score blends ESPN's projection with his real
// week-by-week results this season (see playerForm.js), so players who are
// scoring well above or well below ESPN's expectation are treated accordingly.
//
// Moves are then judged on the thing that matters: the chance to WIN the
// matchup. The opponent's lineup is modeled too, and each player carries a
// realistic spread of outcomes — so an underdog is steered toward high-ceiling
// players and a favorite toward reliable floors.
//
// Pure functions (no network), so every rule is covered by tests.

import { PRO_TEAM_ABBREV, projectedTotal, actualTotal } from "./normalize.js";
import { buildForm, extractWeekly } from "./playerForm.js";

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

// Standard normal CDF (Abramowitz & Stegun 7.1.26).
function erf(x) {
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}
const normCdf = (z) => 0.5 * (1 + erf(z * Math.SQRT1_2));
export const winProbability = (mu, variance, muOpp, varOpp) => normCdf((mu - muOpp) / Math.sqrt(variance + varOpp + 1));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

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

  // Real season results: whatever ESPN sent with this player, merged with our
  // own saved week-by-week history (newest data wins).
  const saved = ctx.history ? ctx.history(p.id) : null;
  const fromRaw = extractWeekly(p, ctx.season, ctx.week - 1);
  const form = buildForm({
    weeks: { ...(saved ? saved.a : {}), ...fromRaw.weeks },
    pace: fromRaw.pace || (saved ? saved.pace : null),
    prevPpg: fromRaw.prevPpg || (saved ? saved.prev : null),
    proj,
    posId: p.defaultPositionId,
    lastWeek: ctx.week - 1,
  });

  const expected = form.exp * factor; // the form-adjusted, injury-adjusted expectation
  const exp = game === "post" ? actual : game === "in" ? Math.max(actual, expected) : expected;
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
    exp, // expected points this week (what we add up)
    value: exp, // what the lineup optimizer maximizes (adds a win-driven variance term later)
    sd: form.sd,
    // How much he's worth beyond this week: his estimated true level, blended with this week.
    outlook: 0.5 * exp + 0.5 * form.talent * (factor > 0 ? 1 : 0.5),
    form,
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

const card = (pl) => ({
  name: pl.name,
  pos: pl.pos,
  team: pl.team,
  proj: pl.proj,
  exp: round1(pl.exp),
  status: pl.statusText,
  form: pl.form.games
    ? { games: pl.form.games, seasonAvg: pl.form.seasonAvg, recentAvg: pl.form.recentAvg, pace: pl.form.pace != null ? round1(pl.form.pace) : null, adj: round1(pl.form.adj), trend: pl.form.trend, weeks: pl.form.weeks }
    : null,
});

// A sentence about how his real season is moving our expectation, when it matters.
function formNote(pl) {
  if (Math.abs(pl.form.adj) < 1) return null;
  const games = `${pl.form.games} game${pl.form.games === 1 ? "" : "s"}`;
  const expected = pl.form.pace ? ` (ESPN expected about ${round1(pl.form.pace)})` : "";
  const its = pl.pos === "DST" ? "its" : "his";
  return `${pl.name} has averaged ${pl.form.seasonAvg} over ${games}${expected}, so ${its} ${pl.proj} projection is adjusted ${pl.form.adj > 0 ? "up" : "down"} to ${round1(pl.form.exp)}.`;
}

const isStarterSlot = (slotId) => slotId != null && slotId !== BENCH && slotId !== IR;

/* ---------------- the advisor ---------------- */

export function buildSuggestions({ team, freeAgents, week, season, gameStateByTeam = {}, rules = DEFAULT_RULES, history = null, opponent = null }) {
  const counts = rules.lineupSlotCounts;
  const ctx = {
    week,
    season: season || new Date().getFullYear(),
    gameStateByTeam,
    hasSchedule: Object.keys(gameStateByTeam).length > 0,
    slotCounts: counts,
    history,
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

  const base = { teamName: String(team.name).trim(), week, league: leagueDescription };

  if (roster.every((p) => p.proj === 0)) {
    return { ...base, summary: null, suggestions: [], watch: [], rising: [], note: `Projections for Week ${week} aren't published yet — check back once ESPN posts them.` };
  }
  if (ctx.hasSchedule && Object.values(gameStateByTeam).every((s) => s === "post")) {
    return { ...base, summary: null, suggestions: [], watch: [], rising: [], note: `Every Week ${week} game is final, so there are no lineup moves left to make.` };
  }

  /* ---- lineup helpers ---- */
  const slotsToFill = (players) => {
    const open = [];
    lineupSlotIds.forEach((s) => {
      const lockedHere = players.filter((p) => p.slotId === s && p.locked).length;
      for (let i = 0; i < Math.max(0, counts[s] - lockedHere); i++) open.push(s);
    });
    return open;
  };
  const movable = (players) => players.filter((p) => !p.locked && p.slotId !== IR);
  const optimal = (players) => bestLineup(slotsToFill(players), movable(players));
  const lockedStarters = (players) => players.filter((p) => isStarterSlot(p.slotId) && p.locked);
  const unlockedStarters = (players) => players.filter((p) => isStarterSlot(p.slotId) && !p.locked);

  // Expected points and uncertainty of a lineup: the locked starters plus the chosen players.
  const summarize = (players, chosen) => {
    const fixed = lockedStarters(players);
    return {
      mu: fixed.reduce((a, p) => a + p.exp, 0) + chosen.reduce((a, p) => a + p.exp, 0),
      variance: fixed.reduce((a, p) => a + (p.game === "in" ? 0.5 * p.sd * p.sd : 0), 0) + chosen.reduce((a, p) => a + p.sd * p.sd, 0),
    };
  };
  const chosenOf = (picks) => picks.filter((x) => x.player).map((x) => x.player);
  const asSet = (players) => summarize(players, unlockedStarters(players));
  const asBest = (players) => summarize(players, chosenOf(optimal(players).picks));

  /* ---- the opponent, modeled the same way ---- */
  let opp = null;
  if (opponent && opponent.team) {
    const oppPlayers = (opponent.team.roster?.entries || []).map((e) => makePlayer(e, ctx));
    const setLineup = summarize(oppPlayers, unlockedStarters(oppPlayers));
    opp = { name: String(opponent.team.name).trim(), mu: setLineup.mu, variance: setLineup.variance };
  }
  const winPct = (sum) => (opp ? winProbability(sum.mu, sum.variance, opp.mu, opp.variance) : null);

  /* ---- win-driven risk preference ----
     Adding a player with mean m and variance v changes the win probability by roughly
     m/S - z*v/(2*S^2) (S = combined spread, z = how far ahead we are). So the value
     of a player is  m - (z / 2S) * v : when we're behind (z < 0) variance is a plus,
     when we're ahead it's a minus. */
  const best1 = optimal(roster);
  const sum1 = summarize(roster, chosenOf(best1.picks));
  let lam = 0;
  if (opp) {
    const S = Math.sqrt(sum1.variance + opp.variance + 1);
    const z = (sum1.mu - opp.mu) / S;
    lam = clamp(-z / (2 * S), -0.03, 0.03);
  }
  const applyLam = (list) => list.forEach((pl) => { pl.value = pl.locked ? pl.exp : pl.exp + lam * pl.sd * pl.sd; });
  applyLam(roster);
  applyLam(fas);

  const suggestions = [];
  const winDeltaOf = (before, after) => (opp ? Math.round((winProbability(after.mu, after.variance, opp.mu, opp.variance) - winProbability(before.mu, before.variance, opp.mu, opp.variance)) * 1000) / 10 : null);
  const priorityFor = (gain, winDelta, forced) => {
    const w = winDelta == null ? 0 : winDelta;
    return forced || gain >= 6 || w >= 8 ? "high" : gain >= 3 || w >= 4 ? "medium" : "low";
  };

  /* 1) Free lineup swaps — no waiver claim needed */
  const best0 = optimal(roster);
  const currentStarters = unlockedStarters(roster);
  const bestStarters = new Set(chosenOf(best0.picks).map((p) => p.id));
  const setNow = asSet(roster);
  const bestNow = summarize(roster, chosenOf(best0.picks));

  const ins = best0.picks
    .filter((x) => x.player && !currentStarters.some((c) => c.id === x.player.id))
    .map((x) => ({ player: x.player, slot: x.slot }))
    .sort((a, b) => b.player.value - a.player.value);
  const outs = currentStarters.filter((c) => !bestStarters.has(c.id)).sort((a, b) => a.value - b.value);

  const whyBenched = (out) => (out.factor < 1 ? `${out.name} is ${isPhrase(out)}` : `${out.name} projects for just ${round1(out.exp)}`);
  const pairs = [];
  const freeOuts = outs.slice();
  let direct = true;
  ins.forEach(({ player: inn }) => {
    const k = freeOuts.findIndex((o) => inn.eligible.has(o.slotId));
    if (k < 0) { direct = false; return; }
    pairs.push({ inn, out: freeOuts.splice(k, 1)[0] });
  });

  if (ins.length > 0 && direct && freeOuts.length === 0) {
    pairs.forEach(({ inn, out }) => {
      const gain = inn.exp - out.exp;
      const winDelta = winDeltaOf(setNow, { mu: setNow.mu + gain, variance: setNow.variance - out.sd * out.sd + inn.sd * inn.sd });
      if (gain < MIN_SWAP_GAIN && !(winDelta != null && winDelta >= 2)) return;
      if (gain <= 0 && !(winDelta != null && winDelta >= 2)) return;
      const notes = [formNote(inn), formNote(out)].filter(Boolean);
      const riskNote = lam > 0.004 && inn.sd > out.sd + 0.8 ? ` You're the underdog, so ${inn.name}'s higher ceiling helps.` : lam < -0.004 && inn.sd < out.sd - 0.8 ? ` You're the favorite, so ${inn.name}'s steadier floor helps.` : "";
      suggestions.push({
        type: "lineup",
        priority: priorityFor(gain, winDelta, out.factor === 0),
        gain: round1(gain),
        winDelta,
        title: `Start ${inn.name} over ${out.name}`,
        reason: `${whyBenched(out)}. ${inn.name} (${inn.pos}, ${round1(inn.exp)} expected${inn.factor < 1 ? `, ${isPhrase(inn)}` : ""}) can take his ${SLOT_LABEL[out.slotId] || "lineup"} spot — a free move from your bench.${riskNote}${notes.length ? " " + notes.join(" ") : ""}`,
        start: card(inn),
        sit: card(out),
        slot: SLOT_LABEL[out.slotId] || "lineup",
      });
    });
  } else if (ins.length > 0) {
    const gain = bestNow.mu - setNow.mu;
    const winDelta = winDeltaOf(setNow, bestNow);
    if (gain >= MIN_SWAP_GAIN || (winDelta != null && winDelta >= 2)) {
      const forced = outs.some((o) => o.factor === 0);
      suggestions.push({
        type: "lineup",
        priority: priorityFor(gain, winDelta, forced),
        gain: round1(gain),
        winDelta,
        title: `Re-set your lineup (+${round1(gain)} pts)`,
        reason:
          `${ins.map(({ player: p, slot }) => `Start ${p.name} (${p.pos}, ${round1(p.exp)} expected) at ${SLOT_LABEL[slot] || "lineup"}`).join("; ")}. ` +
          `${outs.length ? `Bench ${outs.map((o) => `${o.name} (${o.factor < 1 ? isPhrase(o) : round1(o.exp) + " expected"})`).join(", ")}.` : ""}`,
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
        winDelta: null,
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
        winDelta: null,
        title: `${p.name} looks healthy — he's still on your IR`,
        reason: `${p.name} is no longer listed as injured (${p.proj} proj) but is parked in an IR slot where he can't score. Move him to your bench or lineup.`,
        start: card(p),
      });
    });

  /* 3) Pickups — each judged on the lineup it creates */
  const limitFor = (posId) => (rules.positionLimits && rules.positionLimits[posId] != null ? rules.positionLimits[posId] : -1);
  const rosterLimit = rules.isBenchUnlimited ? Infinity : Object.entries(counts).filter(([s]) => Number(s) !== IR).reduce((a, [, n]) => a + n, 0);

  let working = roster.slice();
  let baseline = optimal(working).total;
  let baselineSummary = asBest(working);
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
      const atPosLimit = posLimit > 0 && samePos.length >= posLimit;
      const mustDrop = atPosLimit || nonIr.length >= rosterLimit;
      const addedRoster = [...working, { ...c, slotId: BENCH }];
      const options = [];
      if (!mustDrop) options.push({ drop: null, players: addedRoster });
      else {
        nonIr
          .filter((d) => d.droppable && !(isStarterSlot(d.slotId) && d.locked))
          .filter((d) => !atPosLimit || d.posId === c.posId)
          .forEach((d) => options.push({ drop: d, players: addedRoster.filter((x) => x.id !== d.id) }));
      }
      options.forEach((o) => { o.objective = optimal(o.players).total - baseline; });
      // Among drops that cost the same this week, cut the player with the weakest outlook
      // (long-term level, which reflects how he has actually been performing).
      const top = Math.max(...options.map((o) => o.objective));
      const near = options.filter((o) => o.objective >= top - 0.25);
      const pickOpt = near.sort((x, y) => (x.drop ? x.drop.outlook + x.drop.owned * 0.02 : -1) - (y.drop ? y.drop.outlook + y.drop.owned * 0.02 : -1))[0];
      if (pickOpt && (!bestMove || pickOpt.objective > bestMove.objective)) bestMove = { c, drop: pickOpt.drop, objective: pickOpt.objective, players: pickOpt.players };
    });
    if (!bestMove || bestMove.objective < MIN_PICKUP_GAIN) break;

    const before = optimal(working);
    const after = optimal(bestMove.players);
    const afterSummary = summarize(bestMove.players, chosenOf(after.picks));
    const gainPts = afterSummary.mu - baselineSummary.mu;
    if (gainPts < 1) break; // not a real points gain — don't recommend a pure variance play
    const winDelta = winDeltaOf(baselineSummary, afterSummary);
    const took = after.picks.find((x) => x.player && x.player.id === bestMove.c.id);
    const displaced = before.picks.map((x) => x.player).find((pl) => pl && !after.picks.some((y) => y.player && y.player.id === pl.id));
    const c = bestMove.c;
    const spot = took ? SLOT_LABEL[took.slot] || "lineup" : "lineup";
    const atLimit = limitFor(c.posId) > 0 && working.filter((p) => p.slotId !== IR && p.posId === c.posId).length >= limitFor(c.posId);
    const dropNote = bestMove.drop
      ? `${bestMove.drop.name} (${bestMove.drop.pos}) is the best player to cut${atLimit ? ` — your roster is at the ${limitFor(c.posId)}-${c.pos} limit` : ""}${bestMove.drop.form.trend === "cold" ? `; he has been scoring below expectations` : ""}.`
      : "You have open roster room, so no drop is required.";
    const notes = [formNote(c), bestMove.drop ? formNote(bestMove.drop) : null].filter(Boolean);
    suggestions.push({
      type: "pickup",
      priority: priorityFor(gainPts, winDelta, false),
      gain: round1(gainPts),
      winDelta,
      title: bestMove.drop ? `Add ${c.name}, drop ${bestMove.drop.name}` : `Add ${c.name}`,
      reason:
        `${c.name} (${c.pos}, ${c.team}) is expected to score ${round1(c.exp)} this week and would start in your ${spot} spot` +
        `${displaced ? `, replacing ${displaced.name} (${round1(displaced.exp)})` : ""} — ${round1(gainPts)} more points than your best current lineup. ${dropNote}` +
        `${notes.length ? " " + notes.join(" ") : ""}`,
      add: { ...card(c), owned: round1(c.owned) },
      ...(bestMove.drop ? { drop: card(bestMove.drop) } : {}),
      ...(c.factor < 1 ? { caution: `Listed ${c.statusText.toLowerCase()} — check his status before kickoff.` } : {}),
    });
    usedFa.add(c.id);
    working = bestMove.players.map((p) => (p.id === c.id ? { ...p, slotId: BENCH } : p));
    baseline = after.total;
    baselineSummary = afterSummary;
  }

  /* 4) Starters to keep an eye on, and free agents who are heating up */
  const watch = roster
    .filter((p) => isStarterSlot(p.slotId) && !p.locked && p.factor > 0 && p.factor < 1)
    .map((p) => ({ ...card(p), note: `Listed ${p.statusText.toLowerCase()} — check his status before kickoff and have a backup ready.` }));
  const suggestedIds = new Set(suggestions.filter((x) => x.add).map((x) => x.add.name));
  // Only free agents who are close to cracking THIS team's lineup (within 2.5 points
  // of the weakest starter they could replace) — otherwise it's just noise.
  const weakestStarterFor = (f) => {
    const rivals = unlockedStarters(roster).filter((s) => [...f.eligible].some((slot) => s.eligible.has(slot)));
    return rivals.length ? Math.min(...rivals.map((s) => s.exp)) : Infinity;
  };
  const rising = fas
    .filter((f) => f.game === "pre" && f.factor >= 0.85 && f.form.trend === "hot" && f.form.games >= 2 && f.eligible.size > 0 && limitFor(f.posId) !== 0 && !suggestedIds.has(f.name) && f.exp >= weakestStarterFor(f) - 2.5)
    .sort((a, b) => b.form.adj - a.form.adj)
    .slice(0, 4)
    .map((f) => ({ ...card(f), owned: round1(f.owned) }));

  const order = { high: 0, medium: 1, low: 2 };
  const typeOrder = { lineup: 0, ir: 1, pickup: 2 };
  suggestions.sort((a, b) => order[a.priority] - order[b.priority] || typeOrder[a.type] - typeOrder[b.type] || b.gain - a.gain);

  const pctRound = (x) => (x == null ? null : Math.round(x * 1000) / 10);
  return {
    ...base,
    summary: {
      current: round1(setNow.mu),
      afterLineupFixes: round1(bestNow.mu),
      afterPickups: round1(baselineSummary.mu),
      irOpen: irFree,
      win: opp ? { current: pctRound(winPct(setNow)), afterLineupFixes: pctRound(winPct(bestNow)), afterPickups: pctRound(winPct(baselineSummary)) } : null,
      opponent: opp ? { name: opp.name, projected: round1(opp.mu) } : null,
    },
    suggestions,
    watch,
    rising,
    note: suggestions.length === 0 ? "Your lineup is already set up well — no worthwhile moves right now." : null,
  };
}
