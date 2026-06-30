const API_PRIMARY = "https://wcup2026.org/api/data.php?action=all";
const API_FALLBACK = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";
const LOCAL_JSON = "data/matches.json";
const API_FETCH_TIMEOUT_MS = 20000;
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const IS_FILE_PROTOCOL = window.location.protocol === "file:";

const STORAGE_KEYS = {
  timezone: "wc2026_timezone",
  team: "wc2026_team",
  status: "wc2026_status",
  group: "wc2026_group",
  groupByDate: "wc2026_group_by_date",
};

const KNOCKOUT_ROUNDS = [
  "Round of 32",
  "Round of 16",
  "Quarter-final",
  "Semi-final",
  "Match for third place",
  "Final",
];

const LOCAL_SQUADS = "data/squads.json";

const TEAM_ALIASES = {
  "Bosnia & Herzegovina": "Bosnia and Herzegovina",
  USA: "United States",
};

const POS_ORDER = { GK: 0, DF: 1, MF: 2, FW: 3 };
const POS_LABELS = { GK: "Goalkeepers", DF: "Defenders", MF: "Midfielders", FW: "Forwards" };

/** @type {Record<string, {group:string, coach:string, players:Array}>} */
let squadTeams = {};

const $ = (sel) => document.querySelector(sel);

const els = {
  loading: $("#loading"),
  error: $("#error"),
  errorMessage: $("#error-message"),
  retryBtn: $("#retry-btn"),
  refreshBtn: $("#refresh-btn"),
  matchesContainer: $("#matches-container"),
  emptyState: $("#empty-state"),
  metaLine: $("#meta-line"),
  searchInput: $("#search-input"),
  teamFilter: $("#team-filter"),
  statusFilter: $("#status-filter"),
  groupFilter: $("#group-filter"),
  timezoneSelect: $("#timezone-select"),
  groupByDate: $("#group-by-date"),
  statUpcoming: $("#stat-upcoming"),
  statLive: $("#stat-live"),
  statFinished: $("#stat-finished"),
  statTotal: $("#stat-total"),
  statLiveCard: document.querySelector(".stat-live"),
  squadModal: $("#squad-modal"),
  squadTitle: $("#squad-title"),
  squadSubtitle: $("#squad-subtitle"),
  squadFlag: $("#squad-flag"),
  squadBody: $("#squad-body"),
  squadClose: $("#squad-close"),
  standingsContainer: $("#standings-container"),
};

/** @type {Array<{id:number,team1:string,team2:string,flag1?:string,flag2?:string,status:string,score:number[]|null,live_minute:number|null,datetime:number,group:string,round:string,ground:string}>} */
let allMatches = [];

function getDefaultTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function initTimezoneSelect() {
  const saved = localStorage.getItem(STORAGE_KEYS.timezone);
  const detected = getDefaultTimezone();
  const zones = [...new Set([detected, ...COMMON_TIMEZONES])].sort((a, b) =>
    a.localeCompare(b)
  );

  els.timezoneSelect.innerHTML = zones
    .map(
      (z) =>
        `<option value="${escapeAttr(z)}"${z === (saved || detected) ? " selected" : ""}>${escapeHtml(z.replace(/_/g, " "))}</option>`
    )
    .join("");
}

function formatDateHeading(unixSec, tz) {
  const d = new Date(unixSec * 1000);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

function formatTime(unixSec, tz) {
  const d = new Date(unixSec * 1000);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function formatShortDate(unixSec, tz) {
  const d = new Date(unixSec * 1000);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
  }).format(d);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function parseOpenFootballTime(timeStr) {
  const m = timeStr?.match(/(\d{1,2}):(\d{2})\s*UTC([+-]\d+)/i);
  if (!m) return null;
  const [, h, min, offsetH] = m;
  const utcH = Number(h) - Number(offsetH);
  return { hour: utcH, minute: Number(min) };
}

function openFootballToUnix(dateStr, timeStr) {
  const parsed = parseOpenFootballTime(timeStr);
  if (!parsed || !dateStr) return Math.floor(Date.now() / 1000);
  const [y, mo, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, parsed.hour, parsed.minute));
  return Math.floor(dt.getTime() / 1000);
}

function inferStatusFromScore(score, datetime) {
  if (score && Array.isArray(score) && score.length === 2) return "finished";
  const now = Date.now() / 1000;
  const matchEnd = datetime + 2 * 3600;
  if (now >= datetime && now <= matchEnd) return "live";
  if (now > matchEnd) return "finished";
  return "upcoming";
}

function normalizePrimaryMatch(m) {
  const datetime = Number(m.datetime);
  const hasScore = Array.isArray(m.score) && m.score.length === 2;
  const apiStatus = m.status || "upcoming";

  let status = apiStatus;
  if (apiStatus === "finished") {
    status = "finished";
  } else if (hasScore) {
    status = "finished";
  } else if (apiStatus === "live") {
    const now = Date.now() / 1000;
    if (now > datetime + 2 * 3600) status = "finished";
    else if (now < datetime) status = "upcoming";
    else status = "live";
  } else {
    status = inferStatusFromScore(null, datetime);
  }

  return {
    id: m.id,
    team1: m.team1,
    team2: m.team2,
    flag1: m.flag1 || "",
    flag2: m.flag2 || "",
    status,
    score: status === "finished" && hasScore ? m.score : null,
    live_minute: status === "live" ? m.live_minute : null,
    datetime,
    group: m.group || "",
    round: m.round || "",
    ground: m.ground || "",
  };
}

function normalizeFallbackMatches(data) {
  const rounds = data.rounds || [];
  const matches = [];
  let id = 0;

  for (const round of rounds) {
    for (const m of round.matches || []) {
      const scoreFt = m.score?.ft;
      const hasScore = Array.isArray(scoreFt) && scoreFt.length === 2;
      const datetime = openFootballToUnix(m.date, m.time);
      const status = hasScore
        ? "finished"
        : inferStatusFromScore(null, datetime);

      matches.push({
        id: id++,
        team1: m.team1,
        team2: m.team2,
        flag1: flagUrlForTeam(m.team1),
        flag2: flagUrlForTeam(m.team2),
        status,
        score: hasScore ? scoreFt : null,
        live_minute: null,
        datetime,
        group: m.group || "",
        round: round.name || "",
        ground: m.ground || "",
      });
    }
  }
  return matches;
}

const TEAM_FLAG_CODES = {
  Mexico: "mx",
  "South Africa": "za",
  "South Korea": "kr",
  "Czech Republic": "cz",
  Czechia: "cz",
  Canada: "ca",
  USA: "us",
  "United States": "us",
  Germany: "de",
  Brazil: "br",
  Argentina: "ar",
  France: "fr",
  England: "gb-eng",
  Spain: "es",
  Italy: "it",
  Portugal: "pt",
  Netherlands: "nl",
  Belgium: "be",
  Japan: "jp",
  Australia: "au",
  Croatia: "hr",
  Morocco: "ma",
  Switzerland: "ch",
  Poland: "pl",
  Senegal: "sn",
  Uruguay: "uy",
  Colombia: "co",
  Ecuador: "ec",
  Peru: "pe",
  Chile: "cl",
  Turkey: "tr",
  Wales: "gb-wls",
  Scotland: "gb-sct",
  "Ivory Coast": "ci",
  "Côte d'Ivoire": "ci",
  Ghana: "gh",
  Nigeria: "ng",
  Cameroon: "cm",
  Tunisia: "tn",
  Egypt: "eg",
  "Saudi Arabia": "sa",
  Iran: "ir",
  Qatar: "qa",
  "Costa Rica": "cr",
  Panama: "pa",
  Jamaica: "jm",
  Haiti: "ht",
  Paraguay: "py",
  Bolivia: "bo",
  Venezuela: "ve",
  Honduras: "hn",
  "New Zealand": "nz",
  "Bosnia and Herzegovina": "ba",
  "Bosnia & Herzegovina": "ba",
  Serbia: "rs",
  Denmark: "dk",
  Sweden: "se",
  Norway: "no",
  Austria: "at",
  Ukraine: "ua",
  Romania: "ro",
  Hungary: "hu",
  Greece: "gr",
  "Curaçao": "cw",
  Curacao: "cw",
  "DR Congo": "cd",
  "Congo DR": "cd",
};

function flagUrlForTeam(team) {
  const code = TEAM_FLAG_CODES[team];
  return code ? `https://flagcdn.com/w80/${code}.png` : "";
}

function loadEmbeddedMatches() {
  const data = window.__WC_MATCHES__;
  if (!data?.ok || !Array.isArray(data.matches)) {
    throw new Error("Bundled match data is missing or invalid.");
  }
  return {
    matches: data.matches.map(normalizePrimaryMatch),
    source: "bundled data (refresh via server for live updates)",
    updated: data.updated ?? null,
  };
}

async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMatches() {
  const errors = [];

  if (IS_FILE_PROTOCOL) {
    try {
      return loadEmbeddedMatches();
    } catch (err) {
      throw new Error("Could not load bundled match data.");
    }
  }

  const [apiResult, localResult] = await Promise.all([
    fetchJson(API_PRIMARY, API_FETCH_TIMEOUT_MS).catch((err) => ({ error: err.message })),
    fetchJson(LOCAL_JSON, 5000).catch((err) => ({ error: err.message })),
  ]);

  const sources = [];

  if (apiResult?.ok && Array.isArray(apiResult.matches)) {
    sources.push({
      data: apiResult,
      source: "wcup2026.org",
      updated: apiResult.updated ?? 0,
    });
  } else if (apiResult?.error) {
    errors.push(`API: ${apiResult.error}`);
    console.warn("Primary API failed:", apiResult.error);
  }

  if (localResult?.ok && Array.isArray(localResult.matches)) {
    sources.push({
      data: localResult,
      source: "local cache",
      updated: localResult.updated ?? 0,
    });
  } else if (localResult?.error) {
    errors.push(`Local: ${localResult.error}`);
    console.warn("Local JSON failed:", localResult.error);
  }

  if (sources.length) {
    sources.sort((a, b) => b.updated - a.updated);
    const best = sources[0];
    return {
      matches: best.data.matches.map(normalizePrimaryMatch),
      source: best.source,
      updated: best.data.updated ?? null,
    };
  }

  try {
    const data = await fetchJson(API_FALLBACK, 8000);
    return {
      matches: normalizeFallbackMatches(data),
      source: "openfootball",
      updated: null,
    };
  } catch (err) {
    errors.push(`Fallback: ${err.message}`);
    console.warn("Openfootball fallback failed:", err);
  }

  try {
    return loadEmbeddedMatches();
  } catch (err) {
    errors.push(`Bundled: ${err.message}`);
    throw new Error(
      errors.length
        ? `Could not load matches. ${errors.join(" · ")}`
        : "Could not load match data."
    );
  }
}

function isPlaceholderTeam(name) {
  if (!name) return true;
  if (/^[12][A-L]$/.test(name)) return true;
  if (/^W\d+$/.test(name)) return true;
  if (/^L\d+$/.test(name)) return true;
  if (/^3[A-Z]/.test(name) && name.includes("/")) return true;
  return false;
}

function populateTeamFilter() {
  const teams = new Set();
  for (const m of allMatches) {
    if (!isPlaceholderTeam(m.team1)) teams.add(m.team1);
    if (!isPlaceholderTeam(m.team2)) teams.add(m.team2);
  }
  const sorted = [...teams].sort((a, b) => a.localeCompare(b));
  const saved = localStorage.getItem(STORAGE_KEYS.team) || "";

  els.teamFilter.innerHTML =
    '<option value="">All teams</option>' +
    sorted.map((t) => `<option value="${escapeAttr(t)}"${t === saved ? " selected" : ""}>${escapeHtml(t)}</option>`).join("");
}

function populateGroupFilter() {
  const groups = new Set();
  for (const m of allMatches) {
    if (m.group) groups.add(m.group);
    if (m.round && !m.group) groups.add(m.round);
  }
  const sorted = [...groups].sort((a, b) => a.localeCompare(b));
  const saved = localStorage.getItem(STORAGE_KEYS.group) || "";

  els.groupFilter.innerHTML =
    '<option value="">All stages</option>' +
    sorted.map((g) => `<option value="${escapeAttr(g)}"${g === saved ? " selected" : ""}>${escapeHtml(g)}</option>`).join("");
}

function restoreFilters() {
  const status = localStorage.getItem(STORAGE_KEYS.status);
  els.statusFilter.value = status || "upcoming";
  const groupByDate = localStorage.getItem(STORAGE_KEYS.groupByDate);
  if (groupByDate !== null) els.groupByDate.checked = groupByDate === "true";
}

function isGroupStageGroup(name) {
  return /^Group [A-L]$/.test(name || "");
}

function matchPassesStatusFilter(match, status) {
  if (status === "all") return true;
  if (status === "upcoming") return match.status === "upcoming" || match.status === "live";
  return match.status === status;
}

function computeStandings(matches) {
  const groups = {};

  for (const m of matches) {
    if (!isGroupStageGroup(m.group)) continue;
    if (!groups[m.group]) groups[m.group] = {};
    for (const team of [m.team1, m.team2]) {
      if (isPlaceholderTeam(team)) continue;
      if (!groups[m.group][team]) {
        groups[m.group][team] = { team, played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 };
      }
    }
  }

  for (const m of matches) {
    if (!isGroupStageGroup(m.group)) continue;
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

function renderStandingsTeamCell(team) {
  const flag = flagUrlForTeam(team);
  const flagHtml = flag
    ? `<img class="standings-flag" src="${escapeAttr(flag)}" alt="" loading="lazy" width="20" height="15">`
    : "";
  const nameHtml = hasSquad(team)
    ? `<button type="button" class="standings-team-link team-link" data-team="${escapeAttr(team)}">${escapeHtml(team)}</button>`
    : `<span class="standings-team-name">${escapeHtml(team)}</span>`;
  return `<span class="standings-team">${flagHtml}${nameHtml}</span>`;
}

function resolveGroupPosPlaceholder(name, groupStandings) {
  const m = String(name || "").match(/^([12])([A-L])$/);
  if (!m) return name;
  const idx = m[1] === "1" ? 0 : 1;
  const group = `Group ${m[2]}`;
  const row = groupStandings[group]?.[idx];
  return row?.team || name;
}

function isKnockoutRound(name) {
  return KNOCKOUT_ROUNDS.includes(name);
}

function getKnockoutMatches(matches, roundName) {
  return matches
    .filter((m) => m.round === roundName && !m.group)
    .sort((a, b) => a.datetime - b.datetime);
}

const KNOCKOUT_NEXT_ROUND = {
  "Round of 32": "Round of 16",
  "Round of 16": "Quarter-final",
  "Quarter-final": "Semi-final",
  "Semi-final": "Final",
};

function sortStandingsRows(rows) {
  return rows.sort((a, b) => {
    const gdA = a.gf - a.ga;
    const gdB = b.gf - b.ga;
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (gdB !== gdA) return gdB - gdA;
    if (b.gf !== a.gf) return b.gf - a.gf;
    return a.team.localeCompare(b.team);
  });
}

function getRemainingGroupMatches(group, matches) {
  return matches.filter((m) => m.group === group && m.status !== "finished");
}

function getGroupTeams(group, matches) {
  const set = new Set();
  for (const m of matches) {
    if (m.group !== group) continue;
    for (const t of [m.team1, m.team2]) {
      if (!isPlaceholderTeam(t)) set.add(t);
    }
  }
  return [...set];
}

function buildGroupTable(group, teams, results) {
  const rows = {};
  for (const t of teams) {
    rows[t] = { team: t, played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 };
  }
  for (const { team1, team2, score } of results) {
    if (!score) continue;
    const row1 = rows[team1];
    const row2 = rows[team2];
    if (!row1 || !row2) continue;
    const [s1, s2] = score;
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
  return sortStandingsRows(Object.values(rows));
}

function collectFinishedGroupResults(group, matches) {
  return matches
    .filter((m) => m.group === group && m.status === "finished" && m.score)
    .map((m) => ({ team1: m.team1, team2: m.team2, score: m.score }));
}

function enumerateGroupSimulations(group, matches, pinnedMatch, pinnedScore) {
  const remaining = getRemainingGroupMatches(group, matches);
  const finished = collectFinishedGroupResults(group, matches);
  const others = pinnedMatch ? remaining.filter((m) => m.id !== pinnedMatch.id) : remaining;

  function recurse(idx, simulated) {
    if (idx >= others.length) {
      const results = [...finished];
      if (pinnedMatch && pinnedScore) {
        results.push({ team1: pinnedMatch.team1, team2: pinnedMatch.team2, score: pinnedScore });
      }
      for (const s of simulated) results.push(s);
      return [results];
    }
    const m = others[idx];
    const out = [];
    for (const score of [[1, 0], [1, 1], [0, 1]]) {
      out.push(...recurse(idx + 1, [...simulated, { team1: m.team1, team2: m.team2, score }]));
    }
    return out;
  }

  return recurse(0, []);
}

function scoreForTeamResult(match, team, result) {
  const home = match.team1 === team;
  if (result === "draw") return [1, 1];
  const teamWins = result === "win";
  if (home) return teamWins ? [1, 0] : [0, 1];
  return teamWins ? [0, 1] : [1, 0];
}

function teamTablePosition(table, team) {
  return table.findIndex((r) => r.team === team);
}

function getGroupTeamSignificance(team, match, matches) {
  if (!team || isPlaceholderTeam(team) || !isGroupStageGroup(match.group)) return null;

  const group = match.group;
  const teams = getGroupTeams(group, matches);
  const remaining = getRemainingGroupMatches(group, matches);
  if (!remaining.some((m) => m.id === match.id)) return null;

  const simulate = (result) => {
    const pinnedScore = scoreForTeamResult(match, team, result);
    return enumerateGroupSimulations(group, matches, match, pinnedScore).map((results) =>
      buildGroupTable(group, teams, results)
    );
  };

  const simulateAllRemaining = () =>
    enumerateGroupSimulations(group, matches, null, null).map((results) =>
      buildGroupTable(group, teams, results)
    );

  const canTopTwo = (result) => simulate(result).some((table) => teamTablePosition(table, team) < 2);
  const canFirst = (result) => simulate(result).some((table) => teamTablePosition(table, team) === 0);
  const canThird = (result) => simulate(result).some((table) => teamTablePosition(table, team) === 2);

  const clinchesTopTwo = (result) =>
    simulate(result).every((table) => teamTablePosition(table, team) < 2);
  const clinchesFirst = (result) =>
    simulate(result).every((table) => teamTablePosition(table, team) === 0);

  const clinchedFirst = simulateAllRemaining().every((table) => teamTablePosition(table, team) === 0);
  const clinchedTopTwo = simulateAllRemaining().every((table) => teamTablePosition(table, team) < 2);

  const outOfTopTwo = !canTopTwo("win") && !canTopTwo("draw") && !canTopTwo("loss");

  if (clinchedFirst) return "Clinched group";

  if (outOfTopTwo) {
    if (canThird("win") && !canThird("draw") && !canThird("loss")) return "Must win for 3rd-place hopes";
    if (canThird("win")) return "Win boosts Round of 32 chances";
    return null;
  }

  const mustWin = canTopTwo("win") && !canTopTwo("draw") && !canTopTwo("loss");

  if (mustWin && canFirst("win") && !canFirst("draw")) return "Must win for 1st place";
  if (mustWin) return "Must win to advance";

  if (clinchesFirst("win")) return "Win clinches 1st place";
  if (clinchesTopTwo("win")) return "Win clinches Round of 32";
  if (clinchesTopTwo("draw")) return "Draw clinches Round of 32";

  if (canTopTwo("draw") && !canTopTwo("loss")) return "Draw enough to advance";

  if (canFirst("win") && !clinchedTopTwo) return "Win for 1st place";
  if (clinchedTopTwo && canFirst("win")) return "Win for 1st place";

  return null;
}

function getKnockoutTeamSignificance(match) {
  if (!isKnockoutRound(match.round)) return null;
  if (match.round === "Final") return "Win to be champions";
  if (match.round === "Match for third place") return "Win for 3rd place";
  const next = KNOCKOUT_NEXT_ROUND[match.round];
  return next ? `Win to reach ${next}` : null;
}

function getMatchSignificance(match, matches) {
  if (match.status !== "upcoming" && match.status !== "live") {
    return { team1: null, team2: null };
  }

  if (isGroupStageGroup(match.group)) {
    return {
      team1: getGroupTeamSignificance(match.team1, match, matches),
      team2: getGroupTeamSignificance(match.team2, match, matches),
    };
  }

  if (isKnockoutRound(match.round)) {
    const label = getKnockoutTeamSignificance(match);
    return {
      team1: isPlaceholderTeam(match.team1) ? null : label,
      team2: isPlaceholderTeam(match.team2) ? null : label,
    };
  }

  return { team1: null, team2: null };
}

function renderTeamBlock(team, flagHtml, significance, away) {
  const sigHtml = significance
    ? `<span class="match-significance">${escapeHtml(significance)}</span>`
    : "";
  return `
    <div class="team ${away ? "team-away" : "team-home"}">
      ${flagHtml}
      <div class="team-info">
        ${renderTeamName(team)}
        ${sigHtml}
      </div>
    </div>
  `;
}

function computeRoundStandings(matches, groupStandings) {
  const teams = {};

  const ensureTeam = (name) => {
    const resolved = resolveGroupPosPlaceholder(name, groupStandings);
    if (isPlaceholderTeam(resolved)) return null;
    if (!teams[resolved]) {
      teams[resolved] = { team: resolved, played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 };
    }
    return teams[resolved];
  };

  for (const m of matches) {
    ensureTeam(m.team1);
    ensureTeam(m.team2);
  }

  for (const m of matches) {
    if ((m.status !== "finished" && m.status !== "live") || !m.score || m.score.length !== 2) continue;

    const t1 = resolveGroupPosPlaceholder(m.team1, groupStandings);
    const t2 = resolveGroupPosPlaceholder(m.team2, groupStandings);
    const row1 = teams[t1];
    const row2 = teams[t2];
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

  return Object.values(teams).sort((a, b) => {
    const gdA = a.gf - a.ga;
    const gdB = b.gf - b.ga;
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (gdB !== gdA) return gdB - gdA;
    if (b.gf !== a.gf) return b.gf - a.gf;
    return a.team.localeCompare(b.team);
  });
}

function renderStageDropdown(title, meta, innerHtml, stageKey) {
  const stage = stageKey ?? title;
  return `
    <details class="stage-dropdown" data-stage="${escapeAttr(stage)}">
      <summary class="stage-dropdown-summary">
        <span class="stage-dropdown-summary-inner">
          <span class="stage-dropdown-label">
            <span class="stage-dropdown-title">${escapeHtml(title)}</span>
            ${meta ? `<span class="stage-dropdown-meta">${escapeHtml(meta)}</span>` : ""}
          </span>
          <span class="stage-caret" aria-hidden="true">▾</span>
        </span>
      </summary>
      <div class="stage-dropdown-body">${innerHtml}</div>
    </details>
  `;
}

function renderKnockoutRoundDropdown(roundName, matches, groupStandings) {
  const rows = computeRoundStandings(matches, groupStandings);
  const played = matches.filter((m) => m.status === "finished" || m.status === "live").length;
  const meta = rows.length
    ? `${rows.length} team${rows.length !== 1 ? "s" : ""}${played ? ` · ${played} played` : ""}`
    : "TBD";

  const inner = rows.length
    ? renderGroupStandingsTable(rows, { highlightTop: false })
    : `<p class="standings-empty">Teams TBD</p>`;

  return renderStageDropdown(roundName, meta, inner);
}

function renderGroupStandingsTable(rows, { highlightTop = true } = {}) {
  const body = rows
    .map((row, i) => {
      const gd = row.gf - row.ga;
      const gdLabel = gd > 0 ? `+${gd}` : String(gd);
      let rowClass = "standings-row";
      if (highlightTop) {
        rowClass =
          i < 2 ? "standings-row standings-row-top" : i === 2 ? "standings-row standings-row-third" : "standings-row";
      }
      return `
        <tr class="${rowClass}" data-team="${escapeAttr(row.team)}">
          <td class="standings-cell-team">${renderStandingsTeamCell(row.team)}</td>
          <td>${row.played}</td>
          <td class="standings-hide-sm">${row.w}</td>
          <td class="standings-hide-sm">${row.d}</td>
          <td class="standings-hide-sm">${row.l}</td>
          <td>${gdLabel}</td>
          <td class="standings-pts">${row.pts}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="standings-table-wrap">
      <table class="standings-table">
        <thead>
          <tr>
            <th scope="col">Team</th>
            <th scope="col" title="Played">P</th>
            <th scope="col" class="standings-hide-sm" title="Won">W</th>
            <th scope="col" class="standings-hide-sm" title="Drawn">D</th>
            <th scope="col" class="standings-hide-sm" title="Lost">L</th>
            <th scope="col" title="Goal difference">GD</th>
            <th scope="col" title="Points">Pts</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function renderGroupStandingsCard(group, rows) {
  return `
    <div class="standings-group" data-group="${escapeAttr(group)}">
      <h3 class="standings-group-title">${escapeHtml(group)}</h3>
      ${renderGroupStandingsTable(rows)}
    </div>
  `;
}

function renderGroupStageSection(groupNames, groupStandings) {
  const grid = groupNames.map((g) => renderGroupStandingsCard(g, groupStandings[g])).join("");
  return renderStageDropdown(
    "Group stage",
    `${groupNames.length} group${groupNames.length !== 1 ? "s" : ""}`,
    `<div class="standings-grid">${grid}</div>`
  );
}

function renderStandings(focusStage = null) {
  if (!els.standingsContainer) return;

  const groupStandings = computeStandings(allMatches);
  let groupFilter = els.groupFilter.value;

  // Match-card navigation: show all standings sections, only open/highlight the target.
  if (focusStage) {
    groupFilter = "";
  }

  let groupNames = Object.keys(groupStandings).sort((a, b) => a.localeCompare(b));
  let knockoutRounds = KNOCKOUT_ROUNDS.filter((r) => getKnockoutMatches(allMatches, r).length > 0);

  if (isGroupStageGroup(groupFilter)) {
    groupNames = groupNames.filter((g) => g === groupFilter);
    knockoutRounds = [];
  } else if (isKnockoutRound(groupFilter)) {
    groupNames = [];
    knockoutRounds = knockoutRounds.filter((r) => r === groupFilter);
  }

  const stages = [];
  if (groupNames.length) {
    stages.push(renderGroupStageSection(groupNames, groupStandings));
  }
  stages.push(
    ...knockoutRounds.map((r) =>
      renderKnockoutRoundDropdown(r, getKnockoutMatches(allMatches, r), groupStandings)
    )
  );

  if (!stages.length) {
    els.standingsContainer.innerHTML = `<p class="standings-empty">No standings for the selected filter.</p>`;
    return;
  }

  els.standingsContainer.innerHTML = stages.join("");
}

function getFilteredMatches() {
  const team = els.teamFilter.value;
  const status = els.statusFilter.value;
  const group = els.groupFilter.value;
  const query = els.searchInput.value.trim().toLowerCase();

  return allMatches.filter((m) => {
    if (team && m.team1 !== team && m.team2 !== team) return false;
    if (!matchPassesStatusFilter(m, status)) return false;
    if (group && m.group !== group && m.round !== group) return false;
    if (query) {
      const haystack = [m.team1, m.team2, m.group, m.round, m.ground].join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function sortMatches(matches) {
  const now = Date.now() / 1000;
  return [...matches].sort((a, b) => {
    const statusOrder = { live: 0, upcoming: 1, finished: 2 };
    const sa = statusOrder[a.status] ?? 3;
    const sb = statusOrder[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
    if (a.status === "upcoming" && b.status === "upcoming") {
      const aPast = a.datetime <= now;
      const bPast = b.datetime <= now;
      if (aPast !== bPast) return aPast ? 1 : -1;
    }
    return a.datetime - b.datetime;
  });
}

function renderStatusBadge(match) {
  if (match.status === "live") {
    const min = match.live_minute != null && match.live_minute > 0 ? ` ${match.live_minute}'` : "";
    return `<span class="status-badge status-live">Live${min}</span>`;
  }
  if (match.status === "finished") {
    return `<span class="status-badge status-finished">FT</span>`;
  }
  return `<span class="status-badge status-upcoming">Upcoming</span>`;
}

function renderCenter(match, tz) {
  if (match.status === "finished") {
    if (match.score) {
      return `<span class="match-score">${match.score[0]} – ${match.score[1]}</span>`;
    }
    return `<span class="match-score match-score-pending">–</span>`;
  }
  if (match.status === "live") {
    return `<span class="match-vs">IN PLAY</span>`;
  }
  return `
    <span class="match-time">${formatTime(match.datetime, tz)}</span>
    <span class="match-countdown" data-kickoff="${match.datetime}">—</span>
  `;
}

function resolveTeamKey(name) {
  return TEAM_ALIASES[name] || name;
}

function getSquadForTeam(name) {
  return squadTeams[resolveTeamKey(name)] || null;
}

function hasSquad(name) {
  return !isPlaceholderTeam(name) && !!getSquadForTeam(name);
}

async function loadSquads() {
  if (window.__WC_SQUADS__?.teams) {
    squadTeams = window.__WC_SQUADS__.teams;
    return;
  }
  if (!IS_FILE_PROTOCOL) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(LOCAL_SQUADS, { cache: "no-store", signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        if (data.teams) squadTeams = data.teams;
      }
    } catch (err) {
      console.warn("Could not load squads:", err);
    }
  }
}

function renderTeamName(name) {
  const label = escapeHtml(name);
  if (!hasSquad(name)) {
    return `<span class="team-name">${label}</span>`;
  }
  return `<button type="button" class="team-name team-link" data-team="${escapeAttr(name)}">${label}</button>`;
}

function renderPlayerRow(player) {
  const cap = player.captain ? '<span class="player-captain" title="Captain">(C)</span>' : "";
  const stats = [
    player.pos,
    player.club ? escapeHtml(player.club) : "",
    player.caps != null ? `${player.caps} caps` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return `
    <li class="player-row">
      <span class="player-no">${player.no ?? "—"}</span>
      <div class="player-info">
        <span class="player-name">${escapeHtml(player.name)}${cap}</span>
        <span class="player-meta">${stats}</span>
      </div>
    </li>
  `;
}

function openSquadModal(teamName) {
  const squad = getSquadForTeam(teamName);
  if (!squad) return;

  const flagCode = TEAM_FLAG_CODES[teamName] || TEAM_FLAG_CODES[resolveTeamKey(teamName)];
  if (flagCode) {
    els.squadFlag.src = `https://flagcdn.com/w80/${flagCode}.png`;
    els.squadFlag.hidden = false;
  } else {
    els.squadFlag.hidden = true;
  }

  els.squadTitle.textContent = teamName;
  const subtitleParts = [];
  if (squad.group) subtitleParts.push(`Group ${squad.group}`);
  if (squad.coach) subtitleParts.push(`Coach: ${squad.coach}`);
  subtitleParts.push(`${squad.players.length} players`);
  els.squadSubtitle.textContent = subtitleParts.join(" · ");

  const byPos = {};
  for (const p of squad.players) {
    const pos = p.pos || "MF";
    if (!byPos[pos]) byPos[pos] = [];
    byPos[pos].push(p);
  }

  const sections = Object.keys(byPos)
    .sort((a, b) => (POS_ORDER[a] ?? 9) - (POS_ORDER[b] ?? 9))
    .map((pos) => {
      const players = byPos[pos].sort((a, b) => (a.no ?? 99) - (b.no ?? 99));
      return `
        <section class="squad-section">
          <h3 class="squad-section-title">${POS_LABELS[pos] || pos}</h3>
          <ul class="player-list">
            ${players.map(renderPlayerRow).join("")}
          </ul>
        </section>
      `;
    })
    .join("");

  els.squadBody.innerHTML = sections;
  els.squadModal.hidden = false;
  els.squadModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  els.squadClose.focus();
}

function closeSquadModal() {
  els.squadModal.hidden = true;
  els.squadModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function renderStageLink(label, stageName, team1, team2) {
  return `<button type="button" class="group-tag stage-link" data-stage="${escapeAttr(stageName)}" data-team1="${escapeAttr(team1 || "")}" data-team2="${escapeAttr(team2 || "")}">${escapeHtml(label)}</button>`;
}

function ensureStandingsForStage(stageName) {
  renderStandings(stageName);
}

function clearStandingsFlash() {
  els.standingsContainer?.querySelectorAll(".standings-flash, .standings-row-flash").forEach((el) => {
    el.classList.remove("standings-flash", "standings-row-flash");
  });
}

function applyStandingsHighlight(stageName, teams) {
  const container = els.standingsContainer;
  if (!container) return;

  clearStandingsFlash();
  container.scrollIntoView({ behavior: "smooth", block: "start" });

  const groupStandings = computeStandings(allMatches);
  const resolvedTeams = teams
    .map((t) => resolveGroupPosPlaceholder(t, groupStandings))
    .filter((t) => t && !isPlaceholderTeam(t));

  let highlightTarget = null;

  if (isGroupStageGroup(stageName)) {
    const groupStageDropdown = [...container.querySelectorAll("details.stage-dropdown")].find(
      (el) => el.dataset.stage === "Group stage"
    );
    if (groupStageDropdown) {
      groupStageDropdown.open = true;
      highlightTarget = [...groupStageDropdown.querySelectorAll(".standings-group")].find(
        (el) => el.dataset.group === stageName
      );
    }
  } else {
    const roundDropdown = [...container.querySelectorAll("details.stage-dropdown")].find(
      (el) => el.dataset.stage === stageName
    );
    if (roundDropdown) {
      roundDropdown.open = true;
      highlightTarget = roundDropdown;
    }
  }

  if (highlightTarget) {
    highlightTarget.classList.add("standings-flash");
    setTimeout(() => {
      highlightTarget.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
  }

  for (const team of resolvedTeams) {
    for (const row of container.querySelectorAll(".standings-row")) {
      if (row.dataset.team === team) {
        row.classList.add("standings-row-flash");
      }
    }
  }

  setTimeout(clearStandingsFlash, 2600);
}

function navigateToStandings(stageName, teams) {
  ensureStandingsForStage(stageName);
  requestAnimationFrame(() => {
    applyStandingsHighlight(stageName, teams);
  });
}

function handleMatchContainerClick(event) {
  const stageBtn = event.target.closest(".stage-link");
  if (stageBtn) {
    event.preventDefault();
    navigateToStandings(stageBtn.dataset.stage, [stageBtn.dataset.team1, stageBtn.dataset.team2]);
    return;
  }
  handleSquadClick(event);
}

function handleSquadClick(event) {
  const btn = event.target.closest(".team-link");
  if (!btn) return;
  event.preventDefault();
  openSquadModal(btn.dataset.team);
}

function initSquadModal() {
  els.matchesContainer.addEventListener("click", handleMatchContainerClick);
  els.standingsContainer?.addEventListener("click", handleSquadClick);
  els.squadClose.addEventListener("click", closeSquadModal);
  els.squadModal.querySelector("[data-close-squad]").addEventListener("click", closeSquadModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.squadModal.hidden) closeSquadModal();
  });
}

function renderMatchCard(match, tz) {
  const flag1 = match.flag1
    ? `<img class="team-flag" src="${escapeAttr(match.flag1)}" alt="" loading="lazy" width="32" height="22">`
    : "";
  const flag2 = match.flag2
    ? `<img class="team-flag" src="${escapeAttr(match.flag2)}" alt="" loading="lazy" width="32" height="22">`
    : "";

  const significance = getMatchSignificance(match, allMatches);

  const cardClass = [
    "match-card",
    match.status === "live" ? "is-live" : "",
    match.status === "finished" ? "is-finished" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const dateLabel = formatShortDate(match.datetime, tz);

  return `
    <article class="${cardClass}" data-id="${match.id}">
      ${renderTeamBlock(match.team1, flag1, significance.team1, false)}
      <div class="match-center">
        ${renderCenter(match, tz)}
        ${renderStatusBadge(match)}
        ${match.status === "live" ? `<span class="match-vs">${dateLabel}</span>` : ""}
      </div>
      ${renderTeamBlock(match.team2, flag2, significance.team2, true)}
      <div class="match-meta">
        ${match.group ? renderStageLink(match.group, match.group, match.team1, match.team2) : ""}
        ${match.round && isKnockoutRound(match.round) ? renderStageLink(match.round, match.round, match.team1, match.team2) : match.round ? `<span>${escapeHtml(match.round)}</span>` : ""}
        ${match.ground ? `<span>📍 ${escapeHtml(match.ground)}</span>` : ""}
      </div>
    </article>
  `;
}

function updateStats() {
  const upcoming = allMatches.filter((m) => m.status === "upcoming").length;
  const live = allMatches.filter((m) => m.status === "live").length;
  const finished = allMatches.filter((m) => m.status === "finished").length;

  els.statUpcoming.textContent = upcoming;
  els.statLive.textContent = live;
  els.statFinished.textContent = finished;
  els.statTotal.textContent = allMatches.length;
  els.statLiveCard?.classList.toggle("has-live", live > 0);
}

function render() {
  renderStandings();
  const tz = els.timezoneSelect.value;
  const filtered = sortMatches(getFilteredMatches());
  const groupByDate = els.groupByDate.checked;

  els.emptyState.hidden = filtered.length > 0;
  els.matchesContainer.hidden = filtered.length === 0;

  if (filtered.length === 0) {
    els.matchesContainer.innerHTML = "";
    return;
  }

  if (!groupByDate) {
    els.matchesContainer.innerHTML = filtered.map((m) => renderMatchCard(m, tz)).join("");
    updateMatchCountdowns();
    return;
  }

  const byDate = new Map();
  for (const m of filtered) {
    const key = formatDateHeading(m.datetime, tz);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(m);
  }

  els.matchesContainer.innerHTML = [...byDate.entries()]
    .map(([date, matches]) => {
      const isoDate = new Date(matches[0].datetime * 1000).toISOString().slice(0, 10);
      return `
        <section class="date-group">
          <h2 class="date-heading">
            <time datetime="${isoDate}">${escapeHtml(date)}</time>
            <span class="match-count">${matches.length} match${matches.length !== 1 ? "es" : ""}</span>
          </h2>
          ${matches.map((m) => renderMatchCard(m, tz)).join("")}
        </section>
      `;
    })
    .join("");

  updateMatchCountdowns();
}

function setMeta(source, updated) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  let text = `Last refreshed ${timeStr}`;
  if (updated) {
    const apiTime = new Date(updated * 1000).toLocaleString();
    text += ` · Data updated ${apiTime}`;
  }
  text += ` · Source: ${source}`;
  if (IS_FILE_PROTOCOL) {
    text += " · Use a local server (npx serve .) for live API updates";
  }
  els.metaLine.textContent = text;
}

function setLoading(isLoading) {
  els.loading.hidden = !isLoading;
  els.refreshBtn.classList.toggle("is-loading", isLoading);
  els.refreshBtn.disabled = isLoading;
}

function showError(msg) {
  els.error.hidden = false;
  els.errorMessage.textContent = msg;
}

function hideError() {
  els.error.hidden = true;
}

async function loadData() {
  setLoading(true);
  hideError();

  try {
    const { matches, source, updated } = await fetchMatches();
    allMatches = matches;
    populateTeamFilter();
    populateGroupFilter();
    updateStats();
    setMeta(source, updated);
    try {
      render();
    } catch (renderErr) {
      console.error("Render failed:", renderErr);
      showError(renderErr.message || "Could not display page content.");
    }
  } catch (err) {
    showError(err.message || "Failed to load matches.");
    els.matchesContainer.innerHTML = "";
    els.matchesContainer.hidden = true;
  } finally {
    setLoading(false);
  }
}

function saveAndRender() {
  localStorage.setItem(STORAGE_KEYS.timezone, els.timezoneSelect.value);
  localStorage.setItem(STORAGE_KEYS.team, els.teamFilter.value);
  localStorage.setItem(STORAGE_KEYS.status, els.statusFilter.value);
  localStorage.setItem(STORAGE_KEYS.group, els.groupFilter.value);
  localStorage.setItem(STORAGE_KEYS.groupByDate, String(els.groupByDate.checked));
  render();
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function boot() {
  initSportPicker("worldcup");
  initTimezoneSelect();
  restoreFilters();
  initSquadModal();

  els.refreshBtn.addEventListener("click", loadData);
  els.retryBtn.addEventListener("click", loadData);
  els.timezoneSelect.addEventListener("change", saveAndRender);
  els.teamFilter.addEventListener("change", saveAndRender);
  els.statusFilter.addEventListener("change", saveAndRender);
  els.groupFilter.addEventListener("change", saveAndRender);
  els.groupByDate.addEventListener("change", saveAndRender);
  els.searchInput.addEventListener("input", debounce(render, 200));

  loadSquads()
    .catch((err) => console.warn("Squads load skipped:", err))
    .then(async () => {
      await loadData();
      startMatchCountdowns();
      setInterval(() => {
        if (document.visibilityState === "visible") loadData();
      }, AUTO_REFRESH_MS);
    });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
