import {
  RATINGS,
  SKILLS,
  playerRatingLabel,
  ratingRankLabel,
  skillKeyFromLabel,
  getGameLimit,
  setGameLimit,
  ensureQueuesExist,
  addPlayer,
  listenToQueues,
  listenToPlayers,
  reorderQueue,
  skipPlayer,
  markPlayerAbsent,
  activatePlayerToStandby,
  updatePlayerSkill,
  updatePlayerGender,
  updatePlayerProfile,
  updatePlayerPracticePartner,
  removePlayer,
  archiveAllPlayers,
  archiveSinglePlayer,
  generateSmartRound,
  playerNameKey,
} from "./queue.js";
import {
  ensureCourtsExist,
  listenToCourts,
  assignMatchToCourt,
  finishMatch,
  toggleCourtStatus,
  updateCourtAllowedSkill,
  addCourt,
  removeCourt,
  replaceActiveCourtPlayer
} from "./courts.js";
import { 
  db, collection, query, where, orderBy, limit, onSnapshot,
  auth, onAuthStateChanged, signOut, doc, getDoc, setDoc
, getTenantCollection, getTenantDoc} from "./firebase.js";
import { startAutoLogout, stopAutoLogout } from "./auto-logout.js";

const AVG_MATCH_MINUTES = 15;

let activeSettingsUser = null;
let activeDashboardColor = "#8b5cf6";

const CUSTOM_THEME_PROPERTIES = [
  "--bg-base", "--bg-card", "--bg-sub", "--accent-tl", "--accent-gd", "--accent-or",
  "--text-base", "--text-muted", "--border", "--theme-panel", "--theme-sidebar",
  "--theme-subpanel", "--theme-border", "--theme-glow",
  "--theme-sidebar-text", "--theme-button-text", "--theme-header-text", "--theme-gradient-start", "--theme-gradient-end",
  "--theme-card-text", "--theme-card-pill-bg",
];

const ORIGINAL_DASHBOARD_PALETTE = {
  "--bg-base": "#0a2e2e",
  "--bg-card": "#0f3d3d",
  "--bg-sub": "#0c3232",
  "--accent-or": "#E85A1A",
  "--accent-gd": "#F5C42A",
  "--accent-tl": "#1fcfb1",
  "--text-base": "#F2E8D5",
  "--text-muted": "#a8c4be",
  "--border": "rgba(245, 196, 42, 0.18)",
};

function dashboardThemeStorageKey(userId) {
  return `dq_dashboard_theme_${userId}`;
}

function readDashboardColor(value) {
  if (!value || value === "teal") return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return normalizeDashboardColor(parsed.start);
    }
  } catch {
    // Old accounts stored one color as a plain string.
  }
  return normalizeDashboardColor(value);
}

function normalizeDashboardColor(color, fallback = "#8b5cf6") {
  return typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color.trim())
    ? color.trim().toLowerCase()
    : fallback;
}

function hexToRgb(hex) {
  const value = normalizeDashboardColor(hex).slice(1);
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function mixHex(first, second, firstWeight) {
  const a = hexToRgb(first);
  const b = hexToRgb(second);
  const mixChannel = (channel) => Math.round(a[channel] * firstWeight + b[channel] * (1 - firstWeight));
  return `#${[mixChannel("r"), mixChannel("g"), mixChannel("b")]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const linearize = (channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function readableTextColor(background) {
  const luminance = relativeLuminance(background);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast > whiteContrast ? "#07111f" : "#f8fafc";
}

function applyDashboardColor(color) {
  const selectedColor = normalizeDashboardColor(color);
  const body = document.body;
  const base = mixHex(selectedColor, "#080a13", 0.17);
  const card = mixHex(selectedColor, "#101320", 0.28);
  const sub = mixHex(selectedColor, "#0c0e18", 0.2);
  const sidebar = mixHex(selectedColor, "#0b1a1a", 0.42);
  const bright = mixHex(selectedColor, "#ffffff", 0.72);
  const deep = mixHex(selectedColor, "#05060b", 0.78);
  const headerSurface = mixHex(selectedColor, base, 0.52);

  activeDashboardColor = selectedColor;
  body.dataset.dashboardTheme = "custom";
  body.style.setProperty("--bg-base", base);
  body.style.setProperty("--bg-card", card);
  body.style.setProperty("--bg-sub", sub);
  body.style.setProperty("--accent-tl", selectedColor);
  body.style.setProperty("--accent-gd", bright);
  body.style.setProperty("--accent-or", deep);
  body.style.setProperty("--text-base", "#f8fafc");
  body.style.setProperty("--text-muted", "#cbd5e1");
  body.style.setProperty("--border", rgba(selectedColor, 0.28));
  body.style.setProperty("--theme-panel", rgba(card, 0.96));
  body.style.setProperty("--theme-sidebar", rgba(sidebar, 0.98));
  body.style.setProperty("--theme-subpanel", rgba(sub, 0.86));
  body.style.setProperty("--theme-border", rgba(bright, 0.24));
  body.style.setProperty("--theme-glow", rgba(selectedColor, 0.32));
  body.style.setProperty("--theme-sidebar-text", readableTextColor(sidebar));
  body.style.setProperty("--theme-button-text", readableTextColor(selectedColor));
  body.style.setProperty("--theme-header-text", readableTextColor(headerSurface));
  // Stat values and the small queue-count pills sit on dark translucent panels.
  // Derive their ink from that panel, not from the selected accent color.
  body.style.setProperty("--theme-card-text", readableTextColor(sub));
  body.style.setProperty("--theme-card-pill-bg", rgba(sub, 0.94));

  const colorValue = document.getElementById("dashboard-color-value");
  if (colorValue) colorValue.textContent = selectedColor.toUpperCase();
}

function restoreOriginalDashboardDesign() {
  document.body.removeAttribute("data-dashboard-theme");
  CUSTOM_THEME_PROPERTIES.forEach((property) => document.body.style.removeProperty(property));
  Object.entries(ORIGINAL_DASHBOARD_PALETTE).forEach(([property, value]) => {
    document.body.style.setProperty(property, value);
  });
  activeDashboardColor = "#1fcfb1";
  const colorValue = document.getElementById("dashboard-color-value");
  if (colorValue) colorValue.textContent = "ORIGINAL";
}

function setupSidebarTooltips() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar || document.getElementById("sidebar-float-label")) return;

  const tooltip = document.createElement("div");
  tooltip.id = "sidebar-float-label";
  tooltip.className = "sidebar-float-label";
  tooltip.setAttribute("role", "tooltip");
  document.body.appendChild(tooltip);

  let pressTimer = null;
  let activeItem = null;
  const hide = () => {
    window.clearTimeout(pressTimer);
    pressTimer = null;
    activeItem = null;
    tooltip.classList.remove("is-visible");
  };
  const isCollapsedDesktopSidebar = () => window.innerWidth >= 768 && sidebar.classList.contains("md:w-16");
  const show = (item, force = false) => {
    if (!force && !isCollapsedDesktopSidebar()) return;
    const label = item.dataset.sidebarLabel;
    if (!label) return;
    const bounds = item.getBoundingClientRect();
    tooltip.textContent = label;
    tooltip.style.left = `${Math.max(8, bounds.right + 12)}px`;
    tooltip.style.top = `${Math.max(12, Math.min(window.innerHeight - 12, bounds.top + bounds.height / 2))}px`;
    tooltip.classList.add("is-visible");
    activeItem = item;
  };

  sidebar.querySelectorAll(".nav-item[title]").forEach((item) => {
    const label = item.getAttribute("title");
    item.dataset.sidebarLabel = label;
    item.setAttribute("aria-label", label);
    item.removeAttribute("title"); // Use the consistent custom label instead of the browser tooltip.

    item.addEventListener("mouseenter", () => show(item));
    item.addEventListener("mouseleave", hide);
    item.addEventListener("focus", () => show(item));
    item.addEventListener("blur", hide);
    item.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch") return;
      pressTimer = window.setTimeout(() => {
        show(item, true);
        activeItem = item;
        navigator.vibrate?.(8);
      }, 500);
    });
    const finishTouch = (event) => {
      const wasLongPress = activeItem === item;
      window.clearTimeout(pressTimer);
      pressTimer = null;
      if (!wasLongPress) return;
      event.preventDefault();
      item.addEventListener("click", (clickEvent) => clickEvent.preventDefault(), { once: true, capture: true });
      window.setTimeout(hide, 1400);
    };
    item.addEventListener("pointerup", finishTouch);
    item.addEventListener("pointercancel", hide);
  });

  window.addEventListener("resize", hide);
  window.addEventListener("scroll", hide, true);
}

function populateSettingsProfile(user, profile = {}) {
  activeSettingsUser = user;
  const displayName = (profile.name || user.displayName || user.email || "Account").trim();
  const initial = displayName.charAt(0).toUpperCase() || "A";
  const clubName = profile.club ? `${profile.club.charAt(0).toUpperCase()}${profile.club.slice(1)} club` : "PicklQ account";

  const profileName = document.getElementById("settings-profile-heading");
  const profileEmail = document.getElementById("settings-profile-email");
  const profileClub = document.getElementById("settings-profile-club");
  const avatar = document.getElementById("settings-avatar");
  if (profileName) profileName.textContent = displayName;
  if (profileEmail) profileEmail.textContent = user.email || "";
  if (profileClub) profileClub.textContent = clubName;
  if (avatar) avatar.textContent = initial;

  // Keep the selection private to this signed-in account, with the browser
  // copy taking priority if a connection was unavailable during a prior save.
  const savedValue = localStorage.getItem(dashboardThemeStorageKey(user.uid));
  const savedColor = readDashboardColor(savedValue);
  if (savedValue === "teal" || (!savedColor && (!profile.dashboardTheme || profile.dashboardTheme === "teal"))) {
    restoreOriginalDashboardDesign();
  } else {
    const profileColor = profile.dashboardTheme === "custom"
      ? profile.dashboardColor || profile.dashboardColorStart
      : "#8b5cf6";
    applyDashboardColor(savedColor || profileColor);
  }
}

function getMorphOpts() {
  return {
    childrenOnly: true,
    onBeforeElUpdated: function(fromEl, toEl) {
      if (fromEl.classList && (fromEl.classList.contains('sortable-ghost') || fromEl.classList.contains('sortable-drag') || fromEl.classList.contains('sortable-fallback'))) {
        return false;
      }
      if (fromEl._sortable) {
        toEl._sortable = fromEl._sortable;
      }
      if (fromEl.dataset && fromEl.dataset.sortableAttached) {
        toEl.dataset.sortableAttached = fromEl.dataset.sortableAttached;
      }
      const isPlayerField = fromEl.matches?.('[data-player-rating], [data-player-skill], [data-player-gender]');
      if (!isPlayerField && (fromEl.tagName === 'INPUT' || fromEl.tagName === 'SELECT' || fromEl.tagName === 'TEXTAREA')) {
        if (fromEl.type !== 'checkbox' && fromEl.type !== 'radio') {
          toEl.value = fromEl.value;
        } else {
          toEl.checked = fromEl.checked;
        }
      }
      return true;
    }
  };
}

window.smoothUpdateHTML = function(container, html) {
  if (window.morphdom) {
    const temp = container.cloneNode(false);
    temp.innerHTML = html;
    morphdom(container, temp, getMorphOpts());
  } else {
    container.innerHTML = html;
  }
};

window.smoothUpdateNode = function(container, node) {
  if (window.morphdom) {
    const temp = container.cloneNode(false);
    if (node) temp.appendChild(node);
    morphdom(container, temp, getMorphOpts());
  } else {
    container.innerHTML = "";
    if (node) container.appendChild(node);
  }
};

const state = {
  queues: {},
  courts: [],
  players: new Map(),
  pendingMatches: [],
  matchLog: [],
  matchLogPage: 0,
  matchLogShowArchived: false,
  search: "",
  filter: "All",
  automationLock: false,
  editingMatches: new Set(),
  // Auto queue top-up is enabled by default. A user can explicitly turn it
  // off, which stores "0" in local storage.
  autoRound: localStorage.getItem("dq_auto_round") !== "0",
  autoRoundMode: localStorage.getItem("dq_auto_round_mode") || "smart",
  autoRoundLock: false,
  ready: {
    queues: false,
    courts: false,
    players: false,
    pendingMatches: false,
  },
};

const SCORING_STORAGE_KEY = "dq_scoring_enabled";

function scoringIsEnabled() {
  const storedValue = localStorage.getItem(SCORING_STORAGE_KEY);
  // Keep the dashboard's pre-existing "Scoring: ON" behavior for clubs that
  // have not selected a preference yet.
  return storedValue === null ? true : storedValue === "true";
}

function refreshScoringUI() {
  const scoringEnabled = scoringIsEnabled();
  const headerLabel = document.getElementById("header-scoring-label");
  const headerButton = document.getElementById("toggle-scoring-btn");
  const rankingToggle = document.getElementById("ranking-scoring-toggle");
  const rankingLabel = document.getElementById("ranking-scoring-label");

  if (headerLabel) headerLabel.textContent = `Scoring: ${scoringEnabled ? "ON" : "OFF"}`;
  if (headerButton) {
    headerButton.setAttribute("aria-pressed", String(scoringEnabled));
    headerButton.classList.toggle("border-purple-500/60", scoringEnabled);
    headerButton.classList.toggle("text-purple-300", scoringEnabled);
  }
  if (rankingToggle) rankingToggle.checked = scoringEnabled;
  if (rankingLabel) rankingLabel.textContent = "Games 1st";
}

function setScoringEnabled(enabled) {
  localStorage.setItem(SCORING_STORAGE_KEY, String(enabled));
  refreshScoringUI();
}

function refreshGameLimitUI() {
  const limit = getGameLimit();
  const label = document.getElementById("game-limit-label");
  const button = document.getElementById("game-limit-btn");
  if (label) label.textContent = limit ? `Game Limit: ${limit}` : "Game Limit: Off";
  if (button) {
    button.classList.toggle("border-amber-500/60", Boolean(limit));
    button.classList.toggle("text-amber-300", Boolean(limit));
  }
}

const style = document.createElement('style');
style.textContent = `
  .match-card.is-editing .queue-item {
    cursor: grab !important;
  }
  .match-card.is-editing .drag-handle,
  .match-card.is-editing .queue-actions {
    display: flex !important;
  }
`;
document.head.appendChild(style);

const elements = {
  addForm: document.getElementById("add-player-form"),
  nameInput: document.getElementById("player-name"),
  skillSelect: document.getElementById("player-rating"),
  locationInput: document.getElementById("player-location"),
  searchInput: document.getElementById("player-search"),
  filterSelect: document.getElementById("player-filter"),
  playersBodyBeginner: document.getElementById("players-body-beginner"),
  playersBodyIntermediate: document.getElementById("players-body-intermediate"),
  playersBodyAdvanced: document.getElementById("players-body-advanced"),
  donePlayersContainer: document.getElementById("done-players-container"),
  donePlayersBodyBeginner: document.getElementById("done-players-body-beginner"),
  donePlayersBodyIntermediate: document.getElementById("done-players-body-intermediate"),
  donePlayersBodyAdvanced: document.getElementById("done-players-body-advanced"),
  toastContainer: document.getElementById("toast-container"),
};

function initializeRatingUI() {
  const ratings = SKILLS;
  const counts = document.querySelector("#stat-queues > div");
  if (counts) {
    counts.innerHTML = ratings.map((rating) =>
      `<span class="badge badge-beginner" data-queue-count="${rating.key}">${rating.label} · ${rating.rank} 0</span>`
    ).join("");
  }

  const queues = document.getElementById("queues-container");
  if (queues) {
    queues.innerHTML = ratings.map((rating) => `
      <div class="glass-card" data-skill-card="${rating.key}">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 class="queue-title text-cyan-400">${rating.label} · ${rating.rank} Queue</h3>
            <p class="queue-meta"><span data-queue-total="${rating.key}">0 waiting</span><span class="mx-2 text-slate-500">|</span><span data-queue-wait="${rating.key}">Est wait 0 mins</span></p>
          </div>
          <span class="skill-pill skill-beginner">${rating.rank}</span>
        </div>
        <div class="queue-matches-container" data-queue="${rating.key}" id="queue-${rating.key}"></div>
      </div>`).join("");
  }

  const filter = document.getElementById("player-filter");
  if (filter) filter.innerHTML = `<option value="All">All ratings</option>${RATINGS.map((rating) => `<option value="${rating.label}">${rating.label} · ${rating.rank}</option>`).join("")}<option value="Archived">Archived Status</option>`;

  const activeExtra = [elements.playersBodyIntermediate, elements.playersBodyAdvanced];
  const doneExtra = [elements.donePlayersBodyIntermediate, elements.donePlayersBodyAdvanced];
  [...activeExtra, ...doneExtra].forEach((body) => body?.closest(".mb-6")?.remove());
  const activeBlock = elements.playersBodyBeginner?.closest(".mb-6");
  const doneBlock = elements.donePlayersBodyBeginner?.closest(".mb-6");
  if (activeBlock) activeBlock.querySelector("h3").textContent = "Players";
  if (doneBlock) doneBlock.querySelector("h3").textContent = "Done Playing";
  document.querySelectorAll("th").forEach((header) => {
    if (header.textContent.trim() === "Skill") header.textContent = "Rating";
  });

  const compactList = document.createElement("div");
  compactList.id = "compact-player-list";
  compactList.className = "waiting-player-card mt-5 border border-slate-700/50 rounded-xl overflow-hidden max-h-[620px]";
  compactList.innerHTML = `
    <div class="waiting-player-card__header">
      <div>
        <h3 class="waiting-player-card__title">Waiting to Play <span id="compact-player-count">(0)</span></h3>
        <p class="waiting-player-card__meta" id="compact-player-summary">Loading queue...</p>
      </div>
      <button type="button" class="waiting-player-card__add" id="compact-add-player" title="Add player">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>
        <span>Add player</span>
      </button>
    </div>
    <div class="waiting-player-card__list"><p class="p-4 text-sm text-slate-500">Loading players...</p></div>`;
  compactList.addEventListener("click", handlePlayerActionClick);
  compactList.addEventListener("change", async (event) => {
    const playerId = event.target.dataset.playerRating;
    if (!playerId) return;
    try {
      await updatePlayerSkill(playerId, event.target.value);
      showToast("Player rating updated");
    } catch (error) {
      showToast(error.message || "Unable to update rating", "error");
    }
  });
  document.getElementById("custom-match-panel")?.after(compactList);
  compactList.closest(".glass-subcard")?.classList.add("player-controls-workspace");
  document.getElementById("compact-add-player")?.addEventListener("click", () => {
    openNewPlayerModal();
  });

  const queueContainer = document.getElementById("queues-container");
  const queueSection = queueContainer?.closest("section");
  const queueDestination = document.querySelector("#players-body-beginner")?.closest(".glass-subcard");
  if (queueContainer && queueDestination) {
    const queueWorkspace = document.createElement("div");
    queueWorkspace.className = "queue-workspace mb-6";
    queueWorkspace.innerHTML = `
      <div class="flex items-center justify-between gap-3 mb-4">
        <div><h3 class="text-lg font-display font-semibold">Next Matches</h3><p class="text-xs text-slate-400">All generated matches in one queue</p></div>
        <span class="text-xs text-emerald-400">Up next</span>
      </div>`;
    queueWorkspace.appendChild(queueContainer);
    // The former player tables are superseded by the compact Waiting to Play
    // panel. Keep this column dedicated to upcoming match cards.
    queueDestination.replaceChildren(queueWorkspace);
    if (queueSection) queueSection.style.display = "none";
  }

  const workspaceStyle = document.createElement("style");
  workspaceStyle.textContent = `
    .queue-workspace #queues-container { display:block; }
    .queue-workspace { min-width:0; }
    .queue-workspace #global-match-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.8rem; }
    .queue-workspace .match-card { min-width:0; height:100%; padding:.8rem !important; border-radius:.9rem; }
    .queue-workspace .match-card > div:first-child { min-height:1.9rem; margin-bottom:.6rem; padding-bottom:.5rem; }
    .queue-workspace .match-card > div:first-child > div:last-child { flex-wrap:wrap; justify-content:flex-end; }
    .queue-workspace .match-card .match-card-drag-handle h4 { font-size:.72rem; }
    .queue-workspace .match-card .match-teams { grid-template-columns:1fr; gap:.5rem; }
    .queue-workspace .match-card .match-teams > div { padding:.55rem; border-radius:.65rem; min-width:0; }
    .queue-workspace .match-card .match-teams > div:nth-child(2) { min-height:1rem; padding:0; }
    .queue-workspace .match-card .team-list { min-height:0; }
    .queue-workspace .match-card .team-list > * + * { margin-top:.3rem; }
    .queue-workspace .match-card .queue-item {
      min-height:2.4rem;
      padding:.4rem .45rem;
      border-radius:.55rem;
      gap:.35rem;
    }
    .queue-workspace .match-card .queue-item .font-semibold { font-size:.76rem; line-height:1.15; }
    .queue-workspace .match-card .queue-item .drag-handle { font-size:.75rem; }
    .queue-workspace .match-card .queue-item .rating-badge { font-size:.6rem; padding:.1rem .25rem; white-space:nowrap; }
    .queue-workspace .match-card .queue-actions button { padding:.22rem; }
    .queue-workspace .queue-item[data-player-id],
    .queue-workspace .queue-item[data-player-id] .drag-handle { touch-action:none; -webkit-user-select:none; user-select:none; }
    .queue-workspace .queue-item[data-player-id] .drag-handle { display:inline-flex; align-items:center; min-width:1.4rem; min-height:1.8rem; margin:-.3rem 0; }
    @media (max-width: 1150px) {
      .queue-workspace #global-match-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
    }
    @media (max-width: 700px) {
      .queue-workspace #global-match-grid { grid-template-columns:1fr; }
    }
    @media (max-width: 520px) {
      .queue-workspace .match-card { padding:.75rem !important; }
      .queue-workspace .match-card > div:first-child { gap:.45rem; }
      .queue-workspace .match-card > div:first-child > div:last-child { width:100%; justify-content:space-between; }
      .queue-workspace .match-card .match-card-drag-handle h4 { font-size:.66rem; }
      .queue-workspace .match-card .match-teams { grid-template-columns:1fr !important; gap:.5rem; }
      .queue-workspace .match-card .match-teams > div:nth-child(2) { min-height:1.25rem; padding:0; }
      .queue-workspace .match-card .team-list { min-height:0; }
      .queue-workspace .match-card .queue-item .font-semibold { font-size:.88rem; }
      .queue-workspace .match-card .queue-item .rating-rank { display:none; }
    }
    .queue-workspace #queues-container > .glass-card,
    .queue-workspace #queues-container .queue-matches-container { display:contents; }
    .queue-workspace #queues-container .queue-matches-container > .queue-matches-grid { display:none; }
    .queue-workspace #queues-container > .glass-card > .flex { display:none; }
    .queue-workspace #queues-container .queue-empty { display:none; }
    #compact-player-list { max-height:480px; scrollbar-gutter:stable; background:rgba(5, 29, 34, .58); container-type:inline-size; }
    #compact-player-list .waiting-player-card__header { min-height:64px; display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.75rem .9rem; border-bottom:1px solid rgba(51,65,85,.7); background:linear-gradient(135deg, rgba(15,38,53,.96), rgba(8,28,39,.92)); }
    #compact-player-list .waiting-player-card__title { margin:0; color:#f1f5f9; font-size:.76rem; font-weight:800; line-height:1.15; letter-spacing:.035em; text-transform:uppercase; }
    #compact-player-list .waiting-player-card__title span { color:#94a3b8; font-weight:600; }
    #compact-player-list .waiting-player-card__meta { margin:.28rem 0 0; color:#64748b; font-size:.64rem; }
    #compact-player-list .waiting-player-card__add { display:inline-flex; align-items:center; gap:.38rem; flex:none; padding:.42rem .6rem; border:1px solid rgba(71,85,105,.72); border-radius:.42rem; background:rgba(15,23,42,.5); color:#e2e8f0; font-size:.65rem; font-weight:700; transition:border-color .18s ease, background .18s ease, color .18s ease; }
    #compact-player-list .waiting-player-card__add:hover { border-color:rgba(52,211,153,.7); background:rgba(16,185,129,.12); color:#a7f3d0; }
    #compact-player-list .waiting-player-card__add svg { width:.82rem; height:.82rem; }
    #compact-player-list .waiting-player-card__list { max-height:416px; overflow-y:auto; }
    #compact-player-list .compact-player { display:grid; grid-template-columns:1.5rem minmax(0,1fr) auto auto auto; gap:.65rem; align-items:center; min-height:58px; padding:.62rem .8rem; border-bottom:1px solid rgba(51,65,85,.55); transition:background .18s ease; }
    #compact-player-list .compact-player:hover { background:rgba(30,41,59,.28); }
    #compact-player-list .compact-player__rank { align-self:start; padding-top:.12rem; color:#34d399; font-size:.86rem; line-height:1; }
    #compact-player-list .compact-player__name { margin:0; color:#f8fafc; font-size:.76rem; font-weight:750; line-height:1.2; }
    #compact-player-list .compact-player__stats { margin:.24rem 0 0; color:#94a3b8; font-size:.62rem; line-height:1.1; }
    #compact-player-list .compact-player__rating { min-width:4.65rem; border-color:rgba(71,85,105,.8); background:rgba(15,23,42,.68); color:#e2e8f0; }
    #compact-player-list .compact-player__status { border-color:rgba(71,85,105,.8); background:rgba(30,41,59,.75); color:#e2e8f0; font-size:.62rem; font-weight:650; }
    #compact-player-list .compact-player__actions { display:flex; align-items:center; gap:.5rem; white-space:nowrap; }
    #compact-player-list .compact-player__action { padding:0; border:0; background:transparent; font-size:.64rem; font-weight:650; transition:color .18s ease; }
    #compact-player-list .compact-player__action--out { color:#cbd5e1; }
    #compact-player-list .compact-player__action--out:hover { color:#fda4af; }
    #compact-player-list .compact-player__action--done { color:#fcd34d; }
    #compact-player-list .compact-player__action--done:hover { color:#fde68a; }
    #compact-player-list .compact-player__action:disabled { cursor:not-allowed; color:#475569; }
    #compact-player-list .compact-player:last-child { border-bottom:0; }
    @media (min-width:768px) {
      .player-controls-workspace { display:flex; flex-direction:column; min-height:0; }
      .player-controls-workspace #compact-player-list { display:flex; flex:1 1 auto; flex-direction:column; min-height:0; max-height:none; }
      .player-controls-workspace #compact-player-list .waiting-player-card__list { flex:1 1 auto; min-height:0; max-height:none; }
    }
    /* The list lives in a narrow tablet column as well as on phones, so use
       its actual container width instead of the viewport width. */
    @container (max-width: 480px) {
      #compact-player-list .waiting-player-card__add span { display:none; }
      #compact-player-list .waiting-player-card__add { padding:.48rem; }
      #compact-player-list .waiting-player-card__header { gap:.5rem; padding:.65rem .7rem; }
      #compact-player-list .waiting-player-card__header > div { min-width:0; }
      #compact-player-list .waiting-player-card__meta { line-height:1.25; }
      #compact-player-list .compact-player { grid-template-columns:1.1rem minmax(0,1fr) auto; grid-template-rows:auto auto; gap:.35rem .4rem; padding:.65rem .7rem; }
      #compact-player-list .compact-player > :nth-child(1) { grid-row:1 / span 2; }
      #compact-player-list .compact-player > :nth-child(2) { grid-column:2; grid-row:1; }
      #compact-player-list .compact-player > :nth-child(3) { grid-column:2; grid-row:2; width:4.15rem; min-width:0; }
      #compact-player-list .compact-player > :nth-child(4) { grid-column:3; grid-row:1; }
      #compact-player-list .compact-player > :nth-child(5) { grid-column:3; grid-row:2; justify-self:end; gap:.3rem; }
      #compact-player-list .compact-player__status { padding:.25rem .4rem; font-size:.56rem; }
      #compact-player-list .compact-player__actions { gap:.3rem; }
      #compact-player-list .compact-player__action { font-size:.58rem; }
    }
  `;
  document.head.appendChild(workspaceStyle);
}

initializeRatingUI();

function shuffleArray(input) {
  const arr = input.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function ratingForPlayer(player) {
  return player ? playerRatingLabel(player) : "—";
}

function rankForPlayer(player) {
  return player ? ratingRankLabel(player) : "Unrated";
}

function rotationInsight(teamA, teamB) {
  const players = [...teamA, ...teamB].filter(Boolean);
  if (players.length !== 4) return { label: "Waiting for players", tone: "text-slate-500" };

  const lineupKey = [...players].sort().join("__");
  const pairKey = (team) => [...team].sort().join("__");
  const isRepeatLineup = state.matchLog.some((match) =>
    match.players?.length === 4 && [...match.players].sort().join("__") === lineupKey
  );
  const repeatPartners = state.matchLog.some((match) =>
    [match.teamA, match.teamB].some((team) =>
      team?.length === 2 && (pairKey(team) === pairKey(teamA) || pairKey(team) === pairKey(teamB))
    )
  );
  if (isRepeatLineup) return { label: "Repeat lineup", tone: "text-rose-400" };
  if (repeatPartners) return { label: "Repeat partner", tone: "text-amber-400" };
  return { label: "Fresh rotation", tone: "text-emerald-400" };
}

function showToast(message, tone = "info") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  if (tone === "error") {
    toast.style.borderColor = "rgba(248, 113, 113, 0.6)";
  } else if (tone === "warning") {
    toast.style.borderColor = "rgba(251, 191, 36, 0.7)";
    toast.style.background = "rgba(120, 83, 9, 0.92)";
  }
  elements.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function showConfirmModal(message, title = "Please Confirm") {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const titleEl = document.getElementById("confirm-modal-title");
    const msgEl = document.getElementById("confirm-modal-message");
    const btnOk = document.getElementById("confirm-modal-ok");
    const btnCancel = document.getElementById("confirm-modal-cancel");

    titleEl.textContent = title;
    msgEl.textContent = message;
    modal.classList.remove("hidden");

    const cleanup = () => {
      modal.classList.add("hidden");
      btnOk.removeEventListener("click", onOk);
      btnCancel.removeEventListener("click", onCancel);
    };

    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };

    btnOk.addEventListener("click", onOk);
    btnCancel.addEventListener("click", onCancel);
  });
}

function formatFirebaseError(error) {
  if (!error) return "Unexpected error";
  const code = error.code || "";
  if (code === "permission-denied") {
    return "Firestore rules blocked the write. Deploy rules to allow access.";
  }
  if (code === "unavailable") {
    return "Firestore is unavailable. Check your network connection.";
  }
  if (code === "failed-precondition") {
    return "Firestore needs a missing index or persistence failed.";
  }
  return error.message || "Unexpected error";
}

function cacheState() {
  localStorage.setItem("pbs-queues", JSON.stringify(state.queues));
  localStorage.setItem("pbs-courts", JSON.stringify(state.courts));
  localStorage.setItem("pbs-players", JSON.stringify(Array.from(state.players.values())));
}

function loadCachedState() {
  try {
    const queues = JSON.parse(localStorage.getItem("pbs-queues") || "{}");
    const courts = JSON.parse(localStorage.getItem("pbs-courts") || "[]");
    const players = JSON.parse(localStorage.getItem("pbs-players") || "[]");
    if (Object.keys(queues).length) state.queues = queues;
    if (courts.length) state.courts = courts;
    if (players.length) {
      state.players = new Map(players.map((player) => [player.id, player]));
    }
  } catch (error) {
    console.warn("Cache load failed", error);
  }
}

function renderStats() {
  const waiting = Array.from(state.players.values()).filter(
    (player) => player.status === "Waiting"
  ).length;
  const activeMatches = state.courts.filter((court) => court.status === "Active").length;
  const availableCourts = state.courts.filter(
    (court) => court.status === "Available"
  ).length;

  document.querySelector('[data-stat="waiting"]').textContent = waiting;
  document.querySelector('[data-stat="matches"]').textContent = activeMatches;
  document.querySelector('[data-stat="courts"]').textContent = availableCourts;

  SKILLS.forEach((skill) => {
    const count = (state.queues[skill.key] || []).filter(id => id !== "EMPTY").length;
    const pill = document.querySelector(`[data-queue-count="${skill.key}"]`);
    if (pill) pill.textContent = `${skill.label} ${count}`;
  });
}

function renderQueues() {
  SKILLS.forEach((skill) => {
    const container = document.querySelector(`[data-queue="${skill.key}"]`);
    if (!container) return;

    const order = state.queues[skill.key] || [];
    // Queue cards share one visual order, even though their players remain in
    // separate rating queues for matching and drag-and-drop.
    const matchesBefore = SKILLS
      .slice(0, SKILLS.findIndex((item) => item.key === skill.key))
      .reduce((total, previousSkill) => total + Math.ceil((state.queues[previousSkill.key] || []).length / 4), 0);

    if (!order.length) {
      window.smoothUpdateHTML(container, `<p class="queue-empty text-slate-500 py-4 text-center text-sm border border-dashed border-slate-700/50 rounded-xl mt-4">No players waiting.</p>`);
    } else {
      const wrapper = document.createElement("div");
      wrapper.className = "queue-matches-grid grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 items-start";
      
      const chunks = [];
      for (let i = 0; i < order.length; i += 4) {
        chunks.push(order.slice(i, i + 4));
      }

      chunks.forEach((chunk, index) => {
        const matchCard = document.createElement("div");
        const matchId = `${skill.key}-${index}`;
        const isEditing = state.editingMatches && state.editingMatches.has(matchId);
        
        const matchNumber = matchesBefore + index + 1;
        const isUpNext = matchNumber === 1;
        const isComplete = chunk.length === 4 && chunk.every(id => id && id !== "EMPTY");
        const rotation = isComplete
          ? rotationInsight(chunk.slice(0, 2), chunk.slice(2, 4))
          : { label: "Waiting for players", tone: "text-slate-500" };
        const titleText = isUpNext ? "Up Next · Match 1" : `Match ${matchNumber}`;
        const headerColor = isUpNext ? "text-emerald-400" : "text-slate-400";
        const bgStyles = isUpNext 
            ? "border border-emerald-500/30 bg-emerald-500/5 shadow-lg shadow-emerald-500/5" 
            : "border border-slate-700/60 bg-slate-800/20";
        
        matchCard.className = `match-card rounded-xl p-2 sm:p-3 ${bgStyles} ${isEditing ? "is-editing" : ""}`;
        matchCard.dataset.matchId = matchId;
        matchCard.dataset.skillKey = skill.key;
        matchCard.innerHTML = `
          <div class="flex items-center justify-between mb-2 border-b border-slate-700/50 pb-1.5 rounded transition-colors">
            <div class="flex items-center gap-1.5 cursor-grab match-card-drag-handle hover:bg-slate-700/30 px-1 -ml-1 rounded">
              <svg class="${headerColor}" opacity="0.7" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5v14"/><path d="M15 5v14"/></svg>
              <h4 class="text-[10px] uppercase tracking-wider font-bold ${headerColor}">${titleText}</h4>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-semibold ${isComplete ? "text-green-400" : "text-amber-400"}">${chunk.length}/4</span>
              <span class="text-[9px] font-semibold ${rotation.tone}">${rotation.label}</span>
              <button class="text-slate-400 hover:text-white px-1 edit-match-btn transition-colors" title="Edit Match">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
              </button>
            </div>
          </div>
          
          <div class="match-teams grid grid-cols-[1fr_auto_1fr] gap-2 items-stretch">
            <div class="bg-slate-900/60 rounded-lg border border-slate-700/50 p-1.5">
               <div class="text-[9px] text-slate-500 font-bold uppercase mb-1 text-center">Team A</div>
               <ul class="team-list space-y-1 min-h-[32px]" data-queue="${skill.key}"></ul>
            </div>
            
            <div class="flex items-center justify-center px-1">
              <span class="text-[9px] font-bold text-slate-500 bg-slate-800/80 px-1.5 py-0.5 rounded">VS</span>
            </div>
            
            <div class="bg-slate-900/60 rounded-lg border border-slate-700/50 p-1.5">
               <div class="text-[9px] text-slate-500 font-bold uppercase mb-1 text-center">Team B</div>
               <ul class="team-list space-y-1 min-h-[32px]" data-queue="${skill.key}"></ul>
            </div>
          </div>
        `;

        const teamAList = matchCard.querySelectorAll("ul")[0];
        const teamBList = matchCard.querySelectorAll("ul")[1];

        for (let i = 0; i < 4; i++) {
          const playerId = chunk[i];
          const item = document.createElement("li");

          if (playerId && playerId !== "EMPTY") {
            const player = state.players.get(playerId);
            item.className = "queue-item bg-slate-800 hover:bg-slate-700 transition-colors border border-slate-600/50 p-1 rounded flex items-center justify-between min-h-[28px] cursor-grab";
            item.dataset.playerId = playerId;

            const lastResult = player?.lastResult;
            const resultBadge = lastResult === "Win"
              ? `<span class="text-[9px] font-bold text-green-400 bg-green-400/10 px-1 rounded">W</span>`
              : lastResult === "Loss"
              ? `<span class="text-[9px] font-bold text-red-400 bg-red-400/10 px-1 rounded">L</span>`
              : "";

            item.innerHTML = `
              <div class="flex items-center gap-1 overflow-hidden min-w-0">
                <span class="drag-handle text-slate-400 cursor-grab hover:text-white px-0.5 text-xs shrink-0">⋮⋮</span>
                <span class="font-semibold text-[11px] truncate flex-1 cursor-grab" title="${player ? player.name : "Unknown"}">${player ? player.name : "Unknown"}</span>
                <span class="rating-badge text-[10px] font-bold text-cyan-300 bg-cyan-400/10 border border-cyan-400/20 px-1.5 py-0.5 rounded shrink-0" title="${ratingForPlayer(player)} · ${rankForPlayer(player)}">${ratingForPlayer(player)}</span>
                ${resultBadge}
              </div>
              <div class="queue-actions hidden items-center gap-0.5 shrink-0">
                <button class="text-slate-300 hover:text-white p-0.5" data-action="skip" title="Skip to bottom">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
                </button>
                <button class="text-slate-300 hover:text-red-400 p-0.5" data-action="absent" title="Remove">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                </button>
              </div>
            `;
          } else {
            item.className = "queue-item add-player-btn bg-slate-800/40 hover:bg-slate-700/60 transition-colors border border-dashed border-slate-600/50 p-1 rounded flex items-center justify-center cursor-pointer min-h-[28px]";
            item.dataset.action = "open-add-player-modal";
            item.dataset.queueKey = skill.key;
            item.dataset.matchId = matchId;
            item.dataset.slotIndex = i;
            item.innerHTML = `
              <span class="text-[10px] text-slate-400 font-semibold uppercase tracking-wider flex items-center gap-1 pointer-events-none">
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
                Add
              </span>
            `;
            if (!isEditing) {
              item.style.display = "none";
            }
          }
          
          if (i < 2) {
            teamAList.appendChild(item);
          } else {
            teamBList.appendChild(item);
          }
        }

        wrapper.appendChild(matchCard);
      });
      window.smoothUpdateNode(container, wrapper);
    }

    const count = order.filter(id => id !== "EMPTY").length;
    const wait = Math.max(0, Math.ceil(count / 4) * AVG_MATCH_MINUTES);
    const countEl = document.querySelector(`[data-queue-total="${skill.key}"]`);
    const waitEl = document.querySelector(`[data-queue-wait="${skill.key}"]`);
    if (countEl) countEl.textContent = `${count} waiting`;
    if (waitEl) waitEl.textContent = `Est wait ${wait} mins`;
  });
  
  renderQueueWorkspaceCards();

  // Re-attach sortable after re-render
  setupSortable();
}

function renderQueueWorkspaceCards() {
  const queuesContainer = document.getElementById("queues-container");
  if (!queuesContainer?.closest(".queue-workspace")) return;

  let globalGrid = document.getElementById("global-match-grid");
  if (!globalGrid) {
    globalGrid = document.createElement("div");
    globalGrid.id = "global-match-grid";
    globalGrid.className = "queue-matches-grid";
    queuesContainer.appendChild(globalGrid);
  }

  const cards = Array.from(queuesContainer.querySelectorAll(
    ".queue-matches-container .match-card"
  ));
  
  try {
    const savedOrder = JSON.parse(localStorage.getItem("globalMatchOrder") || "[]");
    if (savedOrder.length > 0) {
      cards.sort((a, b) => {
        const idxA = savedOrder.indexOf(a.dataset.matchId);
        const idxB = savedOrder.indexOf(b.dataset.matchId);
        if (idxA === -1 && idxB === -1) return 0;
        if (idxA === -1) return 1;
        if (idxB === -1) return -1;
        return idxA - idxB;
      });
    }
  } catch(e) {}
  
  // Re-number titles based on global order
  cards.forEach((card, index) => {
    const isUpNext = index === 0;
    const titleText = isUpNext ? "Up Next · Match 1" : `Match ${index + 1}`;
    const headerColor = isUpNext ? "text-emerald-400" : "text-slate-400";
    
    const h4 = card.querySelector(".match-card-drag-handle h4");
    if (h4) {
      h4.textContent = titleText.toUpperCase();
      h4.className = `text-[10px] uppercase tracking-wider font-bold ${headerColor}`;
    }
    
    const svg = card.querySelector(".match-card-drag-handle svg");
    if (svg) svg.setAttribute("class", headerColor);
    
    card.classList.remove("border-slate-700/60", "bg-slate-800/20", "border-emerald-500/30", "bg-emerald-500/5", "shadow-lg", "shadow-emerald-500/5");
    if (isUpNext) {
      card.classList.add("border-emerald-500/30", "bg-emerald-500/5", "shadow-lg", "shadow-emerald-500/5");
    } else {
      card.classList.add("border-slate-700/60", "bg-slate-800/20");
    }
  });

  globalGrid.replaceChildren(...cards);
}


function renderCourts() {
  const container = document.getElementById("courts-container");
  if (!container) return;

  // Compute total queued players and best next skill
  const activeTally = {};
  state.courts.forEach(c => {
    if (c.status === "Active" && c.skill) {
      activeTally[c.skill] = (activeTally[c.skill] || 0) + 1;
    }
  });

  // Best queue option (for available courts with queue)
  const hasPending = state.pendingMatches.length > 0;
  const queueOptions = SKILLS.map(skill => ({
    key: skill.key,
    label: skill.label,
    count: (state.queues[skill.key] || []).filter(id => id !== "EMPTY").length,
  })).filter(q => q.count >= 4);
  queueOptions.sort((a, b) => {
    const aA = activeTally[a.label] || 0, bA = activeTally[b.label] || 0;
    if (aA !== bA) return aA - bA;
    return b.count - a.count;
  });

  let bestQueue = hasPending ? { key: "custom", label: "Custom", count: state.pendingMatches.length * 4 } : null;
  if (!bestQueue) {
    const globalGrid = document.getElementById("global-match-grid");
    if (globalGrid && globalGrid.children.length > 0) {
      const firstCard = globalGrid.children[0];
      const skillKey = firstCard.dataset.skillKey;
      const count = (state.queues[skillKey] || []).filter(id => id !== "EMPTY").length;
      if (count >= 4) {
        bestQueue = { key: skillKey, label: SKILLS.find(s => s.key === skillKey)?.label || "Unknown", count };
      }
    }
    if (!bestQueue) {
      bestQueue = queueOptions[0] || null;
    }
  }
  const totalQueued = SKILLS.reduce((s, sk) => s + (state.queues[sk.key] || []).filter(id => id !== "EMPTY").length, 0);

  const nameFor = id => (id && state.players.get(id)?.name) || "--";

  const courts = [...state.courts].sort((a, b) =>
    (a.name || a.id).localeCompare(b.name || b.id, undefined, { numeric: true })
  );

  window.smoothUpdateHTML(container, courts.map(court => {
    const courtInfo = {
      id: court.id,
      name: court.name || court.id.replace(/^court-/, "Court "),
    };

    const cid = court.id;
    const isBuiltInCourt = ["court-1", "court-2", "court-3"].includes(cid);
    const removeCourtButton = isBuiltInCourt
      ? ""
      : `<button class="text-rose-500/50 hover:text-rose-400 transition-colors p-1 flex items-center justify-center" data-remove-court="${cid}" title="Remove Court">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>
         </button>`;

    if (court.status === "Active") {
      const players = court.players || [];
      const teamAIds = players.slice(0, 2);
      const teamBIds = players.slice(2, 4);
      const rotation = rotationInsight(teamAIds, teamBIds);
      return `
        <div class="glass-card court-card" data-court-id="${cid}" style="border-color:rgba(56,189,248,0.25);">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 flex-wrap">
              <h3 class="court-title">${courtInfo.name}</h3>
              <span class="court-status active">● LIVE</span>
              <span class="text-[9px] font-semibold ${rotation.tone}">${rotation.label}</span>
            </div>
            <span class="court-timer font-mono text-xl font-bold text-cyan-300" data-court-timer="${cid}">00:00</span>
          </div>
          <div class="team-grid mt-2">
            <div class="team-card" style="border-color:rgba(56,189,248,0.3);background:rgba(56,189,248,0.07);">
              <p class="team-label text-cyan-400">Team A</p>
              <p class="team-player mt-2 flex justify-between items-center group"><span>${nameFor(teamAIds[0])}</span><span class="text-[9px] text-cyan-300">${ratingForPlayer(state.players.get(teamAIds[0]))}</span><button class="text-slate-400 hover:text-white transition-colors opacity-0 group-hover:opacity-100" data-replace-active="${cid}" data-slot="0" title="Change Player"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg></button></p>
              <p class="team-player flex justify-between items-center group"><span>${nameFor(teamAIds[1])}</span><span class="text-[9px] text-cyan-300">${ratingForPlayer(state.players.get(teamAIds[1]))}</span><button class="text-slate-400 hover:text-white transition-colors opacity-0 group-hover:opacity-100" data-replace-active="${cid}" data-slot="1" title="Change Player"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg></button></p>
            </div>
            <div class="team-card" style="border-color:rgba(251,113,133,0.3);background:rgba(251,113,133,0.07);">
              <p class="team-label text-rose-400">Team B</p>
              <p class="team-player mt-2 flex justify-between items-center group"><span>${nameFor(teamBIds[0])}</span><span class="text-[9px] text-cyan-300">${ratingForPlayer(state.players.get(teamBIds[0]))}</span><button class="text-slate-400 hover:text-white transition-colors opacity-0 group-hover:opacity-100" data-replace-active="${cid}" data-slot="2" title="Change Player"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg></button></p>
              <p class="team-player flex justify-between items-center group"><span>${nameFor(teamBIds[1])}</span><span class="text-[9px] text-cyan-300">${ratingForPlayer(state.players.get(teamBIds[1]))}</span><button class="text-slate-400 hover:text-white transition-colors opacity-0 group-hover:opacity-100" data-replace-active="${cid}" data-slot="3" title="Change Player"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg></button></p>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2 mt-1">
            <button class="btn-primary" style="background:linear-gradient(135deg,rgba(56,189,248,0.9),rgba(14,165,233,0.9));"
              data-finish-court="${cid}" data-winner="teamA">Team A Wins 🏆</button>
            <button class="btn-primary" style="background:linear-gradient(135deg,rgba(251,113,133,0.9),rgba(244,63,94,0.9));"
              data-finish-court="${cid}" data-winner="teamB">Team B Wins 🏆</button>
          </div>
          <button class="btn-secondary w-full text-xs text-slate-500 mt-1" data-finish-court="${cid}" data-winner="">No Winner / End Match</button>
        </div>`;
    }

    if (court.status === "Available") {
      const courtAllowedSkill = court.allowedSkill !== undefined ? court.allowedSkill : null;
      const courtQueuedTotal = (courtAllowedSkill === null || courtAllowedSkill === "any")
        ? totalQueued
        : (state.queues[courtAllowedSkill] || []).filter(id => id !== "EMPTY").length;

      const hasValidMatch = (courtAllowedSkill === null || courtAllowedSkill === "any" ? state.pendingMatches.length > 0 : false) || courtQueuedTotal >= 4;

      const skillDropdown = `
        <select class="input-field text-xs py-1 px-2 h-auto mt-1 w-36 bg-slate-800 border-slate-700" data-court-skill-select="${cid}">
          <option value="any" ${courtAllowedSkill === null || courtAllowedSkill === "any" ? "selected" : ""}>Any Rating</option>
          ${SKILLS.map((rating) => `<option value="${rating.key}" ${courtAllowedSkill === rating.key ? "selected" : ""}>${rating.label} Only</option>`).join("")}
        </select>
      `;

      if (hasValidMatch) {
        return `
          <div class="glass-card court-card" data-court-id="${cid}">
            <div class="flex items-start justify-between">
              <div>
                <h3 class="court-title">${courtInfo.name}</h3>
                ${skillDropdown}
              </div>
              <div class="flex items-center gap-1">
                ${removeCourtButton}
                <button class="text-slate-400 hover:text-white text-lg leading-none px-1" data-toggle-court="${cid}" title="Mark Inactive">×</button>
              </div>
            </div>
            <button class="btn-primary w-full py-3 text-sm mt-4 shadow-lg shadow-emerald-500/20" data-start-court="${cid}" style="background:linear-gradient(135deg,rgba(16,185,129,0.9),rgba(5,150,105,0.9));border-color:rgba(16,185,129,0.4)">
              ▶ Start Next Match
            </button>
          </div>`;
      } else {
        // No eligible queue — waiting for players
        const queued = Math.min(courtQueuedTotal, 3);
        const pct = Math.round((queued / 4) * 100);
        return `
          <div class="glass-card court-card" data-court-id="${cid}" style="border-style:dashed;border-color:rgba(148,163,184,0.2);">
            <div class="flex items-start justify-between">
              <div>
                <h3 class="court-title text-slate-400">${courtInfo.name}</h3>
                ${skillDropdown}
              </div>
              <div class="flex items-center gap-1">
                ${removeCourtButton}
                <button class="text-slate-500 hover:text-white text-lg leading-none px-1" data-toggle-court="${cid}" title="Mark Inactive">×</button>
              </div>
            </div>
            <div class="flex flex-col items-center justify-center py-6 gap-3 text-center">
              <p class="text-slate-400 text-sm">Waiting for players...</p>
              <p class="text-slate-500 text-xs">(${courtQueuedTotal}/4 in queue)</p>
              <div class="w-full bg-slate-800 rounded-full h-1.5">
                <div class="bg-cyan-500/50 h-1.5 rounded-full transition-all" style="width:${pct}%"></div>
              </div>
            </div>
          </div>`;
      }
    }

    // Inactive
    return `
      <div class="glass-card court-card" data-court-id="${cid}" style="opacity:0.5;">
        <div class="flex items-center justify-between">
          <h3 class="court-title text-slate-500">${courtInfo.name}</h3>
          <div class="flex items-center gap-1">
            ${removeCourtButton}
            <span class="text-xs text-slate-600 uppercase tracking-widest ml-1">Inactive</span>
          </div>
        </div>
        <button class="btn-secondary w-full mt-2" data-toggle-court="${cid}">Mark Available</button>
      </div>`;
  }).join(""));;
}


function renderPlayers() {
  const allActive = Array.from(state.players.values()).filter(p => p.status !== "Archived" && p.status !== "Roster");
  const court1 = state.courts.find((c) => c.id === "court-1");
  const court2 = state.courts.find((c) => c.id === "court-2");
  const court3 = state.courts.find((c) => c.id === "court-3");
  const court1ActivePlayers = new Set(court1?.players || []);
  const court1LastPlayers = new Set(court1?.lastMatchPlayers || []);
  const court2ActivePlayers = new Set(court2?.players || []);
  const court2LastPlayers = new Set(court2?.lastMatchPlayers || []);
  const court3ActivePlayers = new Set(court3?.players || []);
  const court3LastPlayers = new Set(court3?.lastMatchPlayers || []);

  const filteredRows = Array.from(state.players.values())
    .filter((player) => {
      if (state.filter.startsWith("Archived")) {
        if (player.status !== "Archived") return false;
        if (state.filter !== "Archived") {
          const targetDate = state.filter.split("Archived:")[1];
          // Use dedicated archivedDate field first; fallback to updatedAt parsing
          const pDate = player.archivedDate || (() => {
            if (!player.updatedAt) return "";
            let d;
            if (typeof player.updatedAt.toDate === 'function') d = player.updatedAt.toDate();
            else if (player.updatedAt.seconds) d = new Date(player.updatedAt.seconds * 1000);
            else d = new Date(player.updatedAt);
            return !isNaN(d.getTime()) ? d.toLocaleDateString() : "";
          })();
          if (pDate !== targetDate) return false;
        }
        return player.name.toLowerCase().includes(state.search.toLowerCase());
      }
      if (player.status === "Archived") return false;
      if (player.status === "Roster") return false;
      const matchFilter = state.filter === "All" || player.rating === state.filter;
      const matchSearch = player.name.toLowerCase().includes(state.search.toLowerCase());
      return matchFilter && matchSearch;
    })
    .sort((a, b) => {
      const statusOrder = { Playing: 0, Stacked: 1, Waiting: 2, Standby: 3, Absent: 4 };
      return (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5);
    });

  const doneRows = state.filter.startsWith("Archived")
    ? []
    : filteredRows.filter((player) => player.status === "Standby" || player.status === "Absent");
  const activeRows = state.filter.startsWith("Archived")
    ? filteredRows
    : filteredRows.filter((player) => player.status !== "Standby" && player.status !== "Absent" && player.status !== "Roster");

  // Update total players count badge
  const countEl = document.getElementById("total-players-count");
  if (countEl) {
    const archivedCount = Array.from(state.players.values()).filter(p => p.status === "Archived").length;
    const rosterCount = Array.from(state.players.values()).filter(p => p.status === "Roster").length;
    const parts = [];
    if (allActive.length > 0) parts.push(`${allActive.length} active`);
    if (archivedCount > 0) parts.push(`${archivedCount} archived`);
    if (rosterCount > 0) parts.push(`${rosterCount} saved`);
    countEl.textContent = parts.length ? `(${parts.join(", ")})` : "";
  }

  const getWaitTime = (player) => {
    if (player.status !== "Standby" && player.status !== "Waiting" && player.status !== "Absent") return "";
    let d;
    if (player.updatedAt) {
      if (typeof player.updatedAt.toDate === 'function') d = player.updatedAt.toDate();
      else if (player.updatedAt.seconds) d = new Date(player.updatedAt.seconds * 1000);
      else d = new Date(player.updatedAt);
    }
    if (d && !isNaN(d.getTime())) {
      const diffMins = Math.floor((Date.now() - d.getTime()) / 60000);
      return diffMins > 0 ? `<br><span class="text-[10px] text-slate-400">(${diffMins}m)</span>` : `<br><span class="text-[10px] text-slate-400">(just now)</span>`;
    }
    return "";
  };

  const compactList = document.getElementById("compact-player-list");
  if (compactList) {
    const compactRows = filteredRows;
    const queuedCount = compactRows.filter((player) => player.status === "Waiting" || player.status === "Stacked").length;
    const countLabel = compactList.querySelector("#compact-player-count");
    const summaryLabel = compactList.querySelector("#compact-player-summary");
    const list = compactList.querySelector(".waiting-player-card__list");
    if (countLabel) countLabel.textContent = `(${compactRows.length})`;
    if (summaryLabel) {
      summaryLabel.textContent = `${queuedCount} queued · ${Math.max(0, compactRows.length - queuedCount)} in match or unavailable`;
    }
    if (!list) return;
    list.innerHTML = compactRows.length
      ? compactRows.map((player, index) => {
          const games = (player.wins ?? 0) + (player.losses ?? 0);
          const isUnavailable = player.status === "Playing" || player.status === "Stacked";
          return `
            <div class="compact-player">
              <span class="compact-player__rank">${index + 1}</span>
              <div class="min-w-0"><button type="button" class="compact-player__name block w-full truncate text-left hover:text-cyan-300 transition-colors" data-player-details="${player.id}" title="View and edit ${player.name}">${player.name}</button>
                <p class="compact-player__stats">${games} GP · <span class="text-emerald-400">${player.wins ?? 0}W</span> <span class="text-rose-400">${player.losses ?? 0}L</span>${getWaitTime(player)}</p>
              </div>
              <select class="compact-player__rating input-field text-xs py-1 px-1.5 w-16" data-player-rating="${player.id}" aria-label="${player.name} rating">
                ${RATINGS.map((rating) => `<option value="${rating.label}" ${player.rating === rating.label ? "selected" : ""}>${rating.label}</option>`).join("")}
              </select>
              <span class="compact-player__status px-2 py-1 rounded whitespace-nowrap">${player.status}</span>
              <div class="compact-player__actions"><button class="compact-player__action compact-player__action--out" data-player-absent="${player.id}" title="Mark absent or return to queue" ${isUnavailable ? "disabled" : ""}>${isUnavailable ? "In match" : (player.status === "Absent" || player.status === "Standby" ? "Return" : "Out")}</button>
              <button class="compact-player__action compact-player__action--done" data-player-done="${player.id}" title="Mark done playing" ${isUnavailable ? "disabled" : ""}>Done</button></div>
            </div>`;
        }).join("")
      : `<p class="p-4 text-sm text-slate-500">No players match the current filter.</p>`;
  }

  const generateRowHTML = (player, idx) => `
      <tr class="border-t border-slate-800/60">
        <td class="py-3 text-center text-slate-500 text-xs font-mono">${idx + 1}</td>
        <td class="font-semibold">
          <div class="flex items-center flex-wrap gap-2">
            <button type="button" class="text-left hover:text-cyan-300 hover:underline underline-offset-4 transition-colors" data-player-details="${player.id}" title="View and edit ${player.name}">${player.name}</button>
            ${player.practicePartner && state.players.get(player.practicePartner)
              ? `<span class="text-[10px] px-1.5 py-0.5 rounded border border-purple-400/40 text-purple-300 bg-purple-500/10 align-middle" title="Fixed Partner">🔗 ${state.players.get(player.practicePartner).name}</span>`
              : ''}
          </div>
          ${court1ActivePlayers.has(player.id)
            ? '<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-cyan-400/40 text-cyan-300 bg-cyan-500/10 align-middle">C1 Now</span>'
            : court1LastPlayers.has(player.id)
            ? '<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-amber-400/40 text-amber-300 bg-amber-500/10 align-middle">C1 Last</span>'
            : ''}
          ${court2ActivePlayers.has(player.id)
            ? '<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-cyan-400/40 text-cyan-300 bg-cyan-500/10 align-middle">C2 Now</span>'
            : court2LastPlayers.has(player.id)
            ? '<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-amber-400/40 text-amber-300 bg-amber-500/10 align-middle">C2 Last</span>'
            : ''}
          ${court3ActivePlayers.has(player.id)
            ? '<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-cyan-400/40 text-cyan-300 bg-cyan-500/10 align-middle">C3 Now</span>'
            : court3LastPlayers.has(player.id)
            ? '<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-amber-400/40 text-amber-300 bg-amber-500/10 align-middle">C3 Last</span>'
            : ''}
        </td>
        <td>
          <select class="input-field max-w-[110px] text-xs py-1" data-player-gender="${player.id}">
            <option value="" ${!player.gender || (player.gender.toLowerCase() !== "male" && player.gender.toLowerCase() !== "m" && player.gender.toLowerCase() !== "female" && player.gender.toLowerCase() !== "f") ? "selected" : ""}>Unspecified</option>
            <option value="Male" ${player.gender?.toLowerCase() === "male" || player.gender?.toLowerCase() === "m" ? "selected" : ""}>Male</option>
            <option value="Female" ${player.gender?.toLowerCase() === "female" || player.gender?.toLowerCase() === "f" ? "selected" : ""}>Female</option>
          </select>
        </td>
        <td class="text-slate-300 text-sm">${player.location || "—"}</td>
        <td class="whitespace-nowrap text-center">${player.status}${getWaitTime(player)}</td>
        <td>
          ${player.lastResult === 'Win' ? '<span class="text-xs font-semibold px-2 py-1 bg-green-500/20 text-green-400 rounded-md border border-green-500/30">Won</span>' : ''}
          ${player.lastResult === 'Loss' ? '<span class="text-xs font-semibold px-2 py-1 bg-red-500/20 text-red-400 rounded-md border border-red-500/30">Lost</span>' : ''}
          ${!player.lastResult ? '<span class="text-xs text-slate-500">—</span>' : ''}
        </td>
        <td class="text-purple-400 font-semibold">${(player.wins ?? 0) + (player.losses ?? 0)}</td>
        <td class="text-green-400 font-semibold">${player.wins ?? 0}W</td>
        <td class="text-red-400 font-semibold">${player.losses ?? 0}L</td>
        <td class="text-blue-400 font-semibold">${((player.wins ?? 0) + (player.losses ?? 0)) > 0 ? Math.round(((player.wins ?? 0) / ((player.wins ?? 0) + (player.losses ?? 0))) * 100) + '%' : '—'}</td>
        <td>
          <select class="input-field" data-player-skill="${player.id}" aria-label="Rating">
            ${RATINGS.map(
              (rating) =>
                `<option value="${rating.label}" ${
                  player.rating === rating.label ? "selected" : ""
                }>${rating.label}</option>`
            ).join("")}
          </select>
        </td>
        <td class="sticky right-0 py-3 pl-4 text-right" style="background:rgba(12,50,50,0.98);">
          <div class="flex flex-nowrap justify-end gap-1">
            <button class="btn-secondary text-xs px-2 py-1 whitespace-nowrap mobile-icon-only" data-player-setup-partner="${player.id}">&#x1F517; <span>Partner</span></button>
            <button
              class="btn-secondary text-xs px-2 py-1 whitespace-nowrap mobile-icon-only ${player.status === "Playing" || player.status === "Stacked" ? "opacity-50 cursor-not-allowed" : ""}"
              data-player-absent="${player.id}"
              ${player.status === "Playing" || player.status === "Stacked" ? "disabled" : ""}
            >
              &#x21A9; <span>${player.status === "Playing" || player.status === "Stacked"
                ? "In Match"
                : player.status === "Absent" || player.status === "Standby"
                ? "Return"
                : "Absent"}</span>
            </button>
            <button class="btn-secondary text-xs px-2 py-1 whitespace-nowrap mobile-icon-only" style="border-color: rgba(251,191,36,0.4); color:#fbbf24;" data-player-done="${player.id}">&#x2714; <span>Done Playing</span></button>
            <button class="btn-secondary text-xs px-2 py-1 whitespace-nowrap mobile-icon-only" style="border-color: rgba(248,113,113,0.4); color:#fca5a5;" data-player-remove="${player.id}">&#x2715;</button>
          </div>
        </td>
      </tr>
    `;

  const renderTable = (tbodyElement, countElementId) => {
    if (!tbodyElement) return;
    
    // For archived filter we don't separate by skill if we still show the table, 
    // but the user only wanted to separate by skill.
    // If the overall filter is set to a specific skill or Archived, the activeRows is already filtered.
    const rows = activeRows;
    
    const countEl = document.getElementById(countElementId);
    if (countEl) countEl.textContent = rows.length;

    if (!rows.length) {
      window.smoothUpdateHTML(tbodyElement, `<tr><td class="py-4 text-slate-500 text-center" colspan="12">No players.</td></tr>`);
    } else {
      window.smoothUpdateHTML(tbodyElement, rows.map(generateRowHTML).join(""));
    }
  };

  renderTable(elements.playersBodyBeginner, "count-beginner");

  const renderDoneTable = (tbodyElement, countElementId) => {
    if (!tbodyElement) return;
    const rows = doneRows;
    
    const countEl = document.getElementById(countElementId);
    if (countEl) countEl.textContent = rows.length;

    if (!rows.length) {
      window.smoothUpdateHTML(tbodyElement, `<tr><td class="py-4 text-slate-500 text-center" colspan="12">No done-playing players.</td></tr>`);
    } else {
      window.smoothUpdateHTML(tbodyElement, rows.map((player, idx) => `
      <tr class="border-t border-slate-800/60">
        <td class="py-3 text-center text-slate-500 text-xs font-mono">${idx + 1}</td>
        <td class="font-semibold">
          <div class="flex items-center flex-wrap gap-2">
            <button type="button" class="text-left hover:text-cyan-300 hover:underline underline-offset-4 transition-colors" data-player-details="${player.id}" title="View and edit ${player.name}">${player.name}</button>
            ${player.practicePartner && state.players.get(player.practicePartner)
              ? `<span class="text-[10px] px-1.5 py-0.5 rounded border border-purple-400/40 text-purple-300 bg-purple-500/10 align-middle" title="Fixed Partner">&#x1F517; ${state.players.get(player.practicePartner).name}</span>`
              : ''}
          </div>
          ${court1ActivePlayers.has(player.id)
            ? '<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-cyan-400/40 text-cyan-300 bg-cyan-500/10 align-middle">C1 Now</span>'
            : court1LastPlayers.has(player.id)
            ? '<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-amber-400/40 text-amber-300 bg-amber-500/10 align-middle">C1 Last</span>'
            : ''}
          ${court2ActivePlayers.has(player.id)
            ? '<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-cyan-400/40 text-cyan-300 bg-cyan-500/10 align-middle">C2 Now</span>'
            : court2LastPlayers.has(player.id)
            ? '<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-amber-400/40 text-amber-300 bg-amber-500/10 align-middle">C2 Last</span>'
            : ''}
          ${court3ActivePlayers.has(player.id)
            ? '<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-cyan-400/40 text-cyan-300 bg-cyan-500/10 align-middle">C3 Now</span>'
            : court3LastPlayers.has(player.id)
            ? '<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-amber-400/40 text-amber-300 bg-amber-500/10 align-middle">C3 Last</span>'
            : ''}
        </td>
        <td>
          <select class="input-field max-w-[110px] text-xs py-1" data-player-gender="${player.id}">
            <option value="" ${!player.gender || (player.gender.toLowerCase() !== "male" && player.gender.toLowerCase() !== "m" && player.gender.toLowerCase() !== "female" && player.gender.toLowerCase() !== "f") ? "selected" : ""}>Unspecified</option>
            <option value="Male" ${player.gender?.toLowerCase() === "male" || player.gender?.toLowerCase() === "m" ? "selected" : ""}>Male</option>
            <option value="Female" ${player.gender?.toLowerCase() === "female" || player.gender?.toLowerCase() === "f" ? "selected" : ""}>Female</option>
          </select>
        </td>
        <td class="text-slate-300 text-sm">${player.location || "—"}</td>
        <td class="whitespace-nowrap text-center">${player.status}${getWaitTime(player)}</td>
        <td>
          ${player.lastResult === 'Win' ? '<span class="text-xs font-semibold px-2 py-1 bg-green-500/20 text-green-400 rounded-md border border-green-500/30">Won</span>' : ''}
          ${player.lastResult === 'Loss' ? '<span class="text-xs font-semibold px-2 py-1 bg-red-500/20 text-red-400 rounded-md border border-red-500/30">Lost</span>' : ''}
          ${!player.lastResult ? '<span class="text-xs text-slate-500">—</span>' : ''}
        </td>
        <td class="text-purple-400 font-semibold">${(player.wins ?? 0) + (player.losses ?? 0)}</td>
        <td class="text-green-400 font-semibold">${player.wins ?? 0}W</td>
        <td class="text-red-400 font-semibold">${player.losses ?? 0}L</td>
        <td class="text-blue-400 font-semibold">${((player.wins ?? 0) + (player.losses ?? 0)) > 0 ? Math.round(((player.wins ?? 0) / ((player.wins ?? 0) + (player.losses ?? 0))) * 100) + '%' : '—'}</td>
        <td>
          <select class="input-field" data-player-skill="${player.id}">
            ${RATINGS.map(
              (rating) =>
                `<option value="${rating.label}" ${
                  player.rating === rating.label ? "selected" : ""
                }>${rating.label}</option>`
            ).join("")}
          </select>
        </td>
        <td class="sticky right-0 py-3 pl-4 text-right" style="background:rgba(12,50,50,0.98);">
          <div class="flex flex-nowrap justify-end gap-1">
            <button class="btn-secondary text-xs px-2 py-1 whitespace-nowrap mobile-icon-only" data-player-setup-partner="${player.id}">&#x1F517; <span>Partner</span></button>
            <button class="btn-secondary text-xs px-2 py-1 whitespace-nowrap mobile-icon-only" data-player-absent="${player.id}">&#x21A9; <span>Return</span></button>
            <button class="btn-secondary text-xs px-2 py-1 whitespace-nowrap mobile-icon-only" style="border-color: rgba(251,191,36,0.4); color:#fbbf24;" data-player-done="${player.id}">&#x2714; <span>Done Playing</span></button>
            <button class="btn-secondary text-xs px-2 py-1 whitespace-nowrap mobile-icon-only" style="border-color: rgba(248,113,113,0.4); color:#fca5a5;" data-player-remove="${player.id}">&#x2715;</button>
          </div>
        </td>
      </tr>
      `).join(""));
    }
  };

  renderDoneTable(elements.donePlayersBodyBeginner, "count-done-beginner");
}

async function handlePlayerActionClick(event) {
  const btn = event.target.closest('button');
  if (!btn) return;
  const details = btn.getAttribute("data-player-details");
  const absent = btn.getAttribute("data-player-absent");
  const remove = btn.getAttribute("data-player-remove");
  const done = btn.getAttribute("data-player-done");
  const setupPartner = btn.getAttribute("data-player-setup-partner");

  if (details) {
    openPlayerDetailsModal(details);
    return;
  }
  
  if (setupPartner) {
    openPartnerModal(setupPartner);
    return;
  }
  
  if (!absent && !remove && !done) return;

  try {
    if (done) {
      await archiveSinglePlayer(done);
      showToast("Player archived as Done Playing.");
    }
    if (absent) {
      const player = state.players.get(absent);
      if (player?.status === "Playing" || player?.status === "Stacked") {
        showToast("Player is currently in a match.", "error");
        return;
      }
      const isOut = player?.status === "Absent" || player?.status === "Standby";
      await markPlayerAbsent(absent, !isOut);
      showToast(isOut ? "Player returned to queue" : "Player marked absent");
    }
    if (remove) {
      await removePlayer(remove);
      showToast("Player removed");
    }
  } catch (error) {
    console.error("Player update failed", error);
    showToast(formatFirebaseError(error), "error");
  }
}

function setupSortable() {
  if (!window.Sortable) {
    showToast("SortableJS failed to load", "error");
    return;
  }

  const globalGrid = document.getElementById("global-match-grid");
  if (globalGrid) {
    if (!globalGrid._sortable) {
      globalGrid._sortable = new Sortable(globalGrid, {
        animation: 150,
        draggable: ".match-card",
        handle: ".match-card-drag-handle",
        filter: ".queue-item, button, select, input, textarea",
        preventOnFilter: false,
        fallbackOnBody: true,
        forceFallback: true,
        delay: 120,
        delayOnTouchOnly: true,
        touchStartThreshold: 5,
        fallbackTolerance: 3,
        onMove: (event) => {
          return true; // Allow match cards to be dragged anywhere freely
        },
        onEnd: async (event) => {
          const globalOrder = [];
          Array.from(globalGrid.children).forEach(child => {
            if (child.dataset.matchId) {
              globalOrder.push(child.dataset.matchId);
            }
          });
          localStorage.setItem("globalMatchOrder", JSON.stringify(globalOrder));

          const skillKey = event.item.dataset.skillKey;
          const order = [];
          globalGrid.querySelectorAll(`.match-card[data-skill-key="${skillKey}"] .queue-item`).forEach((item) => {
            if (item.dataset.playerId) {
              order.push(item.dataset.playerId);
            } else if (item.dataset.action === "open-add-player-modal") {
              order.push("EMPTY");
            }
          });
          while (order.length > 0 && order[order.length - 1] === "EMPTY") {
            order.pop();
          }
          
          renderNextMatch();
          
          try {
            await reorderQueue(skillKey, order);
          } catch (error) {
            showToast(error.message || "Failed to reorder matches", "error");
          }
        },
      });
    }

    globalGrid.querySelectorAll(".team-list").forEach((list) => {
      if (list._sortable) return;

      const skillKey = list.dataset.queue;
      list._sortable = new Sortable(list, {
        group: `queue-${skillKey}`, // Revert to only allowing dragging within same skill queue
        animation: 150,
        filter: "button, .add-player-btn",
        preventOnFilter: false,
        fallbackOnBody: true,
        forceFallback: true,
        fallbackTolerance: 3,
        delay: 0,
        swap: true,
        swapClass: "bg-slate-700/80",
        touchStartThreshold: 5,
        onEnd: async () => {
          const order = [];
          globalGrid.querySelectorAll(`.match-card[data-skill-key="${skillKey}"] .queue-item`).forEach((item) => {
            if (item.dataset.playerId) order.push(item.dataset.playerId);
          });
          try {
            await reorderQueue(skillKey, order);
          } catch (error) {
            showToast(error.message || "Failed to reorder queue", "error");
          }
        },
      });
    });
    return;
  }

  document.querySelectorAll(".queue-matches-container").forEach((container) => {
    const skillKey = container.dataset.queue;
    
    // Sortable for match cards (reordering matches)
    container.querySelectorAll(".queue-matches-grid").forEach((grid) => {
      if (grid._sortable) return;
      grid._sortable = new Sortable(grid, {
        group: `queue-grid-${skillKey}`,
        animation: 150,
        handle: '.match-card-drag-handle',
        delay: 150,
        delayOnTouchOnly: true,
        touchStartThreshold: 3,
        onEnd: async (e) => {
          const order = [];
          container.querySelectorAll(".queue-item").forEach((item) => {
            if (item.dataset.playerId) {
              order.push(item.dataset.playerId);
            } else if (item.dataset.action === "open-add-player-modal") {
              order.push("EMPTY");
            }
          });
          // Clean trailing EMPTYs
          while (order.length > 0 && order[order.length - 1] === "EMPTY") {
            order.pop();
          }
          try {
            await reorderQueue(skillKey, order);
          } catch (error) {
            showToast(error.message || "Failed to reorder matches", "error");
          }
        },
      });
    });

    // Sortable for players (reordering within/between matches)
    container.querySelectorAll(".team-list").forEach((list) => {
      if (list._sortable) return;

      list._sortable = new Sortable(list, {
        group: `queue-${skillKey}`, // Allows dragging between match cards in this skill queue
        animation: 150,
        filter: 'button, .add-player-btn',
        preventOnFilter: false,
        fallbackOnBody: true,
        forceFallback: true,
        fallbackTolerance: 3,
        delay: 0,
        swap: true,
        swapClass: 'bg-slate-700/80',
        touchStartThreshold: 5,
        onEnd: async (e) => {
          // Rebuild the entire order array from ALL match cards in this skill's container
          const order = [];
          container.querySelectorAll(".queue-item").forEach((item) => {
            if (item.dataset.playerId) {
              order.push(item.dataset.playerId);
            }
          });
          
          try {
            await reorderQueue(skillKey, order);
          } catch (error) {
            showToast(error.message || "Failed to reorder queue", "error");
          }
        },
      });
    });
  });
}

// Court skill restrictions:
// Court 1 → Beginner only
// Court 2 → Intermediate only
// Court 3 → Any skill (random / overflow)
const COURT_SKILL_RESTRICTION = {};

// Returns allowed skill keys for a given court
function getAllowedSkillsForCourt(court) {
  if (court.allowedSkill !== undefined) {
    return (court.allowedSkill === "any" || court.allowedSkill === "Any") ? null : court.allowedSkill;
  }
  const restriction = COURT_SKILL_RESTRICTION[court.id];
  if (restriction === null || restriction === undefined) return null; // null means any
  return restriction; // single key string
}

async function maybeAutoAssignMatches() {
  if (state.automationLock) return;
  if (!state.ready.queues || !state.ready.courts || !state.ready.pendingMatches) return;

  state.automationLock = true;

  try {
    const availableCourts = state.courts.filter((court) => court.status === "Available");
    
    let pendingIndex = 0;
    const localAssignedTally = {};
    const localQueueDeductions = {};
    const busyPlayers = new Set();
    state.courts.forEach(c => {
      if (c.status === "Active" && c.players) c.players.forEach(p => busyPlayers.add(p));
    });

    for (const court of availableCourts) {
      const allowedSkill = getAllowedSkillsForCourt(court); // null = any, string = specific key

      const activeTally = {};
      state.courts.forEach(c => {
        if (c.status === "Active" && c.skill) {
          activeTally[c.skill] = (activeTally[c.skill] || 0) + 1;
        }
      });
      
      for (const [skill, count] of Object.entries(localAssignedTally)) {
        activeTally[skill] = (activeTally[skill] || 0) + count;
      }
      
      // Filter skill queues by court restriction
      const queueOptions = SKILLS
        .filter(skill => allowedSkill === null || skill.key === allowedSkill)
        .map((skill) => {
          const deducted = localQueueDeductions[skill.key] || 0;
          return {
            key: skill.key,
            label: skill.label,
            length: (state.queues[skill.key] || []).filter(id => id !== "EMPTY").length - deducted,
            isCustom: false
          };
        }).filter((queue) => queue.length >= 4);

      // Custom (stacked) matches go to any court
      if (allowedSkill === null) {
        // Find the next pending match where NO players are currently busy
        while (pendingIndex < state.pendingMatches.length) {
          const match = state.pendingMatches[pendingIndex];
          const hasBusyPlayer = match.players.some(pid => busyPlayers.has(pid));
          if (!hasBusyPlayer) break;
          pendingIndex++; // skip this match for now, players are busy
        }

        if (pendingIndex < state.pendingMatches.length) {
          queueOptions.push({
            key: "custom",
            label: "Custom",
            length: (state.pendingMatches.length - pendingIndex) * 4,
            isCustom: true
          });
        }
      }

      if (!queueOptions.length) continue; // skip this court, no eligible queue

      queueOptions.sort((a, b) => {
        // Force custom matches to always have the lowest priority
        if (a.isCustom && !b.isCustom) return 1;
        if (!a.isCustom && b.isCustom) return -1;

        const aActive = activeTally[a.label] || 0;
        const bActive = activeTally[b.label] || 0;
        if (aActive !== bActive) return aActive - bActive;
        return b.length - a.length;
      });

      const chosen = queueOptions[0];

      try {
        if (chosen.isCustom) {
          const match = state.pendingMatches[pendingIndex];
          const { activatePendingMatch } = await import("./courts.js");
          await activatePendingMatch(match.id, court.id);
          match.players.forEach(pid => busyPlayers.add(pid));
          pendingIndex++;
          localAssignedTally["Custom"] = (localAssignedTally["Custom"] || 0) + 1;
        } else {
          await assignMatchToCourt(court.id, chosen.key);
          localAssignedTally[chosen.label] = (localAssignedTally[chosen.label] || 0) + 1;
          localQueueDeductions[chosen.key] = (localQueueDeductions[chosen.key] || 0) + 4;
        }
      } catch (err) {
        // If match cannot be started (e.g., players are still busy playing), skip this court
        console.warn(`Could not assign court ${court.id}: ${err.message}`);
      }
    }
  } catch (error) {
    console.warn(error);
  } finally {
    state.automationLock = false;
  }
}

function startTimerLoop() {
  setInterval(() => {
    state.courts.forEach((court) => {
      const timerEl = document.querySelector(`[data-court-timer="${court.id}"]`);
      if (!timerEl || !court.startedAt) return;

      let start;
      if (typeof court.startedAt.toDate === 'function') {
        start = court.startedAt.toDate();
      } else if (court.startedAt.seconds !== undefined) {
        start = new Date(court.startedAt.seconds * 1000);
      } else {
        start = new Date(court.startedAt);
      }

      if (isNaN(start.getTime())) return;

      const diffMs = Math.max(0, Date.now() - start.getTime());
      const minutes = Math.floor(diffMs / 60000);
      const seconds = Math.floor((diffMs % 60000) / 1000);
      timerEl.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    });
  }, 1000);
}

let _pendingAddSlotInfo = null;

function openPlayerDetailsModal(playerId) {
  const player = state.players.get(playerId);
  const modal = document.getElementById("player-details-modal");
  if (!player || !modal) return;

  const wins = player.wins || 0;
  const losses = player.losses || 0;
  const gender = String(player.gender || "").toLowerCase();
  const normalizedGender = gender === "male" || gender === "m"
    ? "Male"
    : gender === "female" || gender === "f"
      ? "Female"
      : "Unspecified";

  document.getElementById("player-details-id").value = player.id;
  document.getElementById("player-details-title").textContent = player.name;
  document.getElementById("player-details-summary").textContent = "Update player information and partner preferences.";
  document.getElementById("player-details-name").value = player.name || "";
  document.getElementById("player-details-location").value = player.location || "";
  document.getElementById("player-details-gender").value = normalizedGender;
  document.getElementById("player-details-status").textContent = player.status || "Unknown";
  document.getElementById("player-details-games").textContent = wins + losses;
  document.getElementById("player-details-record").textContent = `${wins}W · ${losses}L`;

  const ratingSelect = document.getElementById("player-details-rating");
  ratingSelect.innerHTML = RATINGS.map((rating) =>
    `<option value="${rating.label}" ${player.rating === rating.label ? "selected" : ""}>${rating.label}</option>`
  ).join("");

  const partnerSelect = document.getElementById("player-details-partner");
  partnerSelect.innerHTML = [`<option value="">None</option>`, ...Array.from(state.players.values())
    .filter((candidate) => candidate.id !== player.id && candidate.status !== "Archived")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((candidate) => `<option value="${candidate.id}" ${player.practicePartner === candidate.id ? "selected" : ""}>${candidate.name}</option>`)
  ].join("");

  modal.classList.remove("hidden");
  document.getElementById("player-details-name")?.focus();
}

function openPartnerModal(playerId) {
  const player = state.players.get(playerId);
  if (!player) return;

  const modal = document.getElementById("partner-modal");
  const select = document.getElementById("partner-modal-select");
  const nameEl = document.getElementById("partner-modal-player-name");
  const idInput = document.getElementById("partner-modal-player-id");

  nameEl.textContent = player.name;
  idInput.value = playerId;

  const options = [`<option value="">None</option>`];
  Array.from(state.players.values())
    .filter(p => p.id !== playerId && p.status !== 'Archived')
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(p => {
      const selected = player.practicePartner === p.id ? "selected" : "";
      options.push(`<option value="${p.id}" ${selected}>${p.name}</option>`);
    });

  select.innerHTML = options.join("");
  modal.classList.remove("hidden");
}

function openLockPartnersModal() {
  const players = Array.from(state.players.values())
    .filter((player) => player.status !== "Archived")
    .sort((a, b) => a.name.localeCompare(b.name));
  if (players.length < 2) {
    showToast("Add at least two active players before locking a pair.", "error");
    return;
  }

  const playerASelect = document.getElementById("lock-partners-player-a");
  const playerBSelect = document.getElementById("lock-partners-player-b");
  const modal = document.getElementById("lock-partners-modal");
  const options = players.map((player) => `<option value="${player.id}">${player.name}</option>`).join("");
  playerASelect.innerHTML = options;
  playerBSelect.innerHTML = options;
  if (players[1]) playerBSelect.value = players[1].id;
  modal.classList.remove("hidden");
}

function openUnlockPartnersModal() {
  const playerById = state.players;
  const seenPairs = new Set();
  const pairs = Array.from(playerById.values())
    .filter((player) => player.practicePartner && playerById.has(player.practicePartner))
    .map((player) => {
      const partner = playerById.get(player.practicePartner);
      const pairKey = [player.id, partner.id].sort().join("|");
      if (seenPairs.has(pairKey)) return null;
      seenPairs.add(pairKey);
      return { player, partner };
    })
    .filter(Boolean)
    .sort((a, b) => a.player.name.localeCompare(b.player.name));

  if (!pairs.length) {
    showToast("No fixed partners to unlock.");
    return;
  }

  const select = document.getElementById("unlock-partners-player");
  const modal = document.getElementById("unlock-partners-modal");
  select.innerHTML = pairs
    .map(({ player, partner }) => `<option value="${player.id}">${player.name} &amp; ${partner.name}</option>`)
    .join("");
  modal.classList.remove("hidden");
}

function openNewPlayerModal() {
  const partnerSelect = document.getElementById("player-practice-partner");
  if (partnerSelect) {
    partnerSelect.innerHTML = `<option value="">None</option>` +
      Array.from(state.players.values())
        .filter(player => player.status !== "Archived")
        .map(player => `<option value="${player.id}">${player.name}</option>`)
        .join("");
  }
  document.getElementById("add-player-modal")?.classList.remove("hidden");
  elements.nameInput?.focus();
}

function openAddPlayerModal(queueKey, matchIndex, slotIndex, courtId = null) {
  _pendingAddSlotInfo = { queueKey, matchIndex, slotIndex, courtId };
  const modal = document.getElementById("add-to-match-modal");
  const list = document.getElementById("add-to-match-list");
  const search = document.getElementById("add-to-match-search");
  
  search.value = "";
  
  const populateList = (filterText = "") => {
    const excludedStatuses = new Set(["Archived", "Done Playing"]);
    const allAvailable = Array.from(state.players.values()).filter(p => !excludedStatuses.has(p.status));
    allAvailable.sort((a, b) => a.name.localeCompare(b.name));
    
    list.innerHTML = "";
    
    const filtered = allAvailable.filter(p => p.name.toLowerCase().includes(filterText.toLowerCase()));
    
    if (filtered.length === 0) {
      list.innerHTML = `<li class="text-sm text-slate-500 text-center py-2">No matching waiting players found.</li>`;
      return;
    }
    
    filtered.forEach(p => {
      const li = document.createElement("li");
      li.className = "p-2 hover:bg-slate-700/50 cursor-pointer rounded-md flex justify-between items-center transition-colors border border-transparent hover:border-slate-600";
      li.innerHTML = `
        <span class="font-semibold text-sm text-slate-200">${p.name}</span>
        <span class="text-xs text-slate-500 px-2 py-0.5 rounded-full bg-slate-800">${p.skill}</span>
      `;
      li.onclick = () => confirmAddPlayer(p.id);
      list.appendChild(li);
    });
  };
  
  populateList();
  search.oninput = (e) => populateList(e.target.value);
  modal.classList.remove("hidden");
}

async function confirmAddPlayer(playerId) {
  if (!_pendingAddSlotInfo) return;
  const { queueKey, matchIndex, slotIndex, courtId } = _pendingAddSlotInfo;
  
  if (courtId) {
    try {
      await replaceActiveCourtPlayer(courtId, slotIndex, playerId);
      showToast("Player updated in active match!");
    } catch (error) {
      console.error("Failed to replace player", error);
      showToast(error.message || "Failed to replace player", "error");
    } finally {
      document.getElementById("add-to-match-modal").classList.add("hidden");
      _pendingAddSlotInfo = null;
    }
    return;
  }
  
  const order = state.queues[queueKey] || [];
  const targetIndex = (matchIndex * 4) + slotIndex;
  
  const newOrder = [...order];
  const existingIdx = newOrder.indexOf(playerId);
  if (existingIdx !== -1) {
    newOrder[existingIdx] = "EMPTY";
  }
  
  if (newOrder[targetIndex] === "EMPTY" || newOrder[targetIndex] === undefined) {
    newOrder[targetIndex] = playerId;
  } else {
    // Determine actual splice index ignoring trailing EMPTYs? No, just splice.
    let finalTargetIndex = targetIndex;
    if (existingIdx !== -1 && existingIdx < targetIndex) {
      finalTargetIndex -= 1;
    }
    newOrder.splice(finalTargetIndex, 0, playerId);
  }
  
  // Clean up trailing EMPTYs just in case
  while (newOrder.length > 0 && newOrder[newOrder.length - 1] === "EMPTY") {
    newOrder.pop();
  }
  
  try {
    await reorderQueue(queueKey, newOrder);
    await markPlayerAbsent(playerId, false);
    showToast("Player added to match!");
  } catch (error) {
    console.error("Failed to add player", error);
    showToast(error.message || "Failed to add player", "error");
  } finally {
    document.getElementById("add-to-match-modal").classList.add("hidden");
    _pendingAddSlotInfo = null;
  }
}

let _pendingFinishCourtId = null;

function openWinnerModal(courtId) {
  _pendingFinishCourtId = courtId;

  // Look up the court from state to get team names
  const court = state.courts.find(c => c.id === courtId);
  const players = court?.players || [];

  const nameFor = (id) => state.players.get(id)?.name || "Unknown";

  // players[0], [1] = Team A   players[2], [3] = Team B
  const teamANames = [nameFor(players[0]), nameFor(players[1])].filter(n => n !== "Unknown" && n !== "--");
  const teamBNames = [nameFor(players[2]), nameFor(players[3])].filter(n => n !== "Unknown" && n !== "--");

  const modal = document.getElementById("winner-modal");
  const scoreFields = document.getElementById("winner-score-fields");
  const teamAScore = document.getElementById("winner-team-a-score");
  const teamBScore = document.getElementById("winner-team-b-score");
  document.getElementById("winner-team-a-names").textContent = teamANames.join(" & ") || "Team A";
  document.getElementById("winner-team-b-names").textContent = teamBNames.join(" & ") || "Team B";
  scoreFields?.classList.toggle("hidden", !scoringIsEnabled());
  if (teamAScore) teamAScore.value = "";
  if (teamBScore) teamBScore.value = "";
  modal.classList.remove("hidden");
}

async function confirmFinishMatch(winnerTeam) {
  let score = null;
  if (scoringIsEnabled() && winnerTeam) {
    const teamAScoreValue = document.getElementById("winner-team-a-score")?.value;
    const teamBScoreValue = document.getElementById("winner-team-b-score")?.value;
    const teamAScore = Number(teamAScoreValue);
    const teamBScore = Number(teamBScoreValue);
    if (teamAScoreValue === "" || teamBScoreValue === "" || !Number.isInteger(teamAScore) || teamAScore < 0 || !Number.isInteger(teamBScore) || teamBScore < 0) {
      showToast("Enter a whole-number score for both teams.", "error");
      return;
    }
    if ((winnerTeam === "teamA" && teamAScore <= teamBScore) || (winnerTeam === "teamB" && teamBScore <= teamAScore)) {
      showToast("The selected winner must have the higher score.", "error");
      return;
    }
    score = { teamA: teamAScore, teamB: teamBScore };
  }

  const courtId = _pendingFinishCourtId;
  _pendingFinishCourtId = null;
  document.getElementById("winner-modal").classList.add("hidden");

  try {
    await finishMatch(courtId, winnerTeam, score);
    showToast("Match finished" + (winnerTeam ? ` — ${winnerTeam === "teamA" ? "Team A" : "Team B"} wins!` : ""));
  } catch (error) {
    console.error("Finish match failed", error);
    showToast(formatFirebaseError(error), "error");
  }
}

function bindEvents() {
  setupSidebarTooltips();
  const gameLimitBtn = document.getElementById("game-limit-btn");
  const gameLimitModal = document.getElementById("game-limit-modal");
  const gameLimitInput = document.getElementById("game-limit-input");
  const closeGameLimitModal = () => gameLimitModal?.classList.add("hidden");

  gameLimitBtn?.addEventListener("click", () => {
    const limit = getGameLimit();
    if (gameLimitInput) gameLimitInput.value = limit ? String(limit) : "";
    gameLimitModal?.classList.remove("hidden");
    gameLimitInput?.focus();
  });
  document.getElementById("close-game-limit-modal")?.addEventListener("click", closeGameLimitModal);
  gameLimitModal?.addEventListener("click", (event) => {
    if (event.target === gameLimitModal) closeGameLimitModal();
  });
  document.getElementById("save-game-limit-btn")?.addEventListener("click", () => {
    const rawValue = gameLimitInput?.value.trim() || "";
    const limit = Number(rawValue);
    if (!rawValue || !Number.isInteger(limit) || limit < 1) {
      showToast("Enter a whole-number game limit of at least 1, or use Turn Off.", "error");
      return;
    }
    setGameLimit(limit);
    refreshGameLimitUI();
    closeGameLimitModal();
    showToast(`Game limit set to ${limit} games per player.`);
  });
  document.getElementById("clear-game-limit-btn")?.addEventListener("click", () => {
    setGameLimit(null);
    refreshGameLimitUI();
    closeGameLimitModal();
    showToast("Game limit turned off.");
  });
  refreshGameLimitUI();

  document.getElementById("lock-partners-btn")?.addEventListener("click", openLockPartnersModal);
  document.getElementById("unlock-partners-btn")?.addEventListener("click", openUnlockPartnersModal);
  const playerDetailsModal = document.getElementById("player-details-modal");
  const playerDetailsForm = document.getElementById("player-details-form");
  const closePlayerDetailsModal = () => playerDetailsModal?.classList.add("hidden");

  document.getElementById("close-player-details-modal")?.addEventListener("click", closePlayerDetailsModal);
  document.getElementById("cancel-player-details-btn")?.addEventListener("click", closePlayerDetailsModal);
  playerDetailsModal?.addEventListener("click", (event) => {
    if (event.target === playerDetailsModal) closePlayerDetailsModal();
  });
  playerDetailsForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const playerId = document.getElementById("player-details-id").value;
    const player = state.players.get(playerId);
    if (!player) {
      showToast("This player is no longer available.", "error");
      closePlayerDetailsModal();
      return;
    }

    const name = document.getElementById("player-details-name").value;
    const location = document.getElementById("player-details-location").value;
    const rating = document.getElementById("player-details-rating").value;
    const gender = document.getElementById("player-details-gender").value;
    const partnerId = document.getElementById("player-details-partner").value;
    const saveButton = document.getElementById("save-player-details-btn");

    try {
      if (saveButton) saveButton.disabled = true;
      await updatePlayerProfile(playerId, { name, location });
      if (rating !== player.rating) await updatePlayerSkill(playerId, rating);
      const currentGender = String(player.gender || "Unspecified").toLowerCase();
      if (currentGender !== gender.toLowerCase()) await updatePlayerGender(playerId, gender);
      if ((player.practicePartner || "") !== partnerId) await updatePlayerPracticePartner(playerId, partnerId);
      showToast("Player details updated");
      closePlayerDetailsModal();
    } catch (error) {
      console.error("Unable to update player details", error);
      showToast(error.message || "Unable to update player details.", "error");
    } finally {
      if (saveButton) saveButton.disabled = false;
    }
  });

  const partnerModal = document.getElementById("partner-modal");
  const closePartnerBtn = document.getElementById("close-partner-modal");
  const partnerForm = document.getElementById("partner-form");

  if (closePartnerBtn && partnerModal) {
    closePartnerBtn.addEventListener("click", () => partnerModal.classList.add("hidden"));
  }
  if (partnerModal) {
    partnerModal.addEventListener("click", (e) => {
      if (e.target === partnerModal) partnerModal.classList.add("hidden");
    });
  }
  if (partnerForm) {
    partnerForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const playerId = document.getElementById("partner-modal-player-id").value;
      const partnerId = document.getElementById("partner-modal-select").value;
      try {
        await updatePlayerPracticePartner(playerId, partnerId);
        showToast("Practice partner updated");
        partnerModal.classList.add("hidden");
      } catch (err) {
        showToast("Error updating partner", "error");
      }
    });
  }

  const lockPartnersModal = document.getElementById("lock-partners-modal");
  const lockPartnersForm = document.getElementById("lock-partners-form");
  const closeLockPartnersModal = () => lockPartnersModal?.classList.add("hidden");
  document.getElementById("close-lock-partners-modal")?.addEventListener("click", closeLockPartnersModal);
  lockPartnersModal?.addEventListener("click", (event) => {
    if (event.target === lockPartnersModal) closeLockPartnersModal();
  });
  lockPartnersForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const playerA = document.getElementById("lock-partners-player-a").value;
    const playerB = document.getElementById("lock-partners-player-b").value;
    if (!playerA || !playerB || playerA === playerB) {
      showToast("Choose two different players to lock a pair.", "error");
      return;
    }
    try {
      await updatePlayerPracticePartner(playerA, playerB);
      const firstName = state.players.get(playerA)?.name || "Player 1";
      const secondName = state.players.get(playerB)?.name || "Player 2";
      showToast(`${firstName} and ${secondName} are now fixed partners.`);
      closeLockPartnersModal();
    } catch (error) {
      showToast(error.message || "Unable to lock partners.", "error");
    }
  });

  const unlockPartnersModal = document.getElementById("unlock-partners-modal");
  const unlockPartnersForm = document.getElementById("unlock-partners-form");
  const closeUnlockPartnersModal = () => unlockPartnersModal?.classList.add("hidden");
  document.getElementById("close-unlock-partners-modal")?.addEventListener("click", closeUnlockPartnersModal);
  unlockPartnersModal?.addEventListener("click", (event) => {
    if (event.target === unlockPartnersModal) closeUnlockPartnersModal();
  });
  unlockPartnersForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const playerId = document.getElementById("unlock-partners-player").value;
    const player = state.players.get(playerId);
    const partner = player ? state.players.get(player.practicePartner) : null;
    if (!player || !partner) {
      showToast("That fixed partner pair is no longer available.", "error");
      closeUnlockPartnersModal();
      return;
    }
    try {
      await updatePlayerPracticePartner(playerId, "");
      showToast(`${player.name} and ${partner.name} are no longer fixed partners.`);
      closeUnlockPartnersModal();
    } catch (error) {
      showToast(error.message || "Unable to unlock this partner pair.", "error");
    }
  });

  elements.addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const genderSelect = document.getElementById("player-gender");
      const partnerSelect = document.getElementById("player-practice-partner");
      const newPlayerId = await addPlayer({
        name: elements.nameInput.value,
        rating: elements.skillSelect.value,
        gender: genderSelect ? genderSelect.value : "",
        location: elements.locationInput ? elements.locationInput.value.trim() : "",
      });
      if (partnerSelect && partnerSelect.value) {
        await updatePlayerPracticePartner(newPlayerId, partnerSelect.value);
      }
      elements.nameInput.value = "";
      elements.skillSelect.value = "";
      if (genderSelect) genderSelect.value = "";
      if (elements.locationInput) elements.locationInput.value = "";
      showToast("Player added");
      
      const modal = document.getElementById("add-player-modal");
      if (modal) modal.classList.add("hidden");
    } catch (error) {
      console.error("Add player failed", error);
      showToast(formatFirebaseError(error), "error");
    }
  });

  const closeAddPlayerBtn = document.getElementById("close-add-player-modal");
  const addPlayerModal = document.getElementById("add-player-modal");

  if (closeAddPlayerBtn && addPlayerModal) {
    closeAddPlayerBtn.addEventListener("click", () => {
      addPlayerModal.classList.add("hidden");
    });
  }

  const openSavedPlayersBtn = document.getElementById("open-saved-players-modal");
  const closeSavedPlayersBtn = document.getElementById("close-saved-players-modal");
  const savedPlayersModal = document.getElementById("saved-players-modal");
  const savedPlayersSearch = document.getElementById("saved-players-search");
  const savedPlayersList = document.getElementById("saved-players-list");

  function renderSavedPlayersRoster() {
    if (!savedPlayersList) return;
    const searchStr = (savedPlayersSearch.value || "").toLowerCase();

    const todayStr = new Date().toLocaleDateString();

    function isToday(ts) {
      if (!ts) return false;
      let d;
      if (typeof ts.toDate === "function") d = ts.toDate();
      else if (ts.seconds) d = new Date(ts.seconds * 1000);
      else d = new Date(ts);
      return d.toLocaleDateString() === todayStr;
    }
    
    const rosterByName = new Map();
    Array.from(state.players.values())
      .filter(p => p.status === "Roster")
      .forEach((player) => {
        const key = playerNameKey(player.name);
        if (!rosterByName.has(key)) rosterByName.set(key, player);
      });
    const rosterPlayers = Array.from(rosterByName.values())
      .filter(p => p.name.toLowerCase().includes(searchStr))
      .sort((a, b) => a.name.localeCompare(b.name));
    
    savedPlayersList.innerHTML = rosterPlayers.length ? rosterPlayers.map(p => `
      <li class="flex items-center justify-between p-2 hover:bg-slate-800/50 rounded-lg">
        <div>
          <p class="font-semibold text-white text-sm">${p.name} <span class="text-xs text-slate-400 ml-1">(${p.skill})</span></p>
          <p class="text-xs text-slate-500">${p.gender || "Unspecified"} • ${p.skill}</p>
        </div>
        <button class="btn-primary text-xs px-3 py-1" data-roster-add="${p.id}">Add to Queue</button>
      </li>
    `).join("") : `<li class="p-4 text-slate-500 text-sm text-center">No players imported today.</li>`;
  }

  if (openSavedPlayersBtn && savedPlayersModal) {
    openSavedPlayersBtn.addEventListener("click", () => {
      savedPlayersSearch.value = "";
      renderSavedPlayersRoster();
      savedPlayersModal.classList.remove("hidden");
      savedPlayersSearch.focus();
    });
  }

  if (closeSavedPlayersBtn && savedPlayersModal) {
    closeSavedPlayersBtn.addEventListener("click", () => {
      savedPlayersModal.classList.add("hidden");
    });
  }

  if (savedPlayersSearch) {
    savedPlayersSearch.addEventListener("input", renderSavedPlayersRoster);
  }

  if (savedPlayersList) {
    savedPlayersList.addEventListener("click", async (e) => {
      if (e.target.dataset.rosterAdd) {
        const playerId = e.target.dataset.rosterAdd;
        try {
          await activatePlayerToStandby(playerId);
          showToast("Player added to standby.");
          renderSavedPlayersRoster();
        } catch (err) {
          showToast(err.message, "error");
        }
      }
    });
  }

  // Close modal when clicking outside
  if (addPlayerModal) {
    addPlayerModal.addEventListener("click", (e) => {
      if (e.target === addPlayerModal) {
        addPlayerModal.classList.add("hidden");
      }
    });
  }

  if (savedPlayersModal) {
    savedPlayersModal.addEventListener("click", (e) => {
      if (e.target === savedPlayersModal) {
        savedPlayersModal.classList.add("hidden");
      }
    });
  }

  // Match Log Modal Logic
  const viewMatchLogBtn = document.getElementById("view-match-log-btn");
  const closeMatchLogModal = document.getElementById("close-match-log-modal");
  const matchLogModal = document.getElementById("match-log-modal");

  if (viewMatchLogBtn && matchLogModal) {
    viewMatchLogBtn.addEventListener("click", () => {
      matchLogModal.classList.remove("hidden");
    });
  }

  if (closeMatchLogModal && matchLogModal) {
    closeMatchLogModal.addEventListener("click", () => {
      matchLogModal.classList.add("hidden");
    });
  }

  // Close modal when clicking outside
  if (matchLogModal) {
    matchLogModal.addEventListener("click", (e) => {
      if (e.target === matchLogModal) {
        matchLogModal.classList.add("hidden");
      }
    });
  }
  const handleArchiveAll = async () => {
    if (!(await showConfirmModal("Are you sure you want to end the session and archive all active players? This will clear all courts and queues."))) return;
    try {
      await archiveAllPlayers(Array.from(state.players.values()));
      showToast("Session ended. All players archived.");
    } catch (error) {
      console.error("Archive failed", error);
      showToast(formatFirebaseError(error), "error");
    }
  };

  const headerEndSessionBtn = document.getElementById("header-end-session-btn");
  if (headerEndSessionBtn) {
    headerEndSessionBtn.addEventListener("click", handleArchiveAll);
  }

  elements.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value;
    renderPlayers();
  });

  elements.filterSelect.addEventListener("change", (event) => {
    state.filter = event.target.value;
    renderPlayers();
  });

  const autoAssignToggle = document.getElementById("auto-assign-toggle");
  if (autoAssignToggle) {
    autoAssignToggle.addEventListener("change", (event) => {
      if (event.target.checked) {
        maybeAutoAssignMatches();
      }
    });
  }

  const addCourtBtn = document.getElementById("add-court-btn");
  addCourtBtn?.addEventListener("click", async () => {
    const originalContent = addCourtBtn.innerHTML;
    try {
      addCourtBtn.disabled = true;
      addCourtBtn.textContent = "Adding...";
      const court = await addCourt();
      showToast(`${court.name} added and ready for matches.`);
    } catch (error) {
      console.error("Add court failed", error);
      showToast(formatFirebaseError(error), "error");
    } finally {
      addCourtBtn.disabled = false;
      addCourtBtn.innerHTML = originalContent;
    }
  });

  const generateRoundBtn = document.getElementById("generate-round-btn");
  const matchingModeModal = document.getElementById("matching-mode-modal");
  const closeMatchingModeModal = document.getElementById("close-matching-mode-modal");
  const confirmMatchingModeBtn = document.getElementById("confirm-matching-mode-btn");

  if (generateRoundBtn && matchingModeModal) {
    generateRoundBtn.addEventListener("click", async () => {
      const activeCourts = state.courts.filter(c => c.status === "Active");
      if (activeCourts.length > 0) {
        if (!(await showConfirmModal(`There are ${activeCourts.length} matches still playing on the courts. Generating a new round now will include both Waiting and Playing players in the shuffle. The new matches won't start until the players finish their current games. Proceed?`))) {
          return;
        }
      }
      matchingModeModal.classList.remove("hidden");
    });

    closeMatchingModeModal?.addEventListener("click", () => {
      matchingModeModal.classList.add("hidden");
    });

    matchingModeModal.addEventListener("click", (e) => {
      if (e.target === matchingModeModal) matchingModeModal.classList.add("hidden");
    });

    confirmMatchingModeBtn?.addEventListener("click", async () => {
      const selectedMode = document.querySelector('input[name="matching_mode"]:checked')?.value || 'smart';
      
      // Persist chosen mode for Auto Round to reuse
      state.autoRoundMode = selectedMode;
      localStorage.setItem("dq_auto_round_mode", selectedMode);

      try {
        confirmMatchingModeBtn.disabled = true;
        confirmMatchingModeBtn.innerHTML = "Generating...";
        const history = [
          ...state.matchLog,
          ...state.courts.filter((court) => court.status === "Active").map((court) => ({
            players: court.players || [],
            teamA: (court.players || []).slice(0, 2),
            teamB: (court.players || []).slice(2, 4),
          })),
        ];
        const summary = await generateSmartRound(Array.from(state.players.values()), selectedMode, history, {
          lockPartners: true,
        });
        const repeatCount = summary.repeatLineups + summary.repeatTeammates + summary.repeatOpponents;
        showToast(
          repeatCount
            ? "Smart rotation: " + summary.matches + " matches · " + summary.repeatLineups + " repeat lineup(s), " + summary.repeatTeammates + " repeat partner(s), " + summary.repeatOpponents + " repeat opponent(s)."
            : "Smart rotation ready: " + summary.matches + " balanced matches · no repeat lineups, partners, or opponents.",
          repeatCount ? "warning" : "info"
        );
        matchingModeModal.classList.add("hidden");
      } catch (error) {
        showToast(error.message || "Failed to generate round.", "error");
      } finally {
        confirmMatchingModeBtn.disabled = false;
        confirmMatchingModeBtn.innerHTML = "Generate Matches";
      }
    });
  }

  // ── Auto Round toggle button ──────────────────────────────────────────────
  const autoRoundBtn = document.getElementById("auto-round-btn");
  const autoRoundModeLabel = document.getElementById("auto-round-mode-label");

  function updateAutoRoundBtn() {
    if (!autoRoundBtn) return;
    if (state.autoRound) {
      autoRoundBtn.innerHTML = "&#x23F9; Stop Auto Round";
      autoRoundBtn.style.background = "rgba(239,68,68,0.15)";
      autoRoundBtn.style.borderColor = "rgba(239,68,68,0.5)";
      autoRoundBtn.style.color = "#fca5a5";
    } else {
      autoRoundBtn.innerHTML = "&#x1F504; Prefer Auto Round";
      autoRoundBtn.style.background = "";
      autoRoundBtn.style.borderColor = "";
      autoRoundBtn.style.color = "";
    }
    if (autoRoundModeLabel) {
      const modeNames = {
        smart: "Smart Balance",
        winners_losers: "Winners/Losers",
        social_mix: "Social Mix",
        balanced: "Balanced",
        fair_play: "Fair Play",
        mixed: "Mixed Doubles",
        flex_borrow: "Flex Borrow",
        rating: "Rating Separated",
      };
      autoRoundModeLabel.textContent = state.autoRound
        ? `Mode: ${modeNames[state.autoRoundMode] || state.autoRoundMode}`
        : "";
    }
  }

  autoRoundBtn?.addEventListener("click", () => {
    state.autoRound = !state.autoRound;
    localStorage.setItem("dq_auto_round", state.autoRound ? "1" : "0");
    updateAutoRoundBtn();
    if (state.autoRound) {
      showToast("Auto Round ON — keeps upcoming matches queued automatically.");
      window.requestAutoQueueTopUp?.();
    } else {
      showToast("Auto Round disabled.");
    }
  });

  updateAutoRoundBtn();

  document.body.addEventListener("click", async (event) => {
    const editBtn = event.target.closest(".edit-match-btn");
    if (editBtn) {
      const matchCard = editBtn.closest(".match-card");
      if (matchCard) {
        const id = matchCard.dataset.matchId;
        const willBeEditing = !state.editingMatches.has(id);
        
        if (willBeEditing) {
          state.editingMatches.add(id);
          matchCard.classList.add("is-editing");
          matchCard.querySelectorAll('.add-player-btn').forEach(btn => btn.style.display = 'flex');
        } else {
          state.editingMatches.delete(id);
          matchCard.classList.remove("is-editing");
          matchCard.querySelectorAll('.add-player-btn').forEach(btn => btn.style.display = 'none');
        }
      }
      return;
    }

    const action = event.target.closest("[data-action]")?.getAttribute("data-action") || event.target.getAttribute("data-action");
    const playerRow = event.target.closest(".queue-item");

    if (action && playerRow) {
      if (action === "open-add-player-modal") {
        const queueKey = playerRow.dataset.queueKey;
        const matchId = playerRow.dataset.matchId;
        const slotIndex = parseInt(playerRow.dataset.slotIndex, 10);
        // matchId format is "skillKey-index", e.g. "beginner-0"
        const matchIndex = parseInt(matchId.split("-").pop(), 10);
        openAddPlayerModal(queueKey, matchIndex, slotIndex);
        return;
      }
      const playerId = playerRow.dataset.playerId;
      try {
        if (action === "skip") {
          await skipPlayer(playerId);
          showToast("Player skipped");
        }
        if (action === "absent") {
          await markPlayerAbsent(playerId, true);
          showToast("Player marked absent");
        }
        if (action === "remove") {
          await removePlayer(playerId);
          showToast("Player removed");
        }
      } catch (error) {
        console.error("Queue action failed", error);
        showToast(formatFirebaseError(error), "error");
      }
      return;
    }

    const finishButton = event.target.getAttribute("data-finish-match");
    if (finishButton) {
      openWinnerModal(finishButton);
      return;
    }

    // Direct win/end button on court card (no modal)
    const finishCourtBtn = event.target.closest("[data-finish-court]");
    if (finishCourtBtn) {
      const courtId = finishCourtBtn.dataset.finishCourt;
      const winner = finishCourtBtn.dataset.winner || null;
      if (scoringIsEnabled()) {
        openWinnerModal(courtId);
        return;
      }
      try {
        await finishMatch(courtId, winner || null);
        const msg = winner === "teamA" ? "Team A wins! 🏆" : winner === "teamB" ? "Team B wins! 🏆" : "Match ended.";
        showToast(msg);
      } catch (error) {
        console.error("Finish court failed", error);
        showToast(formatFirebaseError(error), "error");
      }
      return;
    }

    const replaceActiveBtn = event.target.closest("[data-replace-active]");
    if (replaceActiveBtn) {
      const courtId = replaceActiveBtn.dataset.replaceActive;
      const slotIndex = parseInt(replaceActiveBtn.dataset.slot, 10);
      openAddPlayerModal(null, null, slotIndex, courtId);
      return;
    }

    // Start Next Match button on court card
    const startCourtBtn = event.target.closest("[data-start-court]");
    if (startCourtBtn) {
      const courtId = startCourtBtn.dataset.startCourt;
      const court = state.courts.find(c => c.id === courtId);
      const courtAllowedSkill = court?.allowedSkill && court.allowedSkill !== "any" ? court.allowedSkill : null;
      let skillKey = null;
      
      // Look at pending matches first, then global grid
      if (!courtAllowedSkill && state.pendingMatches && state.pendingMatches.length > 0) {
        skillKey = "custom";
      } else {
        const globalGrid = document.getElementById("global-match-grid");
        if (globalGrid && globalGrid.children.length > 0) {
          // If court has restricted skill, find the first match with that skill
          for (const card of globalGrid.children) {
            if (!courtAllowedSkill || card.dataset.skillKey === courtAllowedSkill) {
              const count = (state.queues[card.dataset.skillKey] || []).filter(id => id !== "EMPTY").length;
              if (count >= 4) {
                skillKey = card.dataset.skillKey;
                break;
              }
            }
          }
        }
      }

      try {
        if (!skillKey) {
          showToast("Select a queue first", "error");
          return;
        }
        startCourtBtn.disabled = true;
        startCourtBtn.textContent = "Starting...";
        if (skillKey === "custom") {
          if (!state.pendingMatches.length) {
            showToast("No pending custom match available", "error");
            return;
          }
          const { activatePendingMatch } = await import("./courts.js");
          await activatePendingMatch(state.pendingMatches[0].id, courtId);
          showToast("Custom match started!");
        } else {
          await assignMatchToCourt(courtId, skillKey);
          showToast("Match started!");
        }
      } catch (error) {
        console.error("Start court failed", error);
        showToast(formatFirebaseError(error), "error");
      }
      return;
    }

    const removeCourtBtn = event.target.closest("[data-remove-court]");
    if (removeCourtBtn) {
      const courtId = removeCourtBtn.dataset.removeCourt;
      const court = state.courts.find((item) => item.id === courtId);
      if (!court) return;

      const confirmed = await showConfirmModal(
        `Remove ${court.name || "this court"}? This cannot be undone.`,
        "Remove Court"
      );
      if (!confirmed) return;

      try {
        removeCourtBtn.disabled = true;
        await removeCourt(courtId);
        showToast(`${court.name || "Court"} removed.`);
      } catch (error) {
        console.error("Remove court failed", error);
        showToast(formatFirebaseError(error), "error");
        removeCourtBtn.disabled = false;
      }
      return;
    }

    const toggleButton = event.target.closest("[data-toggle-court]")?.dataset.toggleCourt
      || event.target.getAttribute("data-toggle-court");
    if (toggleButton) {
      try {
        await toggleCourtStatus(toggleButton);
        showToast("Court status updated");
      } catch (error) {
        console.error("Toggle court failed", error);
        showToast(formatFirebaseError(error), "error");
      }
      return;
    }
  });

  [elements.playersBodyBeginner, elements.playersBodyIntermediate, elements.playersBodyAdvanced].forEach(body => {
    if (!body) return;
    
    body.addEventListener("change", async (event) => {
      if (event.target.dataset.playerSkill) {
        const playerId = event.target.dataset.playerSkill;
        const newSkill = event.target.value;
        try {
          await updatePlayerSkill(playerId, newSkill);
          showToast("Player rating updated");
        } catch (err) {
          showToast(err.message || "Error updating rating", "error");
        }
      }
      
      if (event.target.dataset.playerGender) {
        const playerId = event.target.dataset.playerGender;
        const newGender = event.target.value;
        try {
          await updatePlayerGender(playerId, newGender);
          showToast("Player gender updated");
        } catch (err) {
          showToast("Error updating gender", "error");
        }
      }


    });

    body.addEventListener("click", handlePlayerActionClick);
  });

  elements.donePlayersContainer.addEventListener("change", async (event) => {
    if (event.target.dataset.playerSkill) {
      const playerId = event.target.dataset.playerSkill;
      const newSkill = event.target.value;
      try {
        await updatePlayerSkill(playerId, newSkill);
        showToast("Player rating updated");
      } catch (err) {
        showToast(err.message || "Error updating rating", "error");
      }
    }
    if (event.target.dataset.playerGender) {
      const playerId = event.target.dataset.playerGender;
      const newGender = event.target.value;
      try {
        await updatePlayerGender(playerId, newGender);
        showToast("Player gender updated");
      } catch (err) {
        showToast("Error updating gender", "error");
      }
    }

  });

  document.body.addEventListener("change", async (event) => {
    if (event.target.dataset.courtSkillSelect) {
      const courtId = event.target.dataset.courtSkillSelect;
      const val = event.target.value;
      const newSkill = val === "any" ? null : val;
      try {
        await updateCourtAllowedSkill(courtId, newSkill);
        showToast("Court restriction updated");
      } catch (err) {
        showToast("Error updating court", "error");
      }
    }
  });

  elements.donePlayersContainer.addEventListener("click", handlePlayerActionClick);

  const customBtn = document.getElementById("start-custom-match-btn");
  const customModal = document.getElementById("custom-match-modal");
  const closeCustomModal = document.getElementById("close-custom-modal");
  const launchCustomBtn = document.getElementById("launch-custom-match");

  customBtn.addEventListener("click", () => {
    const allActive = Array.from(state.players.values())
      .filter(p => p.status === "Waiting" || p.status === "Standby")
      .sort((a, b) => a.name.localeCompare(b.name));
    
    // Populate selects
    ["custom-team-a1", "custom-team-a2", "custom-team-b1", "custom-team-b2"].forEach((selId) => {
      const select = document.getElementById(selId);
      select.innerHTML = `<option value="" disabled selected>Select player...</option>` + 
        allActive.map(p => `<option value="${p.id}">${p.name} (${p.skill})</option>`).join("");
    });
    
    checkRepeatMatchup();
    customModal.classList.remove("hidden");
  });

  const checkRepeatMatchup = () => {
    const a1 = document.getElementById("custom-team-a1").value;
    const a2 = document.getElementById("custom-team-a2").value;
    const b1 = document.getElementById("custom-team-b1").value;
    const b2 = document.getElementById("custom-team-b2").value;
    
    const currentSet = [a1, a2, b1, b2].sort().join(",");
    const hasRepeat = state.matchLog.some(m => {
      if (!m.players || m.players.length !== 4) return false;
      return [...m.players].sort().join(",") === currentSet;
    });
    
    const warningEl = document.getElementById("repeat-matchup-warning");
    const selectedIds = [a1, a2, b1, b2];
    const hasFourPlayers = !selectedIds.includes("") && new Set(selectedIds).size === 4;
    const pairKey = (left, right) => [left, right].sort().join(",");
    const currentPairs = new Set([pairKey(a1, a2), pairKey(b1, b2)]);
    const hasRepeatPartner = state.matchLog.some((match) =>
      [match.teamA, match.teamB].some((team) => team?.length === 2 && currentPairs.has(pairKey(team[0], team[1])))
    );

    if (!hasFourPlayers) {
      warningEl.classList.add("hidden");
      return;
    }

    warningEl.classList.remove("hidden");
    if (hasRepeat || hasRepeatPartner) {
      warningEl.className = "flex items-center gap-1 text-xs text-rose-400 font-semibold bg-rose-500/10 px-2 py-1 rounded border border-rose-500/20";
      warningEl.textContent = hasRepeat ? "Repeat lineup detected" : "Repeat partner detected";
    } else {
      warningEl.className = "flex items-center gap-1 text-xs text-emerald-300 font-semibold bg-emerald-500/10 px-2 py-1 rounded border border-emerald-500/20";
      warningEl.textContent = "Fresh lineup · no repeats";
    }
  };

  ["custom-team-a1", "custom-team-a2", "custom-team-b1", "custom-team-b2"].forEach(selId => {
    document.getElementById(selId).addEventListener("change", checkRepeatMatchup);
  });

  document.getElementById("auto-balance-match")?.addEventListener("click", () => {
    const ids = [
      document.getElementById("custom-team-a1").value,
      document.getElementById("custom-team-a2").value,
      document.getElementById("custom-team-b1").value,
      document.getElementById("custom-team-b2").value
    ];
    if (ids.includes("")) {
      showToast("Please select 4 players first.", "error");
      return;
    }
    const unique = new Set(ids);
    if (unique.size !== 4) {
      showToast("Please select 4 distinct players.", "error");
      return;
    }
    const selected = ids.map(id => state.players.get(id));

    // Calculate power: rating * 100 + Win% (0-100)
    const getPower = (p) => {
      const skillVal = Number(p.rating || 2.0);
      let winPct = 0;
      let totalGames = (p.wins || 0) + (p.losses || 0);
      if (totalGames > 0) winPct = (p.wins || 0) / totalGames * 100;
      return (skillVal * 100) + winPct;
    };

    const sorted = [...selected].sort((a, b) => getPower(b) - getPower(a));
    // Strongest (0) + Weakest (3) vs Mid (1) + Mid (2)
    const teamA = [sorted[0], sorted[3]];
    const teamB = [sorted[1], sorted[2]];
    
    document.getElementById("custom-team-a1").value = teamA[0].id;
    document.getElementById("custom-team-a2").value = teamA[1].id;
    document.getElementById("custom-team-b1").value = teamB[0].id;
    document.getElementById("custom-team-b2").value = teamB[1].id;
    
    checkRepeatMatchup();
    showToast("Match auto-balanced based on skill and win %!");
  });

  closeCustomModal.addEventListener("click", () => {
    customModal.classList.add("hidden");
  });

  launchCustomBtn.addEventListener("click", async () => {
    const a1 = document.getElementById("custom-team-a1").value;
    const a2 = document.getElementById("custom-team-a2").value;
    const b1 = document.getElementById("custom-team-b1").value;
    const b2 = document.getElementById("custom-team-b2").value;
    
    const playersArr = [a1, a2, b1, b2];
    if (playersArr.includes("")) {
      showToast("Please select 4 players.", "error");
      return;
    }
    const unique = new Set(playersArr);
    if (unique.size !== 4) {
      showToast("Please assign 4 distinct players to the teams.", "error");
      return;
    }

    try {
      launchCustomBtn.disabled = true;
      launchCustomBtn.textContent = "Queueing...";
      const { queueCustomMatch } = await import("./courts.js");
      await queueCustomMatch(playersArr, [a1, a2], [b1, b2]);
      
      customModal.classList.add("hidden");
      showToast("Custom match queued successfully!");
    } catch (err) {
      console.error(err);
      showToast(err.message || "Failed to queue match", "error");
    } finally {
      launchCustomBtn.disabled = false;
      launchCustomBtn.textContent = "Queue Custom Match";
    }
  });

  // Winner modal buttons
  document.getElementById("winner-team-a-btn").addEventListener("click", () => confirmFinishMatch("teamA"));
  document.getElementById("winner-team-b-btn").addEventListener("click", () => confirmFinishMatch("teamB"));
  document.getElementById("winner-no-winner-btn").addEventListener("click", () => confirmFinishMatch(null));
  document.getElementById("winner-modal-close").addEventListener("click", () => {
    _pendingFinishCourtId = null;
    document.getElementById("winner-modal").classList.add("hidden");
  });

  const addToMatchModal = document.getElementById("add-to-match-modal");
  document.getElementById("close-add-to-match-modal")?.addEventListener("click", () => {
    addToMatchModal.classList.add("hidden");
    _pendingAddSlotInfo = null;
  });
  addToMatchModal?.addEventListener("click", (e) => {
    if (e.target === addToMatchModal) {
      addToMatchModal.classList.add("hidden");
      _pendingAddSlotInfo = null;
    }
  });

  // TV Share Modal logic
  const tvShareModal = document.getElementById("tv-share-modal");
  const openTvShareBtn = document.getElementById("open-tv-share-btn");
  const closeTvShareBtn = document.getElementById("close-tv-share-modal");
  const tvShareLink = document.getElementById("tv-share-link");
  const copyTvLinkBtn = document.getElementById("copy-tv-link-btn");

  // Sidebar toggle logic
  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  if (sidebar && sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      // Desktop only logic, bypass on mobile (which relies on offcanvas)
      if (window.innerWidth < 768) return;
      const texts = sidebar.querySelectorAll('.sidebar-text');
      if (sidebar.classList.contains('md:w-16')) {
        sidebar.classList.replace('md:w-16', 'md:w-64');
        texts.forEach(t => t.classList.replace('md:opacity-0', 'md:opacity-100'));
      } else {
        sidebar.classList.replace('md:w-64', 'md:w-16');
        texts.forEach(t => t.classList.replace('md:opacity-100', 'md:opacity-0'));
      }
    });
  }

  // Mobile Menu Logic
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  
  function toggleMobileMenu() {
    if (!sidebar || !sidebarOverlay) return;
    const isClosed = sidebar.classList.contains('-translate-x-full');
    if (isClosed) {
      sidebar.classList.remove('-translate-x-full');
      sidebarOverlay.classList.remove('hidden');
      setTimeout(() => sidebarOverlay.classList.remove('opacity-0'), 10);
    } else {
      sidebar.classList.add('-translate-x-full');
      sidebarOverlay.classList.add('opacity-0');
      setTimeout(() => sidebarOverlay.classList.add('hidden'), 300);
    }
  }

  if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', toggleMobileMenu);
  if (sidebarOverlay) sidebarOverlay.addEventListener('click', toggleMobileMenu);

  // Account settings: profile summary plus a private, per-account dashboard palette.
  const settingsModal = document.getElementById("settings-modal");
  const openSettingsBtn = document.getElementById("open-settings-btn");
  const closeSettingsBtn = document.getElementById("close-settings-modal");
  const closeSettingsModal = () => settingsModal?.classList.add("hidden");

  openSettingsBtn?.addEventListener("click", () => {
    settingsModal?.classList.remove("hidden");
    if (window.innerWidth < 768 && sidebar && !sidebar.classList.contains("-translate-x-full")) {
      toggleMobileMenu();
    }
  });
  closeSettingsBtn?.addEventListener("click", closeSettingsModal);
  settingsModal?.addEventListener("click", (event) => {
    if (event.target === settingsModal) closeSettingsModal();
  });

  const colorPickerTarget = document.getElementById("dashboard-color-picker");
  if (colorPickerTarget && window.Pickr) {
    const pickr = window.Pickr.create({
      el: colorPickerTarget,
      theme: "nano",
      default: activeDashboardColor,
      position: "top-middle",
      swatches: ["#1fcfb1", "#38bdf8", "#8b5cf6", "#d946ef", "#e85a1a", "#f5c42a"],
      components: { preview: true, opacity: false, hue: true, interaction: { hex: true, input: true, save: true, cancel: true } },
    });
    let savedColor = activeDashboardColor;
    const colorFromPickr = (color) => color ? normalizeDashboardColor(color.toHEXA().toString().slice(0, 7)) : savedColor;

    pickr.on("change", (color) => applyDashboardColor(colorFromPickr(color)));
    pickr.on("cancel", () => {
      applyDashboardColor(savedColor);
      pickr.setColor(savedColor, true);
    });
    pickr.on("save", async (color) => {
      const nextColor = colorFromPickr(color);
      savedColor = nextColor;
      applyDashboardColor(nextColor);
      pickr.hide();

      if (!activeSettingsUser) return;
      localStorage.setItem(dashboardThemeStorageKey(activeSettingsUser.uid), nextColor);
      try {
        await setDoc(
          doc(db, "users", activeSettingsUser.uid),
          { dashboardTheme: "custom", dashboardColor: nextColor, dashboardColorStart: null, dashboardColorEnd: null },
          { merge: true }
        );
        showToast("Dashboard color updated.");
      } catch (error) {
        console.warn("Dashboard color is stored on this device until it can sync", error);
        showToast("Dashboard color updated on this device.");
      }
    });

    document.getElementById("restore-original-design-btn")?.addEventListener("click", async () => {
      restoreOriginalDashboardDesign();
      savedColor = activeDashboardColor;
      // Do not call setColor here: Pickr can emit a change event for a programmatic
      // update, which would immediately reapply the old custom color.
      pickr.hide();

      if (!activeSettingsUser) return;
      localStorage.setItem(dashboardThemeStorageKey(activeSettingsUser.uid), "teal");
      try {
        await setDoc(
          doc(db, "users", activeSettingsUser.uid),
          { dashboardTheme: "teal", dashboardColor: null, dashboardColorStart: null, dashboardColorEnd: null },
          { merge: true }
        );
        showToast("Original dashboard design restored.");
      } catch (error) {
        console.warn("Original dashboard design is stored on this device until it can sync", error);
        showToast("Original dashboard design restored on this device.");
      }
    });
  }

  const tvQrcodeContainer = document.getElementById("tv-qrcode");
  let qrCodeInstance = null;

  openTvShareBtn?.addEventListener("click", async () => {
    try {
      const { auth } = await import("./firebase.js");
      if (!auth.currentUser) return;
      
      const baseUrl = window.location.href.substring(0, window.location.href.lastIndexOf('/'));
      const shareUrl = `${baseUrl}/tv.html?tenant=${auth.currentUser.uid}`;
      
      tvShareLink.value = shareUrl;
      
      // Generate QR Code
      tvQrcodeContainer.innerHTML = ""; // Clear existing
      qrCodeInstance = new QRCode(tvQrcodeContainer, {
        text: shareUrl,
        width: 200,
        height: 200,
        colorDark : "#0f3d3d",
        colorLight : "#ffffff",
        correctLevel : QRCode.CorrectLevel.H
      });
      
      tvShareModal.classList.remove("hidden");
    } catch (err) {
      console.error(err);
      showToast("Error generating share link.", "error");
    }
  });

  closeTvShareBtn?.addEventListener("click", () => {
    tvShareModal.classList.add("hidden");
  });

  copyTvLinkBtn?.addEventListener("click", () => {
    const linkInput = document.getElementById("tv-share-link");
    if (linkInput) {
      navigator.clipboard.writeText(linkInput.value).then(() => {
        showToast("Link copied to clipboard!");
      });
    }
  });

  // Ranking Modal Logic
  const viewRankingBtn = document.getElementById("view-ranking-btn");
  const headerTopPlayersBtn = document.getElementById("header-top-players-btn");
  const rankingModal = document.getElementById("ranking-modal");
  const closeRankingBtn = document.getElementById("close-ranking-modal");
  const rankingTbody = document.getElementById("ranking-tbody");

  // A perfect record from only a couple of games is not enough to pass a
  // player who has completed more matches. Games played is the first ranking
  // factor; points/win rate only settle players with equal experience.
  const comparePlayersByRanking = (a, b, usePoints = false) => {
    const aWins = a.wins || 0;
    const aGames = aWins + (a.losses || 0);
    const bWins = b.wins || 0;
    const bGames = bWins + (b.losses || 0);
    if (bGames !== aGames) return bGames - aGames;
    if (usePoints && (b.pointsDiff || 0) !== (a.pointsDiff || 0)) return (b.pointsDiff || 0) - (a.pointsDiff || 0);
    const aRate = aGames ? aWins / aGames : 0;
    const bRate = bGames ? bWins / bGames : 0;
    if (bRate !== aRate) return bRate - aRate;
    if (bWins !== aWins) return bWins - aWins;
    return String(a.name || "").localeCompare(String(b.name || ""));
  };

  const openBasicRankingModal = () => {
    if (!rankingModal || !rankingTbody) return;

    const allPlayers = Array.from(state.players.values()).filter(p => p.status !== "Archived" && ((p.wins || 0) + (p.losses || 0)) > 0);
    
    allPlayers.sort((a, b) => comparePlayersByRanking(a, b));

    rankingTbody.innerHTML = allPlayers.length > 0 ? allPlayers.map((player, idx) => {
      const gp = (player.wins || 0) + (player.losses || 0);
      const winPct = gp > 0 ? Math.round(((player.wins || 0) / gp) * 100) + '%' : '0%';
      let rankIcon = idx + 1;
      if (idx === 0) rankIcon = '🥇';
      else if (idx === 1) rankIcon = '🥈';
      else if (idx === 2) rankIcon = '🥉';

      return `
        <tr class="border-t border-slate-800/60 hover:bg-slate-800/20">
          <td class="py-3 px-4 text-center font-bold text-lg text-slate-300">${rankIcon}</td>
          <td class="py-3 px-4 font-semibold text-white">${player.name}</td>
          <td class="py-3 px-4 text-slate-400 text-xs">${ratingForPlayer(player)}</td>
          <td class="py-3 px-4 text-center text-purple-400 font-semibold">${gp}</td>
          <td class="py-3 px-4 text-center text-green-400 font-semibold">${player.wins || 0}</td>
          <td class="py-3 px-4 text-center text-red-400 font-semibold">${player.losses || 0}</td>
          <td class="py-3 px-4 text-center text-blue-400 font-semibold">${winPct}</td>
        </tr>
      `;
    }).join("") : `<tr><td colspan="7" class="py-6 text-center text-slate-500">No players with matches played yet.</td></tr>`;

    rankingModal.classList.remove("hidden");
    // Ensure mobile sidebar closes when opening modal
    if (window.innerWidth < 768 && window.toggleMobileMenu) window.toggleMobileMenu();
  };

  const rankingContent = document.getElementById("ranking-content");
  const rankingToggle = document.getElementById("ranking-scoring-toggle");
  const rankingTabOverall = document.getElementById("ranking-tab-overall");
  const rankingTabCategory = document.getElementById("ranking-tab-category");
  let currentRankingTab = "overall";

  const rankedPlayers = () => {
    const usePoints = scoringIsEnabled();
    return Array.from(state.players.values())
      .filter((player) => player.status !== "Archived" && ((player.wins || 0) + (player.losses || 0)) > 0)
      .sort((a, b) => comparePlayersByRanking(a, b, usePoints));
  };

  const rankingTable = (players, limit, compact = false) => {
    const usePoints = scoringIsEnabled();
    const rows = players.slice(0, limit);
    if (!rows.length) return `<p class="py-8 text-center text-sm text-slate-500">No completed matches yet.</p>`;

    const cell = compact ? "px-2 py-2 text-[10px]" : "px-3 py-2.5 text-xs md:text-sm";
    return `<div class="overflow-x-auto rounded-lg border border-slate-700/50 bg-slate-950/20">
      <table class="w-full whitespace-nowrap text-left">
        <thead class="border-b border-slate-700/50 bg-slate-800/80 text-[10px] uppercase tracking-wide text-slate-400">
          <tr>
            <th class="${cell} w-10 text-center">#</th><th class="${cell}">Player</th><th class="${cell}">Skill</th>
            <th class="${cell} text-center">Games</th><th class="${cell} text-center">Wins</th><th class="${cell} text-center">Losses</th>
            ${usePoints ? `<th class="${cell} text-center text-emerald-400">${compact ? "Pts" : "Pts Diff"}</th>` : ""}
            <th class="${cell} text-center text-cyan-300">Win Rate</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-800/70">
          ${rows.map((player, index) => {
            const games = (player.wins || 0) + (player.losses || 0);
            const winRate = games ? Math.round(((player.wins || 0) / games) * 100) : 0;
            const points = player.pointsDiff || 0;
            const rank = index === 0 ? "&#x1F451;" : index === 1 ? "&#x1F948;" : index === 2 ? "&#x1F949;" : index + 1;
            const pointsText = points > 0 ? `+${points}` : points;
            return `<tr class="transition-colors hover:bg-slate-800/40">
              <td class="${cell} text-center font-bold text-slate-300">${rank}</td>
              <td class="${cell} max-w-40 truncate font-semibold text-white" title="${player.name}">${player.name}</td>
              <td class="${cell} text-slate-400">${ratingForPlayer(player)}</td>
              <td class="${cell} text-center text-slate-300">${games}</td>
              <td class="${cell} text-center font-semibold text-emerald-400">${player.wins || 0}</td>
              <td class="${cell} text-center font-semibold text-rose-400">${player.losses || 0}</td>
              ${usePoints ? `<td class="${cell} text-center font-bold ${points >= 0 ? "text-emerald-400" : "text-rose-400"}">${pointsText}</td>` : ""}
              <td class="${cell} text-center font-bold text-cyan-300">${winRate}%</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
  };

  const renderRankingContent = () => {
    if (!rankingContent) return;
    const players = rankedPlayers();
    const activeTab = "w-36 rounded-full bg-purple-600 px-4 py-2 text-xs font-bold text-white shadow-lg transition-colors";
    const inactiveTab = "w-36 rounded-full px-4 py-2 text-xs font-bold text-slate-400 transition-colors hover:text-white";
    if (rankingTabOverall) rankingTabOverall.className = currentRankingTab === "overall" ? activeTab : inactiveTab;
    if (rankingTabCategory) rankingTabCategory.className = currentRankingTab === "category" ? activeTab : inactiveTab;

    if (currentRankingTab === "overall") {
      rankingContent.innerHTML = rankingTable(players, 10);
      return;
    }

    const cardTones = ["border-cyan-500/35 bg-cyan-500/5", "border-fuchsia-500/35 bg-fuchsia-500/5", "border-amber-500/35 bg-amber-500/5"];
    rankingContent.innerHTML = `<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">${SKILLS.map((skill, index) => {
      const categoryPlayers = players.filter((player) => skillKeyFromLabel(ratingForPlayer(player)) === skill.key);
      return `<section class="overflow-hidden rounded-xl border ${cardTones[index]}">
        <h3 class="border-b border-slate-700/50 bg-slate-800/70 px-4 py-3 text-xs font-bold uppercase tracking-wider text-white">${skill.label} <span class="ml-1 text-slate-400">${skill.rank}</span></h3>
        ${rankingTable(categoryPlayers, 3, true)}
      </section>`;
    }).join("")}</div>`;
  };

  const openRankingModal = () => {
    if (!rankingModal || !rankingContent) return;
    refreshScoringUI();
    renderRankingContent();
    rankingModal.classList.remove("hidden");
    if (window.innerWidth < 768 && window.toggleMobileMenu) window.toggleMobileMenu();
  };

  viewRankingBtn?.addEventListener("click", openRankingModal);
  headerTopPlayersBtn?.addEventListener("click", openRankingModal);
  rankingTabOverall?.addEventListener("click", () => {
    currentRankingTab = "overall";
    renderRankingContent();
  });
  rankingTabCategory?.addEventListener("click", () => {
    currentRankingTab = "category";
    renderRankingContent();
  });
  rankingToggle?.addEventListener("change", (event) => {
    setScoringEnabled(event.target.checked);
    renderRankingContent();
  });
  document.getElementById("toggle-scoring-btn")?.addEventListener("click", () => {
    setScoringEnabled(!scoringIsEnabled());
    if (!rankingModal?.classList.contains("hidden")) renderRankingContent();
  });
  refreshScoringUI();

  closeRankingBtn?.addEventListener("click", () => {
    rankingModal.classList.add("hidden");
  });
  
  rankingModal?.addEventListener("click", (e) => {
    if (e.target === rankingModal) rankingModal.classList.add("hidden");
  });

  // Archive Players Modal Logic
  const viewArchiveBtn = document.getElementById("view-archive-btn");
  const archiveModal = document.getElementById("archive-modal");
  const closeArchiveBtn = document.getElementById("close-archive-modal");
  const archiveDateInput = document.getElementById("archive-date-input");
  const clearArchiveDateBtn = document.getElementById("clear-archive-date-btn");
  const archiveTbody = document.getElementById("archive-tbody");

  function toYMD(dateStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "";
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function datesMatch(ymdStr, localStr) {
    if (!ymdStr || !localStr) return false;
    return toYMD(localStr) === ymdStr;
  }

  function renderArchiveModal() {
    if (archiveDateInput && !archiveDateInput.value) {
      archiveDateInput.value = toYMD(new Date());
    }
    
    const selectedYMD = archiveDateInput ? archiveDateInput.value : "";
    
    const archivedPlayers = Array.from(state.players.values()).filter(p => {
      if (p.status !== "Archived") return false;
      if (selectedYMD && !datesMatch(selectedYMD, p.archivedDate)) return false;
      return true;
    });

    if (archiveTbody) {
      archiveTbody.innerHTML = archivedPlayers.length > 0 ? archivedPlayers.map((player, idx) => `
        <tr class="border-t border-slate-800/60 hover:bg-slate-800/30 transition-colors">
          <td class="py-3 px-4 text-center text-slate-500 text-xs font-mono">${idx + 1}</td>
          <td class="py-3 px-4 font-semibold text-white">${player.name}</td>
          <td class="py-3 px-4">
            <span class="text-xs px-2 py-1 rounded border border-slate-700 bg-slate-800">${player.skill || "—"}</span>
          </td>
          <td class="py-3 px-4 text-center text-green-400 font-semibold">${player.wins || 0}</td>
          <td class="py-3 px-4 text-center text-red-400 font-semibold">${player.losses || 0}</td>
          <td class="py-3 px-4 text-slate-400 text-sm">${player.archivedDate || "—"}</td>
        </tr>
      `).join("") : `<tr><td colspan="6" class="py-6 text-center text-slate-500">No archived players found for this date.</td></tr>`;
    }
  }

  viewArchiveBtn?.addEventListener("click", () => {
    renderArchiveModal();
    archiveModal.classList.remove("hidden");
    if (window.innerWidth < 768 && typeof toggleMobileMenu === 'function') toggleMobileMenu();
  });

  closeArchiveBtn?.addEventListener("click", () => {
    archiveModal.classList.add("hidden");
  });

  archiveModal?.addEventListener("click", (e) => {
    if (e.target === archiveModal) archiveModal.classList.add("hidden");
  });

  archiveDateInput?.addEventListener("change", () => {
    renderArchiveModal();
  });
  
  clearArchiveDateBtn?.addEventListener("click", () => {
    if (archiveDateInput) archiveDateInput.value = "";
    renderArchiveModal();
  });

  // Interactive Tour Logic (Intro.js)
  const guideBtn = document.getElementById("guide-btn");
  
  window.openGuide = function() {
    try {
      if (window.__tourStarting) return;
      window.__tourStarting = true;

      if (window.__activeTour) {
        window.__activeTour.exit(true);
      }

      let delay = 10;
      if (window.innerWidth < 768 && typeof toggleMobileMenu === 'function') {
        const sidebar = document.getElementById("sidebar");
        if (sidebar && !sidebar.classList.contains("-translate-x-full")) {
          toggleMobileMenu();
          delay = 350; // Wait for the sidebar animation to finish
        }
      }
      
      setTimeout(() => {
        try {
          if (typeof introJs === 'undefined') {
            if (typeof showToast === 'function') showToast("Tour library not loaded yet.", "error");
            window.__tourStarting = false;
            return;
          }

          const isMobile = window.innerWidth < 768;
          const intro = introJs();

          const steps = [
        {
          title: 'Welcome to PicklQ! 🎉',
          intro: 'Let\'s take a quick interactive tour to see how to run your first session.'
        },
        {
          element: document.querySelector('#stats-container'),
          title: 'Dashboard Stats',
          intro: 'This top bar gives you a bird\'s-eye view of your session: total waiting players, active matches, available courts, and queue sizes.',
          position: 'bottom'
        },
        {
          element: document.querySelector('#lock-partners-btn'),
          title: 'Fixed Partners',
          intro: 'Use <b>Lock Partners</b> to choose two players who should stay on the same team whenever rounds are generated.',
          position: 'bottom'
        },
        {
          element: document.querySelector('#unlock-partners-btn'),
          title: 'Unlock One Pair',
          intro: 'Click <b>Unlock Partner</b> and select the pair to remove. Only that selected pairing is unlocked; every other fixed pair stays together.',
          position: 'bottom'
        }
      ];

      steps.push({
        element: document.querySelector('#open-saved-players-modal'),
        title: 'Saved Players',
        intro: 'Players you previously imported (but haven\'t queued yet) live here. Click <b>Add</b> next to a name to move them into the active Standby section.',
        position: 'bottom'
      });

      if (!isMobile) {
        steps.push(
          {
            element: document.querySelector('#import-players-btn'),
            title: 'Import Players',
            intro: 'Have a roster ready? Import players from a CSV/Excel file or paste a list from Reclub. Imported players are saved privately until you\'re ready to add them.',
            position: 'right'
          }
        );
      }

      steps.push(
        {
          element: document.querySelector('#courts-container'),
          title: 'Set Up Courts',
          intro: 'Click <b>+ Add Court</b> to create courts. You can restrict courts to a skill level (e.g., Beginner Only) or leave them open for all.',
          position: 'bottom'
        },
        {
          element: document.querySelector('#auto-assign-toggle') ? document.querySelector('#auto-assign-toggle').parentElement : null,
          title: 'Auto-Assign',
          intro: 'Turn this ON for a hands-free experience. The system automatically pulls 4 players from the queue and assigns them to any open court.',
          position: 'bottom'
        },
        {
          element: document.querySelector('#round-generator-panel'),
          title: 'Round Generator',
          intro: 'Prefer batch control? The Round Generator balances and queues matches for ALL waiting players at once based on skill and win history.',
          position: 'top'
        },
        {
          element: document.querySelector('#custom-match-panel'),
          title: 'Configure Match',
          intro: 'Need full control? Build custom matchups by hand — pick any 4 players from Waiting or Standby and send them to any court.',
          position: 'top'
        },
        {
          element: document.querySelector('#queues-container'),
          title: 'Manage Queues',
          intro: 'Pending matches appear here sorted by skill. Drag and drop rows to reprioritize who plays next.',
          position: 'top'
        },
        {
          element: document.querySelector('.queue-workspace .match-card-drag-handle, #queues-container .match-card-drag-handle, #queues-container .drag-handle, #queues-container'),
          title: 'Drag Players & Match Cards',
          intro: `
            <p>Drag from the marked handle—on touch devices, press and hold it first.</p>
            <div class="tour-drag-demo" aria-label="Animated example of dragging a player and a match card">
              <div class="tour-drag-demo__label">Player order</div>
              <div class="tour-drag-demo__lane">
                <div class="tour-drag-demo__card tour-drag-demo__card--player"><span class="tour-drag-demo__grip">⋮⋮</span> Player card</div>
                <span class="tour-drag-demo__target">Drop here</span>
                <div class="tour-drag-demo__ghost tour-drag-demo__ghost--player"><span>⋮⋮</span> Player</div>
              </div>
              <div class="tour-drag-demo__label">Upcoming matches</div>
              <div class="tour-drag-demo__lane">
                <div class="tour-drag-demo__card tour-drag-demo__card--match"><span class="tour-drag-demo__grip">⠿</span> Match card header</div>
                <span class="tour-drag-demo__target">New position</span>
                <div class="tour-drag-demo__ghost tour-drag-demo__ghost--match"><span>⠿</span> Match</div>
              </div>
            </div>
            <p class="tour-drag-demo__hint">Grab <b>⋮⋮</b> beside a player to reorder or move them. Grab a <b>match card header</b> to reorder upcoming matches.</p>`,
          position: 'top'
        }
      );

      if (isMobile) {
        steps.push({
          element: document.querySelector('#mobile-menu-btn'),
          title: 'Menu & TV Display',
          intro: 'Open this menu to access the Match Log, Rankings, and the TV Display for a big-screen court view.',
          position: 'bottom'
        });
      } else {
        steps.push({
          element: document.querySelector('#view-tv-btn'),
          title: 'TV Display & Sharing',
          intro: 'Click here to open a TV-friendly view of live courts and the leaderboard. Share the QR code so players can follow along on their phones!',
          position: 'right'
        });
      }

      steps.push(
        {
          element: document.querySelector('.done-playing-section') || document.querySelector('#done-players-container'),
          title: 'Done Playing',
          intro: 'Players who have finished their match appear in this section. Use <b>Return</b> to put them back in queue, or <b>Done Playing</b> to move them to Standby.',
          position: 'top'
        },
        {
          element: document.querySelector('#header-end-session-btn'),
          title: 'End Session',
          intro: 'When the session is over, click <b>End Session</b>. It clears all queues and courts but safely saves everyone\'s stats for the next session!',
          position: 'bottom'
        }
      );

      // Strictly filter out any steps where the target element was requested but is null or hidden
      const validSteps = steps.filter(step => {
        if (!step.element) return true; // Steps without specific elements are fine
        if (!document.body.contains(step.element)) return false; // Must be in DOM
        
        // Skip elements that are invisible (e.g. hidden on this screen size)
        if (step.element.offsetWidth === 0 && step.element.offsetHeight === 0) {
          return false;
        }
        
        return true;
      });

      intro.setOptions({
        steps: validSteps,
        showProgress: true,
        showBullets: false,
        tooltipClass: 'custom-intro-tooltip',
        highlightClass: 'custom-intro-highlight',
        exitOnOverlayClick: true,
        disableInteraction: true,
        nextLabel: 'Next →',
        prevLabel: '← Back',
        doneLabel: 'Got it! 🚀',
        scrollPadding: 80
      });
      
      intro.onexit(() => { window.__activeTour = null; });
      intro.oncomplete(() => { window.__activeTour = null; });
      
      window.__activeTour = intro;
      intro.start();
      window.__tourStarting = false;
        } catch (innerErr) {
          window.__tourStarting = false;
          console.error("Tour error:", innerErr);
          if (typeof showToast === 'function') {
            showToast("Error starting tour: " + innerErr.message, "error");
          }
        }
      }, delay);
    } catch (err) {
      window.__tourStarting = false;
      console.error("Tour wrapper error:", err);
    }
  };

  guideBtn?.addEventListener("click", window.openGuide);
}

async function bootstrap() {
  if (window.location.protocol === "file:") {
    showToast("Open this page with a local server (not file://)", "error");
  }

  window.addEventListener("unhandledrejection", (event) => {
    // Browser extensions can inject promises into the page. MetaMask's
    // session-restoration failure is not a dashboard/Firebase failure, so do
    // not surface it as an application toast.
    const reason = event.reason;
    const extensionMessage = [reason?.message, reason?.cause?.message, String(reason || "")]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (extensionMessage.includes("metamask") || extensionMessage.includes("extension not found")) {
      event.preventDefault();
      return;
    }
    console.error("Unhandled promise rejection", event.reason);
    showToast(formatFirebaseError(event.reason), "error");
  });

  bindEvents();
  bindMatchLogEvents();
  startTimerLoop();

  loadCachedState();
  renderQueues();
  renderCourts();
  renderPlayers();
  renderStats();

  try {
    await ensureQueuesExist();
  } catch (error) {
    console.error("Ensure queues failed", error);
    showToast(formatFirebaseError(error), "error");
  }

  try {
    await ensureCourtsExist();
  } catch (error) {
    console.error("Ensure courts failed", error);
    showToast(formatFirebaseError(error), "error");
  }

  function checkAutoAssign() {
    const toggle = document.getElementById("auto-assign-toggle");
    if (toggle && toggle.checked) {
      maybeAutoAssignMatches();
    }
  }

  // ── Auto Round: keeps a short queue of upcoming matches ready ───────────
  async function checkAutoRound() {
    if (!state.autoRound) return;
    if (state.autoRoundLock) return;
    if (!state.ready.players || !state.ready.queues) return;

    // Once three or fewer cards remain, append fresh matches without moving
    // the cards already waiting in the queue.
    const queuedOrders = Object.values(state.queues);
    const pendingMatches = queuedOrders.reduce((total, order) => {
      const queuedPlayers = order.filter((id) => id && id !== "EMPTY").length;
      return total + Math.ceil(queuedPlayers / 4);
    }, 0);
    if (pendingMatches > 3) return;

    const queuedPlayerIds = new Set(queuedOrders.flat().filter((id) => id && id !== "EMPTY"));
    const gameLimit = getGameLimit();
    const hasUnqueuedPlayers = Array.from(state.players.values()).some((player) =>
      !queuedPlayerIds.has(player.id) &&
      (player.status === "Waiting" || player.status === "Standby" || player.status === "Playing") &&
      (!gameLimit || ((player.wins || 0) + (player.losses || 0) + (player.status === "Playing" ? 1 : 0)) < gameLimit)
    );
    if (!hasUnqueuedPlayers) return;

    state.autoRoundLock = true;
    try {
      // A match completion updates the court and its players in the same
      // Firestore write, but their listeners can arrive separately. Wait for
      // the player snapshot so the just-finished players are eligible for the
      // new round instead of still looking like they are on court.
      await new Promise((resolve) => setTimeout(resolve, 350));

      const players = Array.from(state.players.values());
      const mode = state.autoRoundMode || "smart";
      const history = [
        ...state.matchLog,
        ...state.courts.filter((court) => court.status === "Active").map((court) => ({
          players: court.players || [],
          teamA: (court.players || []).slice(0, 2),
          teamB: (court.players || []).slice(2, 4),
        })),
      ];
      const summary = await generateSmartRound(players, mode, history, {
        preserveExisting: true,
        lockPartners: true,
      });
      const repeatCount = summary.repeatLineups + summary.repeatTeammates + summary.repeatOpponents;
      showToast(
        repeatCount
          ? "Smart auto rotation: " + summary.matches + " matches, " + repeatCount + " repeat warning(s)."
          : "Smart auto rotation ready: " + summary.matches + " balanced matches with no repeats.",
        repeatCount ? "warning" : "info"
      );

      // Let auto-assign pick it up naturally
      setTimeout(() => checkAutoAssign(), 500);
    } catch (err) {
      console.warn("Auto round skipped:", err.message);
    } finally {
      state.autoRoundLock = false;
    }
  }

  window.requestAutoQueueTopUp = checkAutoRound;

  listenToQueues((queues) => {
    state.queues = queues;
    state.ready.queues = true;
    renderQueues();
    renderStats();
    renderNextMatch();
    setupSortable();
    cacheState();
    checkAutoAssign();
    checkAutoRound();
  });

  listenToCourts((courts) => {
    state.courts = courts;
    state.ready.courts = true;

    renderCourts();
    renderStats();
    renderNextMatch();
    cacheState();
    checkAutoAssign();

    checkAutoRound();
  });

  listenToPlayers((players) => {
    state.players = new Map(players.map((player) => [player.id, player]));
    
    // Dynamically rebuild player filter with archive dates
    const archiveDates = new Set();
    players.forEach(p => {
      if (p.status === "Archived") {
        // Prefer the dedicated archivedDate string field; fallback to updatedAt parsing
        if (p.archivedDate) {
          archiveDates.add(p.archivedDate);
        } else if (p.updatedAt) {
          let dateObj;
          if (typeof p.updatedAt.toDate === 'function') dateObj = p.updatedAt.toDate();
          else if (p.updatedAt.seconds) dateObj = new Date(p.updatedAt.seconds * 1000);
          else dateObj = new Date(p.updatedAt);
          if (!isNaN(dateObj.getTime())) {
            archiveDates.add(dateObj.toLocaleDateString());
          }
        }
      }
    });

    const filterEl = elements.filterSelect;
    if (filterEl) {
      const currentVal = filterEl.value;
      const staticOptions = `
        <option value="All">All ratings</option>
        ${RATINGS.map((rating) => `<option value="${rating.label}">${rating.label}</option>`).join("")}
      `;
      let archiveOptions = `<option value="Archived">All Archived</option>`;
      Array.from(archiveDates).sort((a, b) => new Date(b) - new Date(a)).forEach(dateStr => {
        archiveOptions += `<option value="Archived:${dateStr}">Archived: ${dateStr}</option>`;
      });
      filterEl.innerHTML = staticOptions + archiveOptions;
      
      if (Array.from(filterEl.options).some(o => o.value === currentVal)) {
        filterEl.value = currentVal;
      } else {
        filterEl.value = "All";
        state.filter = "All";
      }
    }

    state.ready.players = true;
    try {
      renderPlayers();
      renderQueues();
      renderCourts();
      renderStats();
      renderPendingMatches();
      renderNextMatch();
      renderMatchLog();
      cacheState();
      
      const toggle = document.getElementById("auto-assign-toggle");
      if (toggle && toggle.checked) {
        maybeAutoAssignMatches();
      }
      
      const errDiv = document.getElementById("debug-error");
      if (errDiv) errDiv.remove();
    } catch (err) {
      console.error("Render error:", err);
      let errDiv = document.getElementById("debug-error");
      if (!errDiv) {
        errDiv = document.createElement("div");
        errDiv.id = "debug-error";
        errDiv.style = "position: fixed; top: 10px; left: 10px; right: 10px; z-index: 9999; background: red; color: white; padding: 20px; border-radius: 8px; font-family: monospace; white-space: pre-wrap; overflow-y: auto; max-height: 50vh;";
        document.body.appendChild(errDiv);
      }
      errDiv.textContent = "FATAL ERROR IN RENDER: " + err.message + "\n" + err.stack;
    }
    checkAutoRound();
  });

  const q = query(getTenantCollection("matches"), where("status", "==", "Pending"));
  onSnapshot(q, (snapshot) => {
    const docs = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    docs.sort((a, b) => {
      const t1 = a.createdAt?.seconds || 0;
      const t2 = b.createdAt?.seconds || 0;
      return t1 - t2;
    });
    state.pendingMatches = docs;
    state.ready.pendingMatches = true;
    renderPendingMatches();
    renderNextMatch();
    
    const toggle = document.getElementById("auto-assign-toggle");
    if (toggle && toggle.checked) {
      maybeAutoAssignMatches();
    }
  }, (error) => {
    console.error("Pending matches listener error:", error);
  });

  // Real-time listeners for match log (Completed + Archived)
  // Two separate listeners merged client-side (Firestore doesn't support OR queries here)
  const matchLogCache = { completed: [], archived: [] };
  const mergeMatchLog = () => {
    const all = [...matchLogCache.completed, ...matchLogCache.archived];
    all.sort((a, b) => (b.endedAt?.seconds || 0) - (a.endedAt?.seconds || 0));
    state.matchLog = all.slice(0, 200);
    renderMatchLog();
    // Rotation labels are based on completed-match history, so refresh the
    // visible cards as soon as that history changes.
    if (state.ready.players && state.ready.queues) {
      renderQueues();
      renderPendingMatches();
      renderNextMatch();
    }
  };

  onSnapshot(query(getTenantCollection("matches"), where("status", "==", "Completed")), (snap) => {
    matchLogCache.completed = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    mergeMatchLog();
  }, (err) => console.error("Match log (Completed) error:", err));

  onSnapshot(query(getTenantCollection("matches"), where("status", "==", "Archived")), (snap) => {
    matchLogCache.archived = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    mergeMatchLog();
  }, (err) => console.error("Match log (Archived) error:", err));
}

function renderPendingMatches() {
  const container = document.getElementById("pending-matches-container");
  if (!container) return;

  if (state.pendingMatches.length === 0) {
    container.innerHTML = "";
    return;
  }

  const cardsHtml = state.pendingMatches.map((match, index) => {
    const rotation = rotationInsight(match.teamA || [], match.teamB || []);
    const buildTeamHtml = (teamIds) => {
      return teamIds.map(id => {
        const p = state.players.get(id);
        const name = p ? p.name : "Unknown";
        const lastResult = p?.lastResult;
        const resultBadge = lastResult === "Win"
          ? `<span class="text-[9px] font-bold text-green-400 bg-green-400/10 px-1 rounded">W</span>`
          : lastResult === "Loss"
          ? `<span class="text-[9px] font-bold text-red-400 bg-red-400/10 px-1 rounded">L</span>`
          : "";
          
        return `
          <li class="bg-slate-800 border border-slate-600/50 p-1 rounded flex items-center gap-1 overflow-hidden">
            <span class="font-semibold text-[11px] truncate max-w-[70px] sm:max-w-[90px]" title="${name}">${name}</span>
            <span class="text-[9px] font-bold text-cyan-300 bg-cyan-400/10 border border-cyan-400/20 px-1 rounded shrink-0">${ratingForPlayer(p)}</span>
            ${resultBadge}
          </li>
        `;
      }).join("");
    };

    return `
      <div class="match-card rounded-xl p-2 sm:p-3 border border-amber-500/50 bg-amber-500/10 shadow-lg shadow-amber-500/5">
        <div class="flex items-center justify-between mb-2 border-b border-amber-500/30 pb-1.5">
          <h4 class="text-[10px] uppercase tracking-wider font-bold text-amber-400">Custom Match ${index + 1}</h4>
          <span class="text-[10px] font-semibold text-amber-500">Priority</span>
          <span class="text-[9px] font-semibold ${rotation.tone}">${rotation.label}</span>
        </div>
        
        <div class="grid grid-cols-[1fr_auto_1fr] gap-2 items-stretch">
          <div class="bg-slate-900/60 rounded-lg border border-slate-700/50 p-1.5">
             <div class="text-[9px] text-slate-500 font-bold uppercase mb-1 text-center">Team A</div>
             <ul class="space-y-1 min-h-[32px]">
               ${buildTeamHtml(match.teamA || [])}
             </ul>
          </div>
          
          <div class="flex items-center justify-center px-1">
            <span class="text-[9px] font-bold text-amber-500/80 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">VS</span>
          </div>
          
          <div class="bg-slate-900/60 rounded-lg border border-slate-700/50 p-1.5">
             <div class="text-[9px] text-slate-500 font-bold uppercase mb-1 text-center">Team B</div>
             <ul class="space-y-1 min-h-[32px]">
               ${buildTeamHtml(match.teamB || [])}
             </ul>
          </div>
        </div>
      </div>
    `;
  }).join("");

  container.innerHTML = `
    <div class="mb-6">
      <h3 class="text-xs uppercase tracking-widest font-bold text-amber-500 mb-3">Pending Custom Matches</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
        ${cardsHtml}
      </div>
    </div>
  `;
}

function renderNextMatch() {
  const container = document.getElementById("next-match-card");
  if (!container) return;

  const availableCourts = state.courts.filter(c => c.status === "Available");
  const courtReady = availableCourts.length > 0;

  // Calculate how many active courts per skill
  const activeTally = {};
  state.courts.forEach(c => {
    if (c.status === "Active" && c.skill) {
      activeTally[c.skill] = (activeTally[c.skill] || 0) + 1;
    }
  });

  // Check pending custom matches first
  if (state.pendingMatches.length > 0) {
    const match = state.pendingMatches[0];
    const teamA = match.teamA || [];
    const teamB = match.teamB || [];
    container.innerHTML = buildNextMatchHTML(teamA, teamB, "Custom", "Stacked", courtReady);
    return;
  }

  // Find which skill queue is "up next" using same priority logic as auto-assign
  const queueOptions = SKILLS.map(skill => ({
    key: skill.key,
    label: skill.label,
    players: state.queues[skill.key] || [],
  })).filter(q => q.players.length >= 4);

  let chosen = null;
  const globalGrid = document.getElementById("global-match-grid");
  if (globalGrid && globalGrid.children.length > 0) {
    const firstCard = globalGrid.children[0];
    const skillKey = firstCard.dataset.skillKey;
    const players = state.queues[skillKey] || [];
    if (players.filter(id => id !== "EMPTY").length >= 4) {
      chosen = {
        key: skillKey,
        label: SKILLS.find(s => s.key === skillKey)?.label || "Unknown",
        players: players
      };
    }
  }

  if (!chosen) {
    if (!queueOptions.length) {
      container.innerHTML = "";
      return;
    }
    queueOptions.sort((a, b) => {
      const aActive = activeTally[a.label] || 0;
      const bActive = activeTally[b.label] || 0;
      if (aActive !== bActive) return aActive - bActive;
      return b.players.length - a.players.length;
    });
    chosen = queueOptions[0];
  }

  // Exclude players who are currently playing on an active court
  const activePlayers = new Set(
    state.courts
      .filter(c => c.status === "Active")
      .flatMap(c => c.players || [])
  );
  const availablePlayers = chosen.players.filter(id => !activePlayers.has(id));
  const nextIds = (availablePlayers.length >= 4
    ? availablePlayers
    : chosen.players
  ).slice(0, 4);

  if (nextIds.length < 4) {
    container.innerHTML = "";
    return;
  }
  const { teamA, teamB } = buildPreviewTeams(nextIds);

  container.innerHTML = buildNextMatchHTML(teamA, teamB, chosen.label, "Auto", courtReady);
}

function buildPreviewTeams(playerIds) {
  if (!Array.isArray(playerIds) || playerIds.length < 4) {
    return { teamA: [], teamB: [] };
  }

  const pairKey = (a, b) => [a, b].sort().join("|");
  const p = playerIds.slice(0, 4).map((id) => {
    const info = state.players.get(id) || {};
    return {
      id,
      lastResult: info.lastResult || null,
      playedWith: info.playedWith || {},
    };
  });

  const referenceCourts = state.courts.filter((c) => c.status === "Available");
  const courtsToRead = referenceCourts.length ? referenceCourts : state.courts;
  const lastTeammatePairs = new Set();
  courtsToRead.forEach((court) => {
    (court.lastTeamPairs || []).forEach((key) => lastTeammatePairs.add(key));
  });

  const combos = [
    { a: [p[0], p[1]], b: [p[2], p[3]] },
    { a: [p[0], p[2]], b: [p[1], p[3]] },
    { a: [p[0], p[3]], b: [p[1], p[2]] },
  ];

  const getOverlap = (x, y) => (x.playedWith[y.id] || 0) + (y.playedWith[x.id] || 0);
  const sameResultScore = (pair) => {
    if (!pair[0].lastResult || !pair[1].lastResult) return 0;
    return pair[0].lastResult === pair[1].lastResult ? 50 : -50;
  };

  let best = combos[0];
  let minScore = Infinity;
  for (const combo of combos) {
    const aBlocked = lastTeammatePairs.has(pairKey(combo.a[0].id, combo.a[1].id));
    const bBlocked = lastTeammatePairs.has(pairKey(combo.b[0].id, combo.b[1].id));

    let score = getOverlap(combo.a[0], combo.a[1]) + getOverlap(combo.b[0], combo.b[1]);
    if (aBlocked) score += 1000;
    if (bBlocked) score += 1000;
    score += sameResultScore(combo.a) + sameResultScore(combo.b);

    if (score < minScore) {
      minScore = score;
      best = combo;
    }
  }

  return {
    teamA: [best.a[0].id, best.a[1].id],
    teamB: [best.b[0].id, best.b[1].id],
  };
}

function buildNextMatchHTML(teamAIds, teamBIds, skillLabel, type, courtReady) {
  const nameFor = id => state.players.get(id)?.name || "Unknown";
  const rotation = rotationInsight(teamAIds, teamBIds);

  const skillColorClass = {
    Beginner: "text-cyan-400",
    Intermediate: "text-amber-400",
    Advanced: "text-rose-400",
    Custom: "text-purple-400",
  }[skillLabel] || "text-slate-300";

  const typeTag = type === "Auto"
    ? `<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">Auto</span>`
    : `<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-purple-500/20 text-purple-300 border border-purple-500/40">Custom</span>`;

  const courtTag = courtReady
    ? `<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-green-500/20 text-green-300 border border-green-500/40 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-green-400 inline-block animate-pulse"></span>Court Ready</span>`
    : `<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-yellow-500/20 text-yellow-300 border border-yellow-500/40">Waiting for Court</span>`;

  const playerRow = (id) => {
    const p = state.players.get(id);
    if (!p) return `<div class="flex items-center gap-2 py-1.5 text-slate-500 italic text-sm">Unknown player</div>`;
    const wins = p.wins || 0;
    const losses = p.losses || 0;
    const wBadge = `<span class="text-xs font-bold text-green-400">${wins}W</span>`;
    const lBadge = `<span class="text-xs font-bold text-red-400">${losses}L</span>`;
    return `
      <div class="flex items-center justify-between py-1.5 border-b border-slate-700/50 last:border-0">
        <span class="font-semibold text-slate-100">${p.name}</span>
        <span class="text-[10px] font-bold text-cyan-300 bg-cyan-400/10 border border-cyan-400/20 px-1.5 py-0.5 rounded">${ratingForPlayer(p)}</span>
        <div class="flex items-center gap-2">
          ${wBadge} ${lBadge}
        </div>
      </div>`;
  };

  return `
    <div class="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-xs uppercase tracking-widest font-bold text-emerald-400">Next Match</span>
        ${typeTag}
        <span class="px-2 py-0.5 rounded-full text-xs font-bold border border-slate-600 ${skillColorClass}">${skillLabel}</span>
        <span class="px-2 py-0.5 rounded-full text-xs font-bold border border-slate-600 ${rotation.tone}">${rotation.label}</span>
        ${courtTag}
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="rounded-lg bg-cyan-500/10 border border-cyan-500/25 p-3">
          <p class="text-xs uppercase tracking-widest text-cyan-400 font-bold mb-2">Team A</p>
          ${teamAIds.map(playerRow).join("")}
        </div>
        <div class="rounded-lg bg-rose-500/10 border border-rose-500/25 p-3">
          <p class="text-xs uppercase tracking-widest text-rose-400 font-bold mb-2">Team B</p>
          ${teamBIds.map(playerRow).join("")}
        </div>
      </div>
    </div>`;
}

// ── Match Log helpers ──────────────────────────────────────────────────────
const MATCH_LOG_PAGE_SIZE = 10;

async function archiveMatch(matchId) {
  const { doc, setDoc, serverTimestamp } = await import("./firebase.js");
  const matchRef = getTenantDoc("matches", matchId);
  await setDoc(matchRef, { status: "Archived", updatedAt: serverTimestamp() }, { merge: true });
}

async function archiveAllMatchLog() {
  const logs = state.matchLog || [];
  const visible = state.matchLogShowArchived ? logs : logs.filter(m => m.status !== "Archived");
  if (!visible.length) return;
  if (!(await showConfirmModal(`Archive all ${visible.length} visible matches? They will be hidden from the log.`))) return;
  try {
    await Promise.all(visible.map(m => archiveMatch(m.id)));
    showToast("All visible matches archived.");
  } catch (err) {
    showToast(formatFirebaseError(err), "error");
  }
}

function renderMatchLog() {
  const tbody = document.getElementById("match-log-body");
  const countEl = document.getElementById("match-log-count");
  const paginationEl = document.getElementById("match-log-pagination");
  const pageInfoEl = document.getElementById("match-log-page-info");
  const prevBtn = document.getElementById("match-log-prev");
  const nextBtn = document.getElementById("match-log-next");
  if (!tbody) return;

  const showArchived = state.matchLogShowArchived || false;
  const allLogs = state.matchLog || [];
  const logs = showArchived ? allLogs : allLogs.filter(m => m.status !== "Archived");

  const totalPages = Math.max(1, Math.ceil(logs.length / MATCH_LOG_PAGE_SIZE));
  // Clamp page
  if (state.matchLogPage === undefined) state.matchLogPage = 0;
  state.matchLogPage = Math.min(state.matchLogPage, totalPages - 1);

  const page = state.matchLogPage;
  const pageSlice = logs.slice(page * MATCH_LOG_PAGE_SIZE, (page + 1) * MATCH_LOG_PAGE_SIZE);

  if (countEl) {
    const archivedCount = allLogs.filter(m => m.status === "Archived").length;
    countEl.textContent = `${logs.length} match${logs.length !== 1 ? "es" : ""}${archivedCount ? ` · ${archivedCount} archived` : ""}`;
  }

  // Pagination controls
  if (logs.length > MATCH_LOG_PAGE_SIZE) {
    paginationEl?.classList.remove("hidden");
    if (pageInfoEl) pageInfoEl.textContent = `Page ${page + 1} of ${totalPages}`;
    if (prevBtn) prevBtn.disabled = page === 0;
    if (nextBtn) nextBtn.disabled = page >= totalPages - 1;
  } else {
    paginationEl?.classList.add("hidden");
  }

  if (!pageSlice.length) {
    tbody.innerHTML = `<tr><td class="py-6 text-slate-500 text-center" colspan="8">${showArchived ? "No matches in archive." : "No completed matches yet."}</td></tr>`;
    return;
  }

  const nameFor = (id) => (!id ? "—" : state.players.get(id)?.name || "Unknown");

  const formatTime = (ts) => {
    if (!ts) return "—";
    let date;
    if (typeof ts.toDate === "function") date = ts.toDate();
    else if (ts.seconds !== undefined) date = new Date(ts.seconds * 1000);
    else date = new Date(ts);
    if (isNaN(date.getTime())) return "—";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const formatDuration = (startTs, endTs) => {
    if (!startTs || !endTs) return "—";
    let start, end;
    if (typeof startTs.toDate === "function") start = startTs.toDate();
    else if (startTs.seconds !== undefined) start = new Date(startTs.seconds * 1000);
    else start = new Date(startTs);
    if (typeof endTs.toDate === "function") end = endTs.toDate();
    else if (endTs.seconds !== undefined) end = new Date(endTs.seconds * 1000);
    else end = new Date(endTs);
    const diffMs = Math.max(0, end - start);
    const mins = Math.floor(diffMs / 60000);
    const secs = Math.floor((diffMs % 60000) / 1000);
    return `${mins}m ${secs}s`;
  };

  const courtLabel = (courtId) => (!courtId ? "—" : courtId.replace("court-", "Court "));

  tbody.innerHTML = pageSlice.map((match) => {
    const teamA = (match.teamA || []).map(nameFor).join(" & ") || "—";
    const teamB = (match.teamB || []).map(nameFor).join(" & ") || "—";
    const winner = match.winner;
    const isArchived = match.status === "Archived";

    let winnerBadge;
    if (winner === "teamA") {
      winnerBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">🏆 Team A</span>`;
    } else if (winner === "teamB") {
      winnerBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/40">🏆 Team B</span>`;
    } else {
      winnerBadge = `<span class="text-slate-500 text-xs">No result</span>`;
    }

    const skillColor = { Beginner: "text-cyan-400", Intermediate: "text-amber-400", Advanced: "text-rose-400" }[match.skill] || "text-slate-400";

    const archiveBtn = isArchived
      ? `<span class="text-xs text-slate-600 italic">Archived</span>`
      : `<button class="text-xs text-slate-400 hover:text-rose-400 transition-colors border border-slate-700 hover:border-rose-500/50 rounded-lg px-2 py-1" data-archive-match="${match.id}">Archive</button>`;

    return `
      <tr class="border-t border-slate-800/60 hover:bg-slate-800/30 transition-colors ${isArchived ? "opacity-40" : ""}">
        <td class="py-3 px-4 text-slate-400">${formatTime(match.endedAt)}</td>
        <td class="px-4 font-semibold">${courtLabel(match.courtId)}</td>
        <td class="px-4 ${skillColor}">${match.skill || "—"}</td>
        <td class="px-4 ${winner === "teamA" ? "text-cyan-300 font-semibold" : "text-slate-300"}">${teamA}</td>
        <td class="px-4 ${winner === "teamB" ? "text-rose-300 font-semibold" : "text-slate-300"}">${teamB}</td>
        <td class="px-4">${winnerBadge}</td>
        <td class="px-4 text-slate-400">${formatDuration(match.startedAt, match.endedAt)}</td>
        <td class="px-4 text-right">${archiveBtn}</td>
      </tr>
    `;
  }).join("");
}

function bindMatchLogEvents() {
  // Pagination
  document.getElementById("match-log-prev")?.addEventListener("click", () => {
    if (state.matchLogPage > 0) { state.matchLogPage--; renderMatchLog(); }
  });
  document.getElementById("match-log-next")?.addEventListener("click", () => {
    const totalPages = Math.ceil((state.matchLog || []).length / MATCH_LOG_PAGE_SIZE);
    if (state.matchLogPage < totalPages - 1) { state.matchLogPage++; renderMatchLog(); }
  });

  // Toggle archived view
  const toggleBtn = document.getElementById("match-log-toggle-archived");
  toggleBtn?.addEventListener("click", () => {
    state.matchLogShowArchived = !state.matchLogShowArchived;
    state.matchLogPage = 0;
    toggleBtn.textContent = state.matchLogShowArchived ? "Hide Archived" : "Show Archived";
    toggleBtn.style.color = state.matchLogShowArchived ? "#fbbf24" : "";
    toggleBtn.style.borderColor = state.matchLogShowArchived ? "rgba(251,191,36,0.4)" : "";
    renderMatchLog();
  });

  // Archive all
  document.getElementById("match-log-archive-all")?.addEventListener("click", archiveAllMatchLog);

  // Per-row archive (delegated)
  document.getElementById("match-log-body")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-archive-match]");
    if (!btn) return;
    const matchId = btn.dataset.archiveMatch;
    btn.disabled = true;
    btn.textContent = "...";
    try {
      await archiveMatch(matchId);
      showToast("Match archived.");
    } catch (err) {
      showToast(formatFirebaseError(err), "error");
      btn.disabled = false;
      btn.textContent = "Archive";
    }
  });
}

// Protect the route
onAuthStateChanged(auth, async (user) => {
  // Dismiss splash screen smoothly once auth is resolved
  const splash = document.getElementById('splash-screen');
  if (splash && !splash.classList.contains('splash-skip')) {
    // Ensure the splash shows for a minimum time so entrance animations play
    const minDisplayMs = 800;
    const splashStart = window.__splashStart || Date.now();
    const elapsed = Date.now() - splashStart;
    const delay = Math.max(0, minDisplayMs - elapsed);

    setTimeout(() => {
      splash.classList.add('splash-hidden');
      splash.style.pointerEvents = 'none'; // Ensure it doesn't block clicks
      splash.addEventListener('transitionend', () => splash.remove(), { once: true });
      setTimeout(() => { if(document.body.contains(splash)) splash.remove(); }, 1000); // safety fallback
      sessionStorage.setItem('dq_splash_shown', 'true');
    }, delay);
  } else if (splash) {
    splash.remove();
    sessionStorage.setItem('dq_splash_shown', 'true');
  }

  if (!user) {
    window.location.href = 'login.html';
    return;
  }
  
  let profileData = {};
  try {
    // Account profiles live at users/{userId}; tenant collections (courts,
    // queues, etc.) live below that document.  Do not look for the profile in
    // the users subcollection, or its club setting will never be found.
    const userDocRef = doc(db, 'users', user.uid);
    const userDoc = await getDoc(userDocRef);
    profileData = userDoc.exists() ? userDoc.data() : {};
    if (profileData.role === 'admin') {
      window.location.href = 'admin.html';
      return;
    }

    // Always reset an unknown/missing club to Deuce so a prior Longos login
    // cannot leave its branding on this account's dashboard.
    const userClub = profileData.club || 'deuce';
    localStorage.setItem('dq_club_preference', userClub);
    applyClubBranding(userClub);
  } catch (err) {
    console.warn("Could not fetch user role", err);
  }

  // Populate the account card and restore only this user's saved dashboard design.
  populateSettingsProfile(user, profileData);

  // Start 20-minute inactivity auto-logout
  startAutoLogout(auth, signOut);

  // Initialize the dashboard
  bootstrap();

  // Show Guide for first time users or new registrations
  const isNewRegistration = localStorage.getItem('dq_new_registration');
  const hasSeenGuide = localStorage.getItem('dq_has_seen_guide_' + user.uid);

  if (isNewRegistration || !hasSeenGuide) {
    // Consume the new-registration flag so it only triggers once
    localStorage.removeItem('dq_new_registration');
    localStorage.setItem('dq_has_seen_guide_' + user.uid, 'true');

    setTimeout(() => {
      if (typeof window.openGuide === 'function') {
        window.openGuide();
      }
    }, 1200);
  }
});

// Logout handler
document.getElementById('logout-btn')?.addEventListener('click', async () => {
  try {
    stopAutoLogout();
    await signOut(auth);
    window.location.href = 'login.html';
  } catch (error) {
    showToast(error.message, "error");
  }
});




function applyClubBranding(club) {
  if (club === 'longos') {
    document.title = 'Longos Pickleball Club';
    document.querySelectorAll('.splash-logo, .header-logo, .sidebar-logo').forEach(img => img.src = 'assets/images/logo-lpc.jpg');
    document.querySelectorAll('.splash-title').forEach(el => el.textContent = 'Longos Club');
    document.querySelectorAll('.header-title').forEach(el => el.textContent = 'Longos Pickleball Club');
    document.querySelectorAll('link[rel="shortcut icon"], link[rel="apple-touch-icon"]').forEach(link => {
      link.href = 'assets/images/logo-lpc.jpg';
    });
    document.querySelectorAll('link[rel="manifest"]').forEach(link => {
      link.href = 'manifest-longos.json';
    });
  } else if (club === 'deuce') {
    document.title = 'Deuce Club Queuing System';
    document.querySelectorAll('.splash-logo, .header-logo, .sidebar-logo').forEach(img => img.src = 'assets/images/deuce-game-logo.png');
    document.querySelectorAll('.splash-title').forEach(el => el.textContent = 'Deuce Club');
    document.querySelectorAll('.header-title').forEach(el => el.textContent = 'Deuce Club Queuing System');
    document.querySelectorAll('link[rel="shortcut icon"], link[rel="apple-touch-icon"]').forEach(link => {
      link.href = 'assets/images/deuce-game-logo.png';
    });
    document.querySelectorAll('link[rel="manifest"]').forEach(link => {
      link.href = 'manifest.json';
    });
  } else if (club === 'balian') {
    document.title = 'Balian Picklers Queuing';
    document.querySelectorAll('.splash-logo, .header-logo, .sidebar-logo').forEach(img => img.src = 'assets/images/balian-pc.jpg');
    document.querySelectorAll('.splash-title').forEach(el => el.textContent = 'Balian Picklers');
    document.querySelectorAll('.header-title').forEach(el => el.textContent = 'Balian Picklers Queuing');
    document.querySelectorAll('link[rel="shortcut icon"], link[rel="apple-touch-icon"]').forEach(link => {
      link.href = 'assets/images/balian-pc.jpg';
    });
  } else {
    document.title = 'PicklQ Queuing System';
    document.querySelectorAll('.splash-logo, .header-logo, .sidebar-logo').forEach(img => img.src = 'assets/images/logologinpage-transparent.png');
    document.querySelectorAll('.splash-title').forEach(el => el.textContent = 'PicklQ');
    document.querySelectorAll('.header-title').forEach(el => el.textContent = 'PicklQ Queuing System');
    document.querySelectorAll('link[rel="shortcut icon"], link[rel="apple-touch-icon"]').forEach(link => {
      link.href = 'assets/images/logologinpage-transparent.png';
    });
  }
}

// Club Selector logic
