const fs = require("fs");
const path = require("path");

const API = "https://wcup2026.org/api/data.php?action=all";
const root = path.join(__dirname, "..");
const jsonPath = path.join(root, "data", "matches.json");
const jsPath = path.join(root, "data", "matches.js");

async function main() {
  const res = await fetch(API, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`API request failed (${res.status})`);
  const data = await res.json();
  if (!data.ok || !Array.isArray(data.matches)) throw new Error("Invalid API response");

  const json = JSON.stringify(data);
  fs.writeFileSync(jsonPath, json, "utf8");
  fs.writeFileSync(jsPath, `window.__WC_MATCHES__ = ${json};\n`, "utf8");

  const upcoming = data.matches.filter((m) => m.status === "upcoming").length;
  const r32 = data.matches.filter((m) => m.round === "Round of 32").length;
  console.log(`Wrote ${data.matches.length} matches (${upcoming} upcoming, ${r32} Round of 32)`);
  console.log(`Updated: ${new Date(data.updated * 1000).toISOString()}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
