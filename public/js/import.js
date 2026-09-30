import { SKILLS, addPlayersBulk, fetchExistingNames, normalizeSkill } from "./queue.js";

const fileInput = document.getElementById("import-file");
const tableBody = document.getElementById("import-body");
const saveButton = document.getElementById("import-save");
const summary = document.getElementById("import-summary");

let rows = [];
let existingNames = new Map();

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
      <td>${row.skill || ""}</td>
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
    const skill = (row.Skill || row.skill || "").trim();
    const gender = (row.Gender || row.gender || "Unspecified").trim();
    const location = (row.Location || row.location || "").trim();
    const normalizedSkill = normalizeSkill(skill);
    const nameLower = name.toLowerCase();

    let valid = true;
    let reason = "";
    let isRevive = false;

    if (!name) {
      valid = false;
      reason = "Missing name";
    } else if (!normalizedSkill) {
      valid = false;
      reason = "Invalid skill";
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
      skill: normalizedSkill || skill,
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
  const validRows = rows.filter((row) => row.valid);
  if (!validRows.length) return;

  await addPlayersBulk(validRows);
  rows = [];
  renderRows();
  fileInput.value = "";
  summary.textContent = "Players imported and queued.";
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
    
    let skill = "Beginner"; // Default
    let gender = "Unspecified";
    let location = "";
    
    for (let i = 1; i < parts.length; i++) {
      const pLower = parts[i].toLowerCase();
      if (pLower.includes('rating=')) {
        const rating = parseFloat(pLower.split('=')[1]);
        if (!isNaN(rating)) {
          if (rating >= 4.0) skill = "Advanced";
          else if (rating >= 3.0) skill = "Intermediate";
        }
      }
      if (pLower.includes('skill=')) {
        skill = parts[i].split('=')[1].trim();
      }
      if (pLower.includes('gender=')) {
        gender = parts[i].split('=')[1].trim();
      }
      if (pLower.includes('location=')) {
        location = parts[i].split('=')[1].trim();
      }
    }
    
    return { Name: name, Skill: skill, Gender: gender, Location: location };
  });

  existingNames = await fetchExistingNames();
  validateRows(parsedRows);
  renderRows();
  closeReclubModal();
});
