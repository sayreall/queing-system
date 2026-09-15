import { 
  auth, 
  db, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  onAuthStateChanged,
  doc,
  setDoc,
  getDoc,
  serverTimestamp
} from "./firebase.js";

// ─── Security Config ───────────────────────────────────────────────────────
const MAX_ATTEMPTS    = 5;          // Failed attempts before lockout
const LOCKOUT_MS      = 10 * 60 * 1000; // 10-minute lockout
const STORAGE_KEY     = 'dq_login_security';

// ─── DOM refs ──────────────────────────────────────────────────────────────
const loginForm       = document.getElementById('login-form');
const registerForm    = document.getElementById('register-form');
const authTitle       = document.getElementById('auth-title');
const toggleBtn       = document.getElementById('toggle-btn');
const toggleText      = document.getElementById('toggle-text');
const errorDiv        = document.getElementById('auth-error');
const lockoutBanner   = document.getElementById('lockout-banner');
const attemptCounter  = document.getElementById('attempt-counter');

// ─── Password Toggle ───────────────────────────────────────────────────────
document.querySelectorAll('.toggle-password').forEach(button => {
  button.addEventListener('click', () => {
    const targetId = button.getAttribute('data-target');
    const input = document.getElementById(targetId);
    if (!input) return;
    
    if (input.type === 'password') {
      input.type = 'text';
      button.querySelector('.eye-open').classList.add('hidden');
      button.querySelector('.eye-closed').classList.remove('hidden');
    } else {
      input.type = 'password';
      button.querySelector('.eye-open').classList.remove('hidden');
      button.querySelector('.eye-closed').classList.add('hidden');
    }
  });
});

let isLoginMode = true;
let lockoutTimer = null;
let registrationInProgress = false;

// ─── Rate-limit helpers ────────────────────────────────────────────────────
function getSecurityState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { attempts: 0, lockedUntil: 0 };
  } catch { return { attempts: 0, lockedUntil: 0 }; }
}

function saveSecurityState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function isLockedOut() {
  const { lockedUntil } = getSecurityState();
  return Date.now() < lockedUntil;
}

function recordFailedAttempt() {
  const state = getSecurityState();
  state.attempts += 1;
  if (state.attempts >= MAX_ATTEMPTS) {
    state.lockedUntil = Date.now() + LOCKOUT_MS;
    state.attempts = 0; // reset counter so next window starts fresh
  }
  saveSecurityState(state);
}

function resetAttempts() {
  saveSecurityState({ attempts: 0, lockedUntil: 0 });
}

function getRemainingAttempts() {
  const { attempts } = getSecurityState();
  return MAX_ATTEMPTS - attempts;
}

// ─── Lockout UI ────────────────────────────────────────────────────────────
function showLockout() {
  const { lockedUntil } = getSecurityState();
  lockoutBanner.style.display = 'block';
  attemptCounter.style.display = 'none';

  // Disable all submit buttons
  document.querySelectorAll('#login-form button[type=submit], #register-form button[type=submit]')
    .forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });

  // Countdown ticker
  clearInterval(lockoutTimer);
  lockoutTimer = setInterval(() => {
    const remaining = Math.max(0, lockedUntil - Date.now());
    if (remaining <= 0) {
      clearInterval(lockoutTimer);
      lockoutBanner.style.display = 'none';
      resetAttempts();
      document.querySelectorAll('#login-form button[type=submit], #register-form button[type=submit]')
        .forEach(b => { b.disabled = false; b.style.opacity = ''; });
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    lockoutBanner.innerHTML =
      `🔒 Too many failed attempts. Please wait <strong>${mins}m ${secs}s</strong> before trying again.`;
  }, 1000);
}

function updateAttemptUI() {
  const remaining = getRemainingAttempts();
  if (remaining < MAX_ATTEMPTS) {
    attemptCounter.style.display = 'block';
    attemptCounter.textContent =
      `⚠️ ${remaining} attempt${remaining === 1 ? '' : 's'} remaining before 10-minute lockout`;
  } else {
    attemptCounter.style.display = 'none';
  }
}

// ─── reCAPTCHA helpers (Explicit Rendering) ──────────────────────────────
const SITE_KEY = "6LdJjrotAAAAAJqGDiYH0B1AdQSMpTK6abxALn1S";
let loginWidgetId = null;
let registerWidgetId = null;
let isGrecaptchaReady = false;

window.renderCaptchas = function() {
  isGrecaptchaReady = true;
  if (isLoginMode && loginWidgetId === null) {
    try { loginWidgetId = window.grecaptcha.render("recaptcha-login", { sitekey: SITE_KEY, theme: "dark" }); } catch(e){}
  } else if (!isLoginMode && registerWidgetId === null) {
    try { registerWidgetId = window.grecaptcha.render("recaptcha-register", { sitekey: SITE_KEY, theme: "dark" }); } catch(e){}
  }
};

// Handle race condition if Google loaded before this module
setTimeout(() => {
  if (window.grecaptcha && window.grecaptcha.render && !isGrecaptchaReady) {
    window.renderCaptchas();
  }
}, 500);

function getCaptchaResponse(widgetId) {
  if (widgetId === null) return "";
  try { return window.grecaptcha.getResponse(widgetId); } catch { return ""; }
}

function resetCaptcha() {
  try {
    if (loginWidgetId !== null) window.grecaptcha.reset(loginWidgetId);
    if (registerWidgetId !== null) window.grecaptcha.reset(registerWidgetId);
  } catch { /* ignore */ }
}

// ─── Error display ─────────────────────────────────────────────────────────
function showError(message) {
  errorDiv.textContent = message;
  errorDiv.classList.remove('hidden');
}

function clearError() {
  errorDiv.classList.add('hidden');
  errorDiv.textContent = '';
}

// ─── Role-based redirect ───────────────────────────────────────────────────
async function redirectBasedOnRole(user) {
  try {
    const userDocRef = doc(db, 'users', user.uid);
    const userDoc = await getDoc(userDocRef);
    if (userDoc.exists()) {
      const profile = userDoc.data();
      // Apply the saved account club before navigation so an older browser
      // preference from the other club cannot win during dashboard loading.
      localStorage.setItem('dq_club_preference', profile.club === 'longos' ? 'longos' : (profile.club === 'guest' ? 'guest' : 'deuce'));
      const role = profile.role;
      if (role === 'admin') {
        window.location.href = 'admin.html?refresh=' + new Date().getTime();
      } else {
        window.location.href = 'index.html?refresh=' + new Date().getTime();
      }
    } else {
      window.location.href = 'index.html?refresh=' + new Date().getTime();
    }
  } catch (error) {
    showError("Error fetching user role: " + error.message);
  }
}

// ─── Toggle login ↔ register ───────────────────────────────────────────────
toggleBtn.addEventListener('click', () => {
  isLoginMode = !isLoginMode;
  clearError();
  resetCaptcha();

  if (isGrecaptchaReady) {
    if (isLoginMode && loginWidgetId === null) {
      loginWidgetId = window.grecaptcha.render("recaptcha-login", { sitekey: SITE_KEY, theme: "dark" });
    } else if (!isLoginMode && registerWidgetId === null) {
      registerWidgetId = window.grecaptcha.render("recaptcha-register", { sitekey: SITE_KEY, theme: "dark" });
    }
  }

  if (isLoginMode) {
    loginForm.classList.remove('hidden');
    registerForm.classList.add('hidden');
    authTitle.textContent = 'PicklQ Login';
    document.title = 'PicklQ Login';
    toggleText.innerHTML = `Don't have an account? <button type="button" id="toggle-btn" class="text-beginner hover:underline focus:outline-none">Register here</button>`;
  } else {
    loginForm.classList.add('hidden');
    registerForm.classList.remove('hidden');
    authTitle.textContent = 'PicklQ Register';
    document.title = 'PicklQ Register';
    toggleText.innerHTML = `Already have an account? <button type="button" id="toggle-btn" class="text-beginner hover:underline focus:outline-none">Sign in here</button>`;
  }

  // Re-attach listener since we replaced innerHTML
  document.getElementById('toggle-btn').addEventListener('click', () => toggleBtn.click());
});

// ─── Login handler ─────────────────────────────────────────────────────────
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  // 1. Check lockout
  if (isLockedOut()) { showLockout(); return; }

  // 2. Verify reCAPTCHA
  const captcha = getCaptchaResponse(loginWidgetId);
  if (!captcha) {
    showError('Please complete the "I\'m not a robot" verification.');
    return;
  }

  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  const btn = loginForm.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    await signInWithEmailAndPassword(auth, email, password);
    resetAttempts();
    // onAuthStateChanged handles redirect
  } catch (error) {
    recordFailedAttempt();
    resetCaptcha();

    if (isLockedOut()) {
      showLockout();
    } else {
      updateAttemptUI();
      const msg = friendlyError(error.code);
      showError(msg);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

// ─── Register handler ──────────────────────────────────────────────────────
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  // 1. Check lockout
  if (isLockedOut()) { showLockout(); return; }

  // 2. Verify reCAPTCHA
  const captcha = getCaptchaResponse(registerWidgetId);
  if (!captcha) {
    showError('Please complete the "I\'m not a robot" verification.');
    return;
  }

  const email    = document.getElementById('register-email').value.trim();
  const password = document.getElementById('register-password').value;
  const name     = document.getElementById('register-name').value.trim();
  const club     = document.getElementById('register-club').value;

  // 3. Extra password strength check
  if (password.length < 8) {
    showError('Password must be at least 8 characters.');
    return;
  }

  const btn = registerForm.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Creating account…';
  registrationInProgress = true;

  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    // Save user to Firestore with default role
    await setDoc(doc(db, 'users', user.uid), {
      email: user.email,
      name: name,
      club: club,
      role: 'queuing_master', // Default role. Admin can change this.
      createdAt: serverTimestamp()
    });

    // Keep the selected club available during the first redirect. Without this,
    // an earlier Longos preference can briefly (or permanently, if offline) win.
    localStorage.setItem('dq_club_preference', club);
    // Flag this as a brand-new registration so the dashboard launches the
    // full tutorial walkthrough on first load.
    localStorage.setItem('dq_new_registration', 'true');
    resetAttempts();
    await redirectBasedOnRole(user);
  } catch (error) {
    recordFailedAttempt();
    resetCaptcha();

    if (isLockedOut()) {
      showLockout();
    } else {
      updateAttemptUI();
      showError(friendlyError(error.code));
    }
  } finally {
    registrationInProgress = false;
    btn.disabled = false;
    btn.textContent = 'Register Account';
  }
});

// ─── Human-readable Firebase error messages ────────────────────────────────
function friendlyError(code) {
  const map = {
    'auth/invalid-email':            'Please enter a valid email address.',
    'auth/user-disabled':            'This account has been disabled.',
    'auth/user-not-found':           'No account found with this email.',
    'auth/wrong-password':           'Incorrect password. Please try again.',
    'auth/invalid-credential':       'Invalid email or password.',
    'auth/email-already-in-use':     'An account with this email already exists.',
    'auth/weak-password':            'Password is too weak. Use at least 8 characters.',
    'auth/network-request-failed':   'Network error. Check your connection.',
    'auth/too-many-requests':        'Too many requests. Please wait a few minutes.',
  };
  return map[code] || 'An error occurred. Please try again.';
}

// ─── Auth state change ─────────────────────────────────────────────────────
onAuthStateChanged(auth, (user) => {
  // Hide splash screen smoothly once auth state is resolved
  const splash = document.getElementById('splash-screen');
  if (splash && !splash.classList.contains('splash-skip')) {
    const minDisplayMs = 800;
    const splashStart = window.__splashStart || Date.now();
    const elapsed = Date.now() - splashStart;
    const delay = Math.max(0, minDisplayMs - elapsed);

    setTimeout(() => {
      splash.classList.add('splash-hidden');
      splash.style.pointerEvents = 'none'; // Ensure it doesn't block clicks
      splash.addEventListener('transitionend', () => splash.remove(), { once: true });
      setTimeout(() => { if(document.body.contains(splash)) splash.remove(); }, 1000); // safety fallback
      sessionStorage.setItem('dq_splash_shown', 'true');
    }, delay);
  } else if (splash) {
    splash.remove();
    sessionStorage.setItem('dq_splash_shown', 'true');
  }

  if (user && !registrationInProgress) {
    redirectBasedOnRole(user);
  }

  // If already locked out on page load, show the banner
  if (isLockedOut()) {
    showLockout();
  } else {
    updateAttemptUI();
  }
});

// Force reload on BFCache restore so reCAPTCHA renders correctly
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    window.location.reload();
  }
});
