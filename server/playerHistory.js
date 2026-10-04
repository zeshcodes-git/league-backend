// Week-by-week points for every player this season, kept in the backend.
//
// ESPN only hands out a player's full weekly history on request, so this keeps
// our own copy (saved to Upstash so it survives restarts). It is topped up only
// when needed: a player we haven't seen, or any player once a new week has
// finished. That keeps ESPN traffic tiny — roughly one batch per week.
//
// It also records the pregame projection ESPN gave for each week as we see it,
// so a more precise "scored above/below projection" comparison can be built as
// the season goes on.

import { extractWeekly } from "./playerForm.js";

const KEY = "playerHistory";

export function createPlayerHistory({ season, kvGet, kvSet }) {
  let data = { season, players: {} };
  let dirty = false;

  return {
    async load() {
      const saved = await kvGet(KEY);
      if (saved && saved.season === season && saved.players) data = saved;
      return data;
    },

    // Save what ESPN says about these players for every COMPLETED week.
    ingest(rawPlayers, lastCompletedWeek) {
      let changed = 0;
      rawPlayers.forEach((entry) => {
        const p = entry.playerPoolEntry ? entry.playerPoolEntry.player : entry.player || entry;
        if (!p || p.id == null) return;
        const { weeks, pace, prevPpg } = extractWeekly(p, season, lastCompletedWeek);
        const rec = data.players[p.id] || { n: p.fullName, a: {} };
        const before = JSON.stringify(rec);
        rec.n = p.fullName;
        rec.pos = p.defaultPositionId;
        rec.a = { ...rec.a, ...weeks }; // ESPN's newest numbers win (stat corrections)
        if (pace) rec.pace = Math.round(pace * 100) / 100;
        if (prevPpg) rec.prev = Math.round(prevPpg * 100) / 100;
        rec.t = lastCompletedWeek; // history is current through this week
        data.players[p.id] = rec;
        if (JSON.stringify(rec) !== before) changed++;
      });
      if (changed) dirty = true;
      return changed;
    },

    // Remember the projection ESPN showed before games, once per player per week.
    recordProjection(playerId, week, proj) {
      const rec = data.players[playerId];
      if (!rec || !(proj > 0)) return;
      rec.pr = rec.pr || {};
      if (rec.pr[week] == null) {
        rec.pr[week] = Math.round(proj * 10) / 10;
        dirty = true;
      }
    },

    get(playerId) {
      return data.players[playerId] || null;
    },

    // Which of these players need their history (re)fetched?
    needsRefresh(ids, lastCompletedWeek) {
      if (lastCompletedWeek < 1) return [];
      return ids.filter((id) => {
        const rec = data.players[id];
        return !rec || rec.t == null || rec.t < lastCompletedWeek;
      });
    },

    async save() {
      if (!dirty) return false;
      dirty = false;
      await kvSet(KEY, data);
      return true;
    },

    stats() {
      const ids = Object.keys(data.players);
      return { players: ids.length, weeksTracked: ids.reduce((a, id) => a + Object.keys(data.players[id].a || {}).length, 0) };
    },
  };
}
