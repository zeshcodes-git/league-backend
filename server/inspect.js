import "dotenv/config";
import { fetchLeague } from "./espnClient.js";

function summarize(label, obj, depth = 0) {
  const indent = "  ".repeat(depth);
  if (Array.isArray(obj)) {
    console.log(`${indent}${label}: array of ${obj.length} items`);
    if (obj.length > 0 && typeof obj[0] === "object") {
      summarize(`${label}[0]`, obj[0], depth + 1);
    }
  } else if (obj && typeof obj === "object") {
    console.log(`${indent}${label}: {`);
    Object.keys(obj).forEach((key) => {
      const val = obj[key];
      if (val && typeof val === "object") {
        summarize(key, val, depth + 1);
      } else {
        console.log(`${indent}  ${key}: ${JSON.stringify(val)}`);
      }
    });
    console.log(`${indent}}`);
  } else {
    console.log(`${indent}${label}: ${JSON.stringify(obj)}`);
  }
}

async function main() {
  console.log("\n===== /api/teams shape =====\n");
  const teamsData = await fetchLeague(["mTeam", "mStandings"]);
  console.log("Top-level keys:", Object.keys(teamsData));
  if (teamsData.teams) summarize("teams", teamsData.teams);

  console.log("\n\n===== /api/matchups shape =====\n");
  const matchupData = await fetchLeague(["mMatchup", "mTeam"]);
  console.log("Top-level keys:", Object.keys(matchupData));
  if (matchupData.schedule) summarize("schedule", matchupData.schedule.slice(0, 1));

  console.log("\n\n===== /api/rosters shape (first team only) =====\n");
  const rosterData = await fetchLeague(["mRoster", "mTeam"]);
  if (rosterData.teams) summarize("teams", rosterData.teams.slice(0, 1));
}

main().catch((err) => {
  console.error("Inspect script failed:", err.message);
});
