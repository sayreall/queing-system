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
} from "./courts.js";
import { db, collection, query, where, orderBy, onSnapshot } from "./firebase.js";

const AVG_MATCH_MINUTES = 15;

const state = {
  queues: {},
  courts: [],
  players: new Map(),
  pendingMatches: [],
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
  debugSave: document.getElementById("debug-save"),
  archiveAll: document.getElementById("archive-all"),
  searchInput: document.getElementById("player-search"),
  filterSelect: document.getElementById("player-filter"),
  playersBody: document.getElementById("players-body"),
  toastContainer: document.getElementById("toast-container"),
};

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
        name.innerHTML = `<span class="drag-handle text-slate-400">::</span>
          <div>
            <p class="font-semibold">${player ? player.name : "Unknown"}</p>
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
  COURTS.forEach((courtInfo) => {
    const court = state.courts.find((item) => item.id === courtInfo.id);
    const statusEl = document.querySelector(`[data-court-status="${courtInfo.id}"]`);
    const timerEl = document.querySelector(`[data-court-timer="${courtInfo.id}"]`);

    if (!court || !statusEl || !timerEl) return;

    statusEl.textContent = court.status;
    statusEl.classList.toggle("active", court.status === "Active");
    statusEl.classList.toggle("bg-slate-700", court.status === "Inactive");
    statusEl.classList.toggle("text-slate-400", court.status === "Inactive");

    const toggleBtn = document.querySelector(`[data-toggle-court="${courtInfo.id}"]`);
    if (toggleBtn) {
      if (court.status === "Active") {
        toggleBtn.classList.add("hidden");
      } else {
        toggleBtn.classList.remove("hidden");
        toggleBtn.textContent = court.status === "Inactive" ? "Mark Available" : "Mark Inactive";
      }
    }

    const players = court.players || [];
    const teams = [players[0], players[1], players[2], players[3]];

    const nameFor = (playerId) =>
      state.players.get(playerId)?.name || "--";

    const teamA = document.querySelector(`[data-team-a="${courtInfo.id}"]`);
    const teamA2 = document.querySelector(`[data-team-a2="${courtInfo.id}"]`);
    const teamB = document.querySelector(`[data-team-b="${courtInfo.id}"]`);
    const teamB2 = document.querySelector(`[data-team-b2="${courtInfo.id}"]`);

    if (teamA) teamA.textContent = nameFor(teams[0]);
    if (teamA2) teamA2.textContent = nameFor(teams[1]);
    if (teamB) teamB.textContent = nameFor(teams[2]);
    if (teamB2) teamB2.textContent = nameFor(teams[3]);

    if (!court.startedAt) {
      timerEl.textContent = "00:00";
    }
  });
}

function renderPlayers() {
  const rows = Array.from(state.players.values())
    .filter((player) => {
      if (state.filter === "Archived") {
        return player.status === "Archived" && player.name.toLowerCase().includes(state.search.toLowerCase());
      }
      if (player.status === "Archived") return false;

      const matchFilter = state.filter === "All" || player.skill === state.filter;
      const matchSearch = player.name.toLowerCase().includes(state.search.toLowerCase());
      return matchFilter && matchSearch;
    })
    .sort((a, b) => {
      if (a.status === "Standby" && b.status !== "Standby") return -1;
      if (a.status !== "Standby" && b.status === "Standby") return 1;
      return a.name.localeCompare(b.name);
    });

  if (!rows.length) {
    elements.playersBody.innerHTML = `
      <tr>
        <td class="py-4 text-slate-500" colspan="4">No matching players.</td>
      </tr>
    `;
    return;
  }

  elements.playersBody.innerHTML = rows
    .map(
      (player) => `
      <tr class="border-t border-slate-800/60">
        <td class="py-3 text-center">
          <input type="checkbox" class="stack-checkbox w-4 h-4 cursor-pointer" data-player-id="${player.id}" />
        </td>
        <td class="font-semibold">${player.name}</td>
        <td class="text-slate-400">${player.gender || "—"}</td>
        <td>${player.status}</td>
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
        <td class="text-right">
          <div class="flex flex-wrap justify-end gap-2">
            <button class="btn-secondary" data-player-absent="${player.id}">
              ${player.status === "Waiting" || player.status === "Playing" ? "Absent" : "Return to Queue"}
            </button>
            <button class="btn-secondary" data-player-remove="${player.id}">Remove</button>
          </div>
        </td>
      </tr>
    `
    )
    .join("");
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
      const activeTally = {};
      state.courts.forEach(c => {
        if (c.status === "Active" && c.skill) {
          activeTally[c.skill] = (activeTally[c.skill] || 0) + 1;
        }
      });
      
      for (const [skill, count] of Object.entries(localAssignedTally)) {
        activeTally[skill] = (activeTally[skill] || 0) + count;
      }
      
      const queueOptions = SKILLS.map((skill) => {
        const deducted = localQueueDeductions[skill.key] || 0;
        return {
          key: skill.key,
          label: skill.label,
          length: (state.queues[skill.key] || []).length - deducted,
          isCustom: false
        };
      }).filter((queue) => queue.length >= 4);

      if (pendingIndex < state.pendingMatches.length) {
        queueOptions.push({
          key: "custom",
          label: "Custom",
          length: (state.pendingMatches.length - pendingIndex) * 4,
          isCustom: true
        });
      }

      if (!queueOptions.length) break;

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

function bindEvents() {
  elements.addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const genderSelect = document.getElementById("player-gender");
      await addPlayer({
        name: elements.nameInput.value,
        skill: elements.skillSelect.value,
        gender: genderSelect ? genderSelect.value : "",
      });
      elements.nameInput.value = "";
      elements.skillSelect.value = "";
      if (genderSelect) genderSelect.value = "";
      showToast("Player added");
    } catch (error) {
      console.error("Add player failed", error);
      showToast(formatFirebaseError(error), "error");
    }
  });

  if (elements.debugSave) {
    elements.debugSave.addEventListener("click", async () => {
      const rawName = elements.nameInput.value.trim();
      const name = rawName || `Debug-${Date.now().toString().slice(-6)}`;
      const skill = elements.skillSelect.value || "Beginner";

      try {
        await addPlayer({ name, skill });
        if (!rawName) {
          elements.nameInput.value = "";
        }
        showToast("Debug player saved");
      } catch (error) {
        console.error("Debug save failed", error);
        showToast(formatFirebaseError(error), "error");
      }
    });
  }

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
      try {
        await finishMatch(finishButton);
        showToast("Match finished");
      } catch (error) {
        console.error("Finish match failed", error);
        showToast(formatFirebaseError(error), "error");
      }
      return;
    }

    const toggleButton = event.target.getAttribute("data-toggle-court");
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
    const select = event.target.closest("select[data-player-skill]");
    if (!select) return;
    const playerId = select.dataset.playerSkill;
    try {
      await updatePlayerSkill(playerId, select.value);
      showToast("Player skill updated");
    } catch (error) {
      console.error("Update skill failed", error);
      showToast(formatFirebaseError(error), "error");
    }
  });

  elements.playersBody.addEventListener("click", async (event) => {
    const absent = event.target.getAttribute("data-player-absent");
    const remove = event.target.getAttribute("data-player-remove");

    try {
      if (absent) {
        const player = state.players.get(absent);
        await markPlayerAbsent(absent, player?.status === "Waiting" || player?.status === "Playing");
        showToast("Player status updated");
      }
      if (remove) {
        await removePlayer(remove);
        showToast("Player removed");
      }
    } catch (error) {
      console.error("Player update failed", error);
      showToast(formatFirebaseError(error), "error");
    }
  });
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
    
    customModal.classList.remove("hidden");
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
    setupSortable();
    cacheState();
    maybeAutoAssignMatches();
  });

  listenToCourts((courts) => {
    state.courts = courts;
    state.ready.courts = true;
    renderCourts();
    renderStats();
    cacheState();
    maybeAutoAssignMatches();
  });

  listenToPlayers((players) => {
    state.players = new Map(players.map((player) => [player.id, player]));
    state.ready.players = true;
    renderPlayers();
    renderQueues();
    renderCourts();
    renderStats();
    renderPendingMatches();
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
    maybeAutoAssignMatches();
  }, (error) => {
    console.error("Pending matches listener error:", error);
  });
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

bootstrap();

const PLAYERS_TO_IMPORT = ["Mitz", "Maxx", "Mitzel", "Dyan", "Howel", "Tobs", "Marcus", "nikka", "rui", "Mench", "Micah", "Chet + 1 hubby", "Dei", "Jeg", "Cris + 1 awasak", "Mak3n + 1 Hubby 🥰🥰", "tuni", "geng", "Fiorelli", "Henry", "Ellaine R.", "Agatha", "RR", "Onib", "Danniel", "Nicole R.", "zhyti", "Bryan", "Profy", "Ta Nhi", "Cy", "Chelle + 1 Hubby", "Judy Billan", "Jomar Billan", "Jenna Quierrez", "Axl Orcullo", "Mariz", "Gary +1 (Mabitac)", "Trisha", "Baisas", "Erica", "Rosemarie", "Paulo", "Jas", "claud", "Juliah", "Cheska", "Pojeg", "Kirt Bellido"];

if (!localStorage.getItem("imported-50-players-v1")) {
  localStorage.setItem("imported-50-players-v1", "true");
  const entries = PLAYERS_TO_IMPORT.map(name => ({ name, skill: "Beginner" }));
  import("./queue.js").then(module => {
    module.addPlayersBulk(entries).then(() => {
      console.log("Successfully imported 50 players!");
    }).catch(err => console.error("Import failed:", err));
  });
}
