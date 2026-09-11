import { 
  auth, 
  db, 
  signOut, 
  onAuthStateChanged,
  collection,
  query,
  onSnapshot,
  doc,
  updateDoc,
  getDoc
} from "./firebase.js";

const logoutBtn = document.getElementById('logout-btn');
const usersTableBody = document.getElementById('users-table-body');
const toastContainer = document.getElementById('toast-container');

function showToast(message, tone = "info") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  if (tone === "error") {
    toast.style.borderColor = "rgba(248, 113, 113, 0.6)";
  }
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

// Ensure only admins can access this page
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = 'login.html';
    return;
  }

  try {
    const userDocRef = doc(db, 'users', user.uid);
    const userDoc = await getDoc(userDocRef);
    if (!userDoc.exists() || userDoc.data().role !== 'admin') {
      window.location.href = 'index.html'; // Redirect non-admins
      return;
    }
    
    // User is admin, start loading users
    loadUsers();
  } catch (error) {
    console.error("Error verifying admin role:", error);
    showToast("Error verifying admin permissions.", "error");
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await signOut(auth);
    window.location.href = 'login.html';
  } catch (error) {
    showToast(error.message, "error");
  }
});

function loadUsers() {
  const usersQuery = query(collection(db, 'users'));
  
  onSnapshot(usersQuery, (snapshot) => {
    usersTableBody.innerHTML = '';
    
    if (snapshot.empty) {
      usersTableBody.innerHTML = '<tr><td colspan="5" class="py-4 px-4 text-center text-slate-500">No users found.</td></tr>';
      return;
    }

    snapshot.forEach((userDoc) => {
      const userData = userDoc.data();
      const tr = document.createElement('tr');
      tr.className = "border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors";
      
      let dateString = "Unknown";
      if (userData.createdAt) {
         if (typeof userData.createdAt.toDate === 'function') {
             dateString = userData.createdAt.toDate().toLocaleString();
         }
      }

      tr.innerHTML = `
        <td class="py-3 px-4 font-semibold">${userData.name || 'N/A'}</td>
        <td class="py-3 px-4 text-slate-300">${userData.email}</td>
        <td class="py-3 px-4">
          <select class="input-field text-xs py-1 px-2 h-auto role-select" data-uid="${userDoc.id}">
            <option value="pending" ${userData.role === 'pending' ? 'selected' : ''}>Pending / Disabled</option>
            <option value="queuing_master" ${userData.role === 'queuing_master' ? 'selected' : ''}>Queuing Master</option>
            <option value="admin" ${userData.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
        </td>
        <td class="py-3 px-4 text-slate-400 text-sm">${dateString}</td>
        <td class="py-3 px-4 text-right">
          <button class="btn-primary text-xs px-3 py-1.5 save-role-btn" data-uid="${userDoc.id}" disabled>Saved</button>
        </td>
      `;
      usersTableBody.appendChild(tr);
    });

    // Add event listeners to dropdowns and save buttons
    document.querySelectorAll('.role-select').forEach(select => {
      select.addEventListener('change', (e) => {
        const uid = e.target.getAttribute('data-uid');
        const saveBtn = document.querySelector(`.save-role-btn[data-uid="${uid}"]`);
        saveBtn.disabled = false;
        saveBtn.textContent = "Save";
        saveBtn.style.background = "linear-gradient(135deg, rgba(245, 196, 42, 0.9), rgba(217, 119, 6, 0.9))"; // Gold color for unsaved
      });
    });

    document.querySelectorAll('.save-role-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const uid = e.target.getAttribute('data-uid');
        const select = document.querySelector(`.role-select[data-uid="${uid}"]`);
        const newRole = select.value;
        
        btn.textContent = "Saving...";
        
        try {
          await updateDoc(doc(db, 'users', uid), { role: newRole });
          showToast(`User role updated to ${newRole}`);
          btn.disabled = true;
          btn.textContent = "Saved";
          btn.style.background = ""; // Reset to primary gradient
        } catch (error) {
          showToast(`Error updating role: ${error.message}`, "error");
          btn.textContent = "Error";
        }
      });
    });
  }, (error) => {
    console.error("Error loading users:", error);
    showToast("Error loading users.", "error");
  });
}
