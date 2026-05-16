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
        <td class="py-4 text-slate-500" colspan="3">No file loaded.</td>
      </tr>
    `;
    summary.textContent = "";
    saveButton.disabled = true;
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.className = "border-t border-slate-800/60";
    tr.innerHTML = `
      <td class="py-3 font-semibold">${row.name || ""}</td>
      <td>${row.skill || ""}</td>
      <td>${row.gender || "Unspecified"}</td>
      <td>${row.valid ? (row.isRevive ? "Ready (Revive)" : "Ready") : row.reason}</td>
    `;
    tableBody.appendChild(tr);
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
