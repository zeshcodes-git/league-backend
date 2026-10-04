import "dotenv/config";
import express from "express";
import cors from "cors";
import { fetchLeague, fetchFreeAgents, fetchNflScoreboard } from "./espnClient.js";
import { shouldRefreshNow, rosterCacheMs } from "./refreshPolicy.js";
import { buildSuggestions, DEFAULT_RULES } from "./suggestions.js";
import { normalizeTeams, normalizeMatchups, buildCompletedWeeks, normalizeRoster, normalizeFreeAgents, normalizeNflGames } from "./normalize.js";

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
    // Handy for checking the odds chart is being fed: should climb all week.
    odds: {
      snapshots: oddsSnapshots.length,
      currentWeekSnapshots: oddsSnapshots.filter((x) => latestDashboard && x.week === (latestDashboard.liveWeek || latestDashboard.currentWeek)).length,
      lastSnapshotAt: oddsSnapshots.length ? new Date(oddsSnapshots[oddsSnapshots.length - 1].time).toISOString() : null,
    },
    uptimeMinutes: Math.round(process.uptime() / 60),
  });
});

// --- Clean, translated data for the website to actually use ---

// In-memory history of win-probability snapshots, so the Kalshi Odds tab
// can chart how each matchup's odds move over time. Resets when the
// server restarts — good enough for now; could be written to a file
// later if you want it to survive restarts.
// Drops snapshots that repeat the previous odds exactly (keeping each run's
// first and last), which shrinks old per-minute data by ~99% and keeps the
// stored list far below Upstash's per-request size limit.
function compactSnapshots(list) {
  const same = (a, b) => a.week === b.week && a.matchups.length === b.matchups.length && a.matchups.every((m, i) => b.matchups[i] && b.matchups[i].id === m.id && b.matchups[i].winProbA === m.winProbA);
  return list.filter((snap, i) => i === 0 || i === list.length - 1 || !same(snap, list[i - 1]) || !same(snap, list[i + 1]));
}
let oddsSnapshots = compactSnapshots((await kvGet("oddsSnapshots")) || []);

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

// Self-heal: an earlier bug could save a week as "complete" with every
// matchup at 0-0 (the NFL schedule lookup came back empty). Drop any such
// week so it can be recorded properly when the week actually finishes.
const isBlankWeek = (w) => !w || !w.matchups || w.matchups.every((m) => !m.scoreA && !m.scoreB);
{
  const cleanedHistory = seasonHistory.filter((w) => !isBlankWeek(w));
  if (cleanedHistory.length !== seasonHistory.length) {
    seasonHistory = cleanedHistory;
    await kvSet("seasonHistory", seasonHistory);
    console.warn("[startup] removed blank week(s) from season history");
  }
  if (lastCompletedWeekSnapshot && isBlankWeek(lastCompletedWeekSnapshot)) {
    lastCompletedWeekSnapshot = null;
    await kvSet("lastCompletedWeek", null);
    console.warn("[startup] removed blank last-completed-week snapshot");
  }
}

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
// What the last NFL schedule lookup said: is a game live, and when is the next kickoff?
let liveInfo = null; // { anyLive, nextKickoffMs }
let lastRefreshAt = 0;
let cachedPlayerStatsById = {};
let playerStatsCachedAt = 0;
// Reused for 10 minutes while games are live, an hour otherwise (see refreshPolicy.js).

async function refreshPlayerStatsIfStale() {
  const now = Date.now();
  if (cachedRosterRaw && now - playerStatsCachedAt < rosterCacheMs(liveInfo)) return;
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

// League structure (regular-season length, playoff size) never changes
// mid-season, so it's fetched once and kept — used for playoff odds.
let cachedLeagueFull = null;
async function getLeagueFull() {
  if (cachedLeagueFull) return cachedLeagueFull;
  try {
    const raw = await fetchLeague(["mSettings"]);
    const sched = raw.settings?.scheduleSettings || {};
    const rs = raw.settings?.rosterSettings || {};
    if (sched.matchupPeriodCount && sched.playoffTeamCount) {
      cachedLeagueFull = {
        regularSeasonWeeks: sched.matchupPeriodCount,
        playoffTeams: sched.playoffTeamCount,
        // Roster rules the lineup advisor needs: starting slots, bench/IR size, position limits.
        rules: {
          lineupSlotCounts: rs.lineupSlotCounts || DEFAULT_RULES.lineupSlotCounts,
          positionLimits: rs.positionLimits || {},
          isBenchUnlimited: Boolean(rs.isBenchUnlimited),
        },
      };
    }
  } catch (err) {
    console.warn("[league settings] failed:", err.message);
  }
  return cachedLeagueFull;
}
// The dashboard only needs the two season-structure numbers.
async function getLeagueInfo() {
  const full = await getLeagueFull();
  return full ? { regularSeasonWeeks: full.regularSeasonWeeks, playoffTeams: full.playoffTeams } : null;
}

// Does the actual work: fetches fresh data from ESPN, figures out which
// matchups are really decided, and records a snapshot. Called both by the
// timer below (automatically, every few minutes) and by /api/dashboard
// directly (as a fallback if the timer hasn't run yet).
async function refreshDashboard() {
  lastRefreshAt = Date.now();
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
    {
      const states = events.map((ev) => ({ state: ev.competitions[0].status.type.state, at: new Date(ev.date).getTime() }));
      const upcoming = states.filter((x) => x.state === "pre").map((x) => x.at);
      liveInfo = { anyLive: states.some((x) => x.state === "in"), nextKickoffMs: upcoming.length ? Math.min(...upcoming) : null };
    }
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

  // Rebuild every finished week from ESPN's own schedule (see
  // buildCompletedWeeks). ESPN's final numbers include stat corrections, so
  // they win over anything we saved earlier; weeks ESPN can't give us are kept.
  // Done before this week's live adjustments below touch the team records.
  {
    const fromEspn = buildCompletedWeeks(matchupRaw.schedule, teams, currentWeek);
    if (fromEspn.length) {
      const byWeek = new Map(seasonHistory.map((w) => [w.week, w]));
      fromEspn.forEach((w) => byWeek.set(w.week, w));
      const merged = [...byWeek.values()].sort((x, y) => x.week - y.week);
      if (JSON.stringify(merged) !== JSON.stringify(seasonHistory)) {
        seasonHistory = merged;
        await kvSet("seasonHistory", seasonHistory);
      }
    }
  }

  const weekComplete = matchups.length > 0 && matchups.every((m) => m.finished) && !isBlankWeek({ matchups });

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
      } else {
        a.ties = (a.ties || 0) + 1;
        b.ties = (b.ties || 0) + 1;
      }
    });
  }

  // Always record the TRUE current week's odds snapshots, regardless of
  // any display hold below — Kalshi Odds should keep tracking real time.
  // Only store a snapshot when something actually moved (or every 15 min as
  // a heartbeat). Recording every minute filled the old 2,000-entry cap in
  // ~33 hours, which is why the Odds chart only ever showed the last day and
  // a half instead of the whole week. This also means far less data is
  // written to storage and sent to the site.
  const lastSnap = oddsSnapshots[oddsSnapshots.length - 1];
  // Before ESPN has published projections for a brand-new week every matchup
  // computes to a meaningless 50/50, so wait until real odds exist — the chart
  // then starts the moment the odds actually mean something.
  const oddsAreMeaningful = matchups.some((m) => m.projA + m.projB > 0 || m.scoreA + m.scoreB > 0);
  const oddsChanged =
    oddsAreMeaningful &&
    (!lastSnap ||
    lastSnap.week !== currentWeek ||
    Date.now() - lastSnap.time >= 15 * 60 * 1000 ||
    matchups.some((m) => {
      const prev = lastSnap.matchups.find((x) => x.id === m.id);
      return !prev || prev.winProbA !== m.winProbA;
    }));
  if (oddsChanged) {
    oddsSnapshots.push({
      time: Date.now(),
      week: currentWeek,
      matchups: matchups.map((m) => ({ id: m.id, winProbA: m.winProbA })),
    });
    // Keep the current and previous week only; the cap is just a safety net.
    oddsSnapshots = oddsSnapshots.filter((x) => x.week >= currentWeek - 1);
    if (oddsSnapshots.length > 3500) oddsSnapshots = oddsSnapshots.slice(-3500);
    await kvSet("oddsSnapshots", oddsSnapshots);
  }

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
    league: await getLeagueInfo(),
    season: Number(process.env.ESPN_SEASON) || null,
    // Set once ESPN assigns final ranks (season over) so the site can add the new champion by itself.
    champion: (() => { const t = (teamsRaw.teams || []).find((x) => x.rankFinal === 1); return t ? { season: Number(process.env.ESPN_SEASON) || null, espnTeamId: t.id } : null; })(),
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
  // Ticks every 30s but only calls ESPN when refreshPolicy says it's worth it.
  setInterval(() => {
    if (!shouldRefreshNow({ hasData: Boolean(latestDashboard), lastRefreshAt, info: liveInfo })) return;
    refreshDashboard().catch((err) => console.warn("[background refresh] failed:", err.message));
  }, 30 * 1000);
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
    // liveWeek only exists during the Mon-Wed hold; otherwise it's the dashboard's current week.
    const currentWeek = latestDashboard ? latestDashboard.liveWeek || latestDashboard.currentWeek : null;
    res.json({ players: normalizeFreeAgents(raw, currentWeek) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lineup & pickup advice for ANY team (see suggestions.js for the rules).
// Injury news changes fast, so this refreshes the roster data if it's more than
// 10 minutes old — but only when someone actually opens the page, and at most
// once per 10 minutes no matter how many people do.
const ADVICE_ROSTER_MAX_AGE_MS = 10 * 60 * 1000;
async function getRosterForAdvice() {
  if (!cachedRosterRaw || Date.now() - playerStatsCachedAt > ADVICE_ROSTER_MAX_AGE_MS) {
    playerStatsCachedAt = 0; // force refreshPlayerStatsIfStale to refetch
    await refreshPlayerStatsIfStale();
  }
  return cachedRosterRaw || (await fetchLeague(["mRoster", "mTeam"]));
}

async function suggestionsForTeam(espnTeamId) {
  const rosterRaw = await getRosterForAdvice();
  const team = rosterRaw.teams.find((t) => t.id === espnTeamId);
  if (!team) return null;
  const [freeAgentsRaw, league] = await Promise.all([getFreeAgentsRaw(), getLeagueFull()]);
  // The same NFL game-state lookup the dashboard uses (cached for a minute).
  if (!cachedGameStateByTeam || Object.keys(cachedGameStateByTeam).length === 0) await getNflScoreboard(rosterRaw.scoringPeriodId, process.env.ESPN_SEASON).catch(() => null);
  const list = Array.isArray(freeAgentsRaw) ? freeAgentsRaw : freeAgentsRaw.players || [];
  const unrostered = list.filter((e) => !e.onTeamId || e.onTeamId <= 0);
  return buildSuggestions({
    team,
    freeAgents: unrostered,
    week: rosterRaw.scoringPeriodId,
    gameStateByTeam: cachedGameStateByTeam || {},
    rules: league ? league.rules : DEFAULT_RULES,
  });
}

app.get("/api/team/:espnTeamId/suggestions", async (req, res) => {
  try {
    const out = await suggestionsForTeam(Number(req.params.espnTeamId));
    if (!out) return res.status(404).json({ error: "No team with that ESPN team id" });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Older versions of the site asked for one fixed team; keep that working.
const MY_TEAM_ESPN_ID = Number(process.env.MY_TEAM_ESPN_ID) || 9;
app.get("/api/my-team-suggestions", async (req, res) => {
  try {
    const out = await suggestionsForTeam(MY_TEAM_ESPN_ID);
    if (!out) return res.status(404).json({ error: "Couldn't find that team." });
    res.json(out);
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
  // The chart is a step line, so a point that repeats the previous value
  // adds nothing. Collapse those runs (keeping the first and last point) —
  // this took the response from hundreds of KB to a few KB.
  Object.keys(byMatchup).forEach((id) => {
    const pts = byMatchup[id];
    byMatchup[id] = pts.filter((pt, i) => i === 0 || i === pts.length - 1 || pt.winProbA !== pts[i - 1].winProbA || pt.winProbA !== pts[i + 1].winProbA);
  });
  res.json({ history: byMatchup });
});

// A stray error in one background task should be logged, not take the whole
// server down (and with it the odds history being recorded).
process.on("unhandledRejection", (err) => console.warn("[unhandledRejection]", err && err.message ? err.message : err));
process.on("uncaughtException", (err) => console.warn("[uncaughtException]", err && err.message ? err.message : err));

app.listen(PORT, () => {
  console.log(`League Command Center backend running at http://localhost:${PORT}`);
  console.log(`Try it: http://localhost:${PORT}/api/health`);
});
