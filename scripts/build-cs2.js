const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const BO3 = "https://api.bo3.gg/api/v1/matches";
const WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const RESULTS_MS_A = 48 * 60 * 60 * 1000;
const RESULTS_MS_S = 30 * 24 * 60 * 60 * 1000;
const FETCH_START_MS = RESULTS_MS_S;
const TOP_TEAM_COUNT = 30;

async function fetchBo3Page(offset, startIso, endIso) {
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
  const res = await fetch(`${BO3}?${params}`);
  if (!res.ok) throw new Error(`BO3 API ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

async function fetchAllMatches() {
  const now = Date.now();
  const startIso = new Date(now - FETCH_START_MS).toISOString();
  const endIso = new Date(now + WINDOW_MS).toISOString();
  let all = [];

  for (let offset = 0; ; offset += 100) {
    const page = await fetchBo3Page(offset, startIso, endIso);
    if (!page.length) break;
    all = all.concat(page);
    if (page.length < 100) break;
  }

  return all;
}

async function fetchTopTeams() {
  const params = new URLSearchParams({
    "filter[teams.discipline_id][eq]": "1",
    "filter[teams.rank][gt]": "0",
    "page[limit]": String(TOP_TEAM_COUNT),
    sort: "rank",
  });
  const res = await fetch(`https://api.bo3.gg/api/v1/teams?${params}`);
  if (!res.ok) throw new Error(`BO3 teams API ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((t) => ({
    rank: t.rank,
    name: t.name,
    slug: t.slug,
    logo: t.image_url || "",
  }));
}

function normalizeMatch(m) {
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
    slug: m.slug || "",
    url: m.slug ? `https://bo3.gg/matches/${m.slug}` : "",
  };
}

function filterMatches(matches, now = Date.now()) {
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

async function fetchTeamRoster(slug) {
  const res = await fetch(`https://api.bo3.gg/api/v1/teams/${slug}`);
  if (!res.ok) return null;
  const data = await res.json();
  const active = (data.players || []).filter((p) => p.status === 1);
  const coaches = active.filter((p) => p.is_coach);
  const players = active.filter((p) => !p.is_coach);
  if (!players.length && !coaches.length) return null;

  return {
    name: data.name,
    slug: data.slug,
    logo: data.image_url || "",
    rank: data.rank,
    coach: coaches.map((c) => c.nickname).join(", "),
    players: players.map((p) => ({
      nickname: p.nickname,
      name: [p.first_name, p.last_name].filter(Boolean).join(" "),
      country: p.country?.name || "",
      image: p.image_url || "",
    })),
  };
}

async function buildRosters(matches, topTeams) {
  const slugs = new Set(topTeams.map((t) => t.slug));
  for (const m of matches) {
    if (m.slug1) slugs.add(m.slug1);
    if (m.slug2) slugs.add(m.slug2);
  }

  const teams = {};
  for (const slug of slugs) {
    const roster = await fetchTeamRoster(slug);
    if (!roster) continue;
    teams[roster.name] = roster;
    await new Promise((r) => setTimeout(r, 80));
  }
  return teams;
}

async function main() {
  const [raw, topTeams] = await Promise.all([fetchAllMatches(), fetchTopTeams()]);
  const now = Date.now();
  const matches = filterMatches(raw.map(normalizeMatch), now).sort((a, b) => a.datetime - b.datetime);

  const sCount = matches.filter((m) => m.tier === "S").length;
  const aCount = matches.filter((m) => m.tier === "A").length;

  const payload = { updated: Math.floor(now / 1000), matches, topTeams };
  const jsonPath = path.join(root, "data", "cs2-matches.json");
  const jsPath = path.join(root, "data", "cs2-matches.js");

  fs.writeFileSync(jsonPath, JSON.stringify(payload));
  fs.writeFileSync(jsPath, `window.__CS2_MATCHES__ = ${JSON.stringify(payload)};`);

  console.log(`Built ${matches.length} S/A matches (${sCount} S-tier, ${aCount} A-tier)`);

  const teams = await buildRosters(matches, topTeams);
  const rosterPayload = { updated: Math.floor(Date.now() / 1000), teams };
  const rosterJson = path.join(root, "data", "cs2-rosters.json");
  const rosterJs = path.join(root, "data", "cs2-rosters.js");

  fs.writeFileSync(rosterJson, JSON.stringify(rosterPayload));
  fs.writeFileSync(rosterJs, `window.__CS2_ROSTERS__ = ${JSON.stringify(rosterPayload)};`);

  console.log(`Built rosters for ${Object.keys(teams).length} teams`);
  console.log(`Top teams: ${topTeams.slice(0, 5).map((t) => t.name).join(", ")}…`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
