// How a player's real 2026 results should change what we expect from him.
//
// ESPN's weekly projection is built from a season-long "talent" estimate plus
// this week's matchup. If a player has clearly been scoring above or below that
// season-long estimate, ESPN's number is probably off for him. This module
// estimates the player's TRUE scoring level from his actual week-by-week points
// (a Bayesian blend), and carries the difference through to this week:
//
//     expected this week = ESPN projection + (our talent estimate - ESPN's pace)
//
// Safeguards so it can't be fooled by noise:
//   - ESPN's pace is the starting belief, so a few games only nudge it
//   - recent weeks count more than old ones (gentle decay)
//   - weeks he didn't play (zero / negative) are ignored, not counted as busts
//   - the adjustment is capped (at 40% of the projection and 8 points)
//   - the estimate's spread is shrunk toward a sensible default for small samples
//
// Pure functions, fully unit-tested.

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const DECAY = 0.85; // each week older counts 85% as much
const MAX_ADJ_FRACTION = 0.4;
const MAX_ADJ_POINTS = 8;
const round1 = (n) => Math.round(n * 10) / 10;

// Typical week-to-week swing for a player at this scoring level.
export function priorSd(level) {
  return clamp(0.38 * Math.max(level || 0, 0) + 1.5, 3, 9);
}

// Pull season stats out of a raw ESPN player object. Only COMPLETED weeks count.
export function extractWeekly(player, season, lastCompletedWeek) {
  const weeks = {};
  let pace = null;
  let prevPpg = null;
  (player.stats || []).forEach((s) => {
    if (s.seasonId === season && s.statSourceId === 0 && s.statSplitTypeId === 1 && s.scoringPeriodId >= 1 && s.scoringPeriodId <= lastCompletedWeek) {
      weeks[s.scoringPeriodId] = Math.round(s.appliedTotal * 100) / 100;
    }
    if (s.seasonId === season && s.statSourceId === 1 && s.statSplitTypeId === 0 && s.appliedAverage > 0) pace = s.appliedAverage;
    if (s.seasonId === season - 1 && s.statSourceId === 0 && s.statSplitTypeId === 0 && s.appliedAverage > 0) prevPpg = s.appliedAverage;
  });
  return { weeks, pace, prevPpg };
}

export function buildForm({ weeks = {}, pace = null, prevPpg = null, proj = 0, posId, lastWeek }) {
  const keepsZeros = posId === 16; // a defense can truly score 0; for others 0 or less means he didn't play
  const all = Object.entries(weeks)
    .map(([w, pts]) => ({ w: Number(w), pts }))
    .filter((o) => o.w <= lastWeek)
    .sort((a, b) => a.w - b.w);
  const obs = all.filter((o) => keepsZeros || o.pts > 0);

  // Starting belief about his scoring level, from the best information available.
  const m0 = pace > 0 ? pace : prevPpg > 0 ? prevPpg * 0.9 : proj > 0 ? proj : null;
  const tau0 = pace > 0 ? 3.0 : prevPpg > 0 ? 4.0 : 4.5;
  const sigma = priorSd(m0 != null ? m0 : proj);

  let talent = m0;
  if (m0 != null && obs.length > 0) {
    let num = m0 / (tau0 * tau0);
    let den = 1 / (tau0 * tau0);
    obs.forEach((o) => {
      const weight = Math.pow(DECAY, lastWeek - o.w);
      const prec = weight / (sigma * sigma);
      // One monster (or dud) week is partly luck: cap how far it can pull the estimate.
      const pts = clamp(o.pts, m0 - 2 * sigma, m0 + 2 * sigma);
      num += pts * prec;
      den += prec;
    });
    talent = num / den;
  }

  let adj = 0;
  if (proj > 0 && talent != null && m0 != null) {
    const cap = Math.min(MAX_ADJ_FRACTION * proj, MAX_ADJ_POINTS);
    // A single game is a thin sample (it could be a role change or a fluke), so trust it less.
    const confidence = obs.length >= 2 ? 1 : 0.6;
    adj = clamp((talent - m0) * confidence, -cap, cap);
  }
  const exp = proj > 0 ? Math.max(0, proj + adj) : 0;

  // Spread of his weekly results, shrunk toward the default when we've seen few games.
  const n = obs.length;
  const mean = n ? obs.reduce((a, o) => a + o.pts, 0) / n : null;
  const s2 = n > 1 ? obs.reduce((a, o) => a + (o.pts - mean) ** 2, 0) / (n - 1) : sigma * sigma;
  const sd = Math.sqrt((n * s2 + 2 * sigma * sigma) / (n + 2));

  const last3 = obs.slice(-3);
  return {
    exp,
    adj,
    talent: talent != null ? talent : exp,
    pace,
    sd,
    games: n,
    seasonAvg: mean != null ? round1(mean) : null,
    recentAvg: last3.length ? round1(last3.reduce((a, o) => a + o.pts, 0) / last3.length) : null,
    trend: n >= 2 && adj >= 1.5 ? "hot" : n >= 2 && adj <= -1.5 ? "cold" : null,
    weeks: all.slice(-6).map((o) => ({ w: o.w, pts: round1(o.pts) })),
  };
}
