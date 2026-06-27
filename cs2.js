const BO3_API =
  "https://api.bo3.gg/api/v1/matches?scope=widget-matches&page[offset]=0&page[limit]=100&sort=start_date&filter[matches.status][in]=upcoming,current,finished&filter[matches.discipline_id][eq]=1&with=teams,tournament";
const LOCAL_JSON = "data/cs2-matches.json";
const LOCAL_ROSTERS = "data/cs2-rosters.json";
const IS_FILE_PROTOCOL = window.location.protocol === "file:";
const WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const RESULTS_MS_A = 48 * 60 * 60 * 1000;
const RESULTS_MS_S = 30 * 24 * 60 * 60 * 1000;
const FETCH_START_MS = RESULTS_MS_S;

const STORAGE_KEYS = {
  timezone: "cs2_timezone",
  team: "cs2_team",
  status: "cs2_status",
  tier: "cs2_tier",
  event: "cs2_event",
  groupByDate: "cs2_group_by_date",
};

let allMatches = [];
/** @type {Array<{rank:number,name:string,slug:string,logo:string}>} */
let topTeams = [];
/** @type {Record<string, {slug:string,logo:string,rank:number|null,coach:string,players:Array}>} */
let teamRosters = {};

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
  tierFilter: $("#tier-filter"),
  eventFilter: $("#event-filter"),
  timezoneSelect: $("#timezone-select"),
  groupByDate: $("#group-by-date"),
  statUpcoming: $("#stat-upcoming"),
  statLive: $("#stat-live"),
  statFinished: $("#stat-finished"),
  statTotal: $("#stat-total"),
  statLiveCard: document.querySelector(".stat-live"),
  rosterModal: $("#roster-modal"),
  rosterTitle: $("#roster-title"),
  rosterSubtitle: $("#roster-subtitle"),
  rosterLogo: $("#roster-logo"),
  rosterBody: $("#roster-body"),
  rosterClose: $("#roster-close"),
  topTeamsList: $("#top-teams-list"),
};

function normalizeBo3Match(m) {
  const rank = m.tournament?.tier_rank;
  const tier = rank === 1 ? "S" : rank === 2 ? "A" : "B";
  const status =
    m.status === "current" ? "live" : m.status === "finished" ? "finished" : "upcoming";

  return {
    id: m.id,
    team1: m.team1?.name || "TBD",
    team2: m.team2?.name || "TBD",
    slug1: m.team1?.slug || "",
    slug2: m.team2?.slug || "",
    logo1: m.team1?.image_url || "",
    logo2: m.team2?.image_url || "",
    status,
    score: status === "finished" ? [m.team1_score ?? 0, m.team2_score ?? 0] : null,
    datetime: Math.floor(new Date(m.start_date).getTime() / 1000),
    event: m.tournament?.name || "",
    tier,
    bestOf: m.bo_type || 3,
    url: m.slug ? `https://bo3.gg/matches/${m.slug}` : "",
  };
}

function filterMatchesByWindow(matches) {
  const now = Date.now();
  return matches.filter((m) => {
    const t = m.datetime * 1000;
    if (m.tier !== "S" && m.tier !== "A") return false;
    if (m.status === "finished") {
      if (m.tier === "S") return now - t <= RESULTS_MS_S;
      return now - t <= RESULTS_MS_A;
    }
    return t <= now + WINDOW_MS;
  });
}

async function fetchBo3Pages() {
  const now = Date.now();
  const startIso = new Date(now - FETCH_START_MS).toISOString();
  const endIso = new Date(now + WINDOW_MS).toISOString();
  let all = [];

  for (let offset = 0; ; offset += 100) {
    const params = new URLSearchParams({
      scope: "widget-matches",
      "page[offset]": String(offset),
      "page[limit]": "100",
      sort: "start_date",
      "filter[matches.status][in]": "upcoming,current,finished",
      "filter[matches.discipline_id][eq]": "1",
      "filter[matches.start_date][gt]": startIso,
      "filter[matches.start_date][lt]": endIso,
      with: "teams,tournament",
    });
    const res = await fetch(`https://api.bo3.gg/api/v1/matches?${params}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`BO3 API returned ${res.status}`);
    const data = await res.json();
    const page = data.results || [];
    if (!page.length) break;
    all = all.concat(page.map(normalizeBo3Match));
    if (page.length < 100) break;
  }

  return filterMatchesByWindow(all);
}

function loadEmbeddedMatches() {
  const data = window.__CS2_MATCHES__;
  if (!data?.matches) throw new Error("Bundled CS2 data is missing.");
  if (data.topTeams) topTeams = data.topTeams;
  return { matches: filterMatchesByWindow(data.matches), source: "bundled data", updated: data.updated };
}

async function fetchMatches() {
  if (!IS_FILE_PROTOCOL) {
    try {
      const matches = await fetchBo3Pages();
      return { matches, source: "bo3.gg", updated: Math.floor(Date.now() / 1000) };
    } catch (err) {
      console.warn("BO3 API failed:", err);
    }

    try {
      const res = await fetch(LOCAL_JSON, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data.topTeams) topTeams = data.topTeams;
        return {
          matches: filterMatchesByWindow(data.matches || []),
          source: "local cache",
          updated: data.updated,
        };
      }
    } catch (err) {
      console.warn("Local CS2 JSON failed:", err);
    }
  }

  return loadEmbeddedMatches();
}

function populateTeamFilter() {
  const teams = new Set();
  for (const m of allMatches) {
    if (m.team1 !== "TBD") teams.add(m.team1);
    if (m.team2 !== "TBD") teams.add(m.team2);
  }
  const saved = localStorage.getItem(STORAGE_KEYS.team) || "";
  els.teamFilter.innerHTML =
    '<option value="">All teams</option>' +
    [...teams].sort().map((t) => `<option value="${escapeAttr(t)}"${t === saved ? " selected" : ""}>${escapeHtml(t)}</option>`).join("");
}

function populateEventFilter() {
  const events = new Set();
  for (const m of allMatches) {
    if (m.event) events.add(m.event);
  }
  const saved = localStorage.getItem(STORAGE_KEYS.event) || "";
  els.eventFilter.innerHTML =
    '<option value="">All tournaments</option>' +
    [...events].sort().map((e) => `<option value="${escapeAttr(e)}"${e === saved ? " selected" : ""}>${escapeHtml(e)}</option>`).join("");
}

function restoreFilters() {
  const savedStatus = localStorage.getItem(STORAGE_KEYS.status);
  els.statusFilter.value = savedStatus || "all";
  const tier = localStorage.getItem(STORAGE_KEYS.tier);
  if (tier) els.tierFilter.value = tier;
  const groupByDate = localStorage.getItem(STORAGE_KEYS.groupByDate);
  if (groupByDate !== null) els.groupByDate.checked = groupByDate === "true";
}

function renderTopTeams() {
  if (!els.topTeamsList || !topTeams.length) return;

  els.topTeamsList.innerHTML = topTeams
    .map((team) => {
      const hasRosterBtn = hasRoster(team.name);
      const logo = team.logo
        ? `<img class="top-team-logo" src="${escapeAttr(team.logo)}" alt="" loading="lazy" width="28" height="28">`
        : "";
      const inner = `${logo}<span class="top-team-rank">#${team.rank}</span><span class="top-team-name">${escapeHtml(team.name)}</span>`;
      if (hasRosterBtn) {
        return `<button type="button" class="top-team-chip team-link" data-team="${escapeAttr(team.name)}">${inner}</button>`;
      }
      return `<span class="top-team-chip">${inner}</span>`;
    })
    .join("");
}

function getFilteredMatches() {
  const team = els.teamFilter.value;
  const status = els.statusFilter.value;
  const tier = els.tierFilter.value;
  const event = els.eventFilter.value;
  const query = els.searchInput.value.trim().toLowerCase();

  return allMatches.filter((m) => {
    if (tier === "S" && m.tier !== "S") return false;
    if (tier === "A" && m.tier !== "A") return false;
    if (tier === "sa" && m.tier !== "S" && m.tier !== "A") return false;
    if (team && m.team1 !== team && m.team2 !== team) return false;
    if (status !== "all" && m.status !== status) return false;
    if (event && m.event !== event) return false;
    if (query) {
      const haystack = [m.team1, m.team2, m.event, m.tier].join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function sortMatches(matches) {
  return [...matches].sort((a, b) => {
    const order = { live: 0, upcoming: 1, finished: 2 };
    const sa = order[a.status] ?? 3;
    const sb = order[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
    return a.datetime - b.datetime;
  });
}

function isRealTeam(name) {
  return name && name !== "TBD";
}

function getRosterForTeam(name) {
  return teamRosters[name] || null;
}

function hasRoster(name) {
  return isRealTeam(name) && !!getRosterForTeam(name)?.players?.length;
}

async function loadRosters() {
  if (window.__CS2_ROSTERS__?.teams) {
    teamRosters = window.__CS2_ROSTERS__.teams;
    return;
  }
  if (!IS_FILE_PROTOCOL) {
    try {
      const res = await fetch(LOCAL_ROSTERS, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data.teams) teamRosters = data.teams;
      }
    } catch (err) {
      console.warn("Could not load CS2 rosters:", err);
    }
  }
}

function renderTeamName(name) {
  const label = escapeHtml(name);
  if (!hasRoster(name)) {
    return `<span class="team-name">${label}</span>`;
  }
  return `<button type="button" class="team-name team-link" data-team="${escapeAttr(name)}">${label}</button>`;
}

function renderPlayerRow(player) {
  const avatar = player.image
    ? `<img class="player-avatar" src="${escapeAttr(player.image)}" alt="" loading="lazy" width="36" height="36">`
    : `<span class="player-no">—</span>`;
  const meta = [player.name, player.country].filter(Boolean).join(" · ");

  return `
    <li class="player-row">
      ${avatar}
      <div class="player-info">
        <span class="player-name">${escapeHtml(player.nickname)}</span>
        ${meta ? `<span class="player-meta">${escapeHtml(meta)}</span>` : ""}
      </div>
    </li>
  `;
}

function openRosterModal(teamName) {
  const roster = getRosterForTeam(teamName);
  if (!roster) return;

  if (roster.logo) {
    els.rosterLogo.src = roster.logo;
    els.rosterLogo.hidden = false;
  } else {
    els.rosterLogo.hidden = true;
  }

  els.rosterTitle.textContent = teamName;
  const subtitleParts = [];
  if (roster.rank) subtitleParts.push(`BO3 rank #${roster.rank}`);
  if (roster.coach) subtitleParts.push(`Coach: ${roster.coach}`);
  subtitleParts.push(`${roster.players.length} players`);
  els.rosterSubtitle.textContent = subtitleParts.join(" · ");

  els.rosterBody.innerHTML = `
    <section class="squad-section">
      <h3 class="squad-section-title">Active roster</h3>
      <ul class="player-list">
        ${roster.players.map(renderPlayerRow).join("")}
      </ul>
    </section>
  `;

  els.rosterModal.hidden = false;
  els.rosterModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  els.rosterClose.focus();
}

function closeRosterModal() {
  els.rosterModal.hidden = true;
  els.rosterModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function handleRosterClick(event) {
  const btn = event.target.closest(".team-link");
  if (!btn) return;
  event.preventDefault();
  openRosterModal(btn.dataset.team);
}

function initRosterModal() {
  const onTeamClick = handleRosterClick;
  els.matchesContainer.addEventListener("click", onTeamClick);
  els.topTeamsList?.addEventListener("click", onTeamClick);
  els.rosterClose.addEventListener("click", closeRosterModal);
  els.rosterModal.querySelector("[data-close-roster]").addEventListener("click", closeRosterModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.rosterModal.hidden) closeRosterModal();
  });
}

function renderStatusBadge(match) {
  if (match.status === "live") return `<span class="status-badge status-live">Live</span>`;
  if (match.status === "finished") return `<span class="status-badge status-finished">FT</span>`;
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
    <span class="match-countdown" data-kickoff="${match.datetime}">—</span>
  `;
}

function renderMatchCard(match, tz) {
  const logo1 = match.logo1
    ? `<img class="team-flag" src="${escapeAttr(match.logo1)}" alt="" loading="lazy" width="32" height="32">`
    : "";
  const logo2 = match.logo2
    ? `<img class="team-flag team-logo" src="${escapeAttr(match.logo2)}" alt="" loading="lazy" width="32" height="32">`
    : "";

  const cardClass = [
    "match-card",
    match.status === "live" ? "is-live" : "",
    match.status === "finished" ? "is-finished" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const tierClass = match.tier === "S" ? "tier-s" : "tier-a";
  const boLabel = `BO${match.bestOf || 3}`;
  const link = match.url
    ? `<a href="${escapeAttr(match.url)}" class="match-link" target="_blank" rel="noopener">View on BO3.gg</a>`
    : "";

  return `
    <article class="${cardClass}" data-id="${match.id}">
      <div class="team team-home">
        ${logo1}
        ${renderTeamName(match.team1)}
      </div>
      <div class="match-center">
        ${renderCenter(match, tz)}
        ${renderStatusBadge(match)}
      </div>
      <div class="team team-away">
        ${logo2}
        ${renderTeamName(match.team2)}
      </div>
      <div class="match-meta">
        <span class="tier-tag ${tierClass}">${match.tier}-Tier</span>
        <span class="group-tag">${escapeHtml(boLabel)}</span>
        <span>${escapeHtml(match.event)}</span>
        ${link}
      </div>
    </article>
  `;
}

function updateStats() {
  els.statUpcoming.textContent = allMatches.filter((m) => m.status === "upcoming").length;
  els.statLive.textContent = allMatches.filter((m) => m.status === "live").length;
  els.statFinished.textContent = allMatches.filter((m) => m.status === "finished").length;
  els.statTotal.textContent = allMatches.length;
  els.statLiveCard?.classList.toggle("has-live", allMatches.some((m) => m.status === "live"));
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
  let text = `Last refreshed ${timeStr} · Source: ${source}`;
  if (updated) {
    text += ` · Data updated ${new Date(updated * 1000).toLocaleString()}`;
  }
  els.metaLine.textContent = text;
}

function setLoading(on) {
  els.loading.hidden = !on;
  els.refreshBtn.classList.toggle("is-loading", on);
  els.refreshBtn.disabled = on;
}

async function loadData() {
  setLoading(true);
  els.error.hidden = true;

  try {
    const { matches, source, updated } = await fetchMatches();
    allMatches = matches;
    populateTeamFilter();
    populateEventFilter();
    updateStats();
    renderTopTeams();
    setMeta(source, updated);
    render();
  } catch (err) {
    els.error.hidden = false;
    els.errorMessage.textContent = err.message || "Failed to load matches.";
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
  localStorage.setItem(STORAGE_KEYS.tier, els.tierFilter.value);
  localStorage.setItem(STORAGE_KEYS.event, els.eventFilter.value);
  localStorage.setItem(STORAGE_KEYS.groupByDate, String(els.groupByDate.checked));
  render();
}

function boot() {
  initSportPicker("cs2");
  initTimezoneSelect(els.timezoneSelect, STORAGE_KEYS.timezone);
  restoreFilters();
  initRosterModal();

  els.refreshBtn.addEventListener("click", loadData);
  els.retryBtn.addEventListener("click", loadData);
  els.timezoneSelect.addEventListener("change", saveAndRender);
  els.teamFilter.addEventListener("change", saveAndRender);
  els.statusFilter.addEventListener("change", saveAndRender);
  els.tierFilter.addEventListener("change", saveAndRender);
  els.eventFilter.addEventListener("change", saveAndRender);
  els.groupByDate.addEventListener("change", saveAndRender);
  els.searchInput.addEventListener("input", debounce(render, 200));

  loadRosters().then(() => {
    if (!topTeams.length && window.__CS2_MATCHES__?.topTeams) {
      topTeams = window.__CS2_MATCHES__.topTeams;
    }
    loadData();
    startMatchCountdowns();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
