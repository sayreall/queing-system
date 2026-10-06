import { addPlayersBulk, fetchExistingNames, normalizeSkill, playerNameKey } from "./queue.js";

const fileInput = document.getElementById("import-file");
const tableBody = document.getElementById("import-body");
const saveButton = document.getElementById("import-save");
const summary = document.getElementById("import-summary");

let rows = [];
let existingNames = new Map();
let isSaving = false;

function renderRows() {
  tableBody.innerHTML = "";

  if (!rows.length) {
    tableBody.innerHTML = `
      <tr>
        <td class="py-4 text-slate-500" colspan="5">No file loaded.</td>
      </tr>
    `;
    summary.textContent = "";
    saveButton.disabled = true;
    return;
  }

  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    tr.className = "border-t border-slate-800/60";
    
    const currentGender = (row.gender || "").toLowerCase();
    const isMale = currentGender === "m" || currentGender === "male";
    const isFemale = currentGender === "f" || currentGender === "female";
    
    const selectHTML = `
      <select class="input-field py-1 px-2 text-sm w-full max-w-[120px]" data-index="${index}">
        <option value="" ${!isMale && !isFemale ? "selected" : ""}>Unspecified</option>
        <option value="Male" ${isMale ? "selected" : ""}>Male</option>
        <option value="Female" ${isFemale ? "selected" : ""}>Female</option>
      </select>
    `;

    tr.innerHTML = `
      <td class="py-3 font-semibold">${row.name || ""}</td>
      <td>${row.rating || ""}</td>
      <td>${selectHTML}</td>
      <td class="text-slate-400">${row.location || "—"}</td>
      <td>${row.valid ? (row.isRevive ? "Ready (Revive)" : "Ready") : row.reason}</td>
    `;
    tableBody.appendChild(tr);
  });

  const selects = tableBody.querySelectorAll("select");
  selects.forEach((select) => {
    select.addEventListener("change", (e) => {
      const idx = e.target.getAttribute("data-index");
      rows[idx].gender = e.target.value;
    });
  });

  const validCount = rows.filter((row) => row.valid).length;
  summary.textContent = `${validCount} valid rows ready to import.`;
  saveButton.disabled = validCount === 0;
}

function validateRows(rawRows) {
  const seenNames = new Set();

  rows = rawRows.map((row) => {
    const name = (row.Name || row.name || "").trim();
    const rating = normalizeSkill(row.Rating ?? row.rating);
    const gender = (row.Gender || row.gender || "Unspecified").trim();
    const location = (row.Location || row.location || "").trim();
    const nameLower = playerNameKey(name);

    let valid = true;
    let reason = "";
    let isRevive = false;

    if (!name) {
      valid = false;
      reason = "Missing name";
    } else if (!rating) {
      valid = false;
      reason = "Rating must be 2.0 to 5.0 in 0.5 steps";
    } else if (seenNames.has(nameLower)) {
      valid = false;
      reason = "Duplicate in file";
    } else if (existingNames.has(nameLower)) {
      const status = existingNames.get(nameLower);
      if (status === "Archived") {
        isRevive = true;
      } else {
        valid = false;
        reason = "Already exists";
      }
    }

    seenNames.add(nameLower);

    return {
      name,
      rating,
      gender,
      location,
      valid,
      reason,
      isRevive,
    };
  });
}

async function handleFile(file) {
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: "array" });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });

  existingNames = await fetchExistingNames();
  validateRows(json);
  renderRows();
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  handleFile(file);
});

saveButton.addEventListener("click", async () => {
  if (isSaving) return;
  const validRows = rows.filter((row) => row.valid);
  if (!validRows.length) return;

  isSaving = true;
  saveButton.disabled = true;
  const originalLabel = saveButton.textContent;
  saveButton.textContent = "Saving...";
  try {
    const addToQueue = document.getElementById("add-to-queue-checkbox")?.checked || false;
    await addPlayersBulk(validRows, addToQueue);
    rows = [];
    renderRows();
    fileInput.value = "";
    summary.textContent = addToQueue ? "Players imported and queued." : "Players saved successfully.";
  } catch (error) {
    console.error("Player import failed", error);
    summary.textContent = error.message || "Unable to import players. Please try again.";
    saveButton.disabled = false;
  } finally {
    isSaving = false;
    saveButton.textContent = originalLabel;
  }
});

// Reclub Import Logic
const openReclubBtn = document.getElementById("open-reclub-modal");
const closeReclubBtn = document.getElementById("close-reclub-modal");
const cancelReclubBtn = document.getElementById("reclub-cancel-btn");
const importReclubBtn = document.getElementById("reclub-import-btn");
const reclubModal = document.getElementById("reclub-modal");
const reclubText = document.getElementById("reclub-text");

function closeReclubModal() {
  reclubModal.classList.add("hidden");
  reclubText.value = "";
}

openReclubBtn?.addEventListener("click", () => {
  reclubModal.classList.remove("hidden");
  reclubText.focus();
});

closeReclubBtn?.addEventListener("click", closeReclubModal);
cancelReclubBtn?.addEventListener("click", closeReclubModal);

reclubModal?.addEventListener("click", (e) => {
  if (e.target === reclubModal) closeReclubModal();
});

importReclubBtn?.addEventListener("click", async () => {
  const text = reclubText.value;
  if (!text.trim()) return;

  let cleanText = text.replace(/Participants\s*\(\d+\)\s*/i, '');
  const segments = cleanText.split(/(?:^|\s+)\d+\.\s+/).filter(s => s.trim());
  
  const parsedRows = segments.map(segment => {
    const parts = segment.split('|').map(p => p.trim());
    const name = parts[0];
    
    let rating = "2.0"; // Default for Reclub entries without a rating.
    let gender = "Unspecified";
    let location = "";
    
    for (let i = 1; i < parts.length; i++) {
      const pLower = parts[i].toLowerCase();
      if (pLower.includes('rating=')) {
        rating = normalizeSkill(pLower.split('=')[1]) || null;
      }
      if (pLower.includes('gender=')) {
        gender = parts[i].split('=')[1].trim();
      }
      if (pLower.includes('location=')) {
        location = parts[i].split('=')[1].trim();
      }
    }
    
    return { Name: name, Rating: rating, Gender: gender, Location: location };
  });

  existingNames = await fetchExistingNames();
  validateRows(parsedRows);
  renderRows();
  closeReclubModal();
});
