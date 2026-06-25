const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const BO3 = "https://api.bo3.gg/api/v1/matches";
const WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const RESULTS_MS = 48 * 60 * 60 * 1000;

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
  const startIso = new Date(now - RESULTS_MS).toISOString();
  const endIso = new Date(now + WINDOW_MS).toISOString();
  let all = [];

  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await fetchBo3Page(offset, startIso, endIso);
    if (!page.length) break;
    all = all.concat(page);
    if (page.length < 100) break;
  }

  return all;
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

async function main() {
  const raw = await fetchAllMatches();
  const now = Date.now();
  const matches = raw
    .map(normalizeMatch)
    .filter((m) => m.tier === "S" || m.tier === "A")
    .filter((m) => {
      const t = m.datetime * 1000;
      if (m.status === "finished") return now - t <= RESULTS_MS;
      return t <= now + WINDOW_MS;
    })
    .sort((a, b) => a.datetime - b.datetime);

  const payload = { updated: Math.floor(now / 1000), matches };
  const jsonPath = path.join(root, "data", "cs2-matches.json");
  const jsPath = path.join(root, "data", "cs2-matches.js");

  fs.writeFileSync(jsonPath, JSON.stringify(payload));
  fs.writeFileSync(jsPath, `window.__CS2_MATCHES__ = ${JSON.stringify(payload)};`);

  console.log(`Built ${matches.length} S/A tier CS2 matches`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
