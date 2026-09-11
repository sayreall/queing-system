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

const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const toggleBtn = document.getElementById('toggle-btn');
const toggleText = document.getElementById('toggle-text');
const errorDiv = document.getElementById('auth-error');

let isLoginMode = true;

// Toggle between Login and Register modes
toggleBtn.addEventListener('click', () => {
  isLoginMode = !isLoginMode;
  errorDiv.classList.add('hidden');
  
  if (isLoginMode) {
    loginForm.classList.remove('hidden');
    registerForm.classList.add('hidden');
    toggleText.innerHTML = `Don't have an account? <button type="button" id="toggle-btn" class="text-beginner hover:underline focus:outline-none">Register here</button>`;
  } else {
    loginForm.classList.add('hidden');
    registerForm.classList.remove('hidden');
    toggleText.innerHTML = `Already have an account? <button type="button" id="toggle-btn" class="text-beginner hover:underline focus:outline-none">Sign in here</button>`;
  }
  
  // Re-attach listener since we replaced innerHTML
  document.getElementById('toggle-btn').addEventListener('click', () => {
    toggleBtn.click();
  });
});

function showError(message) {
  errorDiv.textContent = message;
  errorDiv.classList.remove('hidden');
}

async function redirectBasedOnRole(user) {
  try {
    const userDocRef = doc(db, 'users', user.uid);
    const userDoc = await getDoc(userDocRef);
    
    if (userDoc.exists()) {
      const role = userDoc.data().role;
      if (role === 'admin') {
        window.location.href = 'admin.html';
      } else {
        window.location.href = 'index.html'; // queuing_master or default
      }
    } else {
      // If user doc doesn't exist for some reason, default to index.html
      window.location.href = 'index.html';
    }
  } catch (error) {
    showError("Error fetching user role: " + error.message);
  }
}

// Handle Login
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged will handle redirection
  } catch (error) {
    showError(error.message);
  }
});

// Handle Register
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('register-email').value;
  const password = document.getElementById('register-password').value;
  const name = document.getElementById('register-name').value;
  
  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    
    // Save user to Firestore with default role
    await setDoc(doc(db, 'users', user.uid), {
      email: user.email,
      name: name,
      role: 'queuing_master', // Default role. Admin can change this.
      createdAt: serverTimestamp()
    });
    
    // onAuthStateChanged will handle redirection
  } catch (error) {
    showError(error.message);
  }
});

// Check auth state
onAuthStateChanged(auth, (user) => {
  if (user) {
    redirectBasedOnRole(user);
  }
});
