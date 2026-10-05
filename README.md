# League Command Center — Backend

This is a small local server whose only job is to fetch your ESPN Fantasy
Football league data and hand it to the website. It never changes anything
in your league — no lineup edits, no waiver claims, nothing. Every endpoint
here is read-only.

## Before you start: do you need Node.js?

Open a terminal (on Mac: Spotlight search → "Terminal". On Windows: search
"Command Prompt" or "PowerShell") and type:

```
node --version
```

If you see a version number like `v18.x.x` or higher, you're set. If you see
"command not found," go to https://nodejs.org, download the "LTS" version,
install it, then re-open your terminal and try again.

## Step 1 — Install the project's dependencies

In your terminal, navigate into this folder and run:

```
npm install
```

This downloads the (small) set of packages the server needs. You'll see a
new `node_modules` folder appear — that's normal, and it's already excluded
from git via `.gitignore` so it never gets shared or committed.

## Step 2 — Find your League ID

1. Open your ESPN Fantasy Football league in a browser.
2. Look at the URL. It'll look something like:
   `https://fantasy.espn.com/football/league?leagueId=123456`
3. The number after `leagueId=` is what you need.

## Step 3 — Figure out if your league is public or private

- Go to your league's **Settings** page in ESPN.
- If there's an option like "League is viewable by everyone" and it's
  turned on, your league is **public** — skip to Step 5.
- Otherwise, it's **private**, and you'll need two cookie values (Step 4).

## Step 4 — (Private leagues only) Get your `espn_s2` and `SWID` cookies

These two values are how your browser proves to ESPN that you're logged in.
They are tied to your session, not your password, but you should still treat
them as sensitive and never share them or paste them anywhere public.

1. Make sure you're logged into ESPN Fantasy Football in your browser.
2. Open your browser's developer tools:
   - Chrome/Edge: press `F12`, or right-click the page → "Inspect"
   - Then click the **Application** tab (Chrome/Edge) or **Storage** tab (Firefox)
3. In the left sidebar, find **Cookies**, and click on
   `https://fantasy.espn.com`.
4. You'll see a list of cookies. Find the rows named `espn_s2` and `SWID`.
5. Copy the **Value** column for each one. `SWID` will include curly braces,
   like `{ABC123...}` — copy it exactly as shown, braces included.

## Step 5 — Create your `.env` file

1. In this folder, make a copy of `.env.example` and rename the copy to
   `.env` (just `.env`, no other text).
2. Open `.env` in a text editor and fill in:
   - `ESPN_LEAGUE_ID` — the number from Step 2
   - `ESPN_SEASON` — the year, e.g. `2026`
   - `ESPN_S2` and `ESPN_SWID` — only if your league is private (Step 4).
     Leave them blank for public leagues.
3. Save the file. **Never commit this file to git or paste its contents to
   anyone** — it's already excluded via `.gitignore`.

## Step 6 — Run the server

```
npm run dev
```

You should see:

```
League Command Center backend running at http://localhost:3001
Try it: http://localhost:3001/api/health
```

## Step 7 — Test it

Open `http://localhost:3001/api/health` in your browser. You should see
something like:

```json
{
  "ok": true,
  "leagueIdConfigured": true,
  "seasonConfigured": true,
  "privateLeagueCookiesConfigured": false
}
```

If that looks right, try the real data:

- `http://localhost:3001/api/teams` — team names, owners, records
- `http://localhost:3001/api/matchups` — weekly matchups and scores
- `http://localhost:3001/api/rosters` — full rosters
- `http://localhost:3001/api/settings` — league scoring settings

**If you get an error:** copy the exact error message and send it to me —
I can't test this myself since it needs your specific league credentials,
so debugging together from the real error is the fastest path.

## What's next

Once you can see real data at those URLs, the next step is teaching the
website to fetch from this server instead of using its built-in mock data.
We'll do that page by page, the same way we built the mock version.

## Bandwidth: staying inside Render's free allowance

The backend can pull a lot from ESPN (about 120 KB compressed per refresh, plus a
500 KB roster download), so how often it does that is controlled by one setting
on Render — **`REFRESH_MODE`** (Environment tab, no code change needed):

| Mode | What it does | Rough monthly traffic |
| --- | --- | --- |
| `off` (default) | Never pulls from ESPN on a schedule. The site shows the last saved data (kept in Upstash, so even restarts cost nothing). The site shows a "paused" notice. | about 0 |
| `lowpower` | No timer. A visit may trigger one refresh if the data is over 15 minutes old. | low |
| `auto` | Live mode: every 2 minutes while NFL games are on (or within 20 minutes of kickoff), hourly otherwise. Rosters every 30 min live / 6 h otherwise. | roughly 1 GB |

**To go live for a game day:** set `REFRESH_MODE=auto`, save (Render restarts the
server), and re-enable the schedule in `.github/workflows/keep-awake.yml` if you
want the odds chart to record while nobody is on the site. Set it back to `off`
afterwards. `/api/health` shows the current mode and how old the data is.

What else keeps traffic small: responses are cached by browsers, the odds history is
saved by appending one tiny entry per change (not re-uploading the whole list),
and the site stops refreshing when a tab is hidden or idle.

## Optional settings and housekeeping

These go in your `.env` locally and in the environment variables on Render.

| Variable | What it does |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Free hosted storage. Without it, odds history and season history reset whenever the server restarts. |
| `MY_TEAM_ESPN_ID` | Which team the Waivers "Pickup Suggestions" page is for (defaults to `9`). |
| `ESPN_SEASON` | The season year. Change it once a year; the site title follows it automatically. |

**Keeping the odds chart fed.** Render's free tier sleeps after ~15 minutes without traffic, and a sleeping server can't record odds. `.github/workflows/keep-awake.yml` pings `/api/health` every 5 minutes (free on a public repo). Check it is running from the repo's **Actions** tab, and confirm tracking at `/api/health` — the `odds` section shows how many snapshots exist for the current week and when the last one was taken.

**Things that update by themselves:** the full season history (rebuilt from ESPN's schedule), the playoff size and season length (from league settings), and the champion once ESPN finalizes a season.
