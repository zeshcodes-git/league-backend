import "dotenv/config";
import { fetchLeague } from "./espnClient.js";

async function main() {
  const rosterData = await fetchLeague(["mRoster", "mTeam"]);
  const currentWeek = rosterData.scoringPeriodId;
  console.log("Current scoring period:", currentWeek);

  // Find the same player (Jaxon Smith-Njigba) via the mRoster view instead.
  let found = null;
  for (const team of rosterData.teams) {
    const entries = team.roster?.entries || [];
    const match = entries.find((e) => e.playerPoolEntry.player.fullName === "Jaxon Smith-Njigba");
    if (match) {
      found = match;
      break;
    }
  }

  if (!found) {
    console.log("Could not find that player via mRoster view.");
    return;
  }

  const player = found.playerPoolEntry.player;
  console.log("\nFound via mRoster view:", player.fullName);
  console.log("appliedStatTotal:", found.playerPoolEntry.appliedStatTotal);
  console.log("Number of stats entries:", (player.stats || []).length);
  console.log("\nFull stats array:");
  console.log(JSON.stringify(player.stats, null, 2));
}

main().catch((err) => console.error("Script failed:", err.message));
