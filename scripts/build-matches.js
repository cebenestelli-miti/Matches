const fs = require("fs");
const path = require("path");
const { applyBracketResolution, parseCupFinalsPenalties } = require("./bracket-resolve");

const API = "https://wcup2026.org/api/data.php?action=all";
const CUP_FINALS_URL =
  "https://raw.githubusercontent.com/openfootball/worldcup/master/2026--usa/cup_finals.txt";
const root = path.join(__dirname, "..");
const jsonPath = path.join(root, "data", "matches.json");
const jsPath = path.join(root, "data", "matches.js");

async function main() {
  const res = await fetch(API, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`API request failed (${res.status})`);
  let data = await res.json();
  if (!data.ok || !Array.isArray(data.matches)) throw new Error("Invalid API response");

  let penaltyResults = new Map();
  try {
    const cupRes = await fetch(CUP_FINALS_URL, { signal: AbortSignal.timeout(15000) });
    if (cupRes.ok) penaltyResults = parseCupFinalsPenalties(await cupRes.text());
  } catch (err) {
    console.warn("Penalty results unavailable:", err.message);
  }

  const { matches, changed } = applyBracketResolution(data.matches, penaltyResults);
  data = { ...data, matches };

  const json = JSON.stringify(data);
  fs.writeFileSync(jsonPath, json, "utf8");
  fs.writeFileSync(jsPath, `window.__WC_MATCHES__ = ${json};\n`, "utf8");

  const upcoming = data.matches.filter((m) => m.status === "upcoming").length;
  const r32 = data.matches.filter((m) => m.round === "Round of 32").length;
  const r16 = data.matches.filter((m) => m.round === "Round of 16");
  const r16Resolved = r16.filter((m) => !/^W\d+$/.test(m.team1) && !/^W\d+$/.test(m.team2)).length;
  console.log(`Wrote ${data.matches.length} matches (${upcoming} upcoming, ${r32} Round of 32)`);
  console.log(`Bracket resolution: ${changed} match slot(s) updated (${r16Resolved}/${r16.length} R16 fully named)`);
  console.log(`Updated: ${new Date(data.updated * 1000).toISOString()}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
