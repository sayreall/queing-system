import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  getDoc as _getDoc,
  getDocs as _getDocs,
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
  writeBatch,
  runTransaction,
  getDocFromCache,
  getDocsFromCache
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyAsQtk03ejsFovbeh3mW3bnBFeKt6PdAWo",
    authDomain: "pickleball-e0ed6.firebaseapp.com",
    projectId: "pickleball-e0ed6",
    storageBucket: "pickleball-e0ed6.appspot.com",
    messagingSenderId: "909059572050",
    appId: "1:909059572050:web:89c86508cec9c2fd62ba8b",
    measurementId: "G-J306YP6WFL"
};

const app = initializeApp(firebaseConfig);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({tabManager: persistentMultipleTabManager()})
});
const auth = getAuth(app);

export function getTenantId() {
  const urlParams = new URLSearchParams(window.location.search);
  const tenantParam = urlParams.get('tenant');
  if (tenantParam) return tenantParam;
  if (!auth.currentUser) throw new Error("Not authenticated");
  return auth.currentUser.uid;
}

export function getTenantCollection(collectionName) {
  const tenantId = getTenantId();
  return collection(db, "users", tenantId, collectionName);
}

export function getTenantDoc(collectionName, docId) {
  const tenantId = getTenantId();
  if (!docId) return doc(getTenantCollection(collectionName));
  return doc(db, "users", tenantId, collectionName, docId);
}

export async function getDoc(ref) {
  try {
    return await _getDoc(ref);
  } catch (e) {
    if (e.code === "unavailable") return await getDocFromCache(ref);
    throw e;
  }
}

export async function getDocs(queryOrRef) {
  try {
    return await _getDocs(queryOrRef);
  } catch (e) {
    if (e.code === "unavailable") return await getDocsFromCache(queryOrRef);
    throw e;
  }
}

export {
  auth,
  db,
  collection,
  doc,
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
  writeBatch,
  runTransaction,
  getDocFromCache,
  getDocsFromCache,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
};
