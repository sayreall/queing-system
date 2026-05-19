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
  runTransaction,
  writeBatch,
} from "./firebase.js";

export const SKILLS = [
  { label: "Beginner", key: "beginner" },
  { label: "Intermediate", key: "intermediate" },
  { label: "Advanced", key: "advanced" },
];

const skillByKey = new Map(SKILLS.map((skill) => [skill.key, skill.label]));
const skillByLabel = new Map(
  SKILLS.map((skill) => [skill.label.toLowerCase(), skill])
);

const queueState = new Map();

export function normalizeSkill(input) {
  if (!input) return null;
  const normalized = input.toLowerCase();
  const match = skillByLabel.get(normalized) || skillByLabel.get(normalized.trim());
  return match ? match.label : null;
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
  return name.trim().replace(/\s+/g, " ");
}

export function getQueueDocRef(skillKey) {
  return doc(db, "queues", skillKey);
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
}

export async function addPlayer({ name, skill, gender, location }) {
  const trimmedName = normalizeName(name || "");
  const normalizedSkill = normalizeSkill(skill || "");
  const playerGender = gender || "Unspecified";
  const playerLocation = (location || "").trim();

  if (!trimmedName) throw new Error("Player name is required.");
  if (!normalizedSkill) throw new Error("Skill level is invalid.");

  const nameLower = trimmedName.toLowerCase();
  const existing = await getDocs(
    query(collection(db, "players"), where("nameLower", "==", nameLower), limit(1))
  );

  let playerRef;
  let isRevive = false;

  if (!existing.empty) {
    const docSnap = existing.docs[0];
    if (docSnap.data().status === "Archived") {
      playerRef = docSnap.ref;
      isRevive = true;
    } else {
      throw new Error("Player already exists.");
    }
  } else {
    playerRef = doc(collection(db, "players"));
  }

  const skillKey = skillKeyFromLabel(normalizedSkill);
  const queueRef = getQueueDocRef(skillKey);
  const now = serverTimestamp();

  // Use a transaction to ensure clean state
  await runTransaction(db, async (tx) => {
    if (isRevive) {
      tx.set(playerRef, {
        skill: normalizedSkill,
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
        skill: normalizedSkill,
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

export async function addPlayersBulk(entries) {
  const now = serverTimestamp();
  const batch = writeBatch(db);
  const queueAdditions = new Map();

  const allPlayersSnap = await getDocs(collection(db, "players"));
  const existingMap = new Map();
  allPlayersSnap.forEach(snap => {
    existingMap.set(snap.data().nameLower, snap);
  });

  entries.forEach((entry) => {
    const trimmedName = (entry.name || "").trim();
    const normalizedSkill = normalizeSkill(entry.skill || "");
    const playerGender = entry.gender || "Unspecified";
    const playerLocation = (entry.location || entry.Location || "").trim();
    if (!trimmedName || !normalizedSkill) return;

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
      playerRef = doc(collection(db, "players"));
      // Add to existingMap so duplicates in the same bulk import don't crash
      existingMap.set(nameLower, { ref: playerRef, data: () => ({ status: "Waiting" }) });
    }

    const skillKey = skillKeyFromLabel(normalizedSkill);

    if (isRevive) {
      batch.set(playerRef, {
        skill: normalizedSkill,
        gender: playerGender,
        location: playerLocation,
        status: "Standby",
        playedWith: {},
        updatedAt: now,
      }, { merge: true });
    } else {
      batch.set(playerRef, {
        name: trimmedName,
        nameLower,
        skill: normalizedSkill,
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

  await batch.commit();
}

export async function removePlayer(playerId) {
  const playerRef = doc(db, "players", playerId);

  await runTransaction(db, async (tx) => {
    const playerSnap = await tx.get(playerRef);
    if (!playerSnap.exists()) return;

    const player = playerSnap.data();
    const skillKey = skillKeyFromLabel(player.skill);
    const queueRef = getQueueDocRef(skillKey);
    const queueSnap = await tx.get(queueRef);

    if (queueSnap.exists()) {
      const order = queueSnap.data().order || [];
      const filtered = order.filter((id) => id !== playerId);
      tx.set(
        queueRef,
        { skill: player.skill, order: filtered, updatedAt: serverTimestamp() },
        { merge: true }
      );
    }

    tx.delete(playerRef);
  });
}

export async function archiveAllPlayers(playersList) {
  const batch = writeBatch(db);
  const now = serverTimestamp();

  playersList.forEach((player) => {
    if (player.status !== "Archived") {
      batch.update(doc(db, "players", player.id), {
        status: "Archived",
        currentMatchId: null,
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
    batch.update(doc(db, "courts", courtId), {
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
  if (!normalizedSkill) throw new Error("Skill level is invalid.");

  const playerRef = doc(db, "players", playerId);

  await runTransaction(db, async (tx) => {
    const playerSnap = await tx.get(playerRef);
    if (!playerSnap.exists()) return;

    const player = playerSnap.data();
    const currentKey = skillKeyFromLabel(player.skill);
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
      const filtered = order.filter((id) => id !== playerId);
      tx.set(
        currentQueueRef,
        { skill: player.skill, order: filtered, updatedAt: serverTimestamp() },
        { merge: true }
      );
    }

    const nextOrderRaw = nextSnap.exists() ? nextSnap.data().order || [] : [];
    const nextOrder = nextOrderRaw.filter((id) => id !== playerId).concat(playerId);
    tx.set(
      nextQueueRef,
      { skill: normalizedSkill, order: nextOrder, updatedAt: serverTimestamp() },
      { merge: true }
    );

    tx.update(playerRef, { skill: normalizedSkill, updatedAt: serverTimestamp() });
  });
}

export async function markPlayerAbsent(playerId, absent) {
  const playerRef = doc(db, "players", playerId);

  await runTransaction(db, async (tx) => {
    const playerSnap = await tx.get(playerRef);
    if (!playerSnap.exists()) return;

    const player = playerSnap.data();
    const skillKey = skillKeyFromLabel(player.skill);
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
      updated = order.filter((id) => id !== playerId);
      tx.update(playerRef, {
        status: "Absent",
        updatedAt: serverTimestamp(),
      });
    } else {
      if (!order.includes(playerId)) {
        updated = order.concat(playerId);
      }
      tx.update(playerRef, {
        status: "Waiting",
        updatedAt: serverTimestamp(),
      });
    }

    tx.set(
      queueRef,
      { skill: player.skill, order: updated, updatedAt: serverTimestamp() },
      { merge: true }
    );
  });
}

export async function skipPlayer(playerId) {
  const playerRef = doc(db, "players", playerId);

  await runTransaction(db, async (tx) => {
    const playerSnap = await tx.get(playerRef);
    if (!playerSnap.exists()) return;

    const player = playerSnap.data();
    const skillKey = skillKeyFromLabel(player.skill);
    const queueRef = getQueueDocRef(skillKey);
    const queueSnap = await tx.get(queueRef);
    const order = queueSnap.exists() ? queueSnap.data().order || [] : [];

    if (!order.includes(playerId)) return;

    const filtered = order.filter((id) => id !== playerId);
    filtered.push(playerId);

    tx.set(
      queueRef,
      { skill: player.skill, order: filtered, updatedAt: serverTimestamp() },
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
    })
  );

  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

export function listenToPlayers(callback) {
  return onSnapshot(
    query(collection(db, "players"), orderBy("createdAt")),
    (snapshot) => {
      const players = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
      }));
      callback(players);
    }
  );
}

export async function fetchExistingNames() {
  const snapshot = await getDocs(query(collection(db, "players"), orderBy("nameLower")));
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
