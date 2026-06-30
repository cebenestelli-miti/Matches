/**
 * Shared knockout bracket resolution for build scripts.
 * W{id} / L{id} placeholders → actual teams from finished feeder matches.
 */

function isPlaceholderTeam(name) {
  if (!name) return true;
  if (/^[12][A-L]$/.test(name)) return true;
  if (/^W\d+$/.test(name)) return true;
  if (/^L\d+$/.test(name)) return true;
  if (/^3[A-Z]/.test(name) && name.includes("/")) return true;
  return false;
}

function matchPairKey(team1, team2) {
  return [team1, team2].sort((a, b) => a.localeCompare(b)).join("|");
}

function inferKnockoutWinner(match, allMatches, penaltyResults) {
  if (match.status !== "finished" || !match.score || match.score.length !== 2) return null;

  const [s1, s2] = match.score;
  if (s1 > s2) return match.team1;
  if (s2 > s1) return match.team2;

  const penalty = penaltyResults?.get(matchPairKey(match.team1, match.team2));
  if (penalty?.winner) return penalty.winner;

  if (isPlaceholderTeam(match.team1) || isPlaceholderTeam(match.team2)) return null;

  const knockoutRounds = [
    "Round of 32",
    "Round of 16",
    "Quarter-final",
    "Semi-final",
    "Match for third place",
    "Final",
  ];
  const isKnockout = (r) => knockoutRounds.includes(r);

  const laterKnockout = allMatches.filter(
    (m) => !m.group && isKnockout(m.round) && m.datetime > match.datetime
  );

  const t1Advances = laterKnockout.some((m) => m.team1 === match.team1 || m.team2 === match.team1);
  const t2Advances = laterKnockout.some((m) => m.team1 === match.team2 || m.team2 === match.team2);
  if (t1Advances && !t2Advances) return match.team1;
  if (t2Advances && !t1Advances) return match.team2;

  return null;
}

function resolveGroupPosPlaceholder(name, groupStandings) {
  const m = String(name || "").match(/^([12])([A-L])$/);
  if (!m) return name;
  const idx = m[1] === "1" ? 0 : 1;
  const group = `Group ${m[2]}`;
  const row = groupStandings[group]?.[idx];
  return row?.team || name;
}

function resolveTeamPlaceholder(name, groupStandings, allMatches, penaltyResults) {
  if (!name) return name;

  const groupResolved = resolveGroupPosPlaceholder(name, groupStandings);
  if (groupResolved !== name) return groupResolved;

  const winnerMatch = String(name).match(/^W(\d+)$/);
  if (winnerMatch) {
    const source = allMatches.find((m) => m.id === Number(winnerMatch[1]));
    if (!source) return name;
    const winner = inferKnockoutWinner(source, allMatches, penaltyResults);
    return winner && !isPlaceholderTeam(winner) ? winner : name;
  }

  const loserMatch = String(name).match(/^L(\d+)$/);
  if (loserMatch) {
    const source = allMatches.find((m) => m.id === Number(loserMatch[1]));
    if (!source) return name;
    const winner = inferKnockoutWinner(source, allMatches, penaltyResults);
    if (!winner || isPlaceholderTeam(source.team1) || isPlaceholderTeam(source.team2)) return name;
    const loser = winner === source.team1 ? source.team2 : source.team1;
    return !isPlaceholderTeam(loser) ? loser : name;
  }

  return name;
}

function computeStandings(matches) {
  const groups = {};

  for (const m of matches) {
    if (!/^Group [A-L]$/.test(m.group || "")) continue;
    if (!groups[m.group]) groups[m.group] = {};
    for (const team of [m.team1, m.team2]) {
      if (isPlaceholderTeam(team)) continue;
      if (!groups[m.group][team]) {
        groups[m.group][team] = { team, played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 };
      }
    }
  }

  for (const m of matches) {
    if (!/^Group [A-L]$/.test(m.group || "")) continue;
    if (m.status !== "finished" || !m.score || m.score.length !== 2) continue;

    const row1 = groups[m.group]?.[m.team1];
    const row2 = groups[m.group]?.[m.team2];
    if (!row1 || !row2) continue;

    const [s1, s2] = m.score;
    row1.played++;
    row2.played++;
    row1.gf += s1;
    row1.ga += s2;
    row2.gf += s2;
    row2.ga += s1;

    if (s1 > s2) {
      row1.w++;
      row1.pts += 3;
      row2.l++;
    } else if (s2 > s1) {
      row2.w++;
      row2.pts += 3;
      row1.l++;
    } else {
      row1.d++;
      row2.d++;
      row1.pts++;
      row2.pts++;
    }
  }

  const sorted = {};
  for (const [group, teams] of Object.entries(groups)) {
    sorted[group] = Object.values(teams).sort((a, b) => {
      const gdA = a.gf - a.ga;
      const gdB = b.gf - b.ga;
      if (b.pts !== a.pts) return b.pts - a.pts;
      if (gdB !== gdA) return gdB - gdA;
      if (b.gf !== a.gf) return b.gf - a.gf;
      return a.team.localeCompare(b.team);
    });
  }

  return sorted;
}

function parseCupFinalsPenalties(text) {
  const map = new Map();
  if (!text) return map;

  const penRe =
    /([A-Za-z][A-Za-z &.'éÉçÇäöüÄÖÜßø-]+?)\s+(\d+)-(\d+)\s+a\.e\.t\.\s*\([^)]+\),\s*(\d+)-(\d+)\s+pen\.\s+([A-Za-z][A-Za-z &.'éÉçÇäöüÄÖÜßø-]+?)\s+@/g;

  for (const match of text.matchAll(penRe)) {
    const team1 = match[1].trim();
    const team2 = match[6].trim();
    const pen1 = Number(match[4]);
    const pen2 = Number(match[5]);
    const winner = pen2 > pen1 ? team2 : team1;

    map.set(matchPairKey(team1, team2), {
      winner,
      pens: { [team1]: pen1, [team2]: pen2 },
    });
  }

  return map;
}

function applyBracketResolution(matches, penaltyResults) {
  const groupStandings = computeStandings(matches);
  let changed = 0;

  const resolved = matches.map((m) => {
    const team1 = resolveTeamPlaceholder(m.team1, groupStandings, matches, penaltyResults);
    const team2 = resolveTeamPlaceholder(m.team2, groupStandings, matches, penaltyResults);
    if (team1 === m.team1 && team2 === m.team2) return m;
    changed++;
    return { ...m, team1, team2 };
  });

  return { matches: resolved, changed };
}

module.exports = {
  applyBracketResolution,
  parseCupFinalsPenalties,
  resolveTeamPlaceholder,
};
