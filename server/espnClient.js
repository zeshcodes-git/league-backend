// This is the ONLY file in the whole project that talks to ESPN.
// Every other file asks this one for data — that separation is what
// lets us swap or fix ESPN-specific logic later without touching
// the rest of the app.

const LEAGUE_ID = process.env.ESPN_LEAGUE_ID;
const SEASON_ID = process.env.ESPN_SEASON;
const ESPN_S2 = process.env.ESPN_S2;
const SWID = process.env.ESPN_SWID;

if (!LEAGUE_ID || !SEASON_ID) {
  console.warn(
    "[espnClient] ESPN_LEAGUE_ID or ESPN_SEASON is missing from your .env file. " +
      "Requests to ESPN will fail until both are set."
  );
}

const BASE_URL = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON_ID}/segments/0/leagues/${LEAGUE_ID}`;

// Only attach cookies if both are present — public leagues don't need them.
function authHeaders() {
  if (ESPN_S2 && SWID) {
    return { Cookie: `espn_s2=${ESPN_S2}; SWID=${SWID}` };
  }
  return {};
}

/**
 * Fetch one or more ESPN "views" for the league.
 * ESPN's API returns different slices of data depending on the
 * `view` query param(s) you ask for. Common ones:
 *   mTeam       - team names, owners, records
 *   mRoster     - full rosters with player scores
 *   mMatchup    - weekly matchups and scores
 *   mStandings  - standings table
 *   mSettings   - league settings (scoring rules, roster slots, etc.)
 */
export async function fetchLeague(views = ["mTeam"]) {
  const params = views.map((v) => `view=${v}`).join("&");
  const url = `${BASE_URL}?${params}`;

  const res = await fetch(url, { headers: authHeaders() });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "ESPN rejected the request (401/403). For a private league this usually means " +
        "ESPN_S2 or ESPN_SWID in your .env file is missing, expired, or incorrect."
    );
  }
  if (!res.ok) {
    throw new Error(`ESPN API returned an error: ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      "ESPN returned a webpage instead of data. This usually means the league ID, " +
        "season, or cookies in your .env file don't match what ESPN expects."
    );
  }

  return res.json();
}

/**
 * All players in the league's player pool — both rostered and unrostered.
 * ESPN returns this as a plain array (not wrapped in an object), and its
 * own filter header doesn't reliably narrow this down, so we fetch
 * everything and filter for unclaimed players ourselves in normalize.js.
 */
export async function fetchFreeAgents() {
  const url = `${BASE_URL}/players?view=kona_player_info`;
  const res = await fetch(url, { headers: authHeaders() });

  if (res.status === 401 || res.status === 403) {
    throw new Error("ESPN rejected the free-agent request (401/403) — check ESPN_S2/ESPN_SWID in your .env.");
  }
  if (!res.ok) {
    throw new Error(`ESPN API returned an error: ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error("ESPN returned a webpage instead of data for the free-agent request.");
  }
  return res.json();
}

/**
 * Real NFL scores/schedule. This is a public ESPN endpoint that needs no
 * league ID, season, or cookies — anyone can hit it.
 *
 * With no arguments, returns whatever ESPN considers the "current" week —
 * good for the NFL Scores page. Pass week/seasonYear to force a specific
 * week instead, which matters when we need to line this up exactly with
 * the fantasy league's current scoring period rather than ESPN's own
 * (sometimes momentarily out-of-sync) idea of "this week."
 */
export async function fetchNflScoreboard(week, seasonYear) {
  const params = new URLSearchParams();
  if (week) params.set("week", week);
  if (seasonYear) params.set("dates", seasonYear);
  params.set("seasontype", "2"); // regular season
  const qs = params.toString();
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard${week ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`NFL scoreboard request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}