const API_PRIMARY = "https://wcup2026.org/api/data.php?action=all";
const API_FALLBACK = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";
const LOCAL_JSON = "data/matches.json";
const IS_FILE_PROTOCOL = window.location.protocol === "file:";

const STORAGE_KEYS = {
  timezone: "wc2026_timezone",
  team: "wc2026_team",
  status: "wc2026_status",
  group: "wc2026_group",
  groupByDate: "wc2026_group_by_date",
};

const LOCAL_SQUADS = "data/squads.json";

const TEAM_ALIASES = {
  "Bosnia & Herzegovina": "Bosnia and Herzegovina",
  USA: "United States",
};

const POS_ORDER = { GK: 0, DF: 1, MF: 2, FW: 3 };
const POS_LABELS = { GK: "Goalkeepers", DF: "Defenders", MF: "Midfielders", FW: "Forwards" };

/** @type {Record<string, {group:string, coach:string, players:Array}>} */
let squadTeams = {};

let countdownInterval = null;

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
  return {
    id: m.id,
    team1: m.team1,
    team2: m.team2,
    flag1: m.flag1 || "",
    flag2: m.flag2 || "",
    status: m.status || "upcoming",
    score: m.status === "finished" && m.score ? m.score : null,
    live_minute: m.live_minute,
    datetime: m.datetime,
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

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

async function fetchMatches() {
  const errors = [];

  if (!IS_FILE_PROTOCOL) {
    try {
      const data = await fetchJson(API_PRIMARY);
      if (!data.ok || !Array.isArray(data.matches)) throw new Error("Invalid API response");
      return {
        matches: data.matches.map(normalizePrimaryMatch),
        source: "wcup2026.org",
        updated: data.updated,
      };
    } catch (err) {
      errors.push(`API: ${err.message}`);
      console.warn("Primary API failed:", err);
    }

    try {
      const data = await fetchJson(LOCAL_JSON);
      if (data.ok && Array.isArray(data.matches)) {
        return {
          matches: data.matches.map(normalizePrimaryMatch),
          source: "local cache",
          updated: data.updated ?? null,
        };
      }
    } catch (err) {
      errors.push(`Local: ${err.message}`);
      console.warn("Local JSON failed:", err);
    }

    try {
      const data = await fetchJson(API_FALLBACK);
      return {
        matches: normalizeFallbackMatches(data),
        source: "openfootball",
        updated: null,
      };
    } catch (err) {
      errors.push(`Fallback: ${err.message}`);
      console.warn("Openfootball fallback failed:", err);
    }
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

function getFilteredMatches() {
  const team = els.teamFilter.value;
  const status = els.statusFilter.value;
  const group = els.groupFilter.value;
  const query = els.searchInput.value.trim().toLowerCase();

  return allMatches.filter((m) => {
    if (team && m.team1 !== team && m.team2 !== team) return false;
    if (status !== "all" && m.status !== status) return false;
    if (group && m.group !== group && m.round !== group) return false;
    if (query) {
      const haystack = [m.team1, m.team2, m.group, m.round, m.ground].join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function sortMatches(matches) {
  return [...matches].sort((a, b) => {
    const statusOrder = { live: 0, upcoming: 1, finished: 2 };
    const sa = statusOrder[a.status] ?? 3;
    const sb = statusOrder[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
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
  if (match.status === "finished" && match.score) {
    return `<span class="match-score">${match.score[0]} – ${match.score[1]}</span>`;
  }
  if (match.status === "live") {
    return `<span class="match-vs">IN PLAY</span>`;
  }
  return `
    <span class="match-time">${formatTime(match.datetime, tz)}</span>
    <span class="match-countdown" data-datetime="${match.datetime}">—</span>
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
      const res = await fetch(LOCAL_SQUADS, { cache: "no-store" });
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

function handleSquadClick(event) {
  const btn = event.target.closest(".team-link");
  if (!btn) return;
  event.preventDefault();
  openSquadModal(btn.dataset.team);
}

function initSquadModal() {
  els.matchesContainer.addEventListener("click", handleSquadClick);
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
      <div class="team team-home">
        ${flag1}
        ${renderTeamName(match.team1)}
      </div>
      <div class="match-center">
        ${renderCenter(match, tz)}
        ${renderStatusBadge(match)}
        ${match.status === "live" ? `<span class="match-vs">${dateLabel}</span>` : ""}
      </div>
      <div class="team team-away">
        ${flag2}
        ${renderTeamName(match.team2)}
      </div>
      <div class="match-meta">
        ${match.group ? `<span class="group-tag">${escapeHtml(match.group)}</span>` : ""}
        ${match.round ? `<span>${escapeHtml(match.round)}</span>` : ""}
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

function formatCountdownShort(ms) {
  if (ms <= 0) return "Starting soon";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return `in ${parts.join(" ")}`;
}

function updateMatchCountdowns() {
  const now = Date.now();
  document.querySelectorAll(".match-countdown").forEach((el) => {
    const kickoff = Number(el.dataset.datetime) * 1000;
    el.textContent = formatCountdownShort(kickoff - now);
  });
}

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  updateMatchCountdowns();
  countdownInterval = setInterval(updateMatchCountdowns, 1000);
}

function render() {
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
    render();
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

  loadSquads().then(() => {
    loadData();
    startCountdown();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
