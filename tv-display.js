import { SKILLS, listenToQueues, listenToPlayers } from "./queue.js";
import { COURTS, listenToCourts, ensureCourtsExist } from "./courts.js";
import { db, collection, query, where, onSnapshot , getTenantCollection, getTenantDoc} from "./firebase.js";

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

  // Calculate stats for all players
  const ranked = players.map(p => {
    const wins = p.wins || 0;
    const losses = p.losses || 0;
    const gp = wins + losses;
    const winPct = gp > 0 ? wins / gp : 0;
    return { ...p, wins, gp, winPct };
  });

  // Sort by Wins (descending), then Win% (descending), then least games played
  ranked.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.winPct !== a.winPct) return b.winPct - a.winPct;
    return a.gp - b.gp;
  });

  // Top 3
  const top3 = ranked.slice(0, 3);

  // Helper to render
  const fillCard = (rank, player) => {
    const elName = document.getElementById(`leaderboard-${rank}-name`);
    const elWins = document.getElementById(`leaderboard-${rank}-wins`);
    const elWinPct = document.getElementById(`leaderboard-${rank}-winpct`);
    if (!elName || !elWins || !elWinPct) return;
    
    if (player && player.wins > 0) { // Only show if they have at least 1 win
      elName.textContent = player.name;
      elWins.textContent = player.wins;
      elWinPct.textContent = Math.round(player.winPct * 100) + "%";
    } else {
      elName.textContent = "--";
      elWins.textContent = "0";
      elWinPct.textContent = "0%";
    }
  };

  fillCard(1, top3[0]);
  fillCard(2, top3[1]);
  fillCard(3, top3[2]);

  // Full Rankings
  const fullContainer = document.getElementById("full-rankings-container");
  if (fullContainer) {
    if (ranked.length === 0) {
      fullContainer.innerHTML = `<div class="col-span-full text-slate-500 text-center py-4">No active players</div>`;
    } else {
      fullContainer.innerHTML = ranked.map((player, index) => {
        const rank = index + 1;
        const rankColor = rank === 1 ? "text-gold" : rank === 2 ? "text-slate-300" : rank === 3 ? "text-amber-600" : "text-slate-500";
        
        return `
          <div class="flex items-center justify-between p-2 rounded-lg bg-slate-800/40 border border-slate-700/50">
            <div class="flex items-center gap-2 overflow-hidden">
              <span class="font-display font-bold text-lg w-6 text-center ${rankColor}">#${rank}</span>
              <span class="font-semibold text-slate-200 truncate" style="max-width: 140px;" title="${player.name}">${player.name}</span>
            </div>
            <div class="flex flex-col items-end text-[10px] leading-tight">
              <span class="font-bold text-emerald-400">${player.wins}W - ${player.losses}L</span>
              <span class="text-slate-400">${Math.round(player.winPct * 100)}% WR</span>
            </div>
          </div>
        `;
      }).join("");
    }
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

  onSnapshot(query(getTenantCollection("matches"), where("status", "==", "Completed")), (snap) => {
    state.completedMatches = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    renderLeaderboards();
  });

  startTimerLoop();
}

bootstrap();
