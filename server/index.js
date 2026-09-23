import "dotenv/config";
import express from "express";
import cors from "cors";
import { fetchLeague, fetchFreeAgents, fetchNflScoreboard } from "./espnClient.js";
import { normalizeTeams, normalizeMatchups, normalizeRoster, normalizeFreeAgents, normalizeNflGames } from "./normalize.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

// --- Persistent storage (Upstash) ---
// Everything else in this file keeps its state in memory, which gets wiped
// every time the server restarts (every deploy, or after 15 minutes of no
// traffic on Render's free tier). These two helpers let us keep a few
// important things — like "what happened last week" — around permanently,
// by storing them in a free hosted Redis database instead. If Upstash isn't
// configured, these just quietly do nothing rather than break the app.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function kvGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(UPSTASH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(["GET", key]),
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch (err) {
    console.warn("[kvGet] failed:", err.message);
    return null;
  }
}

async function kvSet(key, value) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(UPSTASH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(["SET", key, JSON.stringify(value)]),
    });
  } catch (err) {
    console.warn("[kvSet] failed:", err.message);
  }
}

// Quick sanity check — hit this first to confirm the server itself is running,
// with no ESPN call involved yet.
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    leagueIdConfigured: Boolean(process.env.ESPN_LEAGUE_ID),
    seasonConfigured: Boolean(process.env.ESPN_SEASON),
    privateLeagueCookiesConfigured: Boolean(process.env.ESPN_S2 && process.env.ESPN_SWID),
    persistentStorageConfigured: Boolean(UPSTASH_URL && UPSTASH_TOKEN),
  });
});

// --- Clean, translated data for the website to actually use ---

// In-memory history of win-probability snapshots, so the Kalshi Odds tab
// can chart how each matchup's odds move over time. Resets when the
// server restarts — good enough for now; could be written to a file
// later if you want it to survive restarts.
let oddsSnapshots = (await kvGet("oddsSnapshots")) || [];

// Cache of the last successfully computed dashboard, so /api/dashboard can
// respond instantly from whatever the background timer last captured,
// instead of every page load triggering its own ESPN calls.
let latestDashboard = null;
// Cached separately so the standalone roster endpoint (which runs outside
// the main refresh cycle) can mark which players have already started
// their real NFL game.
let cachedGameStateByTeam = {};
// The full raw mRoster response from the main refresh cycle, shared with
// the roster-detail and waiver-suggestions endpoints below instead of
// each independently re-fetching the exact same data from ESPN.
let cachedRosterRaw = null;

// Once a week is fully finished, we keep it here — this is what lets News
// and the "hold" window below keep showing a completed week's real results
// even after the fantasy schedule has already moved on to the next one.
let lastCompletedWeekSnapshot = (await kvGet("lastCompletedWeek")) || null; // { week, weekStart, teams, matchups }

// A running log of EVERY completed week this season (not just the most
// recent one) — this is what lets us compute season-long analytics like
// Clutch Record, Consistency, All-Play Record, and a Championship Odds
// trend, instead of only ever seeing the current or last week in isolation.
let seasonHistory = (await kvGet("seasonHistory")) || []; // [{ week, teams, matchups }, ...]

// True once it's Wednesday 12pm Pacific or later (or any day after
// Wednesday) — the traditional "waiver Wednesday" cutoff. Before that,
// we keep showing last week's finished results instead of jumping ahead
// to the new week the moment ESPN advances its own scoring period.
function isPastWednesdayNoonPacific() {
  const pacificNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const day = pacificNow.getDay(); // 0=Sun ... 3=Wed ... 6=Sat
  const hour = pacificNow.getHours();
  if (day > 3) return true;
  if (day < 3) return false;
  return hour >= 12;
}

// The mMatchup view doesn't include each player's full stats breakdown
// (including their pregame projection) — only mRoster does. That fetch is
// by far the largest and most expensive one we make (full season-long
// stats history for every rostered player), and player projections don't
// meaningfully change minute to minute — so it's refreshed on its own,
// much slower cadence instead of every time the live-score cycle runs.
let cachedPlayerStatsById = {};
let playerStatsCachedAt = 0;
const PLAYER_STATS_CACHE_MS = 10 * 60 * 1000; // 10 minutes

async function refreshPlayerStatsIfStale() {
  const now = Date.now();
  if (cachedRosterRaw && now - playerStatsCachedAt < PLAYER_STATS_CACHE_MS) return;
  try {
    const rosterRaw = await fetchLeague(["mRoster", "mTeam"]);
    cachedRosterRaw = rosterRaw;
    const fresh = {};
    (rosterRaw.teams || []).forEach((t) => {
      (t.roster?.entries || []).forEach((e) => {
        const p = e.playerPoolEntry.player;
        fresh[p.id] = p.stats;
      });
    });
    cachedPlayerStatsById = fresh;
    playerStatsCachedAt = now;
  } catch (err) {
    // If this fails, projections just fall back to whatever was cached
    // before (or actual-so-far if nothing's cached yet) — not ideal, but
    // shouldn't break the whole dashboard.
    console.warn("[player stats refresh] failed:", err.message);
  }
}

// The NFL scoreboard is requested by three different places (the main
// refresh cycle, waiver suggestions, and the NFL Scores page) — shared
// here with a short cache instead of each independently re-fetching it.
let cachedNflByKey = {};
const NFL_CACHE_MS = 60 * 1000;

async function getNflScoreboard(week, seasonYear) {
  const key = `${week || "default"}-${seasonYear || "default"}`;
  const cached = cachedNflByKey[key];
  if (cached && Date.now() - cached.at < NFL_CACHE_MS) return cached.data;
  const data = await fetchNflScoreboard(week, seasonYear);
  cachedNflByKey[key] = { data, at: Date.now() };
  return data;
}

// Does the actual work: fetches fresh data from ESPN, figures out which
// matchups are really decided, and records a snapshot. Called both by the
// timer below (automatically, every few minutes) and by /api/dashboard
// directly (as a fallback if the timer hasn't run yet).
async function refreshDashboard() {
  const teamsRaw = await fetchLeague(["mTeam", "mStandings"]);
  const currentWeek = teamsRaw.scoringPeriodId;
  const matchupRaw = await fetchLeague(["mMatchup", "mTeam"]);

  await refreshPlayerStatsIfStale();
  const playerStatsById = cachedPlayerStatsById;

  // ESPN's fantasy system can take hours after the last game ends to
  // officially mark matchups as decided (it waits out a stat-correction
  // window). We can figure out sooner, per matchup, whether it's actually
  // locked in by checking whether every starter's real NFL team is done
  // playing this week.
  let gameStateByTeam = {};
  let weekStart = null;
  try {
    const nflRaw = await getNflScoreboard(currentWeek, process.env.ESPN_SEASON);
    const events = nflRaw.events || [];
    events.forEach((ev) => {
      const comp = ev.competitions[0];
      comp.competitors.forEach((c) => {
        gameStateByTeam[c.team.abbreviation] = comp.status.type.state; // "pre" | "in" | "post"
      });
    });
    if (events.length) {
      weekStart = events.reduce((earliest, ev) => (new Date(ev.date) < new Date(earliest) ? ev.date : earliest), events[0].date);
    }
  } catch {
    // If this lookup fails for any reason, just fall back to ESPN's own
    // fantasy flag below — don't let it break the whole dashboard.
  }
  cachedGameStateByTeam = gameStateByTeam;

  const matchups = normalizeMatchups(matchupRaw, currentWeek, gameStateByTeam, playerStatsById);
  const teams = normalizeTeams(teamsRaw);

  const weekComplete = matchups.length > 0 && matchups.every((m) => m.finished);

  // ESPN's own team win-loss record lags behind the matchup winner flag by
  // even more than the matchup flag lags behind the real games. So: once
  // EVERY matchup this week is actually decided, apply all those results
  // onto the team records ourselves in one go. This is what makes
  // Standings, Power Rankings, Analytics, and Awards all update together
  // instead of just the matchup cards.
  //
  // Deliberately gated on the WHOLE week (weekComplete), not each matchup
  // individually — otherwise teams whose game finishes early (Thursday
  // night, say) would show an updated record while everyone else is still
  // sitting on last week's, which looks inconsistent on Standings. Instead
  // everyone's record stays frozen at last week's value until the entire
  // week is decided, then updates all at once — which in a normal week
  // lines up with Monday Night Football wrapping up.
  //
  // One honest limit: this can't reconstruct each team's win/loss STREAK,
  // since that needs the full sequence of past results, not just this
  // week's outcome — streaks will still reflect ESPN's own (slower) number
  // until ESPN's record catches up.
  if (weekComplete) {
    const teamById = (id) => teams.find((t) => t.id === id);
    matchups.forEach((m) => {
      if (m.espnDecided) return; // already reflected in ESPN's own record
      const a = teamById(m.teamAId);
      const b = teamById(m.teamBId);
      if (!a || !b) return;
      a.pointsFor = Math.round((a.pointsFor + m.scoreA) * 10) / 10;
      a.pointsAgainst = Math.round((a.pointsAgainst + m.scoreB) * 10) / 10;
      b.pointsFor = Math.round((b.pointsFor + m.scoreB) * 10) / 10;
      b.pointsAgainst = Math.round((b.pointsAgainst + m.scoreA) * 10) / 10;
      if (m.scoreA > m.scoreB) {
        a.wins += 1;
        b.losses += 1;
      } else if (m.scoreB > m.scoreA) {
        b.wins += 1;
        a.losses += 1;
      }
    });
  }

  // Always record the TRUE current week's odds snapshots, regardless of
  // any display hold below — Kalshi Odds should keep tracking real time.
  oddsSnapshots.push({
    time: Date.now(),
    week: currentWeek,
    matchups: matchups.map((m) => ({ id: m.id, winProbA: m.winProbA })),
  });
  if (oddsSnapshots.length > 2000) oddsSnapshots.shift();
  await kvSet("oddsSnapshots", oddsSnapshots);

  if (weekComplete && (!lastCompletedWeekSnapshot || lastCompletedWeekSnapshot.week !== currentWeek)) {
    lastCompletedWeekSnapshot = { week: currentWeek, weekStart, teams, matchups };
    kvSet("lastCompletedWeek", lastCompletedWeekSnapshot);
  }
  if (weekComplete && !seasonHistory.some((w) => w.week === currentWeek)) {
    seasonHistory = [...seasonHistory, { week: currentWeek, teams, matchups }].sort((x, y) => x.week - y.week);
    kvSet("seasonHistory", seasonHistory);
  }

  // Hold the display on last week's fully-wrapped results until the
  // following Wednesday at noon Pacific, so people have a couple of days
  // to actually see and reflect on how the week turned out before the
  // site moves on to the next one.
  let displayWeek = currentWeek;
  let displayWeekStart = weekStart;
  let displayTeams = teams;
  let displayMatchups = matchups;
  if (
    !isPastWednesdayNoonPacific() &&
    lastCompletedWeekSnapshot &&
    lastCompletedWeekSnapshot.week === currentWeek - 1
  ) {
    displayWeek = lastCompletedWeekSnapshot.week;
    displayWeekStart = lastCompletedWeekSnapshot.weekStart;
    displayTeams = lastCompletedWeekSnapshot.teams;
    displayMatchups = lastCompletedWeekSnapshot.matchups;
  }

  // Only send lastCompletedWeek separately when it's ACTUALLY different
  // from what's already in teams/matchups above — during the hold window,
  // they're the exact same snapshot, so sending it twice under two keys
  // would just double that part of the payload for no reason. Every
  // frontend consumer already checks weekIsComplete() first (true during
  // a hold), so it never actually needs this field in that case anyway.
  const lastCompletedWeekForResponse =
    lastCompletedWeekSnapshot && lastCompletedWeekSnapshot.week !== displayWeek
      ? { week: lastCompletedWeekSnapshot.week, teams: lastCompletedWeekSnapshot.teams, matchups: lastCompletedWeekSnapshot.matchups }
      : null;

  // Same idea for liveMatchups/liveWeek — only meaningfully different from
  // matchups/currentWeek while a hold is actually active. Most of the
  // week there's no hold, so this avoids sending the whole matchups array
  // twice; the frontend already falls back to matchups/currentWeek when
  // these aren't present.
  const holdActive = displayWeek !== currentWeek;

  latestDashboard = {
    currentWeek: displayWeek,
    weekStart: displayWeekStart,
    teams: displayTeams,
    matchups: displayMatchups,
    lastCompletedWeek: lastCompletedWeekForResponse,
    ...(holdActive ? { liveWeek: currentWeek, liveMatchups: matchups } : {}),
  };
  return latestDashboard;
}

// Capture a snapshot automatically every 60 seconds, all on its own — this
// is what actually builds real odds history throughout game day, whether
// or not anyone has the site open. Only starts once ESPN credentials are
// configured, so it doesn't spam errors while you're still setting up.
//
// This cycle itself is now cheap: the expensive full-roster fetch (by far
// the largest one) runs on its own much slower 10-minute cache instead of
// every cycle, so this interval mainly just keeps live scores current.
if (process.env.ESPN_LEAGUE_ID && process.env.ESPN_SEASON) {
  refreshDashboard().catch((err) => console.warn("[background refresh] failed:", err.message));
  setInterval(() => {
    refreshDashboard().catch((err) => console.warn("[background refresh] failed:", err.message));
  }, 60 * 1000);
}

// Teams + this week's matchups, in the same shape the mock data used.
app.get("/api/dashboard", async (req, res) => {
  try {
    // Serve the latest background-captured snapshot if we have one — keeps
    // page loads fast and avoids hammering ESPN on every single visit.
    if (latestDashboard) return res.json(latestDashboard);
    const dashboard = await refreshDashboard();
    res.json(dashboard);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full roster for one team, by its ESPN team id (the number, not "t1").
app.get("/api/team/:espnTeamId/roster", async (req, res) => {
  try {
    const rosterRaw = cachedRosterRaw || (await fetchLeague(["mRoster", "mTeam"]));
    const team = rosterRaw.teams.find((t) => String(t.id) === req.params.espnTeamId);
    if (!team) return res.status(404).json({ error: "No team with that ESPN team id" });
    res.json({ roster: normalizeRoster(team, rosterRaw.scoringPeriodId, cachedGameStateByTeam) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Waiver-wire / free-agent players.
let cachedFreeAgentsRaw = null;
let freeAgentsCachedAt = 0;
const FREE_AGENTS_CACHE_MS = 5 * 60 * 1000; // ownership % and outlooks don't change fast enough to justify fetching fresh every 30 seconds

async function getFreeAgentsRaw() {
  const now = Date.now();
  if (cachedFreeAgentsRaw && now - freeAgentsCachedAt < FREE_AGENTS_CACHE_MS) return cachedFreeAgentsRaw;
  cachedFreeAgentsRaw = await fetchFreeAgents();
  freeAgentsCachedAt = now;
  return cachedFreeAgentsRaw;
}

app.get("/api/free-agents", async (req, res) => {
  try {
    const raw = await getFreeAgentsRaw();
    const currentWeek = latestDashboard ? latestDashboard.liveWeek : null;
    res.json({ players: normalizeFreeAgents(raw, currentWeek) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Our own reasonable cutoff for "worth making a move" — a free agent has
// to project meaningfully higher than what you'd drop, not just marginally
// better, or this would suggest constant tiny, not-worth-it swaps.
const WAIVER_IMPROVEMENT_THRESHOLD = 3;

function bestFreeAgentAt(pos, freeAgents, excludeIds) {
  return [...freeAgents]
    .filter((f) => f.pos === pos && f.proj != null && !excludeIds.has(f.id))
    .sort((a, b) => b.proj - a.proj)[0];
}

// A transparent, rules-based recommendation engine — NOT a live LLM call.
// It compares your roster's real weekly projections against available free
// agents, and flags byes/injuries first, then meaningful upgrades. Every
// suggestion says exactly why, so it's easy to sanity-check by eye.
const FLEX_ELIGIBLE_POSITIONS = new Set(["RB", "WR", "TE"]);

function computeWaiverSuggestions(roster, freeAgents, teamsPlayingThisWeek) {
  const suggestions = [];
  const flaggedPlayerIds = new Set();
  const usedFreeAgentIds = new Set();

  const starters = roster.filter((p) => p.starter);
  const bench = roster.filter((p) => !p.starter);
  const flexStarter = starters.find((p) => p.slot === "FLEX");

  // Priority 1: a STARTER who's on a bye or clearly not playing this week —
  // this is the most urgent kind of move, since that roster spot is
  // guaranteed to score 0 otherwise.
  starters.forEach((p) => {
    const onBye = !teamsPlayingThisWeek.has(p.nflTeam);
    const isOut = /^(out|ir|doubtful|suspended)/i.test(p.status || "");
    if (!onBye && !isOut) return;
    const best = bestFreeAgentAt(p.pos, freeAgents, usedFreeAgentIds);
    if (!best) return;
    flaggedPlayerIds.add(p.id);
    usedFreeAgentIds.add(best.id);
    const slotNote = p.slot === "FLEX" ? " (your FLEX spot)" : "";
    suggestions.push({
      priority: "high",
      dropName: p.name,
      dropPos: p.pos,
      dropReason: onBye ? "on a bye this week" : `listed as ${p.status}`,
      addName: best.name,
      addPos: best.pos,
      addProj: best.proj,
      reason: `${p.name} is ${onBye ? "on a bye this week" : `listed as ${p.status}`}${slotNote} — ${best.name} is a healthy, available ${best.pos} projected for ${best.proj.toFixed(1)} points this week.`,
    });
  });

  // For each position, find the single WEAKEST roster spot that a free
  // agent there could actually take over. For RB/WR/TE this deliberately
  // includes your FLEX starter and dedicated starter at that position, not
  // just same-position bench players — a strong pickup might be better
  // used bumping a weak FLEX starter than sitting on the bench.
  function weakestCandidateFor(pos) {
    const candidates = bench.filter((p) => p.pos === pos && !flaggedPlayerIds.has(p.id));
    const dedicatedStarter = starters.find((p) => p.slot === pos && !flaggedPlayerIds.has(p.id));
    if (dedicatedStarter) candidates.push(dedicatedStarter);
    if (FLEX_ELIGIBLE_POSITIONS.has(pos) && flexStarter && !flaggedPlayerIds.has(flexStarter.id)) {
      candidates.push(flexStarter);
    }
    const seen = new Set();
    const deduped = candidates.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
    if (deduped.length === 0) return null;
    return deduped.sort((a, b) => a.proj - b.proj)[0];
  }

  ["QB", "RB", "WR", "TE", "K", "DST"].forEach((pos) => {
    const weakest = weakestCandidateFor(pos);
    if (!weakest) return;
    const best = bestFreeAgentAt(pos, freeAgents, usedFreeAgentIds);
    if (!best) return;
    const gap = best.proj - weakest.proj;
    if (gap < WAIVER_IMPROVEMENT_THRESHOLD) return;
    flaggedPlayerIds.add(weakest.id);
    usedFreeAgentIds.add(best.id);
    const slotNote = weakest.slot === "FLEX" ? " in your FLEX spot" : "";
    suggestions.push({
      priority: weakest.starter ? "medium" : "low",
      dropName: weakest.name,
      dropPos: weakest.pos,
      dropReason: `projected for just ${weakest.proj.toFixed(1)} points${slotNote}`,
      addName: best.name,
      addPos: best.pos,
      addProj: best.proj,
      reason: `${best.name} is projected for ${best.proj.toFixed(1)} points at ${best.pos} — about ${gap.toFixed(1)} more than ${weakest.name}'s ${weakest.proj.toFixed(1)}${slotNote}.`,
    });
  });

  const order = { high: 0, medium: 1, low: 2 };
  return suggestions.sort((a, b) => order[a.priority] - order[b.priority]);
}

// This is a personal feature for one specific team in the league (per an
// explicit request), not a general-purpose endpoint — hence the hardcoded
// ESPN team id rather than a :espnTeamId route param.
const MY_TEAM_ESPN_ID = 9; // Z Fleecer

app.get("/api/my-team-suggestions", async (req, res) => {
  try {
    const rosterRaw = cachedRosterRaw || (await fetchLeague(["mRoster", "mTeam"]));
    const currentWeek = rosterRaw.scoringPeriodId;
    const myTeamRaw = rosterRaw.teams.find((t) => t.id === MY_TEAM_ESPN_ID);
    if (!myTeamRaw) return res.status(404).json({ error: "Couldn't find that team." });

    const [freeAgentsRaw, nflRaw] = await Promise.all([getFreeAgentsRaw(), getNflScoreboard()]);
    const roster = normalizeRoster(myTeamRaw, currentWeek, cachedGameStateByTeam);
    const freeAgents = normalizeFreeAgents(freeAgentsRaw, currentWeek);
    const nflGames = normalizeNflGames(nflRaw);
    const teamsPlayingThisWeek = new Set(nflGames.flatMap((g) => [g.home.abbrev, g.away.abbrev]));

    const suggestions = computeWaiverSuggestions(roster, freeAgents, teamsPlayingThisWeek);
    res.json({ teamName: myTeamRaw.name, currentWeek, suggestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Every completed week this season, in order — powers Clutch Record,
// Consistency, All-Play Record, and the Championship Odds trend.
app.get("/api/season-history", (req, res) => {
  res.json({ history: seasonHistory });
});

// Real NFL scores and schedule — no league data involved, so this works
// even before your ESPN league credentials are set up.
app.get("/api/nfl-scoreboard", async (req, res) => {
  try {
    const raw = await getNflScoreboard();
    res.json({ games: normalizeNflGames(raw) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Win-probability history for a given week, grouped by matchup id, for
// the Kalshi Odds tab's charts. Builds up naturally the more often
// /api/dashboard gets called (e.g. every time someone loads the site).
app.get("/api/odds-history", (req, res) => {
  const week = Number(req.query.week);
  const relevant = oddsSnapshots.filter((s) => s.week === week);
  const byMatchup = {};
  relevant.forEach((snap) => {
    snap.matchups.forEach((m) => {
      if (!byMatchup[m.id]) byMatchup[m.id] = [];
      byMatchup[m.id].push({ time: snap.time, winProbA: m.winProbA });
    });
  });
  res.json({ history: byMatchup });
});

app.listen(PORT, () => {
  console.log(`League Command Center backend running at http://localhost:${PORT}`);
  console.log(`Try it: http://localhost:${PORT}/api/health`);
});
