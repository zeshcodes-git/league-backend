import "dotenv/config";
import express from "express";
import cors from "cors";
import { fetchLeague, fetchFreeAgents, fetchNflScoreboard } from "./espnClient.js";
import { normalizeTeams, normalizeMatchups, normalizeRoster, normalizeFreeAgents, normalizeNflGames } from "./normalize.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

// Quick sanity check — hit this first to confirm the server itself is running,
// with no ESPN call involved yet.
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    leagueIdConfigured: Boolean(process.env.ESPN_LEAGUE_ID),
    seasonConfigured: Boolean(process.env.ESPN_SEASON),
    privateLeagueCookiesConfigured: Boolean(process.env.ESPN_S2 && process.env.ESPN_SWID),
  });
});

// Teams, owners, records.
app.get("/api/teams", async (req, res) => {
  try {
    const data = await fetchLeague(["mTeam", "mStandings"]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full rosters (players, positions, scores).
app.get("/api/rosters", async (req, res) => {
  try {
    const data = await fetchLeague(["mRoster", "mTeam"]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Weekly matchups and scores.
app.get("/api/matchups", async (req, res) => {
  try {
    const data = await fetchLeague(["mMatchup", "mTeam"]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// League settings (scoring rules, roster slots, playoff format).
app.get("/api/settings", async (req, res) => {
  try {
    const data = await fetchLeague(["mSettings"]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Clean, translated data for the website to actually use ---

// In-memory history of win-probability snapshots, so the Kalshi Odds tab
// can chart how each matchup's odds move over time. Resets when the
// server restarts — good enough for now; could be written to a file
// later if you want it to survive restarts.
const oddsSnapshots = [];

// Cache of the last successfully computed dashboard, so /api/dashboard can
// respond instantly from whatever the background timer last captured,
// instead of every page load triggering its own ESPN calls.
let latestDashboard = null;

// Once a week is fully finished, we keep it here — this is what lets News
// and the "hold" window below keep showing a completed week's real results
// even after the fantasy schedule has already moved on to the next one.
let lastCompletedWeekSnapshot = null; // { week, weekStart, teams, matchups }

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

// Does the actual work: fetches fresh data from ESPN, figures out which
// matchups are really decided, and records a snapshot. Called both by the
// timer below (automatically, every few minutes) and by /api/dashboard
// directly (as a fallback if the timer hasn't run yet).
async function refreshDashboard() {
  const teamsRaw = await fetchLeague(["mTeam", "mStandings"]);
  const currentWeek = teamsRaw.scoringPeriodId;
  const matchupRaw = await fetchLeague(["mMatchup", "mTeam"]);

  // The mMatchup view doesn't include each player's full stats breakdown
  // (including their pregame projection) — only mRoster does. Fetch it
  // separately and build a quick lookup by player id.
  let playerStatsById = {};
  try {
    const rosterRaw = await fetchLeague(["mRoster", "mTeam"]);
    (rosterRaw.teams || []).forEach((t) => {
      (t.roster?.entries || []).forEach((e) => {
        const p = e.playerPoolEntry.player;
        playerStatsById[p.id] = p.stats;
      });
    });
  } catch {
    // If this fails, projections just fall back to actual-so-far — not
    // ideal, but shouldn't break the whole dashboard.
  }

  // ESPN's fantasy system can take hours after the last game ends to
  // officially mark matchups as decided (it waits out a stat-correction
  // window). We can figure out sooner, per matchup, whether it's actually
  // locked in by checking whether every starter's real NFL team is done
  // playing this week.
  let gameStateByTeam = {};
  let weekStart = null;
  try {
    const nflRaw = await fetchNflScoreboard(currentWeek, process.env.ESPN_SEASON);
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

  const matchups = normalizeMatchups(matchupRaw, currentWeek, gameStateByTeam, playerStatsById);
  const teams = normalizeTeams(teamsRaw);

  // ESPN's own team win-loss record lags behind the matchup winner flag by
  // even more than the matchup flag lags behind the real games. So: for any
  // matchup we've decided is finished ahead of ESPN's own official call,
  // apply that result onto the team records ourselves. This is what makes
  // Standings, Power Rankings, Analytics, and Awards all update together
  // instead of just the matchup cards.
  //
  // One honest limit: this can't reconstruct each team's win/loss STREAK,
  // since that needs the full sequence of past results, not just this
  // week's outcome — streaks will still reflect ESPN's own (slower) number
  // until ESPN's record catches up.
  const teamById = (id) => teams.find((t) => t.id === id);
  matchups.forEach((m) => {
    if (!m.finished || m.espnDecided) return; // already reflected in ESPN's own record, or not actually over yet
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

  // Always record the TRUE current week's odds snapshots, regardless of
  // any display hold below — Kalshi Odds should keep tracking real time.
  oddsSnapshots.push({
    time: Date.now(),
    week: currentWeek,
    matchups: matchups.map((m) => ({ id: m.id, winProbA: m.winProbA })),
  });
  if (oddsSnapshots.length > 2000) oddsSnapshots.shift();

  const weekComplete = matchups.length > 0 && matchups.every((m) => m.finished);
  if (weekComplete && (!lastCompletedWeekSnapshot || lastCompletedWeekSnapshot.week !== currentWeek)) {
    lastCompletedWeekSnapshot = { week: currentWeek, weekStart, teams, matchups };
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

  latestDashboard = {
    currentWeek: displayWeek,
    weekStart: displayWeekStart,
    teams: displayTeams,
    matchups: displayMatchups,
    // Separate from the above — always available so the site can keep
    // showing real News from the last completed week even once we've
    // moved on to displaying a new, still-in-progress week.
    lastCompletedWeek: lastCompletedWeekSnapshot
      ? { week: lastCompletedWeekSnapshot.week, teams: lastCompletedWeekSnapshot.teams, matchups: lastCompletedWeekSnapshot.matchups }
      : null,
    // The TRUE current week/matchups, bypassing the display hold above.
    // Kalshi Odds uses this instead — it should move on to the next
    // week's odds as soon as that week is actually live, rather than
    // waiting out the multi-day reflection window the rest of the site
    // uses for standings/news.
    liveWeek: currentWeek,
    liveMatchups: matchups,
  };
  return latestDashboard;
}

// Capture a snapshot automatically every minute, all on its own — this is
// what actually builds real odds history throughout game day, whether or
// not anyone has the site open. Only starts once ESPN credentials are
// configured, so it doesn't spam errors while you're still setting up.
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
    const rosterRaw = await fetchLeague(["mRoster", "mTeam"]);
    const team = rosterRaw.teams.find((t) => String(t.id) === req.params.espnTeamId);
    if (!team) return res.status(404).json({ error: "No team with that ESPN team id" });
    res.json({ roster: normalizeRoster(team, rosterRaw.scoringPeriodId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Waiver-wire / free-agent players.
app.get("/api/free-agents", async (req, res) => {
  try {
    const raw = await fetchFreeAgents();
    res.json({ players: normalizeFreeAgents(raw) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Real NFL scores and schedule — no league data involved, so this works
// even before your ESPN league credentials are set up.
app.get("/api/nfl-scoreboard", async (req, res) => {
  try {
    const raw = await fetchNflScoreboard();
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
