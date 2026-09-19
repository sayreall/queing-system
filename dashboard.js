import {
  SKILLS,
  ensureQueuesExist,
  addPlayer,
  listenToQueues,
  listenToPlayers,
  reorderQueue,
  skipPlayer,
  markPlayerAbsent,
  updatePlayerSkill,
  updatePlayerGender,
  updatePlayerPracticePartner,
  removePlayer,
  archiveAllPlayers,
  generateNextRound,
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
} from "./courts.js";
import { 
  db, collection, query, where, orderBy, limit, onSnapshot,
  auth, onAuthStateChanged, signOut, doc, getDoc
, getTenantCollection, getTenantDoc} from "./firebase.js";
import { startAutoLogout, stopAutoLogout } from "./auto-logout.js";

const AVG_MATCH_MINUTES = 15;

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
      if (fromEl.tagName === 'INPUT' || fromEl.tagName === 'SELECT' || fromEl.tagName === 'TEXTAREA') {
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
  ready: {
    queues: false,
    courts: false,
    players: false,
    pendingMatches: false,
  },
};

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
  skillSelect: document.getElementById("player-skill"),
  locationInput: document.getElementById("player-location"),
  archiveAll: document.getElementById("archive-all"),
  searchInput: document.getElementById("player-search"),
  filterSelect: document.getElementById("player-filter"),
  playersBodyBeginner: document.getElementById("players-body-beginner"),
  playersBodyIntermediate: document.getElementById("players-body-intermediate"),
  playersBodyAdvanced: document.getElementById("players-body-advanced"),
  donePlayersBody: document.getElementById("done-players-body"),
  toastContainer: document.getElementById("toast-container"),
};

function shuffleArray(input) {
  const arr = input.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function showToast(message, tone = "info") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  if (tone === "error") {
    toast.style.borderColor = "rgba(248, 113, 113, 0.6)";
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
    const count = (state.queues[skill.key] || []).length;
    const pill = document.querySelector(`[data-queue-count="${skill.key}"]`);
    if (pill) pill.textContent = `${skill.label} ${count}`;
  });
}

function renderQueues() {
  SKILLS.forEach((skill) => {
    const container = document.querySelector(`[data-queue="${skill.key}"]`);
    if (!container) return;

    const order = state.queues[skill.key] || [];

    if (!order.length) {
      window.smoothUpdateHTML(container, `<p class="queue-empty text-slate-500 py-4 text-center text-sm border border-dashed border-slate-700/50 rounded-xl mt-4">No players waiting.</p>`);
    } else {
      const wrapper = document.createElement("div");
      wrapper.className = "queue-matches-grid grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-4 items-start";
      
      const chunks = [];
      for (let i = 0; i < order.length; i += 4) {
        chunks.push(order.slice(i, i + 4));
      }

      chunks.forEach((chunk, index) => {
        const matchCard = document.createElement("div");
        const matchId = `${skill.key}-${index}`;
        const isEditing = state.editingMatches && state.editingMatches.has(matchId);
        
        const isUpNext = index === 0;
        const isComplete = chunk.length === 4;
        const titleText = isUpNext ? "Up Next" : `Match ${index + 1}`;
        const headerColor = isUpNext ? "text-emerald-400" : "text-slate-400";
        const bgStyles = isUpNext 
            ? "border border-emerald-500/30 bg-emerald-500/5 shadow-lg shadow-emerald-500/5" 
            : "border border-slate-700/60 bg-slate-800/20";
        
        matchCard.className = `match-card rounded-xl p-2 sm:p-3 ${bgStyles} ${isEditing ? "is-editing" : ""}`;
        matchCard.dataset.matchId = matchId;
        matchCard.innerHTML = `
          <div class="flex items-center justify-between mb-2 border-b border-slate-700/50 pb-1.5 rounded transition-colors">
            <div class="flex items-center gap-1.5 cursor-grab match-card-drag-handle hover:bg-slate-700/30 px-1 -ml-1 rounded">
              <svg class="${headerColor}" opacity="0.7" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5v14"/><path d="M15 5v14"/></svg>
              <h4 class="text-[10px] uppercase tracking-wider font-bold ${headerColor}">${titleText}</h4>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-semibold ${isComplete ? "text-green-400" : "text-amber-400"}">${chunk.length}/4</span>
              <button class="text-slate-400 hover:text-white px-1 edit-match-btn transition-colors" title="Edit Match">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
              </button>
            </div>
          </div>
          
          <div class="grid grid-cols-[1fr_auto_1fr] gap-2 items-stretch">
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

          if (playerId) {
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
              <div class="flex items-center gap-1 overflow-hidden">
                <span class="drag-handle text-slate-400 cursor-grab hover:text-white px-0.5 text-xs">⋮⋮</span>
                <span class="font-semibold text-[11px] truncate max-w-[70px] sm:max-w-[90px] cursor-grab" title="${player ? player.name : "Unknown"}">${player ? player.name : "Unknown"}</span>
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

    const count = order.length;
    const wait = Math.max(0, Math.ceil(count / 4) * AVG_MATCH_MINUTES);
    const countEl = document.querySelector(`[data-queue-total="${skill.key}"]`);
    const waitEl = document.querySelector(`[data-queue-wait="${skill.key}"]`);
    if (countEl) countEl.textContent = `${count} waiting`;
    if (waitEl) waitEl.textContent = `Est wait ${wait} mins`;
  });
  
  // Re-attach sortable after re-render
  setupSortable();
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
    count: (state.queues[skill.key] || []).length,
  })).filter(q => q.count >= 4);
  queueOptions.sort((a, b) => {
    const aA = activeTally[a.label] || 0, bA = activeTally[b.label] || 0;
    if (aA !== bA) return aA - bA;
    return b.count - a.count;
  });
  const bestQueue = hasPending ? { key: "custom", label: "Custom", count: state.pendingMatches.length * 4 } : (queueOptions[0] || null);
  const totalQueued = SKILLS.reduce((s, sk) => s + (state.queues[sk.key] || []).length, 0);

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
      return `
        <div class="glass-card court-card" data-court-id="${cid}" style="border-color:rgba(56,189,248,0.25);">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 flex-wrap">
              <h3 class="court-title">${courtInfo.name}</h3>
              <span class="court-status active">● LIVE</span>
            </div>
            <span class="court-timer font-mono text-xl font-bold text-cyan-300" data-court-timer="${cid}">00:00</span>
          </div>
          <div class="team-grid mt-2">
            <div class="team-card" style="border-color:rgba(56,189,248,0.3);background:rgba(56,189,248,0.07);">
              <p class="team-label text-cyan-400">Team A</p>
              <p class="team-player mt-2">${nameFor(teamAIds[0])}</p>
              <p class="team-player">${nameFor(teamAIds[1])}</p>
            </div>
            <div class="team-card" style="border-color:rgba(251,113,133,0.3);background:rgba(251,113,133,0.07);">
              <p class="team-label text-rose-400">Team B</p>
              <p class="team-player mt-2">${nameFor(teamBIds[0])}</p>
              <p class="team-player">${nameFor(teamBIds[1])}</p>
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
      // Determine which queues are allowed for this court (fallback to default map if null/undefined)
      const courtAllowedSkill = court.allowedSkill !== undefined ? court.allowedSkill : { "court-1": "beginner", "court-2": "intermediate", "court-3": null }[cid];

      const skillDropdown = `
        <select class="input-field text-xs py-1 px-2 h-auto mt-1 w-36 bg-slate-800 border-slate-700" data-court-skill-select="${cid}">
          <option value="any" ${courtAllowedSkill === null || courtAllowedSkill === "any" ? "selected" : ""}>Any Skill</option>
          <option value="beginner" ${courtAllowedSkill === "beginner" ? "selected" : ""}>Beginner Only</option>
          <option value="intermediate" ${courtAllowedSkill === "intermediate" ? "selected" : ""}>Intermediate Only</option>
          <option value="advanced" ${courtAllowedSkill === "advanced" ? "selected" : ""}>Advanced Only</option>
        </select>
      `;

      const selectableQueues = [];
      if ((courtAllowedSkill === null || courtAllowedSkill === "any") && hasPending) {
        selectableQueues.push({
          key: "custom",
          label: `Custom (${state.pendingMatches.length} pending)`,
          count: state.pendingMatches.length * 4
        });
      }
      SKILLS
        .filter(skill => courtAllowedSkill === null || courtAllowedSkill === "any" || skill.key === courtAllowedSkill)
        .forEach((skill) => {
          const count = (state.queues[skill.key] || []).length;
          if (count >= 4) {
            selectableQueues.push({
              key: skill.key,
              label: `${skill.label} (${count} queued)`,
              count
            });
          }
        });

      const courtQueuedTotal = (courtAllowedSkill === null || courtAllowedSkill === "any")
        ? totalQueued
        : (state.queues[courtAllowedSkill] || []).length;

      if (selectableQueues.length) {
        const queueSelect = `
          <select class="input-field text-xs py-1 px-2 h-auto mt-2 w-full bg-slate-800 border-slate-700" data-start-queue-select="${cid}">
            ${selectableQueues.map((q) => `<option value="${q.key}">${q.label}</option>`).join("")}
          </select>
        `;
        return `
          <div class="glass-card court-card" data-court-id="${cid}">
            <div class="flex items-start justify-between">
              <div>
                <h3 class="court-title">${courtInfo.name}</h3>
                ${skillDropdown}
                ${queueSelect}
              </div>
              <div class="flex items-center gap-1">
                ${removeCourtButton}
                <button class="text-slate-400 hover:text-white text-lg leading-none px-1" data-toggle-court="${cid}" title="Mark Inactive">×</button>
              </div>
            </div>
            <div class="flex items-center gap-2 text-xs text-slate-400 mb-1 mt-2">
              <span class="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block"></span>
              <span class="text-cyan-300 font-semibold">Manual Queue Selection</span>
              <span>${selectableQueues.length} options ready</span>
            </div>
            <button class="btn-primary w-full py-3 text-sm" data-start-court="${cid}">
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
  const allActive = Array.from(state.players.values()).filter(p => p.status !== "Archived");
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
          let pDate = "";
          if (player.updatedAt) {
            let d;
            if (typeof player.updatedAt.toDate === 'function') d = player.updatedAt.toDate();
            else if (player.updatedAt.seconds) d = new Date(player.updatedAt.seconds * 1000);
            else d = new Date(player.updatedAt);
            if (!isNaN(d.getTime())) pDate = d.toLocaleDateString();
          }
          if (pDate !== targetDate) return false;
        }
        
        return player.name.toLowerCase().includes(state.search.toLowerCase());
      }
      if (player.status === "Archived") return false;

      const matchFilter = state.filter === "All" || player.skill === state.filter;
      const matchSearch = player.name.toLowerCase().includes(state.search.toLowerCase());
      return matchFilter && matchSearch;
    })
    .sort((a, b) => {
      const statusOrder = { Playing: 0, Stacked: 1, Waiting: 2, Standby: 3, Absent: 4 };
      return (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5);
    });

  const doneRows = state.filter.startsWith("Archived")
    ? []
    : filteredRows.filter((player) => player.status === "Standby");
  const activeRows = state.filter.startsWith("Archived")
    ? filteredRows
    : filteredRows.filter((player) => player.status !== "Standby");

  // Update total players count badge
  const countEl = document.getElementById("total-players-count");
  if (countEl) {
    const archivedCount = Array.from(state.players.values()).filter(p => p.status === "Archived").length;
    countEl.textContent = `(${allActive.length} active${archivedCount ? `, ${archivedCount} archived` : ""})`;
  }

  const generateRowHTML = (player, idx) => `
      <tr class="border-t border-slate-800/60">
        <td class="py-3 text-center text-slate-500 text-xs font-mono">${idx + 1}</td>
        <td class="font-semibold">
          <div class="flex items-center flex-wrap gap-2">
            <span>${player.name}</span>
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
        <td>${player.status}</td>
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
            ${SKILLS.map(
              (skill) =>
                `<option value="${skill.label}" ${
                  player.skill === skill.label ? "selected" : ""
                }>${skill.label}</option>`
            ).join("")}
          </select>
        </td>
        <td class="sticky right-0 py-3 pl-4 text-right" style="background:rgba(12,50,50,0.98);">
          <div class="flex flex-nowrap justify-end gap-1">
            <button class="btn-secondary text-xs px-2 py-1 whitespace-nowrap" data-player-setup-partner="${player.id}">🔗 Partner</button>
            <button
              class="btn-secondary text-xs px-2 py-1 whitespace-nowrap ${player.status === "Playing" || player.status === "Stacked" ? "opacity-50 cursor-not-allowed" : ""}"
              data-player-absent="${player.id}"
              ${player.status === "Playing" || player.status === "Stacked" ? "disabled" : ""}
            >
              ${player.status === "Playing" || player.status === "Stacked"
                ? "In Match"
                : player.status === "Absent" || player.status === "Standby"
                ? "Return"
                : "Absent"}
            </button>
            <button class="btn-secondary text-xs px-2 py-1 whitespace-nowrap" style="border-color: rgba(248,113,113,0.4); color:#fca5a5;" data-player-remove="${player.id}">✕</button>
          </div>
        </td>
      </tr>
    `;

  const renderTable = (tbodyElement, countElementId, skillFilterLabel) => {
    if (!tbodyElement) return;
    
    // For archived filter we don't separate by skill if we still show the table, 
    // but the user only wanted to separate by skill.
    // If the overall filter is set to a specific skill or Archived, the activeRows is already filtered.
    const rows = activeRows.filter(p => p.skill === skillFilterLabel);
    
    const countEl = document.getElementById(countElementId);
    if (countEl) countEl.textContent = rows.length;

    if (!rows.length) {
      window.smoothUpdateHTML(tbodyElement, `<tr><td class="py-4 text-slate-500 text-center" colspan="12">No ${skillFilterLabel} players.</td></tr>`);
    } else {
      window.smoothUpdateHTML(tbodyElement, rows.map(generateRowHTML).join(""));
    }
  };

  renderTable(elements.playersBodyBeginner, "count-beginner", "Beginner");
  renderTable(elements.playersBodyIntermediate, "count-intermediate", "Intermediate");
  renderTable(elements.playersBodyAdvanced, "count-advanced", "Advanced");

  const donePlayersHTML = doneRows.length
    ? doneRows
    .map(
      (player, idx) => `
      <tr class="border-t border-slate-800/60">
        <td class="py-3 text-center text-slate-500 text-xs font-mono">${idx + 1}</td>
        <td class="font-semibold">
          <div class="flex items-center flex-wrap gap-2">
            <span>${player.name}</span>
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
        <td>${player.status}</td>
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
            ${SKILLS.map(
              (skill) =>
                `<option value="${skill.label}" ${
                  player.skill === skill.label ? "selected" : ""
                }>${skill.label}</option>`
            ).join("")}
          </select>
        </td>
        <td class="sticky right-0 py-3 pl-4 text-right" style="background:rgba(12,50,50,0.98);">
          <div class="flex flex-nowrap justify-end gap-1">
            <button class="btn-secondary text-xs px-2 py-1 whitespace-nowrap" data-player-setup-partner="${player.id}">🔗 Partner</button>
            <button class="btn-secondary text-xs px-2 py-1 whitespace-nowrap" data-player-absent="${player.id}">Return</button>
            <button class="btn-secondary text-xs px-2 py-1 whitespace-nowrap" style="border-color: rgba(248,113,113,0.4); color:#fca5a5;" data-player-remove="${player.id}">✕</button>
          </div>
        </td>
      </tr>
    `
    )
    .join("")
    : `
      <tr>
        <td class="py-4 text-slate-500 text-center" colspan="12">No done-playing players yet.</td>
      </tr>
    `;
    window.smoothUpdateHTML(elements.donePlayersBody, donePlayersHTML);
}

async function handlePlayerActionClick(event) {
  const absent = event.target.getAttribute("data-player-absent");
  const remove = event.target.getAttribute("data-player-remove");
  const setupPartner = event.target.getAttribute("data-player-setup-partner");
  
  if (setupPartner) {
    openPartnerModal(setupPartner);
    return;
  }
  
  if (!absent && !remove) return;

  try {
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
            }
          });
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
        delay: 150,
        delayOnTouchOnly: true,
        touchStartThreshold: 3,
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
const COURT_SKILL_RESTRICTION = {
  "court-1": "beginner",
  "court-2": "intermediate",
  "court-3": null, // any
};

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
            length: (state.queues[skill.key] || []).length - deducted,
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

function openAddPlayerModal(queueKey, matchIndex, slotIndex) {
  _pendingAddSlotInfo = { queueKey, matchIndex, slotIndex };
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
  const { queueKey, matchIndex, slotIndex } = _pendingAddSlotInfo;
  
  const order = state.queues[queueKey] || [];
  const targetIndex = (matchIndex * 4) + slotIndex;
  
  const newOrder = [...order];
  const existingIdx = newOrder.indexOf(playerId);
  if (existingIdx !== -1) {
    newOrder.splice(existingIdx, 1);
  }
  
  let finalTargetIndex = targetIndex;
  if (existingIdx !== -1 && existingIdx < targetIndex) {
    finalTargetIndex -= 1;
  }
  
  newOrder.splice(finalTargetIndex, 0, playerId);
  
  try {
    await reorderQueue(queueKey, newOrder);
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
  document.getElementById("winner-team-a-names").textContent = teamANames.join(" & ") || "Team A";
  document.getElementById("winner-team-b-names").textContent = teamBNames.join(" & ") || "Team B";
  modal.classList.remove("hidden");
}

async function confirmFinishMatch(winnerTeam) {
  const courtId = _pendingFinishCourtId;
  _pendingFinishCourtId = null;
  document.getElementById("winner-modal").classList.add("hidden");

  try {
    await finishMatch(courtId, winnerTeam);
    showToast("Match finished" + (winnerTeam ? ` — ${winnerTeam === "teamA" ? "Team A" : "Team B"} wins!` : ""));
  } catch (error) {
    console.error("Finish match failed", error);
    showToast(formatFirebaseError(error), "error");
  }
}

function bindEvents() {
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

  elements.addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const genderSelect = document.getElementById("player-gender");
      const partnerSelect = document.getElementById("player-practice-partner");
      const newPlayerId = await addPlayer({
        name: elements.nameInput.value,
        skill: elements.skillSelect.value,
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

  const openAddPlayerBtn = document.getElementById("open-add-player-modal");
  const closeAddPlayerBtn = document.getElementById("close-add-player-modal");
  const addPlayerModal = document.getElementById("add-player-modal");

  if (openAddPlayerBtn && addPlayerModal) {
    openAddPlayerBtn.addEventListener("click", () => {
      const partnerSelect = document.getElementById("player-practice-partner");
      if (partnerSelect) {
        partnerSelect.innerHTML = `<option value="">None</option>` +
          Array.from(state.players.values())
            .filter(p => p.status !== 'Archived')
            .map(p => `<option value="${p.id}">${p.name}</option>`)
            .join('');
      }
      addPlayerModal.classList.remove("hidden");
      elements.nameInput?.focus();
    });
  }

  if (closeAddPlayerBtn && addPlayerModal) {
    closeAddPlayerBtn.addEventListener("click", () => {
      addPlayerModal.classList.add("hidden");
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
  if (elements.archiveAll) {
    elements.archiveAll.addEventListener("click", async () => {
      if (!(await showConfirmModal("Are you sure you want to end the day and archive all active players? This will clear all courts and queues."))) return;
      try {
        await archiveAllPlayers(Array.from(state.players.values()));
        showToast("Session ended. All players archived.");
      } catch (error) {
        console.error("Archive failed", error);
        showToast(formatFirebaseError(error), "error");
      }
    });
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
      const selectedMode = document.querySelector('input[name="matching_mode"]:checked')?.value || 'social_mix';
      
      try {
        confirmMatchingModeBtn.disabled = true;
        confirmMatchingModeBtn.innerHTML = "Generating...";
        await generateNextRound(Array.from(state.players.values()), selectedMode);
        showToast("Next round generated successfully!");
        matchingModeModal.classList.add("hidden");
      } catch (error) {
        showToast(error.message || "Failed to generate round.", "error");
      } finally {
        confirmMatchingModeBtn.disabled = false;
        confirmMatchingModeBtn.innerHTML = "Generate Matches";
      }
    });
  }

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

    // Start Next Match button on court card
    const startCourtBtn = event.target.closest("[data-start-court]");
    if (startCourtBtn) {
      const courtId = startCourtBtn.dataset.startCourt;
      const queueSelect = document.querySelector(`[data-start-queue-select="${courtId}"]`);
      const skillKey = queueSelect?.value;
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
          showToast("Player skill updated");
        } catch (err) {
          showToast(err.message || "Error updating skill", "error");
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

  elements.donePlayersBody.addEventListener("change", async (event) => {
    if (event.target.dataset.playerSkill) {
      const playerId = event.target.dataset.playerSkill;
      const newSkill = event.target.value;
      try {
        await updatePlayerSkill(playerId, newSkill);
        showToast("Player skill updated");
      } catch (err) {
        showToast(err.message || "Error updating skill", "error");
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

  elements.donePlayersBody.addEventListener("click", handlePlayerActionClick);

  const customBtn = document.getElementById("start-custom-match-btn");
  const customModal = document.getElementById("custom-match-modal");
  const closeCustomModal = document.getElementById("close-custom-modal");
  const launchCustomBtn = document.getElementById("launch-custom-match");

  customBtn.addEventListener("click", () => {
    const allActive = Array.from(state.players.values())
      .filter(p => p.status === "Standby")
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
    if (hasRepeat && new Set([a1, a2, b1, b2]).size === 4) {
      warningEl.classList.remove("hidden");
    } else {
      warningEl.classList.add("hidden");
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

    // Calculate power: Skill (1,2,3) * 100 + Win% (0-100)
    const getPower = (p) => {
      let skillVal = p.skill === "Advanced" ? 3 : p.skill === "Intermediate" ? 2 : 1;
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
  const rankingModal = document.getElementById("ranking-modal");
  const closeRankingBtn = document.getElementById("close-ranking-modal");
  const rankingTbody = document.getElementById("ranking-tbody");

  viewRankingBtn?.addEventListener("click", () => {
    const allPlayers = Array.from(state.players.values()).filter(p => p.status !== "Archived" && ((p.wins || 0) + (p.losses || 0)) > 0);
    
    allPlayers.sort((a, b) => {
      const aW = a.wins || 0;
      const aL = a.losses || 0;
      const bW = b.wins || 0;
      const bL = b.losses || 0;
      const aGP = aW + aL;
      const bGP = bW + bL;
      
      const aWinPct = aGP > 0 ? (aW / aGP) * 100 : 0;
      const bWinPct = bGP > 0 ? (bW / bGP) * 100 : 0;

      if (Math.abs(bWinPct - aWinPct) > 0.1) return bWinPct - aWinPct;
      if (bW !== aW) return bW - aW;
      return bGP - aGP;
    });

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
          <td class="py-3 px-4 text-slate-400 text-xs">${player.skill}</td>
          <td class="py-3 px-4 text-center text-purple-400 font-semibold">${gp}</td>
          <td class="py-3 px-4 text-center text-green-400 font-semibold">${player.wins || 0}</td>
          <td class="py-3 px-4 text-center text-red-400 font-semibold">${player.losses || 0}</td>
          <td class="py-3 px-4 text-center text-blue-400 font-semibold">${winPct}</td>
        </tr>
      `;
    }).join("") : `<tr><td colspan="7" class="py-6 text-center text-slate-500">No players with matches played yet.</td></tr>`;

    rankingModal.classList.remove("hidden");
    // Ensure mobile sidebar closes when opening modal
    if (window.innerWidth < 768 && toggleMobileMenu) toggleMobileMenu();
  });

  closeRankingBtn?.addEventListener("click", () => {
    rankingModal.classList.add("hidden");
  });
  
  rankingModal?.addEventListener("click", (e) => {
    if (e.target === rankingModal) rankingModal.classList.add("hidden");
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
        }
      ];

      if (isMobile) {
        steps.push({
          element: document.querySelector('#open-add-player-modal'),
          title: 'Add Players',
          intro: 'Start by getting players into the system here. You can manually add them, or open the Menu to bulk import.',
          position: 'bottom'
        });
      } else {
        steps.push({
          element: document.querySelector('#import-players-btn'),
          title: 'Add Players',
          intro: 'Start by getting players into the system. You can bulk import via CSV/Excel, paste from Reclub, or manually Add Walk-ins below.',
          position: 'right'
        });
      }

      steps.push(
        {
          element: document.querySelector('#courts-container'),
          title: 'Set Up Courts',
          intro: 'Click <b>+ Add Court</b> to set up your courts. You can specify skill restrictions (e.g., "Beginner Only") or leave them open.',
          position: 'bottom'
        },
        {
          element: document.querySelector('#auto-assign-toggle') ? document.querySelector('#auto-assign-toggle').parentElement : null,
          title: 'Auto-Assign',
          intro: 'Turn this on for a hands-free experience! The system will automatically pull 4 players from the correct queue and assign them whenever a court opens up.',
          position: 'bottom'
        },
        {
          element: document.querySelector('#round-generator-panel'),
          title: 'Round Generator',
          intro: 'Prefer batch processing? Use the Round Generator to auto-balance and queue matches for ALL standby players at once.',
          position: 'top'
        },
        {
          element: document.querySelector('#custom-match-panel'),
          title: 'Custom Matches',
          intro: 'Need full control? Build custom matchups by selecting any 4 players and skip the standard skill restrictions.',
          position: 'top'
        },
        {
          element: document.querySelector('#queues-container'),
          title: 'Manage Queues',
          intro: 'Matches ready to play appear here. You can manually drag and drop them to reorder their priority.',
          position: 'top'
        }
      );

      if (isMobile) {
        steps.push({
          element: document.querySelector('#mobile-menu-btn'),
          title: 'Menu & TV Display',
          intro: 'Open this menu to access the Match Log, Rankings, and the TV Display for a big screen view.',
          position: 'bottom'
        });
      } else {
        steps.push({
          element: document.querySelector('#view-tv-btn'),
          title: 'TV Display & Sharing',
          intro: 'Click here to open a TV-friendly display of live courts and rankings, or use <b>Share TV</b> to let players scan a QR code!',
          position: 'right'
        });
      }

      steps.push({
        element: document.querySelector('#archive-all'),
        title: 'End of the Day',
        intro: 'When the session is over, click this. It clears the queues and courts, but safely stores everyone\'s stats for the next time they play!',
        position: 'top'
      });

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

  listenToQueues((queues) => {
    state.queues = queues;
    state.ready.queues = true;
    renderQueues();
    renderStats();
    renderNextMatch();
    setupSortable();
    cacheState();
    checkAutoAssign();
  });

  listenToCourts((courts) => {
    state.courts = courts;
    state.ready.courts = true;
    renderCourts();
    renderStats();
    renderNextMatch();
    cacheState();
    checkAutoAssign();
  });

  listenToPlayers((players) => {
    state.players = new Map(players.map((player) => [player.id, player]));
    
    // Dynamically rebuild player filter with archive dates
    const archiveDates = new Set();
    players.forEach(p => {
      if (p.status === "Archived" && p.updatedAt) {
        let dateObj;
        if (typeof p.updatedAt.toDate === 'function') dateObj = p.updatedAt.toDate();
        else if (p.updatedAt.seconds) dateObj = new Date(p.updatedAt.seconds * 1000);
        else dateObj = new Date(p.updatedAt);
        if (!isNaN(dateObj.getTime())) {
          archiveDates.add(dateObj.toLocaleDateString());
        }
      }
    });

    const filterEl = elements.filterSelect;
    if (filterEl) {
      const currentVal = filterEl.value;
      const staticOptions = `
        <option value="All">All skills</option>
        <option value="Beginner">Beginner</option>
        <option value="Intermediate">Intermediate</option>
        <option value="Advanced">Advanced</option>
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
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
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

  const chosen = queueOptions[0];

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
  
  try {
    // Account profiles live at users/{userId}; tenant collections (courts,
    // queues, etc.) live below that document.  Do not look for the profile in
    // the users subcollection, or its club setting will never be found.
    const userDocRef = doc(db, 'users', user.uid);
    const userDoc = await getDoc(userDocRef);
    const data = userDoc.exists() ? userDoc.data() : {};
    if (data.role === 'admin') {
      window.location.href = 'admin.html';
      return;
    }

    // Always reset an unknown/missing club to Deuce so a prior Longos login
    // cannot leave its branding on this account's dashboard.
    const userClub = data.club === 'longos' ? 'longos' : 'deuce';
    localStorage.setItem('dq_club_preference', userClub);
    applyClubBranding(userClub);
  } catch (err) {
    console.warn("Could not fetch user role", err);
  }

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
    document.querySelectorAll('.splash-logo, .header-logo, .sidebar-logo').forEach(img => img.src = 'logo-lpc.jpg');
    document.querySelectorAll('.splash-title').forEach(el => el.textContent = 'Longos Club');
    document.querySelectorAll('.header-title').forEach(el => el.textContent = 'Longos Pickleball Club');
    document.querySelectorAll('link[rel="shortcut icon"], link[rel="apple-touch-icon"]').forEach(link => {
      link.href = 'logo-lpc.jpg';
    });
    document.querySelectorAll('link[rel="manifest"]').forEach(link => {
      link.href = 'manifest-longos.json';
    });
  } else if (club === 'guest') {
    document.title = 'PicklQ Queuing System';
    document.querySelectorAll('.splash-logo, .header-logo, .sidebar-logo').forEach(img => img.src = 'logologinpage-transparent.png');
    document.querySelectorAll('.splash-title').forEach(el => el.textContent = 'PicklQ');
    document.querySelectorAll('.header-title').forEach(el => el.textContent = 'PicklQ Queuing System');
    document.querySelectorAll('link[rel="shortcut icon"], link[rel="apple-touch-icon"]').forEach(link => {
      link.href = 'logologinpage-transparent.png';
    });
  } else {
    document.title = 'Deuce Club Queuing System';
    document.querySelectorAll('.splash-logo, .header-logo, .sidebar-logo').forEach(img => img.src = 'deuce-game-logo.png');
    document.querySelectorAll('.splash-title').forEach(el => el.textContent = 'Deuce Club');
    document.querySelectorAll('.header-title').forEach(el => el.textContent = 'Deuce Club Queuing System');
    document.querySelectorAll('link[rel="shortcut icon"], link[rel="apple-touch-icon"]').forEach(link => {
      link.href = 'deuce-game-logo.png';
    });
    document.querySelectorAll('link[rel="manifest"]').forEach(link => {
      link.href = 'manifest.json';
    });
  }
}

// Club Selector logic
