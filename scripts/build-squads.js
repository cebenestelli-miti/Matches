const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
function readJson(file) {
  const raw = fs.readFileSync(path.join(root, file), "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

const wc = readJson("data/squads-source.json");
const matches = readJson("data/matches.json");

const squads = {};
for (const g of wc.groups) {
  for (const t of g.teams) {
    squads[t.team] = {
      group: g.group,
      coach: t.coach || "",
      players: (t.squad || []).map((p) => ({
        no: p.shirt_number,
        pos: p.position,
        name: p.name,
        club: p.club || "",
        caps: p.caps,
        goals: p.goals,
        captain: !!p.captain,
        age: p.age,
      })),
    };
  }
}

const ALIASES = {
  "Bosnia & Herzegovina": "Bosnia and Herzegovina",
  "DR Congo": "Congo DR",
  "Ivory Coast": "Côte d'Ivoire",
  USA: "United States",
};

const resolved = { ...squads };
for (const [from, to] of Object.entries(ALIASES)) {
  if (squads[to] && !resolved[from]) resolved[from] = squads[to];
}

fs.writeFileSync(path.join(root, "data/squads.json"), JSON.stringify({ teams: resolved }));
fs.writeFileSync(
  path.join(root, "data/squads.js"),
  `window.__WC_SQUADS__ = ${JSON.stringify({ teams: resolved })};`
);

console.log(`Built squads for ${Object.keys(resolved).length} teams`);
