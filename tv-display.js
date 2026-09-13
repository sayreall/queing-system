import { SKILLS, listenToQueues, listenToPlayers } from "./queue.js";
import { COURTS, listenToCourts, ensureCourtsExist } from "./courts.js";
import { db, collection, query, where, onSnapshot, getTenantCollection, getTenantDoc, auth, onAuthStateChanged } from "./firebase.js";

const state = {
  queues: {},
  courts: [],
  players: new Map(),
  completedMatches: [],
  pendingMatches: [],
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
    return \`
      <div class="flex items-center justify-between py-1.5 border-b border-slate-700/50 last:border-0">
        <span class="font-semibold text-slate-100">\${p.name}</span>
        <div class="flex items-center gap-2">
          \${wBadge} \${lBadge}
        </div>
      </div>\`;
  };

  return \`
    <div class="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3 h-full">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-xs uppercase tracking-widest font-bold text-emerald-400">Next Match</span>
        \${typeTag}
        <span class="px-2 py-0.5 rounded-full text-xs font-bold border border-slate-600 \${skillColorClass}">\${skillLabel}</span>
        \${courtTag}
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div class="glass-card p-3" style="border-color: rgba(31, 207, 177, 0.2); background: rgba(31, 207, 177, 0.05);">
          <h4 class="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2" style="color:#1fcfb1;">Team A</h4>
          <div class="space-y-1">
            \${teamAIds.map(playerRow).join("")}
          </div>
        </div>
        <div class="glass-card p-3" style="border-color: rgba(232, 90, 26, 0.2); background: rgba(232, 90, 26, 0.05);">
          <h4 class="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2" style="color:#E85A1A;">Team B</h4>
          <div class="space-y-1">
            \${teamBIds.map(playerRow).join("")}
          </div>
        </div>
      </div>
    </div>\`;
}

function renderUpcomingMatches() {
  const container = document.getElementById("tv-upcoming-matches");
  if (!container) return;

  const availableCourtsCount = state.courts.filter(c => c.status === "Available").length;

  const localActiveTally = {};
  state.courts.forEach(c => {
    if (c.status === "Active" && c.skill) {
      localActiveTally[c.skill] = (localActiveTally[c.skill] || 0) + 1;
    }
  });

  const localQueueOptions = SKILLS.map(skill => ({
    key: skill.key,
    label: skill.label,
    players: [...(state.queues[skill.key] || [])],
  }));

  const localPendingMatches = [...(state.pendingMatches || [])];
  
  const activePlayers = new Set(
    state.courts
      .filter(c => c.status === "Active")
      .flatMap(c => c.players || [])
  );
  
  const upcomingMatchesHTML = [];

  for (let i = 0; i < 3; i++) {
    let matchHtml = null;
    let matchPlayers = [];
    
    // Check custom matches first
    let foundCustom = false;
    while (localPendingMatches.length > 0) {
      const match = localPendingMatches.shift();
      const allPlayers = [...(match.teamA || []), ...(match.teamB || [])];
      
      const hasBusy = allPlayers.some(id => activePlayers.has(id));
      if (!hasBusy) {
        foundCustom = true;
        matchHtml = buildNextMatchHTML(match.teamA, match.teamB, "Custom", "Stacked", i < availableCourtsCount);
        matchPlayers = allPlayers;
        break;
      }
    }
    
    if (!foundCustom) {
      const validOptions = localQueueOptions.filter(q => {
        const availableCount = q.players.filter(id => !activePlayers.has(id)).length;
        return availableCount >= 4;
      });
      
      if (validOptions.length === 0) {
        break; // No more matches can be formed
      }
      
      validOptions.sort((a, b) => {
        const aActive = localActiveTally[a.label] || 0;
        const bActive = localActiveTally[b.label] || 0;
        if (aActive !== bActive) return aActive - bActive;
        const aAvail = a.players.filter(id => !activePlayers.has(id)).length;
        const bAvail = b.players.filter(id => !activePlayers.has(id)).length;
        return bAvail - aAvail;
      });
      
      const chosen = validOptions[0];
      const availablePlayersForQueue = chosen.players.filter(id => !activePlayers.has(id));
      const nextIds = availablePlayersForQueue.slice(0, 4);
      
      const { teamA, teamB } = buildPreviewTeams(nextIds);
      matchHtml = buildNextMatchHTML(teamA, teamB, chosen.label, "Auto", i < availableCourtsCount);
      matchPlayers = nextIds;
      
      // Update local state for next iteration
      localActiveTally[chosen.label] = (localActiveTally[chosen.label] || 0) + 1;
      chosen.players = chosen.players.filter(id => !nextIds.includes(id));
    }
    
    if (matchHtml) {
      upcomingMatchesHTML.push(matchHtml);
      matchPlayers.forEach(id => activePlayers.add(id));
    }
  }
  
  if (upcomingMatchesHTML.length > 0) {
    container.innerHTML = upcomingMatchesHTML.join("");
  } else {
    container.innerHTML = \`<div class="col-span-full glass-card text-center text-slate-400 py-8">No players waiting for a match</div>\`;
  }
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

  listenToCourts((courts) => {
    state.courts = courts;
    renderCourts();
    renderUpcomingMatches();
  });

  listenToQueues((queues) => {
    state.queues = queues;
    renderUpcomingMatches();
  });

  listenToPlayers((players) => {
    state.players = new Map(players.map((player) => [player.id, player]));
    renderCourts();
    renderUpcomingMatches();
    renderLeaderboards();
  });

  onSnapshot(query(getTenantCollection("matches"), where("status", "==", "Completed")), (snap) => {
    state.completedMatches = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    renderLeaderboards();
  });

  onSnapshot(query(getTenantCollection("matches"), where("status", "==", "Pending")), (snap) => {
    state.pendingMatches = snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a, b) => a.createdAt - b.createdAt);
    renderUpcomingMatches();
  });

  startTimerLoop();
}

onAuthStateChanged(auth, (user) => {
  const urlParams = new URLSearchParams(window.location.search);
  const tenantParam = urlParams.get('tenant');
  if (user || tenantParam) {
    bootstrap();
  } else {
    window.location.href = 'login.html';
  }
});
