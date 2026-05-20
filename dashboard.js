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
  removePlayer,
  archiveAllPlayers,
} from "./queue.js";
import {
  COURTS,
  ensureCourtsExist,
  listenToCourts,
  assignMatchToCourt,
  finishMatch,
  toggleCourtStatus,
  updateCourtAllowedSkill,
} from "./courts.js";
import { db, collection, query, where, orderBy, limit, onSnapshot } from "./firebase.js";

const AVG_MATCH_MINUTES = 15;

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
  ready: {
    queues: false,
    courts: false,
    players: false,
    pendingMatches: false,
  },
};

const elements = {
  addForm: document.getElementById("add-player-form"),
  nameInput: document.getElementById("player-name"),
  skillSelect: document.getElementById("player-skill"),
  locationInput: document.getElementById("player-location"),
  archiveAll: document.getElementById("archive-all"),
  searchInput: document.getElementById("player-search"),
  filterSelect: document.getElementById("player-filter"),
  playersBody: document.getElementById("players-body"),
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
    const list = document.querySelector(`[data-queue="${skill.key}"]`);
    if (!list) return;

    const order = state.queues[skill.key] || [];
    list.innerHTML = "";

    if (!order.length) {
      const empty = document.createElement("li");
      empty.className = "queue-empty";
      empty.textContent = "No players waiting.";
      list.appendChild(empty);
    } else {
      order.forEach((playerId) => {
        const player = state.players.get(playerId);
        const item = document.createElement("li");
        item.className = "queue-item";
        item.dataset.playerId = playerId;

        const name = document.createElement("div");
        name.className = "flex items-center gap-3";
        const lastResult = player?.lastResult;
        const resultBadge = lastResult === "Win"
          ? `<span class="text-xs font-bold text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded">W</span>`
          : lastResult === "Loss"
          ? `<span class="text-xs font-bold text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded">L</span>`
          : "";
        name.innerHTML = `<span class="drag-handle text-slate-400">::</span>
          <div>
            <p class="font-semibold">${player ? player.name : "Unknown"} ${resultBadge}</p>
            <p class="text-xs text-slate-400">Waiting</p>
          </div>`;

        const actions = document.createElement("div");
        actions.className = "flex flex-wrap items-center gap-2 mt-2 sm:mt-0";
        actions.innerHTML = `
          <button class="btn-secondary" data-action="skip">Skip</button>
          <button class="btn-secondary" data-action="absent">Absent</button>
          <button class="btn-secondary" data-action="remove">Remove</button>
        `;

        item.appendChild(name);
        item.appendChild(actions);
        list.appendChild(item);
      });
    }

    const count = order.length;
    const wait = Math.max(0, Math.ceil(count / 4) * AVG_MATCH_MINUTES);
    const countEl = document.querySelector(`[data-queue-total="${skill.key}"]`);
    const waitEl = document.querySelector(`[data-queue-wait="${skill.key}"]`);
    if (countEl) countEl.textContent = `${count} waiting`;
    if (waitEl) waitEl.textContent = `Est wait ${wait} mins`;
  });
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

  container.innerHTML = COURTS.map(courtInfo => {
    const court = state.courts.find(c => c.id === courtInfo.id);
    if (!court) return "";

    const cid = court.id;

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

      // Find the best eligible queue for this court
      let eligibleBestQueue = null;
      if (hasPending && courtAllowedSkill === null) {
        eligibleBestQueue = { key: "custom", label: "Custom", count: state.pendingMatches.length * 4 };
      } else {
        const eligibleOptions = SKILLS
          .filter(skill => courtAllowedSkill === null || skill.key === courtAllowedSkill)
          .map(skill => ({ key: skill.key, label: skill.label, count: (state.queues[skill.key] || []).length }))
          .filter(q => q.count >= 4);
        eligibleOptions.sort((a, b) => b.count - a.count);
        eligibleBestQueue = eligibleOptions[0] || null;
      }

      const courtQueuedTotal = courtAllowedSkill === null
        ? totalQueued
        : (state.queues[courtAllowedSkill] || []).length;

      if (eligibleBestQueue) {
        // Queue ready — show Start Next Match
        const skillBadgeClass = { Beginner: "text-cyan-400", Intermediate: "text-amber-400", Advanced: "text-rose-400", Custom: "text-purple-400" }[eligibleBestQueue.label] || "text-slate-300";
        return `
          <div class="glass-card court-card" data-court-id="${cid}">
            <div class="flex items-center justify-between">
              <div>
                <h3 class="court-title">${courtInfo.name}</h3>
                ${skillDropdown}
              </div>
              <button class="text-slate-400 hover:text-white text-lg leading-none" data-toggle-court="${cid}" title="Mark Inactive">×</button>
            </div>
            <div class="flex items-center gap-2 text-xs text-slate-400 mb-1">
              <span class="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block"></span>
              <span class="${skillBadgeClass} font-semibold">${eligibleBestQueue.label}</span>
              <span>${eligibleBestQueue.count} players queued</span>
            </div>
            <button class="btn-primary w-full py-3 text-sm" data-start-court="${cid}" data-skill-key="${eligibleBestQueue.key}">
              ▶ Start Next Match
            </button>
          </div>`;
      } else {
        // No eligible queue — waiting for players
        const queued = Math.min(courtQueuedTotal, 3);
        const pct = Math.round((queued / 4) * 100);
        return `
          <div class="glass-card court-card" data-court-id="${cid}" style="border-style:dashed;border-color:rgba(148,163,184,0.2);">
            <div class="flex items-center justify-between">
              <div>
                <h3 class="court-title text-slate-400">${courtInfo.name}</h3>
                ${skillDropdown}
              </div>
              <button class="text-slate-500 hover:text-white text-lg leading-none" data-toggle-court="${cid}" title="Mark Inactive">×</button>
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
          <span class="text-xs text-slate-600 uppercase tracking-widest">Inactive</span>
        </div>
        <button class="btn-secondary w-full mt-2" data-toggle-court="${cid}">Mark Available</button>
      </div>`;
  }).join("");
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
      const statusOrder = { Playing: 0, Stacked: 1, Standby: 2, Waiting: 3, Absent: 4 };
      const aS = statusOrder[a.status] ?? 5;
      const bS = statusOrder[b.status] ?? 5;
      if (aS !== bS) return aS - bS;
      const order = { Win: 0, Loss: 1, null: 2, undefined: 2 };
      const aOrder = order[a.lastResult] ?? 2;
      const bOrder = order[b.lastResult] ?? 2;
      return aOrder - bOrder;
    });

  const doneRows = state.filter.startsWith("Archived")
    ? []
    : filteredRows.filter((player) => player.status === "Standby");
  const activeRowsRaw = state.filter.startsWith("Archived")
    ? filteredRows
    : filteredRows.filter((player) => player.status !== "Standby");
  const activeRows = state.filter.startsWith("Archived") ? activeRowsRaw : shuffleArray(activeRowsRaw);

  // Update total players count badge
  const countEl = document.getElementById("total-players-count");
  if (countEl) {
    const archivedCount = Array.from(state.players.values()).filter(p => p.status === "Archived").length;
    countEl.textContent = `(${allActive.length} active${archivedCount ? `, ${archivedCount} archived` : ""})`;
  }

  if (!activeRows.length) {
    elements.playersBody.innerHTML = `
      <tr>
        <td class="py-4 text-slate-500" colspan="13">No remaining players to play.</td>
      </tr>
    `;
  } else {
    elements.playersBody.innerHTML = activeRows
      .map(
        (player, idx) => `
      <tr class="border-t border-slate-800/60">
        <td class="py-3 text-center">
          <input type="checkbox" class="stack-checkbox w-4 h-4 cursor-pointer" data-player-id="${player.id}" />
        </td>
        <td class="py-3 text-center text-slate-500 text-xs font-mono">${idx + 1}</td>
        <td class="font-semibold">
          ${player.name}
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
        <td class="hidden md:table-cell text-slate-400">${player.gender || "—"}</td>
        <td class="hidden md:table-cell text-slate-300 text-sm">${player.location || "—"}</td>
        <td class="hidden lg:table-cell">${player.status}</td>
        <td class="hidden lg:table-cell">
          ${player.lastResult === 'Win' ? '<span class="text-xs font-semibold px-2 py-1 bg-green-500/20 text-green-400 rounded-md border border-green-500/30">Won</span>' : ''}
          ${player.lastResult === 'Loss' ? '<span class="text-xs font-semibold px-2 py-1 bg-red-500/20 text-red-400 rounded-md border border-red-500/30">Lost</span>' : ''}
          ${!player.lastResult ? '<span class="text-xs text-slate-500">—</span>' : ''}
        </td>
        <td class="text-purple-400 font-semibold">${(player.wins ?? 0) + (player.losses ?? 0)}</td>
        <td class="text-blue-400 font-semibold">${((player.wins ?? 0) + (player.losses ?? 0)) > 0 ? Math.round(((player.wins ?? 0) / ((player.wins ?? 0) + (player.losses ?? 0))) * 100) + '%' : '—'}</td>
        <td class="hidden md:table-cell">
          <select class="input-field" data-player-skill="${player.id}">
            ${SKILLS.map(
              (skill) =>
                `<option value="${skill.label}" ${
                  player.skill === skill.label ? "selected" : ""
                }>${skill.label}</option>`
            ).join("")}
          </select>
        </td>
        <td class="sticky right-0 bg-[#0a1f2e] py-3 pl-2 text-right">
          <div class="flex flex-nowrap justify-end gap-1">
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
    `
      )
      .join("");
  }

  elements.donePlayersBody.innerHTML = doneRows.length
    ? doneRows
    .map(
      (player, idx) => `
      <tr class="border-t border-slate-800/60">
        <td class="py-3 text-center text-slate-500 text-xs font-mono">${idx + 1}</td>
        <td class="font-semibold">
          ${player.name}
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
        <td class="hidden md:table-cell text-slate-400">${player.gender || "—"}</td>
        <td class="hidden md:table-cell text-slate-300 text-sm">${player.location || "—"}</td>
        <td class="hidden lg:table-cell">${player.status}</td>
        <td class="hidden lg:table-cell">
          ${player.lastResult === 'Win' ? '<span class="text-xs font-semibold px-2 py-1 bg-green-500/20 text-green-400 rounded-md border border-green-500/30">Won</span>' : ''}
          ${player.lastResult === 'Loss' ? '<span class="text-xs font-semibold px-2 py-1 bg-red-500/20 text-red-400 rounded-md border border-red-500/30">Lost</span>' : ''}
          ${!player.lastResult ? '<span class="text-xs text-slate-500">—</span>' : ''}
        </td>
        <td class="text-purple-400 font-semibold">${(player.wins ?? 0) + (player.losses ?? 0)}</td>
        <td class="text-blue-400 font-semibold">${((player.wins ?? 0) + (player.losses ?? 0)) > 0 ? Math.round(((player.wins ?? 0) / ((player.wins ?? 0) + (player.losses ?? 0))) * 100) + '%' : '—'}</td>
        <td class="hidden md:table-cell">
          <select class="input-field" data-player-skill="${player.id}">
            ${SKILLS.map(
              (skill) =>
                `<option value="${skill.label}" ${
                  player.skill === skill.label ? "selected" : ""
                }>${skill.label}</option>`
            ).join("")}
          </select>
        </td>
        <td class="sticky right-0 bg-[#0a1f2e] py-3 pl-2 text-right">
          <div class="flex flex-nowrap justify-end gap-1">
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
        <td class="py-4 text-slate-500" colspan="12">No done-playing players yet.</td>
      </tr>
    `;
}

async function handlePlayerActionClick(event) {
  const absent = event.target.getAttribute("data-player-absent");
  const remove = event.target.getAttribute("data-player-remove");
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

  document.querySelectorAll(".queue-list").forEach((list) => {
    if (list.dataset.sortableAttached) return;

    new Sortable(list, {
      animation: 150,
      handle: ".drag-handle",
      onEnd: async () => {
        const skillKey = list.dataset.queue;
        const order = Array.from(list.querySelectorAll(".queue-item")).map(
          (item) => item.dataset.playerId
        );
        try {
          await reorderQueue(skillKey, order);
          showToast("Queue order updated");
        } catch (error) {
          showToast(error.message || "Failed to reorder queue", "error");
        }
      },
    });

    list.dataset.sortableAttached = "true";
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
function getAllowedSkillsForCourt(courtId) {
  const restriction = COURT_SKILL_RESTRICTION[courtId];
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
    
    for (const court of availableCourts) {
      const allowedSkill = getAllowedSkillsForCourt(court.id); // null = any, string = specific key

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
      if (allowedSkill === null && pendingIndex < state.pendingMatches.length) {
        queueOptions.push({
          key: "custom",
          label: "Custom",
          length: (state.pendingMatches.length - pendingIndex) * 4,
          isCustom: true
        });
      }

      if (!queueOptions.length) continue; // skip this court, no eligible queue

      queueOptions.sort((a, b) => {
        const aActive = activeTally[a.label] || 0;
        const bActive = activeTally[b.label] || 0;
        if (aActive !== bActive) return aActive - bActive;
        return b.length - a.length;
      });

      const chosen = queueOptions[0];

      if (chosen.isCustom) {
        const match = state.pendingMatches[pendingIndex];
        const { activatePendingMatch } = await import("./courts.js");
        await activatePendingMatch(match.id, court.id);
        pendingIndex++;
        localAssignedTally["Custom"] = (localAssignedTally["Custom"] || 0) + 1;
      } else {
        await assignMatchToCourt(court.id, chosen.key);
        localAssignedTally[chosen.label] = (localAssignedTally[chosen.label] || 0) + 1;
        localQueueDeductions[chosen.key] = (localQueueDeductions[chosen.key] || 0) + 4;
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
  elements.addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const genderSelect = document.getElementById("player-gender");
      await addPlayer({
        name: elements.nameInput.value,
        skill: elements.skillSelect.value,
        gender: genderSelect ? genderSelect.value : "",
        location: elements.locationInput ? elements.locationInput.value.trim() : "",
      });
      elements.nameInput.value = "";
      elements.skillSelect.value = "";
      if (genderSelect) genderSelect.value = "";
      if (elements.locationInput) elements.locationInput.value = "";
      showToast("Player added");
    } catch (error) {
      console.error("Add player failed", error);
      showToast(formatFirebaseError(error), "error");
    }
  });



  if (elements.archiveAll) {
    elements.archiveAll.addEventListener("click", async () => {
      if (!confirm("Are you sure you want to end the day and archive all active players? This will clear all courts and queues.")) return;
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

  document.body.addEventListener("click", async (event) => {
    const action = event.target.getAttribute("data-action");
    const playerRow = event.target.closest(".queue-item");

    if (action && playerRow) {
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
      const skillKey = startCourtBtn.dataset.skillKey;
      try {
        startCourtBtn.disabled = true;
        startCourtBtn.textContent = "Starting...";
        if (skillKey === "custom") {
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

  elements.playersBody.addEventListener("change", async (event) => {
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

  elements.playersBody.addEventListener("click", handlePlayerActionClick);
  elements.donePlayersBody.addEventListener("click", handlePlayerActionClick);
  elements.playersBody.addEventListener("change", (event) => {
    if (event.target.classList.contains("stack-checkbox")) {
      const checkedBoxes = document.querySelectorAll(".stack-checkbox:checked");
      if (checkedBoxes.length > 4) {
        event.target.checked = false;
        showToast("You can only select up to 4 players for a custom match.", "error");
        return;
      }
      const count = checkedBoxes.length;
      document.getElementById("custom-match-count").textContent = count;
      const btn = document.getElementById("start-custom-match-btn");
      if (count === 4) {
        btn.disabled = false;
        btn.classList.remove("opacity-50", "cursor-not-allowed");
      } else {
        btn.disabled = true;
        btn.classList.add("opacity-50", "cursor-not-allowed");
      }
    }
  });

  const customBtn = document.getElementById("start-custom-match-btn");
  const customModal = document.getElementById("custom-match-modal");
  const closeCustomModal = document.getElementById("close-custom-modal");
  const launchCustomBtn = document.getElementById("launch-custom-match");

  customBtn.addEventListener("click", () => {
    const selected = Array.from(document.querySelectorAll(".stack-checkbox:checked")).map(cb => {
      const id = cb.getAttribute("data-player-id");
      return state.players.get(id);
    });
    
    // Populate selects
    ["custom-team-a1", "custom-team-a2", "custom-team-b1", "custom-team-b2"].forEach((selId, idx) => {
      const select = document.getElementById(selId);
      select.innerHTML = selected.map((p, i) => `<option value="${p.id}" ${i === idx ? 'selected' : ''}>${p.name}</option>`).join("");
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
    const selected = Array.from(document.querySelectorAll(".stack-checkbox:checked")).map(cb => {
      const id = cb.getAttribute("data-player-id");
      return state.players.get(id);
    });
    if (selected.length !== 4) return;

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
      document.querySelectorAll(".stack-checkbox:checked").forEach(cb => cb.checked = false);
      document.getElementById("custom-match-count").textContent = "0";
      customBtn.disabled = true;
      customBtn.classList.add("opacity-50", "cursor-not-allowed");
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

  listenToQueues((queues) => {
    state.queues = queues;
    state.ready.queues = true;
    renderQueues();
    renderStats();
    renderNextMatch();
    setupSortable();
    cacheState();
    maybeAutoAssignMatches();
  });

  listenToCourts((courts) => {
    state.courts = courts;
    state.ready.courts = true;
    renderCourts();
    renderStats();
    renderNextMatch();
    cacheState();
    maybeAutoAssignMatches();
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

    const filterEl = elements.playerFilter;
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
    renderPlayers();
    renderQueues();
    renderCourts();
    renderStats();
    renderPendingMatches();
    renderNextMatch();
    renderMatchLog();
    cacheState();
  });

  const q = query(collection(db, "matches"), where("status", "==", "Pending"));
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
    maybeAutoAssignMatches();
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

  onSnapshot(query(collection(db, "matches"), where("status", "==", "Completed")), (snap) => {
    matchLogCache.completed = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    mergeMatchLog();
  }, (err) => console.error("Match log (Completed) error:", err));

  onSnapshot(query(collection(db, "matches"), where("status", "==", "Archived")), (snap) => {
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

  container.innerHTML = state.pendingMatches.map(match => {
    const p1 = state.players.get(match.teamA[0])?.name || "Player 1";
    const p2 = state.players.get(match.teamA[1])?.name || "Player 2";
    const p3 = state.players.get(match.teamB[0])?.name || "Player 3";
    const p4 = state.players.get(match.teamB[1])?.name || "Player 4";
    return `
      <div class="glass-subcard mb-4 border-amber-500/30 bg-amber-500/10">
        <div class="flex items-center justify-between">
          <h3 class="font-display font-semibold text-amber-300">Pending Stacked Match</h3>
          <span class="text-xs uppercase tracking-wider text-amber-500/80">Next Available Court</span>
        </div>
        <div class="mt-2 text-sm text-slate-300">
          <p><strong>Team A:</strong> ${p1} & ${p2}</p>
          <p><strong>Team B:</strong> ${p3} & ${p4}</p>
        </div>
      </div>
    `;
  }).join("");
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

  if (availablePlayers.length < 4) {
    container.innerHTML = "";
    return;
  }

  const nextIds = availablePlayers.slice(0, 4);
  // Team A = first 2, Team B = last 2 (preview — actual matchmaking may differ)
  const teamA = nextIds.slice(0, 2);
  const teamB = nextIds.slice(2, 4);

  container.innerHTML = buildNextMatchHTML(teamA, teamB, chosen.label, "Auto", courtReady);
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
  const matchRef = doc(db, "matches", matchId);
  await setDoc(matchRef, { status: "Archived", updatedAt: serverTimestamp() }, { merge: true });
}

async function archiveAllMatchLog() {
  const logs = state.matchLog || [];
  const visible = state.matchLogShowArchived ? logs : logs.filter(m => m.status !== "Archived");
  if (!visible.length) return;
  if (!confirm(`Archive all ${visible.length} visible matches? They will be hidden from the log.`)) return;
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
        <td class="py-3 pr-4 text-slate-400">${formatTime(match.endedAt)}</td>
        <td class="pr-4 font-semibold">${courtLabel(match.courtId)}</td>
        <td class="pr-4 ${skillColor}">${match.skill || "—"}</td>
        <td class="pr-4 ${winner === "teamA" ? "text-cyan-300 font-semibold" : "text-slate-300"}">${teamA}</td>
        <td class="pr-4 ${winner === "teamB" ? "text-rose-300 font-semibold" : "text-slate-300"}">${teamB}</td>
        <td class="pr-4">${winnerBadge}</td>
        <td class="pr-4 text-slate-400">${formatDuration(match.startedAt, match.endedAt)}</td>
        <td class="text-right">${archiveBtn}</td>
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


bootstrap();


