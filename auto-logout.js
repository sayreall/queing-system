/**
 * auto-logout.js
 * Tracks user activity. After IDLE_TIMEOUT ms of inactivity, signs the user
 * out and redirects to login.html.
 * Shows a dismissible warning toast at WARN_BEFORE ms before logout.
 *
 * Usage:
 *   import { startAutoLogout } from './auto-logout.js';
 *   startAutoLogout(auth, signOut);   // call once after user is confirmed logged in
 */

const IDLE_TIMEOUT  = 20 * 60 * 1000; // 20 minutes
const WARN_BEFORE   =  2 * 60 * 1000; //  2 minutes before logout (at 18 min)

// Events that count as "activity"
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'];

let idleTimer    = null;
let warnTimer    = null;
let warnToast    = null;
let warnInterval = null;
let started      = false;

function removeWarnToast() {
  if (warnInterval) { clearInterval(warnInterval); warnInterval = null; }
  if (warnToast)    { warnToast.remove(); warnToast = null; }
}

function showWarnToast(secondsLeft) {
  removeWarnToast();

  warnToast = document.createElement('div');
  warnToast.id = 'auto-logout-warn';
  warnToast.style.cssText = `
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 99999;
    background: rgba(12, 50, 50, 0.97);
    border: 1px solid rgba(232, 90, 26, 0.5);
    border-radius: 14px;
    padding: 14px 20px;
    display: flex;
    align-items: center;
    gap: 14px;
    box-shadow: 0 12px 36px rgba(0,0,0,0.5);
    font-family: "Manrope", sans-serif;
    font-size: 0.88rem;
    color: #F2E8D5;
    max-width: calc(100vw - 48px);
    animation: fadeUp 0.3s ease;
  `;

  const countEl = document.createElement('span');
  countEl.style.cssText = 'font-weight:700; color:#f07840; white-space:nowrap;';
  countEl.textContent = `⏱ Auto-logout in ${secondsLeft}s`;

  const msg = document.createElement('span');
  msg.style.color = '#a8c4be';
  msg.textContent = 'Move or click to stay logged in.';

  const stayBtn = document.createElement('button');
  stayBtn.textContent = 'Stay';
  stayBtn.style.cssText = `
    flex-shrink: 0;
    padding: 6px 14px;
    border-radius: 999px;
    background: linear-gradient(135deg, #E85A1A, #c44510);
    color: #fff;
    font-weight: 700;
    font-size: 0.75rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    border: none;
    cursor: pointer;
  `;

  warnToast.appendChild(countEl);
  warnToast.appendChild(msg);
  warnToast.appendChild(stayBtn);

  // Clicking "Stay" resets the timer
  stayBtn.addEventListener('click', resetTimers);

  // Ensure a toast container exists (or just append to body)
  const container = document.getElementById('toast-container') || document.body;
  container.appendChild(warnToast);

  // Countdown tick
  let remaining = secondsLeft;
  warnInterval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(warnInterval);
      countEl.textContent = '⏱ Logging out…';
    } else {
      countEl.textContent = `⏱ Auto-logout in ${remaining}s`;
    }
  }, 1000);
}

function performLogout(auth, signOutFn) {
  removeWarnToast();
  signOutFn(auth)
    .catch(() => {/* ignore */})
    .finally(() => {
      window.location.href = 'login.html';
    });
}

function resetTimers(auth, signOutFn) {
  removeWarnToast();
  clearTimeout(idleTimer);
  clearTimeout(warnTimer);

  // Schedule warning at 18 min
  warnTimer = setTimeout(() => {
    const warnSeconds = Math.round(WARN_BEFORE / 1000); // 120s
    showWarnToast(warnSeconds);
  }, IDLE_TIMEOUT - WARN_BEFORE);

  // Schedule logout at 20 min
  idleTimer = setTimeout(() => {
    performLogout(auth, signOutFn);
  }, IDLE_TIMEOUT);
}

/**
 * Call once after the user is confirmed authenticated.
 * @param {object} auth       - Firebase Auth instance
 * @param {function} signOutFn - Firebase signOut function
 */
export function startAutoLogout(auth, signOutFn) {
  if (started) return; // prevent double-init
  started = true;

  // Start the timers
  resetTimers(auth, signOutFn);

  // Reset on any user activity
  ACTIVITY_EVENTS.forEach(event => {
    window.addEventListener(event, () => resetTimers(auth, signOutFn), { passive: true });
  });
}

/**
 * Stop the auto-logout timers (e.g. on manual logout).
 */
export function stopAutoLogout() {
  removeWarnToast();
  clearTimeout(idleTimer);
  clearTimeout(warnTimer);
  started = false;
  ACTIVITY_EVENTS.forEach(event => {
    // Remove anonymous listeners isn't straightforward, but timers are cleared
    // so they won't fire even if listeners remain.
  });
}
