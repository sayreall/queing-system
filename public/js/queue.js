import {
  db,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  writeBatch, getTenantCollection, getTenantDoc, getDocFromCache} from "./firebase.js";

// Custom runTransaction that uses writeBatch to enable offline support!
const runTransaction = async (db, callback) => {
  const batch = writeBatch(db);
  const txMock = {
    get: async (ref) => {
      try {
        return await getDoc(ref);
      } catch (err) {
        if (err.code === "unavailable") {
          return await getDocFromCache(ref);
        }
        throw err;
      }
    },
    set: (ref, data, opts) => batch.set(ref, data, opts),
    update: (ref, data) => batch.update(ref, data),
    delete: (ref) => batch.delete(ref)
  };
  await callback(txMock);
  batch.commit(); // Don't await so it returns instantly for offline UI!
};

export const RATINGS = [
  { label: "2.0", key: "rating-2-0", rank: "Beginner" },
  { label: "2.5", key: "rating-2-5", rank: "Novice" },
  { label: "3.0", key: "rating-3-0", rank: "Low Intermediate" },
  { label: "3.5", key: "rating-3-5", rank: "High Intermediate" },
  { label: "4.0", key: "rating-4-0", rank: "High Intermediate" },
  { label: "4.5", key: "rating-4-5", rank: "Advanced" },
  { label: "5.0", key: "rating-5-0", rank: "Advanced" },
];

// Retained as an internal alias while the rest of the queue/court code uses
// its existing helper names. Every label is now a rating, never a skill level.
export const SKILLS = RATINGS;

const skillByKey = new Map(SKILLS.map((skill) => [skill.key, skill.label]));
const skillByLabel = new Map(
  SKILLS.map((skill) => [skill.label.toLowerCase(), skill])
);

const queueState = new Map();

export function normalizeSkill(input) {
  const rating = normalizeRating(input);
  return RATINGS.find((item) => Number(item.label) === rating)?.label || null;
}

export function normalizeRating(input) {
  if (input === undefined || input === null || String(input).trim() === "") return null;
  const rating = Number(input);
  if (!Number.isFinite(rating) || rating < 0) return null;
  return Math.round(rating * 100) / 100;
}

export function playerRatingLabel(player) {
  const directRating = normalizeSkill(player?.rating);
  if (directRating) return directRating;
  // Legacy records remain visible after the migration, without exposing their
  // previous skill level in the UI.
  const legacyRatings = { Beginner: "2.5", Intermediate: "3.5", Advanced: "4.5" };
  return legacyRatings[player?.skill] || "2.0";
}

export function ratingRankLabel(input) {
  const rating = typeof input === "object" ? playerRatingLabel(input) : normalizeSkill(input);
  return RATINGS.find((item) => item.label === rating)?.rank || "Unrated";
}

export function skillKeyFromLabel(label) {
  if (!label) return null;
  const match = skillByLabel.get(label.toLowerCase());
  return match ? match.key : null;
}

export function skillLabelFromKey(key) {
  return skillByKey.get(key) || null;
}

export function normalizeName(name) {
  return name.trim().replace(/\s+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function getQueueDocRef(skillKey) {
  return getTenantDoc("queues", skillKey);
}

export async function ensureQueuesExist() {
  await Promise.all(
    SKILLS.map(async (skill) => {
      const ref = getQueueDocRef(skill.key);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, {
          skill: skill.label,
          order: [],
          updatedAt: serverTimestamp(),
        });
      }
    })
  );

  // Carry existing queue positions into their equivalent rating queues once,
  // so upgrading does not make active legacy players disappear from the board.
  const legacyQueueMap = {
    beginner: "rating-2-5",
    intermediate: "rating-3-5",
    advanced: "rating-4-5",
  };
  await Promise.all(Object.entries(legacyQueueMap).map(async ([legacyKey, ratingKey]) => {
    const [legacySnap, ratingSnap] = await Promise.all([
      getDoc(getQueueDocRef(legacyKey)),
      getDoc(getQueueDocRef(ratingKey)),
    ]);
    const legacyOrder = legacySnap.exists() ? legacySnap.data().order || [] : [];
    const ratingOrder = ratingSnap.exists() ? ratingSnap.data().order || [] : [];
    if (legacyOrder.length && !ratingOrder.length) {
      await setDoc(getQueueDocRef(ratingKey), {
        skill: skillLabelFromKey(ratingKey),
        order: legacyOrder,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    }
  }));
}

export async function addPlayer({ name, rating, gender, location, practicePartner }) {
  const trimmedName = normalizeName(name || "");
  const normalizedRating = normalizeSkill(rating);
  const playerGender = gender || "Unspecified";
  const playerLocation = normalizeName(location || "");
  const playerPracticePartner = practicePartner || null;

  if (!trimmedName) throw new Error("Player name is required.");
  if (!normalizedRating) throw new Error("Please select a valid rating.");

  const nameLower = trimmedName.toLowerCase();
  const existing = await getDocs(
    query(getTenantCollection("players"), where("nameLower", "==", nameLower), limit(1))
  );

  let playerRef;
  let isRevive = false;
  let existingPlayer = null;

  if (!existing.empty) {
    const docSnap = existing.docs[0];
    existingPlayer = docSnap.data();
    playerRef = docSnap.ref;
    
    if (existingPlayer.status === "Archived") {
      isRevive = true;
    } else {
      // Player exists and is active. Update their skill, gender, location, and return.
      if (playerRatingLabel(existingPlayer) !== normalizedRating) {
        await updatePlayerSkill(playerRef.id, normalizedRating);
      }
      
      // Update other fields
      await runTransaction(db, async (tx) => {
        tx.set(playerRef, {
          gender: playerGender,
          location: playerLocation,
          rating: normalizedRating,
          updatedAt: serverTimestamp(),
        }, { merge: true });
      });
      
      return playerRef.id;
    }
  } else {
    playerRef = getTenantDoc("players");
  }

  const now = serverTimestamp();

  // Use a transaction to ensure clean state
  await runTransaction(db, async (tx) => {
    if (isRevive) {
      tx.set(playerRef, {
        rating: normalizedRating,
        gender: playerGender,
        location: playerLocation,
        status: "Standby",
        playedWith: {},
        updatedAt: now,
      }, { merge: true });
    } else {
      tx.set(playerRef, {
        name: trimmedName,
        nameLower,
        rating: normalizedRating,
        gender: playerGender,
        location: playerLocation,
        status: "Standby",
        playedWith: {},
        currentMatchId: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  });

  return playerRef.id;
}

export async function addPlayersBulk(entries, addToQueue = false) {
  const now = serverTimestamp();
  const batch = writeBatch(db);

  const allPlayersSnap = await getDocs(getTenantCollection("players"));
  const existingMap = new Map();
  allPlayersSnap.forEach(snap => {
    existingMap.set(snap.data().nameLower, snap);
  });

  const queuesToUpdate = {};
  if (addToQueue) {
    const allQueuesSnap = await getDocs(getTenantCollection("queues"));
    allQueuesSnap.forEach(snap => {
      queuesToUpdate[snap.id] = snap.data().order || [];
    });
  }

  entries.forEach((entry) => {
    const trimmedName = normalizeName(entry.name || "");
    const normalizedRating = normalizeSkill(entry.rating);
    const playerGender = entry.gender || "Unspecified";
    const playerLocation = normalizeName(entry.location || entry.Location || "");
    if (!trimmedName || !normalizedRating) return;

    const nameLower = trimmedName.toLowerCase();
    const existingSnap = existingMap.get(nameLower);
    
    let playerRef;
    let isRevive = false;

    if (existingSnap) {
      if (existingSnap.data().status === "Archived") {
        playerRef = existingSnap.ref;
        isRevive = true;
      } else {
        // Skip adding if they are already an active player
        return;
      }
    } else {
      playerRef = getTenantDoc("players");
      // Add to existingMap so duplicates in the same bulk import don't crash
      existingMap.set(nameLower, { ref: playerRef, data: () => ({ status: addToQueue ? "Waiting" : "Roster" }) });
    }

    const initialStatus = addToQueue ? "Waiting" : "Roster";

    if (isRevive) {
      batch.set(playerRef, {
        rating: normalizedRating,
        gender: playerGender,
        location: playerLocation,
        status: initialStatus,
        playedWith: {},
        updatedAt: now,
      }, { merge: true });
    } else {
      batch.set(playerRef, {
        name: trimmedName,
        nameLower,
        rating: normalizedRating,
        gender: playerGender,
        location: playerLocation,
        status: initialStatus,
        playedWith: {},
        currentMatchId: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (addToQueue) {
      const skillKey = skillKeyFromLabel(normalizedRating);
      if (!queuesToUpdate[skillKey]) queuesToUpdate[skillKey] = [];
      queuesToUpdate[skillKey].push(playerRef.id);
    }
  });

  if (addToQueue) {
    for (const [skillKey, order] of Object.entries(queuesToUpdate)) {
      batch.set(getQueueDocRef(skillKey), { skill: skillLabelFromKey(skillKey), order, updatedAt: now }, { merge: true });
    }
  }

  await batch.commit();
}

export async function removePlayer(playerId) {
  const playerRef = getTenantDoc("players", playerId);

  await runTransaction(db, async (tx) => {
    const playerSnap = await tx.get(playerRef);
    if (!playerSnap.exists()) return;

    const player = playerSnap.data();
    const skillKey = skillKeyFromLabel(playerRatingLabel(player));
    const queueRef = getQueueDocRef(skillKey);
    const queueSnap = await tx.get(queueRef);

    if (queueSnap.exists()) {
      const order = queueSnap.data().order || [];
      let filtered = order.map((id) => id === playerId ? "EMPTY" : id);
      while (filtered.length > 0 && filtered[filtered.length - 1] === "EMPTY") {
        filtered.pop();
      }
      tx.set(
        queueRef,
        { skill: playerRatingLabel(player), order: filtered, updatedAt: serverTimestamp() },
        { merge: true }
      );
    }

    tx.delete(playerRef);
  });
}

export async function archiveSinglePlayer(playerId) {
  const playerRef = getTenantDoc("players", playerId);
  const now = serverTimestamp();
  const archivedDate = new Date().toLocaleDateString();

  await runTransaction(db, async (tx) => {
    const playerSnap = await tx.get(playerRef);
    if (!playerSnap.exists()) return;

    const player = playerSnap.data();
    const skillKey = skillKeyFromLabel(playerRatingLabel(player));
    const queueRef = getQueueDocRef(skillKey);
    const queueSnap = await tx.get(queueRef);

    // Remove player from their skill queue
    if (queueSnap.exists()) {
      const order = queueSnap.data().order || [];
      let filtered = order.map((id) => id === playerId ? "EMPTY" : id);
      while (filtered.length > 0 && filtered[filtered.length - 1] === "EMPTY") {
        filtered.pop();
      }
      tx.set(queueRef, { skill: playerRatingLabel(player), order: filtered, updatedAt: now }, { merge: true });
    }

    // Archive the player but keep their name/stats; add archivedDate for date-filtering
    tx.set(playerRef, {
      status: "Archived",
      currentMatchId: null,
      archivedDate,
      updatedAt: now,
    }, { merge: true });
  });
}

export async function archiveAllPlayers(playersList) {
  const batch = writeBatch(db);
  const now = serverTimestamp();
  const archivedDate = new Date().toLocaleDateString();

  playersList.forEach((player) => {
    if (player.status !== "Archived") {
      batch.update(getTenantDoc("players", player.id), {
        status: "Archived",
        currentMatchId: null,
        archivedDate,
        wins: 0,
        losses: 0,
        lastResult: null,
        playedWith: {},
        updatedAt: now,
      });
    } else {
      // Even if they are already archived, reset stats for the next day and update archivedDate
      batch.update(getTenantDoc("players", player.id), {
        archivedDate,
        wins: 0,
        losses: 0,
        lastResult: null,
        playedWith: {},
        updatedAt: now,
      });
    }
  });

  SKILLS.forEach((skill) => {
    batch.update(getQueueDocRef(skill.key), {
      order: [],
      updatedAt: now,
    });
  });

  const courtIds = ["court-1", "court-2", "court-3"];
  courtIds.forEach((courtId) => {
    batch.update(getTenantDoc("courts", courtId), {
      status: "Available",
      matchId: null,
      players: [],
      skill: null,
      startedAt: null,
      updatedAt: now,
    });
  });

  await batch.commit();
}

export async function updatePlayerSkill(playerId, newSkill) {
  const normalizedSkill = normalizeSkill(newSkill || "");
  if (!normalizedSkill) throw new Error("Rating is invalid.");

  const playerRef = getTenantDoc("players", playerId);

  await runTransaction(db, async (tx) => {
    const playerSnap = await tx.get(playerRef);
    if (!playerSnap.exists()) return;

    const player = playerSnap.data();
    const currentKey = skillKeyFromLabel(playerRatingLabel(player));
    const nextKey = skillKeyFromLabel(normalizedSkill);

    if (currentKey === nextKey) return;

    const currentQueueRef = getQueueDocRef(currentKey);
    const nextQueueRef = getQueueDocRef(nextKey);

    const [currentSnap, nextSnap] = await Promise.all([
      tx.get(currentQueueRef),
      tx.get(nextQueueRef),
    ]);

    if (currentSnap.exists()) {
      const order = currentSnap.data().order || [];
      let filtered = order.map((id) => id === playerId ? "EMPTY" : id);
      while (filtered.length > 0 && filtered[filtered.length - 1] === "EMPTY") {
        filtered.pop();
      }
      tx.set(
        currentQueueRef,
        { skill: playerRatingLabel(player), order: filtered, updatedAt: serverTimestamp() },
        { merge: true }
      );
    }

    const nextOrderRaw = nextSnap.exists() ? nextSnap.data().order || [] : [];
    let nextOrder = nextOrderRaw.filter((id) => id !== playerId);
    
    // Only add to the new queue if they are actually waiting
    if (player.status === "Waiting") {
      nextOrder.push(playerId);
    }
    
    tx.set(
      nextQueueRef,
      { skill: normalizedSkill, order: nextOrder, updatedAt: serverTimestamp() },
      { merge: true }
    );

    tx.update(playerRef, { rating: normalizedSkill, updatedAt: serverTimestamp() });
  });
}

export async function updatePlayerGender(playerId, newGender) {
  const playerRef = getTenantDoc("players", playerId);
  await updateDoc(playerRef, {
    gender: newGender || "Unspecified",
    updatedAt: serverTimestamp(),
  });
}

export async function updatePlayerPracticePartner(playerId, partnerId) {
  const playerRef = getTenantDoc("players", playerId);
  await runTransaction(db, async (tx) => {
    const playerSnap = await tx.get(playerRef);
    if (!playerSnap.exists()) return;
    
    const player = playerSnap.data();
    const oldPartnerId = player.practicePartner;
    
    if (oldPartnerId && oldPartnerId !== partnerId) {
      const oldPartnerRef = getTenantDoc("players", oldPartnerId);
      const oldPartnerSnap = await tx.get(oldPartnerRef);
      if (oldPartnerSnap.exists() && oldPartnerSnap.data().practicePartner === playerId) {
        tx.update(oldPartnerRef, { practicePartner: null, updatedAt: serverTimestamp() });
      }
    }

    if (partnerId) {
       const newPartnerRef = getTenantDoc("players", partnerId);
       const newPartnerSnap = await tx.get(newPartnerRef);
       if (newPartnerSnap.exists()) {
           tx.update(newPartnerRef, { practicePartner: playerId, updatedAt: serverTimestamp() });
       }
    }
    tx.update(playerRef, { practicePartner: partnerId || null, updatedAt: serverTimestamp() });
  });
}

export async function markPlayerAbsent(playerId, absent) {
  const playerRef = getTenantDoc("players", playerId);

  await runTransaction(db, async (tx) => {
    const playerSnap = await tx.get(playerRef);
    if (!playerSnap.exists()) return;

    const player = playerSnap.data();
    const skillKey = skillKeyFromLabel(playerRatingLabel(player));
    const queueRef = getQueueDocRef(skillKey);
    const queueSnap = await tx.get(queueRef);
    const orderRaw = queueSnap.exists() ? queueSnap.data().order || [] : [];
    // Always normalize duplicates first to keep queue count accurate.
    const seen = new Set();
    const order = orderRaw.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    let updated = order;

    if (absent) {
      updated = order.map((id) => id === playerId ? "EMPTY" : id);
      while (updated.length > 0 && updated[updated.length - 1] === "EMPTY") {
        updated.pop();
      }
      tx.update(playerRef, {
        status: "Absent",
        updatedAt: serverTimestamp(),
      });
    } else {
      if (!order.includes(playerId)) {
        const emptyIdx = order.indexOf("EMPTY");
        if (emptyIdx !== -1) {
          updated = [...order];
          updated[emptyIdx] = playerId;
        } else {
          updated = order.concat(playerId);
        }
      }
      tx.update(playerRef, {
        status: "Waiting",
        updatedAt: serverTimestamp(),
      });
    }

    tx.set(
      queueRef,
      { skill: playerRatingLabel(player), order: updated, updatedAt: serverTimestamp() },
      { merge: true }
    );
  });
}

export async function activatePlayerToStandby(playerId) {
  const playerRef = getTenantDoc("players", playerId);
  await updateDoc(playerRef, {
    status: "Standby",
    updatedAt: serverTimestamp(),
  });
}

export async function skipPlayer(playerId) {
  const playerRef = getTenantDoc("players", playerId);

  await runTransaction(db, async (tx) => {
    const playerSnap = await tx.get(playerRef);
    if (!playerSnap.exists()) return;

    const player = playerSnap.data();
    const skillKey = skillKeyFromLabel(playerRatingLabel(player));
    const queueRef = getQueueDocRef(skillKey);
    const queueSnap = await tx.get(queueRef);
    const order = queueSnap.exists() ? queueSnap.data().order || [] : [];

    if (!order.includes(playerId)) return;

    const filtered = order.map((id) => id === playerId ? "EMPTY" : id);
    filtered.push(playerId);

    tx.set(
      queueRef,
      { skill: playerRatingLabel(player), order: filtered, updatedAt: serverTimestamp() },
      { merge: true }
    );
    tx.update(playerRef, { updatedAt: serverTimestamp() });
  });
}

export async function reorderQueue(skillKey, newOrder) {
  const label = skillLabelFromKey(skillKey);
  if (!label) return;

  await setDoc(
    getQueueDocRef(skillKey),
    { skill: label, order: newOrder, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

export function listenToQueues(callback) {
  const unsubscribers = SKILLS.map((skill) =>
    onSnapshot(getQueueDocRef(skill.key), (snap) => {
      const order = snap.exists() ? snap.data().order || [] : [];
      queueState.set(skill.key, order);
      callback(getQueueState());
    }, (error) => {
      console.error("Queue listener error:", error);
      if (window.showTvError) window.showTvError(error);
    })
  );

  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

export function listenToPlayers(callback) {
  return onSnapshot(getTenantCollection("players"), (snapshot) => {
    const players = snapshot.docs.map((docSnap) => {
      const data = docSnap.data();
      const rating = playerRatingLabel(data);
      return {
        id: docSnap.id,
        ...data,
        rating,
        // Compatibility alias for legacy UI helpers. It is never written for
        // newly created players and always contains the numeric rating.
        skill: rating,
      };
    });
    // An orderBy query excludes documents that do not contain its field. Sort
    // locally so legacy/imported players without createdAt remain visible.
    players.sort((a, b) => {
      const createdAtMs = (player) => {
        const value = player.createdAt;
        if (typeof value?.toMillis === "function") return value.toMillis();
        if (typeof value?.seconds === "number") return value.seconds * 1000;
        const parsed = new Date(value || 0).getTime();
        return Number.isNaN(parsed) ? 0 : parsed;
      };
      return createdAtMs(b) - createdAtMs(a);
    });
    callback(players);
  }, (error) => {
    console.error("Players listener error:", error);
    if (window.showTvError) window.showTvError(error);
  });
}

export async function fetchExistingNames() {
  const snapshot = await getDocs(query(getTenantCollection("players"), orderBy("nameLower")));
  const map = new Map();
  snapshot.docs.forEach((docSnap) => {
    map.set(docSnap.data().nameLower, docSnap.data().status);
  });
  return map;
}

export function getQueueState() {
  const state = {};
  SKILLS.forEach((skill) => {
    state[skill.key] = queueState.get(skill.key) || [];
  });
  return state;
}

export async function generateNextRound(playersList, mode = "social_mix") {
  // Gather all eligible players (those waiting, standby, or currently playing)
  const eligiblePlayers = playersList.filter(p => p.status === "Waiting" || p.status === "Standby" || p.status === "Playing");
  
  if (eligiblePlayers.length === 0) {
    throw new Error("No waiting or standby players available.");
  }

  const ratingFor = (player) => {
    return Number(playerRatingLabel(player));
  };
  const bySkill = Object.fromEntries(SKILLS.map((item) => [item.key, []]));
  eligiblePlayers.forEach((player) => {
    const key = skillKeyFromLabel(playerRatingLabel(player));
    if (bySkill[key]) bySkill[key].push(player);
  });

  // ── Flex Borrow: fill short skill groups from Intermediate ──────────────
  // When a skill group (beginner, intermediate, or advanced) has 1–3 players
  // (not enough for a full game of 4), borrow the needed players from the
  // Intermediate queue so no court sits empty.
  if (mode === "flex_borrow" && bySkill.intermediate) {
    // We work on a copy of intermediate so we track what is left to lend.
    const intPool = bySkill.intermediate.slice();

    for (const skill of ["beginner", "advanced"]) {
      const group = bySkill[skill];
      if (group.length === 0) continue; // nothing to help
      const rem = group.length % 4;
      if (rem === 0) continue; // already a full multiple of 4

      const needed = 4 - rem; // 1, 2, or 3
      const available = intPool.filter(p => !group.includes(p));
      const toAdd = available.slice(0, needed);

      if (toAdd.length === needed) {
        // Mark borrowed players so we know they came from intermediate
        toAdd.forEach(p => {
          group.push(p);
          // Remove from intermediate pool so they are not double-scheduled
          const idx = intPool.indexOf(p);
          if (idx !== -1) intPool.splice(idx, 1);
          // Also remove from the main intermediate bySkill array
          const i2 = bySkill.intermediate.indexOf(p);
          if (i2 !== -1) bySkill.intermediate.splice(i2, 1);
        });
      }
      // If not enough intermediates are available, leave the group as-is;
      // the existing padToMultipleOf4 will handle it gracefully.
    }

    // Also check if intermediate itself needs a top-up after lending
    // (it does its own padToMultipleOf4 in the main loop, so nothing extra needed)
  }

  const batch = writeBatch(db);
  const now = serverTimestamp();
  
  for (const [skill, players] of Object.entries(bySkill)) {
    // Basic shuffle first to break ties. Rating groups stay in rating order.
    if (mode !== "rating") {
      for (let i = players.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [players[i], players[j]] = [players[j], players[i]];
      }
    }

    if (mode === "winners_losers") {
      players.sort((a, b) => {
        const scoreA = a.lastResult === "win" ? 1 : (a.lastResult === "loss" ? -1 : 0);
        const scoreB = b.lastResult === "win" ? 1 : (b.lastResult === "loss" ? -1 : 0);
        return scoreB - scoreA;
      });
    } else if (mode === "balanced") {
      players.sort((a, b) => {
        const ratioA = (a.wins || 0) / Math.max(1, (a.wins || 0) + (a.losses || 0));
        const ratioB = (b.wins || 0) / Math.max(1, (b.wins || 0) + (b.losses || 0));
        return ratioB - ratioA;
      });
    } else if (mode === "fair_play") {
      players.sort((a, b) => {
        const gamesA = (a.wins || 0) + (a.losses || 0);
        const gamesB = (b.wins || 0) + (b.losses || 0);
        return gamesA - gamesB;
      });
    } else if (mode === "mixed") {
      const males = players.filter(p => p.gender === "Male");
      const females = players.filter(p => p.gender === "Female");
      const unspec = players.filter(p => p.gender !== "Male" && p.gender !== "Female");
      
      const mixedOrder = [];
      while (males.length > 0 || females.length > 0 || unspec.length > 0) {
        if (males.length > 0) mixedOrder.push(males.shift());
        else if (unspec.length > 0) mixedOrder.push(unspec.shift());
        
        if (females.length > 0) mixedOrder.push(females.shift());
        else if (unspec.length > 0) mixedOrder.push(unspec.shift());
      }
      players.splice(0, players.length, ...mixedOrder);
    }

    // CRITICAL: Ensure Waiting/Standby players ALWAYS come before Playing players.
    // To prevent "handcuffing" ready players to playing players, we pad them INDEPENDENTLY
    // so that ready players form perfect 4/4 matches, and playing players form their own 4/4 matches.
    const readyPlayers = players.filter(p => p.status !== "Playing");
    const playingPlayers = players.filter(p => p.status === "Playing");

    function padToMultipleOf4(group) {
      if (group.length > 0 && group.length % 4 !== 0) {
        const needed = 4 - (group.length % 4);
        const uniqueIds = Array.from(new Set(group.map(p => p.id)));
        if (uniqueIds.length >= 4) {
          const frontPool = group.slice(0, Math.max(needed, Math.floor(group.length / 2)));
          for (let i = 0; i < needed; i++) {
            const randIdx = Math.floor(Math.random() * frontPool.length);
            group.push({ ...frontPool[randIdx] }); // clone object
            frontPool.splice(randIdx, 1);
            if (frontPool.length === 0) break;
          }
        }
      }
      return group;
    }

    const paddedReady = padToMultipleOf4(readyPlayers);
    const paddedPlaying = padToMultipleOf4(playingPlayers);
    
    function pairUpAndFlatten(group) {
        let pairs = [];
        let singles = [];
        let usedIndices = new Set();
        for(let i = 0; i < group.length; i++) {
           if (usedIndices.has(i)) continue;
           let p1 = group[i];
           usedIndices.add(i);
           let partnerIdx = -1;
           if (p1.practicePartner) {
              for (let j = i + 1; j < group.length; j++) {
                 if (!usedIndices.has(j) && group[j].id === p1.practicePartner) {
                    partnerIdx = j;
                    break;
                 }
              }
           }
           if (partnerIdx !== -1) {
              pairs.push([p1, group[partnerIdx]]);
              usedIndices.add(partnerIdx);
           } else {
              singles.push(p1);
           }
        }
        
        let finalArr = [];
        while(pairs.length >= 2) {
           finalArr.push(...pairs.pop(), ...pairs.pop());
        }
        while(pairs.length === 1 && singles.length >= 2) {
           finalArr.push(...pairs.pop(), singles.pop(), singles.pop());
        }
        while(singles.length >= 4) {
           finalArr.push(singles.pop(), singles.pop(), singles.pop(), singles.pop());
        }
        if (pairs.length > 0) finalArr.push(...pairs[0]);
        while (singles.length > 0) finalArr.push(singles.pop());
        return finalArr;
    }
    
    const arrangeRatingTeams = (group) => {
      const arranged = [];
      for (let index = 0; index < group.length; index += 4) {
        const match = group.slice(index, index + 4);
        if (match.length === 4) {
          match.sort((a, b) => ratingFor(a) - ratingFor(b));
          // Lowest + highest play together, as do the middle two.
          arranged.push(match[0], match[3], match[1], match[2]);
        } else {
          arranged.push(...match);
        }
      }
      return arranged;
    };

    players.splice(
      0,
      players.length,
      ...(mode === "rating" ? arrangeRatingTeams(paddedReady) : pairUpAndFlatten(paddedReady)),
      ...(mode === "rating" ? arrangeRatingTeams(paddedPlaying) : pairUpAndFlatten(paddedPlaying))
    );
    const newOrder = players.map(p => p.id);

    const queueRef = getQueueDocRef(skill);
    batch.set(queueRef, { order: newOrder, skill: skillLabelFromKey(skill), updatedAt: now }, { merge: true });
    
    // Ensure all drafted players are marked as "Waiting" so they appear in the queue
    // (Unless they are currently Playing, they should keep their Playing status)
    players.forEach(p => {
      if (p.status !== "Waiting" && p.status !== "Playing") {
        const pRef = getTenantDoc("players", p.id);
        batch.update(pRef, { status: "Waiting", updatedAt: now });
      }
    });
  }

  await batch.commit();
}

// Build one round without cloning players to fill a partial card.  The score
// favours new combinations first, then evenly matched teams.
const rotationPairKey = (a, b) => [a, b].sort().join("__");
const rotationLineupKey = (ids) => [...ids].sort().join("__");

function playerPower(player) {
  const games = (player.wins || 0) + (player.losses || 0);
  const winRate = games ? (player.wins || 0) / games : 0.5;
  return Number(playerRatingLabel(player)) + winRate * 0.35;
}

function pairHistory(playerA, playerB) {
  return (playerA.playedWith?.[playerB.id] || 0) +
    (playerB.playedWith?.[playerA.id] || 0);
}

function sortForRound(players, mode) {
  const copy = [...players];
  const tieBreak = () => Math.random() - 0.5;
  if (mode === "fair_play") {
    return copy.sort((a, b) => ((a.wins || 0) + (a.losses || 0)) - ((b.wins || 0) + (b.losses || 0)) || tieBreak());
  }
  if (mode === "winners_losers") {
    const score = (player) => player.lastResult === "Win" ? 1 : player.lastResult === "Loss" ? -1 : 0;
    return copy.sort((a, b) => score(b) - score(a) || tieBreak());
  }
  if (mode === "balanced") {
    return copy.sort((a, b) => playerPower(b) - playerPower(a) || tieBreak());
  }
  if (mode === "mixed") {
    return copy.sort((a, b) => (a.gender === "Female" ? -1 : 0) - (b.gender === "Female" ? -1 : 0) || tieBreak());
  }
  return copy.sort(tieBreak);
}

function chooseGroup(pool, lineupHistory) {
  const candidates = pool.slice(0, Math.min(8, pool.length));
  let best = candidates.slice(0, 4);
  let bestScore = Infinity;
  for (let a = 0; a < candidates.length - 3; a++) {
    for (let b = a + 1; b < candidates.length - 2; b++) {
      for (let c = b + 1; c < candidates.length - 1; c++) {
        for (let d = c + 1; d < candidates.length; d++) {
          const group = [candidates[a], candidates[b], candidates[c], candidates[d]];
          const repeatLineup = lineupHistory.has(rotationLineupKey(group.map((player) => player.id)));
          let score = repeatLineup ? 10000 : 0;
          for (let x = 0; x < group.length; x++) {
            for (let y = x + 1; y < group.length; y++) score += pairHistory(group[x], group[y]) * 10;
          }
          // Keep people near the front of the chosen matching mode's order.
          score += (a + b + c + d) * 0.25;
          if (score < bestScore) {
            best = group;
            bestScore = score;
          }
        }
      }
    }
  }
  return best;
}

function arrangeBalancedTeams(group, teammateHistory) {
  const pairings = [
    [[group[0], group[1]], [group[2], group[3]]],
    [[group[0], group[2]], [group[1], group[3]]],
    [[group[0], group[3]], [group[1], group[2]]],
  ];
  let best = pairings[0];
  let bestScore = Infinity;
  for (const pairing of pairings) {
    const [teamA, teamB] = pairing;
    const teamAKey = rotationPairKey(teamA[0].id, teamA[1].id);
    const teamBKey = rotationPairKey(teamB[0].id, teamB[1].id);
    const repeats = pairHistory(...teamA) + pairHistory(...teamB) +
      (teammateHistory.has(teamAKey) ? 100 : 0) +
      (teammateHistory.has(teamBKey) ? 100 : 0);
    const balance = Math.abs(
      playerPower(teamA[0]) + playerPower(teamA[1]) -
      playerPower(teamB[0]) - playerPower(teamB[1])
    );
    const score = repeats * 20 + balance;
    if (score < bestScore) {
      best = pairing;
      bestScore = score;
    }
  }
  return best;
}

export async function generateSmartRound(playersList, mode = "social_mix", matchHistory = []) {
  const eligible = playersList.filter((player) =>
    player.status === "Waiting" || player.status === "Standby" || player.status === "Playing"
  );
  if (!eligible.length) throw new Error("No waiting or standby players available.");

  const lineupHistory = new Set(
    matchHistory.filter((match) => match.players?.length === 4)
      .map((match) => rotationLineupKey(match.players))
  );
  const teammateHistory = new Set(
    matchHistory.flatMap((match) => [match.teamA, match.teamB])
      .filter((team) => team?.length === 2)
      .map((team) => rotationPairKey(team[0], team[1]))
  );
  const queues = Object.fromEntries(SKILLS.map((skill) => [skill.key, []]));
  eligible.forEach((player) => {
    const key = skillKeyFromLabel(playerRatingLabel(player));
    if (key) queues[key].push(player);
  });

  const summary = { matches: 0, repeatLineups: 0, repeatTeammates: 0, unpaired: 0, repeatedPlayers: 0 };
  const batch = writeBatch(db);
  const now = serverTimestamp();

  for (const [skillKey, skillPlayers] of Object.entries(queues)) {
    const ready = sortForRound(skillPlayers.filter((player) => player.status !== "Playing"), mode);
    const playing = sortForRound(skillPlayers.filter((player) => player.status === "Playing"), mode);
    const ordered = [];

    for (const pool of [ready, playing]) {
      while (pool.length >= 4) {
        const group = chooseGroup(pool, lineupHistory);
        const groupIds = group.map((player) => player.id);
        const lineupKey = rotationLineupKey(groupIds);
        if (lineupHistory.has(lineupKey)) summary.repeatLineups++;
        const [teamA, teamB] = arrangeBalancedTeams(group, teammateHistory);
        [teamA, teamB].forEach((team) => {
          const key = rotationPairKey(team[0].id, team[1].id);
          if (teammateHistory.has(key)) summary.repeatTeammates++;
          teammateHistory.add(key);
        });
        lineupHistory.add(lineupKey);
        ordered.push(...teamA, ...teamB);
        groupIds.forEach((id) => pool.splice(pool.findIndex((player) => player.id === id), 1));
        summary.matches++;
      }
      summary.unpaired += pool.length;
      ordered.push(...pool);
    }

    batch.set(getQueueDocRef(skillKey), {
      order: ordered.map((player) => player.id),
      skill: skillLabelFromKey(skillKey),
      updatedAt: now,
    }, { merge: true });
    ordered.forEach((player) => {
      if (player.status !== "Waiting" && player.status !== "Playing") {
        batch.update(getTenantDoc("players", player.id), { status: "Waiting", updatedAt: now });
      }
    });
  }

  await batch.commit();
  return summary;
}
