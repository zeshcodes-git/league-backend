import "dotenv/config";
import { fetchLeague } from "./espnClient.js";

async function main() {
  const data = await fetchLeague(["mMatchup", "mTeam"]);
  const currentWeek = data.scoringPeriodId;
  console.log("Current scoring period:", currentWeek);

  const matchup = data.schedule.find((m) => m.matchupPeriodId === currentWeek);
  if (!matchup) {
    console.log("No matchup found for this week.");
    return;
  }

  const entries = matchup.home.rosterForCurrentScoringPeriod?.entries || [];
  console.log("Number of roster entries on the home side:", entries.length);

  const first = entries[0];
  if (!first) {
    console.log("No entries at all.");
    return;
  }

  const player = first.playerPoolEntry.player;
  console.log("\nSample player:", player.fullName);
  console.log("appliedStatTotal on playerPoolEntry:", first.playerPoolEntry.appliedStatTotal);
  console.log("Number of stats entries:", (player.stats || []).length);
  console.log("\nFull stats array:");
  console.log(JSON.stringify(player.stats, null, 2));
}

main().catch((err) => console.error("Script failed:", err.message));
