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
import { skillLabelFromKey, getQueueDocRef, skillKeyFromLabel } from "./queue.js";

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

  // Read latest completed match so we can avoid repeating the same players immediately.
  const lastMatchPlayers = new Set();
  const lastTeammatePairs = new Set();
  const pairKey = (a, b) => [a, b].sort().join("__");
  if (skillLabel) {
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
        const lastPlayers = latest.players || [];
        lastPlayers.forEach((id) => lastMatchPlayers.add(id));
        const prevTeamA = latest.teamA || [];
        const prevTeamB = latest.teamB || [];
        if (prevTeamA.length === 2) lastTeammatePairs.add(pairKey(prevTeamA[0], prevTeamA[1]));
        if (prevTeamB.length === 2) lastTeammatePairs.add(pairKey(prevTeamB[0], prevTeamB[1]));
      }
    } catch (error) {
      // Fallback path while composite index is still building.
      const fallbackSnap = await getDocs(
        query(
          collection(db, "matches"),
          where("status", "==", "Completed"),
          where("skill", "==", skillLabel),
          limit(25)
        )
      );
      if (!fallbackSnap.empty) {
        const latest = fallbackSnap.docs
          .map((docSnap) => docSnap.data())
          .sort((a, b) => {
            const aMs = a?.endedAt?.toMillis ? a.endedAt.toMillis() : 0;
            const bMs = b?.endedAt?.toMillis ? b.endedAt.toMillis() : 0;
            return bMs - aMs;
          })[0];
        const lastPlayers = latest?.players || [];
        lastPlayers.forEach((id) => lastMatchPlayers.add(id));
        const prevTeamA = latest?.teamA || [];
        const prevTeamB = latest?.teamB || [];
        if (prevTeamA.length === 2) lastTeammatePairs.add(pairKey(prevTeamA[0], prevTeamA[1]));
        if (prevTeamB.length === 2) lastTeammatePairs.add(pairKey(prevTeamB[0], prevTeamB[1]));
      }
      console.warn("Using fallback last-match query; composite index is likely still building.", error);
    }
  }

  await runTransaction(db, async (tx) => {
    const [courtSnap, queueSnap] = await Promise.all([
      tx.get(courtRef),
      tx.get(queueRef),
    ]);

    if (!courtSnap.exists()) return;
    const court = courtSnap.data();
    if (court.status !== "Available") return;

    // Court-local memory from the last finished game (works even if match query/index is delayed).
    const courtLastPlayers = court.lastMatchPlayers || [];
    const courtLastTeamPairs = court.lastTeamPairs || [];
    courtLastPlayers.forEach((id) => lastMatchPlayers.add(id));
    courtLastTeamPairs.forEach((key) => lastTeammatePairs.add(key));

    if (court.allowedSkill && court.allowedSkill !== skillKey && skillKey !== "custom") {
      throw new Error(`This court only accepts ${court.allowedSkill} matches.`);
    }

    const orderRaw = queueSnap.exists() ? queueSnap.data().order || [] : [];
    const uniqueOrder = Array.from(new Set(orderRaw));

    // Validate queue entries in-transaction so active/invalid players are not re-matched.
    const orderRefs = uniqueOrder.map((id) => doc(db, "players", id));
    const orderSnaps = await Promise.all(orderRefs.map((ref) => tx.get(ref)));
    const cleanOrder = [];
    for (const snap of orderSnaps) {
      if (!snap.exists()) continue;
      const player = snap.data();
      if (player.status !== "Waiting") continue;
      if (player.currentMatchId) continue;
      cleanOrder.push(snap.id);
    }

    // Self-heal queue if duplicates/stale ids are present.
    const orderChanged =
      cleanOrder.length !== orderRaw.length ||
      cleanOrder.some((id, idx) => id !== orderRaw[idx]);
    if (orderChanged) {
      tx.set(
        queueRef,
        {
          skill: skillLabel,
          order: cleanOrder,
          updatedAt: now,
        },
        { merge: true }
      );
    }

    if (cleanOrder.length < 4) return;

    // Prefer players who did not play in the latest completed match (if enough are waiting).
    const preferredIds = cleanOrder.filter((id) => !lastMatchPlayers.has(id));
    const candidateOrder = preferredIds.length >= 4 ? preferredIds : cleanOrder;

    // Intelligent Matchmaking: Avoid playing with the same people
    const poolSize = Math.min(candidateOrder.length, 8);
    const poolIds = candidateOrder.slice(0, poolSize);
    
    const poolRefs = poolIds.map(id => doc(db, "players", id));
    const poolSnaps = await Promise.all(poolRefs.map(ref => tx.get(ref)));
    
    const poolData = poolSnaps.map(snap => ({
      id: snap.id,
      playedWith: snap.exists() && snap.data().playedWith ? snap.data().playedWith : {},
      lastResult: snap.exists() ? (snap.data().lastResult || null) : null,
    }));

    const getScore = (p1, p2) => {
      let s = (p1.playedWith[p2.id] || 0) + (p2.playedWith[p1.id] || 0);
      return s;
    };

    // Prefer a pool of only winners or only losers if 4+ exist
    const winners = poolData.filter(p => p.lastResult === "Win");
    const losers  = poolData.filter(p => p.lastResult === "Loss");
    const scoringPool = (winners.length >= 4 ? winners : (losers.length >= 4 ? losers : poolData));

    const anchor = scoringPool[0];
    let bestCombo = null;
    let minScore = Infinity;
    const others = scoringPool.slice(1);


    if (others.length < 3) {
      bestCombo = others.map(p => p.id);
    } else {
      for (let i = 0; i < others.length - 2; i++) {
        for (let j = i + 1; j < others.length - 1; j++) {
          for (let k = j + 1; k < others.length; k++) {
            const p1 = others[i];
            const p2 = others[j];
            const p3 = others[k];
            
            let score = 0;
            score += getScore(anchor, p1) + getScore(anchor, p2) + getScore(anchor, p3);
            score += getScore(p1, p2) + getScore(p1, p3) + getScore(p2, p3);
            
            // Add a small penalty for skipping people higher in the queue (lower index)
            score += (i + j + k) * 0.1;
            
            if (score < minScore) {
              minScore = score;
              bestCombo = [p1.id, p2.id, p3.id];
            }
          }
        }
      }
    }

    const selectedIds = [anchor.id, ...bestCombo];
    const remaining = cleanOrder.filter(id => !selectedIds.includes(id));

    // Intelligent Team Selection: Minimize teammate overlap
    const p = selectedIds.map(id => poolData.find(pd => pd.id === id));
    const combos = [
      { a: [p[0], p[1]], b: [p[2], p[3]] },
      { a: [p[0], p[2]], b: [p[1], p[3]] },
      { a: [p[0], p[3]], b: [p[1], p[2]] }
    ];
    
    let bestTeamCombo = combos[0];
    let minTeamScore = Infinity;
    const nonRepeatedCombos = combos.filter((c) => {
      const aPairBlocked = lastTeammatePairs.has(pairKey(c.a[0].id, c.a[1].id));
      const bPairBlocked = lastTeammatePairs.has(pairKey(c.b[0].id, c.b[1].id));
      return !aPairBlocked && !bPairBlocked;
    });
    const teamCandidates = nonRepeatedCombos.length ? nonRepeatedCombos : combos;
    for (const c of teamCandidates) {
      const aPairBlocked = lastTeammatePairs.has(pairKey(c.a[0].id, c.a[1].id));
      const bPairBlocked = lastTeammatePairs.has(pairKey(c.b[0].id, c.b[1].id));
      const repeatPenalty = (aPairBlocked ? 1000 : 0) + (bPairBlocked ? 1000 : 0);
      const sameResultPenalty = (pair) => {
        const r1 = pair[0].lastResult || null;
        const r2 = pair[1].lastResult || null;
        if (!r1 || !r2) return 0;
        // Encourage winner+loser partner rotation, discourage winner+winner / loser+loser.
        return r1 === r2 ? 80 : -20;
      };
      const score =
        getScore(c.a[0], c.a[1]) +
        getScore(c.b[0], c.b[1]) +
        sameResultPenalty(c.a) +
        sameResultPenalty(c.b) +
        repeatPenalty;
      if (score < minTeamScore) {
        minTeamScore = score;
        bestTeamCombo = c;
      }
    }

    const teamA = [bestTeamCombo.a[0].id, bestTeamCombo.a[1].id].sort(() => Math.random() - 0.5);
    const teamB = [bestTeamCombo.b[0].id, bestTeamCombo.b[1].id].sort(() => Math.random() - 0.5);
    const finalPlayers = [...teamA, ...teamB];

    tx.set(matchRef, {
      courtId,
      skill: skillLabel,
      players: finalPlayers,
      teamA,
      teamB,
      status: "Active",
      startedAt: now,
      endedAt: null,
      updatedAt: now,
    });

    tx.set(
      queueRef,
      {
        skill: skillLabel,
        order: remaining,
        updatedAt: now,
      },
      { merge: true }
    );

    tx.set(
      courtRef,
      {
        status: "Active",
        matchId: matchRef.id,
        players: finalPlayers,
        skill: skillLabel,
        startedAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

    finalPlayers.forEach((playerId) => {
      tx.set(
        doc(db, "players", playerId),
        {
          status: "Playing",
          currentMatchId: matchRef.id,
          updatedAt: now,
        },
        { merge: true }
      );
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

    // Determine which skill queues we'll need, then read them ALL now
    const skillKeysNeeded = new Set();
    playerSnaps.forEach((snap) => {
      if (!snap.exists()) return;
      const skillKey = skillKeyFromLabel(snap.data().skill);
      if (skillKey) skillKeysNeeded.add(skillKey);
    });

    const queueRefsMap = new Map();
    const queueSnapsMap = new Map();
    for (const key of skillKeysNeeded) {
      queueRefsMap.set(key, getQueueDocRef(key));
    }
    await Promise.all(
      Array.from(queueRefsMap.entries()).map(async ([key, ref]) => {
        queueSnapsMap.set(key, await tx.get(ref));
      })
    );

    // ── PHASE 2: ALL WRITES (no tx.get allowed below this line) ────────────

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

    const queueAdditions = new Map();

    playerSnaps.forEach((snap, idx) => {
      if (!snap.exists()) return;
      const player = snap.data();
      const playedWith = { ...(player.playedWith || {}) };
      const currentWins = player.wins || 0;
      const currentLosses = player.losses || 0;

      players.forEach((otherId) => {
        if (otherId !== snap.id) {
          playedWith[otherId] = (playedWith[otherId] || 0) + 1;
        }
      });

      const playerId = snap.id;
      let wins = currentWins;
      let losses = currentLosses;
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
