const SPORTS = [
  { id: "worldcup", href: "index.html", icon: "⚽", label: "World Cup 2026" },
  { id: "cs2", href: "cs2.html", icon: "🎮", label: "Counter-Strike 2" },
];

const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Copenhagen",
  "Africa/Johannesburg",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Asia/Dubai",
  "Australia/Sydney",
  "Pacific/Auckland",
];

function getDefaultTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
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

function initSportPicker(activeId) {
  const btn = document.getElementById("sport-picker-btn");
  const menu = document.getElementById("sport-picker-menu");
  if (!btn || !menu) return;

  const sport = SPORTS.find((s) => s.id === activeId) || SPORTS[0];
  btn.querySelector(".sport-picker-icon").textContent = sport.icon;

  menu.innerHTML = SPORTS.map(
    (s) =>
      `<a href="${escapeAttr(s.href)}" class="sport-option${s.id === activeId ? " is-active" : ""}" role="option">${escapeHtml(s.icon)} ${escapeHtml(s.label)}</a>`
  ).join("");

  menu.addEventListener("click", (e) => e.stopPropagation());

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !menu.hidden;
    menu.hidden = open;
    btn.setAttribute("aria-expanded", String(!open));
  });

  document.addEventListener("click", () => {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }
  });
}

function initTimezoneSelect(selectEl, storageKey) {
  const saved = localStorage.getItem(storageKey);
  const detected = getDefaultTimezone();
  const zones = [...new Set([detected, ...COMMON_TIMEZONES])].sort((a, b) => a.localeCompare(b));

  selectEl.innerHTML = zones
    .map(
      (z) =>
        `<option value="${escapeAttr(z)}"${z === (saved || detected) ? " selected" : ""}>${escapeHtml(z.replace(/_/g, " "))}</option>`
    )
    .join("");
}

function formatTime(unixSec, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(unixSec * 1000));
}

function formatDateHeading(unixSec, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(unixSec * 1000));
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

function startMatchCountdowns() {
  if (window.__matchCountdownInterval) clearInterval(window.__matchCountdownInterval);
  updateMatchCountdowns();
  window.__matchCountdownInterval = setInterval(updateMatchCountdowns, 1000);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
