import "dotenv/config";

const LEAGUE_ID = process.env.ESPN_LEAGUE_ID;
const SEASON_ID = process.env.ESPN_SEASON;
const ESPN_S2 = process.env.ESPN_S2;
const SWID = process.env.ESPN_SWID;

function authHeaders() {
  if (ESPN_S2 && SWID) return { Cookie: `espn_s2=${ESPN_S2}; SWID=${SWID}` };
  return {};
}

async function tryFilter(label, filter) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON_ID}/segments/0/leagues/${LEAGUE_ID}/players?view=kona_player_info`;
  console.log(`\n===== ${label} =====`);
  const res = await fetch(url, {
    headers: { ...authHeaders(), "X-Fantasy-Filter": JSON.stringify(filter) },
  });
  console.log("HTTP status:", res.status);
  const contentType = res.headers.get("content-type") || "";
  console.log("Content-Type:", contentType);
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    console.log("Non-JSON response (first 300 chars):", text.slice(0, 300));
    return;
  }
  const data = await res.json();
  if (Array.isArray(data)) {
    console.log("Response is an array with", data.length, "items");
    if (data.length) console.log("First item keys:", Object.keys(data[0]));
    if (data.length) console.log("Sample item:", JSON.stringify(data[0]).slice(0, 500));
  } else {
    console.log("Top-level keys:", Object.keys(data));
    if (data.players) {
      console.log("players array length:", data.players.length);
      if (data.players.length) console.log("Sample player entry:", JSON.stringify(data.players[0]).slice(0, 500));
    }
  }
}

async function main() {
  // Attempt 1: our original filter (status + slots)
  await tryFilter("Attempt 1: status + slot filter", {
    players: {
      filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
      filterSlotIds: { value: [0, 2, 4, 6, 16, 17, 23] },
      sortPercOwned: { sortPriority: 1, sortAsc: false },
      limit: 50,
    },
  });

  // Attempt 2: status only, no slot filter
  await tryFilter("Attempt 2: status only, no slot filter", {
    players: {
      filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
      sortPercOwned: { sortPriority: 1, sortAsc: false },
      limit: 50,
    },
  });

  // Attempt 3: no filter at all, just a limit
  await tryFilter("Attempt 3: no filter, just a limit", {
    players: {
      limit: 20,
    },
  });
}

main().catch((err) => console.error("Script failed:", err.message));
