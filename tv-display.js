import { SKILLS, listenToQueues, listenToPlayers } from "./queue.js";
import { COURTS, listenToCourts, ensureCourtsExist } from "./courts.js";
import { db, collection, query, where, onSnapshot } from "./firebase.js";

const state = {
  queues: {},
  courts: [],
  players: new Map(),
  completedMatches: [],
};

function renderCourts() {
  COURTS.forEach((courtInfo) => {
    const court = state.courts.find((item) => item.id === courtInfo.id);
    if (!court) return;

    const statusEl = document.querySelector(`[data-tv-status="${courtInfo.id}"]`);
    const timerEl = document.querySelector(`[data-tv-timer="${courtInfo.id}"]`);

    if (statusEl) {
      statusEl.textContent = court.status === "Active" ? (court.skill ? court.skill : "Active") : court.status;
      statusEl.classList.toggle("active", court.status === "Active");
    }

    if (timerEl && !court.startedAt) {
      timerEl.textContent = "00:00";
    }

    const nameFor = (playerId) => state.players.get(playerId)?.name || "--";

    const teamA = document.querySelector(`[data-tv-team-a="${courtInfo.id}"]`);
    const teamA2 = document.querySelector(`[data-tv-team-a2="${courtInfo.id}"]`);
    const teamB = document.querySelector(`[data-tv-team-b="${courtInfo.id}"]`);
    const teamB2 = document.querySelector(`[data-tv-team-b2="${courtInfo.id}"]`);

    const players = court.players || [];
    if (teamA) teamA.textContent = nameFor(players[0]);
    if (teamA2) teamA2.textContent = nameFor(players[1]);
    if (teamB) teamB.textContent = nameFor(players[2]);
    if (teamB2) teamB2.textContent = nameFor(players[3]);
  });
}

function renderQueues() {
  SKILLS.forEach((skill) => {
    const list = document.querySelector(`[data-tv-queue="${skill.key}"]`);
    if (!list) return;

    const order = state.queues[skill.key] || [];
    list.innerHTML = "";

    if (!order.length) {
      const empty = document.createElement("li");
      empty.className = "queue-empty";
      empty.textContent = "No players waiting";
      list.appendChild(empty);
      return;
    }

    order.slice(0, 4).forEach((playerId, index) => {
      const item = document.createElement("li");
      item.className = "queue-item";
      const player = state.players.get(playerId);
      item.textContent = `${index + 1}. ${player ? player.name : "Unknown"}`;
      list.appendChild(item);
    });
  });
}

function renderLeaderboards() {
  const players = Array.from(state.players.values()).filter(p => p.status !== "Archived");

  // Ironman
  let ironman = null;
  let maxGP = -1;
  players.forEach(p => {
    const gp = (p.wins || 0) + (p.losses || 0);
    if (gp > maxGP && gp > 0) {
      maxGP = gp;
      ironman = p;
    }
  });

  const elIronmanName = document.getElementById("stat-ironman-name");
  const elIronmanVal = document.getElementById("stat-ironman-val");
  if (ironman) {
    elIronmanName.textContent = ironman.name;
    elIronmanVal.textContent = maxGP;
  }

  // Top Performer
  let topPerformer = null;
  let maxWinPct = -1;
  players.forEach(p => {
    const gp = (p.wins || 0) + (p.losses || 0);
    if (gp >= 3) {
      const pct = (p.wins || 0) / gp;
      if (pct > maxWinPct) {
        maxWinPct = pct;
        topPerformer = p;
      }
    }
  });

  const elTopPerformerName = document.getElementById("stat-topperformer-name");
  const elTopPerformerVal = document.getElementById("stat-topperformer-val");
  if (topPerformer) {
    elTopPerformerName.textContent = topPerformer.name;
    elTopPerformerVal.textContent = Math.round(maxWinPct * 100) + "%";
  }

  // Longest Match
  let longestMatch = null;
  let maxDuration = -1;
  state.completedMatches.forEach(m => {
    if (m.startedAt && m.endedAt) {
      let start = m.startedAt.toMillis ? m.startedAt.toMillis() : (m.startedAt.seconds * 1000 || new Date(m.startedAt).getTime());
      let end = m.endedAt.toMillis ? m.endedAt.toMillis() : (m.endedAt.seconds * 1000 || new Date(m.endedAt).getTime());
      if (!isNaN(start) && !isNaN(end)) {
        const duration = end - start;
        if (duration > maxDuration) {
          maxDuration = duration;
          longestMatch = m;
        }
      }
    }
  });

  const elLongestTime = document.getElementById("stat-longestmatch-time");
  const elLongestPlayers = document.getElementById("stat-longestmatch-players");
  if (longestMatch && maxDuration > 0) {
    const mins = Math.floor(maxDuration / 60000);
    const secs = Math.floor((maxDuration % 60000) / 1000);
    elLongestTime.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    
    const nameFor = (id) => state.players.get(id)?.name || "Unknown";
    const playersArr = longestMatch.players || [];
    elLongestPlayers.textContent = playersArr.map(nameFor).join(", ");
  }
}

function startTimerLoop() {
  setInterval(() => {
    state.courts.forEach((court) => {
      const timerEl = document.querySelector(`[data-tv-timer="${court.id}"]`);
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

async function bootstrap() {
  await ensureCourtsExist();

  listenToCourts((courts) => {
    state.courts = courts;
    renderCourts();
  });

  listenToQueues((queues) => {
    state.queues = queues;
    renderQueues();
  });

  listenToPlayers((players) => {
    state.players = new Map(players.map((player) => [player.id, player]));
    renderCourts();
    renderQueues();
    renderLeaderboards();
  });

  onSnapshot(query(collection(db, "matches"), where("status", "==", "Completed")), (snap) => {
    state.completedMatches = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    renderLeaderboards();
  });

  startTimerLoop();
}

bootstrap();
