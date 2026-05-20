import {
  db,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  runTransaction,
} from "./firebase.js";
import { skillLabelFromKey, getQueueDocRef, skillKeyFromLabel, markPlayerAbsent } from "./queue.js";

export const COURTS = [
  { id: "court-1", name: "Court 1" },
  { id: "court-2", name: "Court 2" },
  { id: "court-3", name: "Court 3" },
];

export async function ensureCourtsExist() {
  await Promise.all(
    COURTS.map(async (court) => {
      const courtRef = doc(db, "courts", court.id);
      const snap = await getDoc(courtRef);
      if (!snap.exists()) {
        await setDoc(courtRef, {
          name: court.name,
          status: "Available",
          matchId: null,
          players: [],
          skill: null,
          allowedSkill: null,
          startedAt: null,
          updatedAt: serverTimestamp(),
        });
      }
    })
  );
}

export function listenToCourts(callback) {
  return onSnapshot(query(collection(db, "courts"), orderBy("name")), (snapshot) => {
    const courts = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));
    callback(courts);
  });
}

export async function assignMatchToCourt(courtId, skillKey) {
  const courtRef = doc(db, "courts", courtId);
  const queueRef = getQueueDocRef(skillKey);
  const matchRef = doc(collection(db, "matches"));
  const now = serverTimestamp();
  const skillLabel = skillLabelFromKey(skillKey);
  const pairKey = (a, b) => [a, b].sort().join("__");

  // Read last completed match to avoid repeating exact same 4 players or teams.
  const lastMatchPlayers = new Set();
  const lastTeammatePairs = new Set();
  try {
    const lastMatchSnap = await getDocs(
      query(
        collection(db, "matches"),
        where("status", "==", "Completed"),
        where("skill", "==", skillLabel),
        orderBy("endedAt", "desc"),
        limit(1)
      )
    );
    if (!lastMatchSnap.empty) {
      const latest = lastMatchSnap.docs[0].data();
      (latest.players || []).forEach(id => lastMatchPlayers.add(id));
      const prevA = latest.teamA || [];
      const prevB = latest.teamB || [];
      if (prevA.length === 2) lastTeammatePairs.add(pairKey(prevA[0], prevA[1]));
      if (prevB.length === 2) lastTeammatePairs.add(pairKey(prevB[0], prevB[1]));
    }
  } catch (_) {
    // Index may still be building — proceed without last-match data.
  }

  await runTransaction(db, async (tx) => {
    const [courtSnap, queueSnap] = await Promise.all([
      tx.get(courtRef),
      tx.get(queueRef),
    ]);

    if (!courtSnap.exists()) return;
    const court = courtSnap.data();
    if (court.status !== "Available") return;

    if (court.allowedSkill && court.allowedSkill !== skillKey && skillKey !== "custom") {
      throw new Error(`This court only accepts ${court.allowedSkill} matches.`);
    }

    // Merge court-local last-match memory (works even if Firestore index is delayed).
    (court.lastMatchPlayers || []).forEach(id => lastMatchPlayers.add(id));
    (court.lastTeamPairs || []).forEach(key => lastTeammatePairs.add(key));

    // ── Build a clean, validated queue ──────────────────────────────────────
    const orderRaw = queueSnap.exists() ? queueSnap.data().order || [] : [];
    const uniqueOrder = Array.from(new Set(orderRaw));

    const playerRefs = uniqueOrder.map(id => doc(db, "players", id));
    const playerSnaps = await Promise.all(playerRefs.map(ref => tx.get(ref)));

    const cleanOrder = [];   // valid player IDs in queue order
    const playerDataMap = new Map(); // id → player data

    for (const snap of playerSnaps) {
      if (!snap.exists()) continue;
      const data = snap.data();
      if (data.status !== "Waiting") continue;
      if (data.currentMatchId) continue;
      cleanOrder.push(snap.id);
      playerDataMap.set(snap.id, {
        id: snap.id,
        lastResult: data.lastResult || null,
        gp: (data.wins || 0) + (data.losses || 0),
        playedWith: data.playedWith || {},
      });
    }

    // Self-heal the queue document if it drifted.
    if (
      cleanOrder.length !== orderRaw.length ||
      cleanOrder.some((id, i) => id !== orderRaw[i])
    ) {
      tx.set(queueRef, { skill: skillLabel, order: cleanOrder, updatedAt: now }, { merge: true });
    }

    if (cleanOrder.length < 4) return;

    // ── Sort queue by fairness (GP and Freshness) ───────────────────────────
    cleanOrder.sort((a, b) => {
      const pA = playerDataMap.get(a);
      const pB = playerDataMap.get(b);
      
      // 1. Lowest Games Played (GP) always goes first
      if (pA.gp !== pB.gp) return pA.gp - pB.gp;
      
      // 2. Tiebreaker: Fresh players (didn't just play) go before repeat players
      const aFresh = !lastMatchPlayers.has(a);
      const bFresh = !lastMatchPlayers.has(b);
      if (aFresh && !bFresh) return -1;
      if (!aFresh && bFresh) return 1;
      
      return 0; // Maintain FIFO for exact ties
    });

    if (cleanOrder.length < 4) return;

    // ── Take exactly the top 4 most deserving players ───────────────────────
    const bestCombo = cleanOrder.slice(0, 4);
    const selectedIds = bestCombo;

    // ── Pick balanced teams from these 4 players ────────────────────────────
    const comboData = bestCombo.map(id => playerDataMap.get(id));
    const teamCombos = [
      { a: [comboData[0], comboData[1]], b: [comboData[2], comboData[3]] },
      { a: [comboData[0], comboData[2]], b: [comboData[1], comboData[3]] },
      { a: [comboData[0], comboData[3]], b: [comboData[1], comboData[2]] },
    ];

    const getOverlap = (p1, p2) => (p1.playedWith[p2.id] || 0) + (p2.playedWith[p1.id] || 0);

    let bestTeamCombo = teamCombos[0];
    let minTeamScore = Infinity;
    
    for (const combo of teamCombos) {
      const aPairBlocked = lastTeammatePairs.has(pairKey(combo.a[0].id, combo.a[1].id));
      const bPairBlocked = lastTeammatePairs.has(pairKey(combo.b[0].id, combo.b[1].id));
      
      // Score = How many times they've played together + huge penalty if they just teamed up
      let score = getOverlap(combo.a[0], combo.a[1]) + getOverlap(combo.b[0], combo.b[1]);
      if (aPairBlocked) score += 1000;
      if (bPairBlocked) score += 1000;
      
      // Balance W/L: Encourage a Winner and a Loser to team up, discourage W+W vs L+L
      const sameResult = (pair) => {
        if (!pair[0].lastResult || !pair[1].lastResult) return 0;
        return pair[0].lastResult === pair[1].lastResult ? 50 : -50;
      };
      score += sameResult(combo.a) + sameResult(combo.b);

      if (score < minTeamScore) {
        minTeamScore = score;
        bestTeamCombo = combo;
      }
    }

    const teamA = [bestTeamCombo.a[0].id, bestTeamCombo.a[1].id];
    const teamB = [bestTeamCombo.b[0].id, bestTeamCombo.b[1].id];
    const finalPlayers = [...teamA, ...teamB];
    const remaining = cleanOrder.filter(id => !finalPlayers.includes(id));

    // ── Write everything atomically ─────────────────────────────────────────
    tx.set(matchRef, {
      courtId, skill: skillLabel,
      players: finalPlayers, teamA, teamB,
      status: "Active",
      startedAt: now, endedAt: null, updatedAt: now,
    });

    tx.set(queueRef, { skill: skillLabel, order: remaining, updatedAt: now }, { merge: true });

    tx.set(courtRef, {
      status: "Active", matchId: matchRef.id,
      players: finalPlayers, skill: skillLabel,
      startedAt: now, updatedAt: now,
    }, { merge: true });

    finalPlayers.forEach(playerId => {
      tx.set(doc(db, "players", playerId), {
        status: "Playing", currentMatchId: matchRef.id, updatedAt: now,
      }, { merge: true });
    });
  });

  return matchRef.id;
}


export async function toggleCourtStatus(courtId) {
  const courtRef = doc(db, "courts", courtId);
  const now = serverTimestamp();

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(courtRef);
    if (!snap.exists()) throw new Error("Court not found");
    const court = snap.data();
    
    if (court.status === "Active") {
      throw new Error("Cannot toggle status of an active court.");
    }
    
    const newStatus = court.status === "Available" ? "Inactive" : "Available";
    tx.set(courtRef, { status: newStatus, updatedAt: now }, { merge: true });
  });
}

export async function finishMatch(courtId, winnerTeam = null) {
  const courtRef = doc(db, "courts", courtId);

  await runTransaction(db, async (tx) => {
    // ── PHASE 1: ALL READS ─────────────────────────────────────────────────
    const courtSnap = await tx.get(courtRef);
    if (!courtSnap.exists()) return;

    const court = courtSnap.data();
    if (!court.matchId) return;

    const matchRef = doc(db, "matches", court.matchId);
    const matchSnap = await tx.get(matchRef);
    const match = matchSnap.exists() ? matchSnap.data() : null;

    const players = match?.players || court.players || [];
    const teamA = match?.teamA || court.players?.slice(0, 2) || [];
    const teamB = match?.teamB || court.players?.slice(2, 4) || [];
    const now = serverTimestamp();


    const playerRefs = players.map(id => doc(db, "players", id));
    const playerSnaps = await Promise.all(playerRefs.map(ref => tx.get(ref)));

    // ── PHASE 2: ALL WRITES ────────────────────────────────────────────────
    if (matchSnap.exists()) {
      tx.set(matchRef, { status: "Completed", endedAt: now, updatedAt: now, winner: winnerTeam }, { merge: true });
    }

    const lastTeamPairs = [];
    if (teamA.length === 2) lastTeamPairs.push([teamA[0], teamA[1]].sort().join("__"));
    if (teamB.length === 2) lastTeamPairs.push([teamB[0], teamB[1]].sort().join("__"));

    tx.set(courtRef, {
      status: "Available",
      matchId: null,
      players: [],
      skill: null,
      startedAt: null,
      lastMatchPlayers: players,
      lastTeamPairs,
      lastCompletedAt: now,
      updatedAt: now
    }, { merge: true });

    playerSnaps.forEach((snap, idx) => {
      if (!snap.exists()) return;
      const player = snap.data();
      const playedWith = { ...(player.playedWith || {}) };

      players.forEach((otherId) => {
        if (otherId !== snap.id) {
          playedWith[otherId] = (playedWith[otherId] || 0) + 1;
        }
      });

      const playerId = snap.id;
      let wins = player.wins || 0;
      let losses = player.losses || 0;
      let lastResult = null;

      if (winnerTeam === "teamA" && teamA.includes(playerId)) { wins++; lastResult = "Win"; }
      else if (winnerTeam === "teamB" && teamB.includes(playerId)) { wins++; lastResult = "Win"; }
      else if (winnerTeam === "teamA" && teamB.includes(playerId)) { losses++; lastResult = "Loss"; }
      else if (winnerTeam === "teamB" && teamA.includes(playerId)) { losses++; lastResult = "Loss"; }

      tx.set(playerRefs[idx], { status: "Standby", currentMatchId: null, playedWith, wins, losses, lastResult, lastMatchEndedAt: now, updatedAt: now }, { merge: true });
    });
  });

}

export async function queueCustomMatch(playerIds, teamA, teamB) {
  const matchRef = doc(collection(db, "matches"));
  const now = serverTimestamp();

  await runTransaction(db, async (tx) => {
    const playerRefs = playerIds.map(id => doc(db, "players", id));
    const playerSnaps = await Promise.all(playerRefs.map(ref => tx.get(ref)));
    
    const queuesToUpdate = new Map();
    
    playerSnaps.forEach((snap, idx) => {
      if (!snap.exists()) return;
      const player = snap.data();
      if (player.status === "Waiting") {
        const skillKey = skillKeyFromLabel(player.skill);
        if (skillKey) {
          if (!queuesToUpdate.has(skillKey)) queuesToUpdate.set(skillKey, []);
          queuesToUpdate.get(skillKey).push(playerIds[idx]);
        }
      }
    });

    const queueRefs = Array.from(queuesToUpdate.keys()).map(skillKey => ({
      skillKey,
      ref: getQueueDocRef(skillKey)
    }));
    
    const queueSnaps = await Promise.all(queueRefs.map(q => tx.get(q.ref)));
    
    queueSnaps.forEach((qSnap, idx) => {
      if (qSnap.exists()) {
        const skillKey = queueRefs[idx].skillKey;
        const toRemove = queuesToUpdate.get(skillKey);
        const order = qSnap.data().order || [];
        const updated = order.filter(id => !toRemove.includes(id));
        tx.set(queueRefs[idx].ref, { order: updated, updatedAt: now }, { merge: true });
      }
    });

    tx.set(matchRef, {
      courtId: null,
      skill: "Custom",
      players: playerIds,
      teamA: teamA,
      teamB: teamB,
      status: "Pending",
      createdAt: now,
      startedAt: null,
      endedAt: null,
      updatedAt: now,
    });

    playerRefs.forEach(ref => {
      tx.set(ref, {
        status: "Stacked",
        currentMatchId: matchRef.id,
        updatedAt: now
      }, { merge: true });
    });
  });
}

export async function activatePendingMatch(matchId, courtId) {
  const courtRef = doc(db, "courts", courtId);
  const matchRef = doc(db, "matches", matchId);
  const now = serverTimestamp();

  await runTransaction(db, async (tx) => {
    const courtSnap = await tx.get(courtRef);
    if (!courtSnap.exists()) throw new Error("Court not found");
    if (courtSnap.data().status !== "Available") throw new Error("Court is not available");

    const matchSnap = await tx.get(matchRef);
    if (!matchSnap.exists()) throw new Error("Match not found");
    const match = matchSnap.data();
    if (match.status !== "Pending") throw new Error("Match is not pending");

    const playerIds = match.players;
    const playerRefs = playerIds.map(id => doc(db, "players", id));

    tx.set(matchRef, {
      courtId,
      status: "Active",
      startedAt: now,
      updatedAt: now,
    }, { merge: true });

    tx.set(courtRef, {
      status: "Active",
      matchId: matchRef.id,
      players: playerIds,
      skill: "Custom",
      startedAt: now,
      updatedAt: now,
    }, { merge: true });

    playerRefs.forEach(ref => {
      tx.set(ref, {
        status: "Playing",
        updatedAt: now
      }, { merge: true });
    });
  });
}

export async function updateCourtAllowedSkill(courtId, allowedSkill) {
  const courtRef = doc(db, "courts", courtId);
  await setDoc(courtRef, { allowedSkill, updatedAt: serverTimestamp() }, { merge: true });
}
