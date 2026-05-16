import { SKILLS, listenToQueues, listenToPlayers } from "./queue.js";
import { COURTS, listenToCourts, ensureCourtsExist } from "./courts.js";

const state = {
  queues: {},
  courts: [],
  players: new Map(),
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
  });

  startTimerLoop();
}

bootstrap();
