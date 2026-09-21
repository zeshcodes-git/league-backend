// This file is the ONLY place that understands ESPN's raw data shapes
// (numeric position codes, nested roster entries, etc). Everything else
// in the app works with the simple, clean shape produced here — the
// same shape our original mock data used.

const PRO_TEAM_ABBREV = {
  0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL",
  7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV",
  14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ",
  21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB",
  28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

const DEFAULT_POSITION = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };

// ESPN lineup slot 20 = Bench, 21 = IR. Anything else is a starting slot.
const BENCH_SLOTS = new Set([20, 21]);
const isStarterSlot = (lineupSlotId) => !BENCH_SLOTS.has(lineupSlotId);

// A small fixed color palette so every team gets a stable color across
// reloads without needing ESPN to provide one.
const COLOR_PALETTE = ["#3FA34D", "#4C8FE3", "#E8963B", "#A85FD1", "#FF6B4A", "#2DBFC7", "#E85D8A", "#8B97A3", "#D4C43F", "#7B6BE0"];
const colorForTeam = (espnTeamId) => COLOR_PALETTE[espnTeamId % COLOR_PALETTE.length];

function ownerName(members, ownerIds) {
  const ownerId = Array.isArray(ownerIds) ? ownerIds[0] : ownerIds;
  const member = (members || []).find((m) => m.id === ownerId);
  if (!member) return "Unknown Owner";
  if (member.firstName) return `${member.firstName} ${member.lastName || ""}`.trim();
  return member.displayName || "Unknown Owner";
}

function streakValue(record) {
  const { streakType, streakLength } = record.overall;
  if (!streakLength) return 0;
  return streakType === "WIN" ? streakLength : -streakLength;
}

export function normalizeTeams(rawTeamsData) {
  const { teams, members } = rawTeamsData;
  return teams.map((t) => ({
    id: `t${t.id}`,
    espnTeamId: t.id,
    name: t.name.trim(),
    owner: ownerName(members, t.owners),
    color: colorForTeam(t.id),
    wins: t.record.overall.wins,
    losses: t.record.overall.losses,
    pointsFor: t.record.overall.pointsFor,
    pointsAgainst: t.record.overall.pointsAgainst,
    streak: streakValue(t.record),
  }));
}

// A player's stats array holds many entries (past weeks, season totals,
// actual AND projected). We need the ONE entry that's specifically this
// week's pregame projection, not just any statSourceId:1 entry.
function projectedTotal(stats, currentWeek, fallback) {
  const entry = (stats || []).find((s) => s.statSourceId === 1 && s.scoringPeriodId === currentWeek);
  return entry ? entry.appliedTotal : fallback;
}

// The top-level playerPoolEntry.appliedStatTotal field's exact scope isn't
// clearly documented by ESPN, and appears to reflect season-to-date rather
// than just the requested week — so for "this week's actual points" we
// pull the specific week's actual entry directly instead, the same
// reliable way projectedTotal above does for projections.
function actualTotal(stats, currentWeek, fallback) {
  const entry = (stats || []).find((s) => s.statSourceId === 0 && s.scoringPeriodId === currentWeek);
  return entry ? entry.appliedTotal : fallback;
}

function playerFromEntry(entry, currentWeek) {
  const p = entry.playerPoolEntry.player;
  const rawActual = entry.playerPoolEntry.appliedStatTotal || 0;
  const weekActual = actualTotal(p.stats, currentWeek, rawActual);
  return {
    id: `p${p.id}`,
    name: p.fullName,
    pos: DEFAULT_POSITION[p.defaultPositionId] || "FLEX",
    nflTeam: PRO_TEAM_ABBREV[p.proTeamId] || "FA",
    starter: isStarterSlot(entry.lineupSlotId),
    weekPts: Math.round(weekActual * 10) / 10,
    proj: Math.round(projectedTotal(p.stats, currentWeek, weekActual) * 10) / 10,
    status: p.injuryStatus === "ACTIVE" ? "Healthy" : p.injuryStatus || "Healthy",
  };
}

// rawRosterTeam is one entry from the /mRoster teams[] array.
export function normalizeRoster(rawRosterTeam, currentWeek) {
  return (rawRosterTeam.roster?.entries || []).map((e) => playerFromEntry(e, currentWeek));
}

// Rough rule of thumb: a fantasy player's actual score typically varies by
// something like 35-45% of their projection from week to week. This isn't
// derived from your league's real historical variance — it's a reasonable
// stand-in so win probability behaves like a real probability (spreads
// apart for lopsided projections, stays close for close ones) instead of
// a flat ratio of two numbers.
const PROJECTION_VOLATILITY = 0.4;

// playerStatsById maps a player's id to their full stats array, sourced
// from the mRoster view — the mMatchup view (which this function otherwise
// reads from) doesn't include enough detail to compute real projections.
function teamSideTotals(side, gameStateByTeam, playerStatsById, currentWeek) {
  const entries = side.rosterForCurrentScoringPeriod?.entries || [];
  const starters = entries.filter((e) => isStarterSlot(e.lineupSlotId));

  const actual = starters.reduce((sum, e) => sum + (e.playerPoolEntry.appliedStatTotal || 0), 0);

  // "Projected" here means "best current estimate of the final score": for
  // any starter whose real NFL game has already finished, their actual
  // score is locked in (zero remaining uncertainty) and used instead of
  // their now-stale pregame projection. Anyone still to play contributes
  // their projection AND some real variance, which is what lets win
  // probability behave like an actual probability instead of a ratio.
  let projected = 0;
  let variance = 0;
  const remainingPlayers = [];
  starters.forEach((e) => {
    const player = e.playerPoolEntry.player;
    const actualPts = e.playerPoolEntry.appliedStatTotal || 0;
    const abbrev = PRO_TEAM_ABBREV[player.proTeamId];
    const state = gameStateByTeam ? gameStateByTeam[abbrev] : undefined;
    if (state === "post") {
      projected += actualPts; // locked in — no more uncertainty left
      return;
    }
    const fullStats = playerStatsById ? playerStatsById[player.id] : null;
    const proj = projectedTotal(fullStats, currentWeek, actualPts);
    projected += proj;
    const sd = Math.max(proj, 0) * PROJECTION_VOLATILITY;
    variance += sd * sd;
    remainingPlayers.push({
      name: player.fullName,
      pos: DEFAULT_POSITION[player.defaultPositionId] || "FLEX",
      proj: Math.round(proj * 10) / 10,
    });
  });

  const top = [...starters]
    .map((e) => ({
      name: e.playerPoolEntry.player.fullName,
      pos: DEFAULT_POSITION[e.playerPoolEntry.player.defaultPositionId] || "FLEX",
      pts: Math.round((e.playerPoolEntry.appliedStatTotal || 0) * 10) / 10,
    }))
    .sort((a, b) => b.pts - a.pts)[0];

  return {
    actual: Math.round(actual * 10) / 10,
    projected: Math.round(projected * 10) / 10,
    variance,
    remainingPlayers,
    top: top || { name: "—", pos: "—", pts: 0 },
  };
}

// A fast, standard approximation of the normal distribution's CDF (accurate
// to within about 1%) — good enough for an estimate like this without
// needing a full statistics library.
function normalCdfApprox(z) {
  return 1 / (1 + Math.exp(-1.702 * z));
}

// Compares each team's likely-final-score distribution (mean ± real
// uncertainty) instead of just their raw projected totals — this is what
// makes win probability move sensibly with the size of the gap AND how
// much of the game is left to play, not just whoever's ahead by a hair.
function computeWinProbability(meanA, varA, meanB, varB) {
  const sd = Math.sqrt(varA + varB) || 1;
  const z = (meanA - meanB) / sd;
  return Math.round(normalCdfApprox(z) * 100);
}

// A fantasy roster side is "locked" once none of its starters have a game
// left to play this week — that's what actually decides a matchup, not
// whether the whole week's schedule has wrapped up.
function isSideLocked(entries, gameStateByTeam) {
  const starters = (entries || []).filter((e) => isStarterSlot(e.lineupSlotId));
  if (starters.length === 0) return false;
  return starters.every((e) => {
    const abbrev = PRO_TEAM_ABBREV[e.playerPoolEntry.player.proTeamId];
    const state = gameStateByTeam[abbrev];
    // No entry usually means that team is on a bye this week — nothing left
    // for them to play, so treat it as locked rather than stuck forever.
    return !state || state === "post";
  });
}

// currentWeek should be the league's current scoringPeriodId.
// gameStateByTeam maps each real NFL team's abbreviation to its game state
// this week ("pre" | "in" | "post"), used to figure out when a matchup is
// truly locked in even before ESPN's own fantasy flag catches up.
export function normalizeMatchups(rawMatchupData, currentWeek, gameStateByTeam = {}, playerStatsById = {}) {
  return rawMatchupData.schedule
    .filter((m) => m.matchupPeriodId === currentWeek)
    .map((m) => {
      const home = teamSideTotals(m.home, gameStateByTeam, playerStatsById, currentWeek);
      const away = teamSideTotals(m.away, gameStateByTeam, playerStatsById, currentWeek);
      const espnFinished = m.winner !== "UNDECIDED";
      const bothSidesLocked =
        isSideLocked(m.home.rosterForCurrentScoringPeriod?.entries, gameStateByTeam) &&
        isSideLocked(m.away.rosterForCurrentScoringPeriod?.entries, gameStateByTeam);
      const finished = espnFinished || bothSidesLocked;
      // Prefer ESPN's official total once it's actually populated; if we're
      // calling it finished ahead of ESPN but their total is still 0, fall
      // back to the real live/actual roster total instead of showing 0-0.
      const scoreA = finished && m.home.totalPoints > 0 ? m.home.totalPoints : home.actual;
      const scoreB = finished && m.away.totalPoints > 0 ? m.away.totalPoints : away.actual;
      // While the matchup is still live, base the odds on each team's
      // likely-final-score distribution (mean and real uncertainty) rather
      // than just a ratio of projections — see computeWinProbability above.
      const winProbA = finished
        ? scoreA >= scoreB ? 100 : 0
        : computeWinProbability(home.projected, home.variance, away.projected, away.variance);
      return {
        id: `m${m.id}`,
        teamAId: `t${m.home.teamId}`,
        teamBId: `t${m.away.teamId}`,
        scoreA,
        scoreB,
        projA: home.projected,
        projB: away.projected,
        remainingA: home.remainingPlayers,
        remainingB: away.remainingPlayers,
        winProbA,
        espnDecided: espnFinished,
        topA: home.top,
        topB: away.top,
        finished,
      };
    });
}

// ESPN returns this as a plain array of ~1000 players — both rostered and
// unrostered. We filter down to just the unclaimed ones (onTeamId is 0 or
// missing means nobody's fantasy team owns them), then sort by ownership
// percentage and cap the list at a reasonable size.
export function normalizeFreeAgents(raw) {
  const list = Array.isArray(raw) ? raw : raw.players || [];
  return list
    .filter((entry) => !entry.onTeamId || entry.onTeamId <= 0)
    .map((entry) => {
      const p = entry.player || entry;
      return {
        id: `p${p.id}`,
        name: p.fullName,
        pos: DEFAULT_POSITION[p.defaultPositionId] || "FLEX",
        nflTeam: PRO_TEAM_ABBREV[p.proTeamId] || "FA",
        percentOwned: p.ownership ? Math.round(p.ownership.percentOwned * 10) / 10 : null,
        percentChange: p.ownership ? Math.round(p.ownership.percentChange * 10) / 10 : null,
        outlook: p.seasonOutlook || null,
      };
    })
    .sort((a, b) => (b.percentOwned || 0) - (a.percentOwned || 0))
    .slice(0, 150);
}

export function normalizeNflGames(raw) {
  return (raw.events || []).map((ev) => {
    const comp = ev.competitions[0];
    const home = comp.competitors.find((c) => c.homeAway === "home");
    const away = comp.competitors.find((c) => c.homeAway === "away");
    return {
      id: ev.id,
      date: ev.date,
      state: comp.status.type.state, // "pre" | "in" | "post"
      statusText: comp.status.type.shortDetail || comp.status.type.detail,
      home: { name: home.team.shortDisplayName || home.team.displayName, abbrev: home.team.abbreviation, score: home.score },
      away: { name: away.team.shortDisplayName || away.team.displayName, abbrev: away.team.abbreviation, score: away.score },
    };
  });
}
