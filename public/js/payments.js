import { db, auth, collection, doc, query, where, onSnapshot, getDoc, serverTimestamp, runTransaction } from "./firebase.js";
import { AUDIT_TIME_ZONE, auditDate, dayBounds, paymentAmounts, toCents, money, entryDate, receiptNumber, summarize, isCourtRent, isReversal, entryLabel, entryImpact, escapeHtml as esc, auditCsv } from "./payment-utils.js";
import { currentPrintBranding, buildAuditPrint, buildReceiptPrint } from "./payment-print.js";

let context;
let entries = [];
let stopAudit;
let stopToday;
let todayEntries = [];
let selectedReceipt;
let auditReady = false;
let todayReady = false;
let saving = false;
let refundSaving = false;
let receiptVersion = 0;
let returnFocus;
const el = id => document.getElementById(id);
const ledger = () => collection(db, "paymentAudits", context.user.uid, "entries");
const entryRef = id => doc(ledger(), id);
const timeLabel = entry => entryDate(entry).toLocaleString("en-PH", { timeZone: AUDIT_TIME_ZONE });

function friendlyError(error) {
  if (error.code === "permission-denied") return "Payment access is unavailable. The new payment security rules must be deployed for this account.";
  if (error.code === "unavailable" || !navigator.onLine) return "Connect to the internet to save or refund a payment. Nothing has been confirmed yet.";
  return error.message || "Could not save the payment. Please try again.";
}

function datedQuery(day) {
  const [start, end] = dayBounds(day);
  return query(ledger(), where("createdAt", ">=", start), where("createdAt", "<", end));
}

function readSnapshot(snapshot) {
  return snapshot.docs.filter(item => !item.metadata.hasPendingWrites).map(item => ({ ...item.data(), id: item.id }))
    .sort((a, b) => entryDate(b) - entryDate(a) || a.id.localeCompare(b.id));
}

function watchAudit() {
  stopAudit?.();
  entries = [];
  auditReady = false;
  renderAudit();
  el("audit-status").textContent = "Loading payment receipts...";
  let request;
  try { request = datedQuery(el("audit-date").value); }
  catch (error) { el("audit-status").textContent = error.message; return; }
  stopAudit = onSnapshot(request, { includeMetadataChanges: true }, snapshot => {
    entries = readSnapshot(snapshot);
    auditReady = !snapshot.metadata.fromCache;
    el("audit-status").textContent = auditReady ? `${entries.length} entries · Philippine time · Confirmed records` : "Cached records only. Reconnect to confirm the complete audit.";
    renderAudit();
  }, error => {
    auditReady = false;
    entries = [];
    renderAudit();
    el("audit-status").textContent = friendlyError(error);
  });
}

let todayKey;
function watchToday() {
  stopToday?.();
  todayKey = auditDate();
  todayEntries = [];
  todayReady = false;
  stopToday = onSnapshot(datedQuery(todayKey), { includeMetadataChanges: true }, snapshot => {
    todayEntries = readSnapshot(snapshot);
    todayReady = !snapshot.metadata.fromCache;
    updatePlayerStatus();
  }, () => { todayReady = false; updatePlayerStatus(); });
}

function refreshPlayers(playerId = el("payment-player").value) {
  const players = context.getPlayers().filter(player => player.status !== "Archived" || player.id === playerId)
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  el("payment-player").replaceChildren(new Option("Select a player", ""), ...players.map(player => new Option(player.name, player.id)));
  el("payment-player").value = playerId;
  updatePlayerStatus();
}

function updatePlayerStatus() {
  const id = el("payment-player").value;
  const payments = todayEntries.filter(entry => entry.playerId === id && entry.type === "payment");
  const refunds = new Set(todayEntries.filter(entry => entry.type === "refund").map(entry => entry.relatedReceiptId));
  const active = payments.filter(entry => !refunds.has(entry.id));
  el("payment-player-status").textContent = id && active.length ? `Already paid today: ${money(active.reduce((sum, entry) => sum + entry.feeCents, 0))}. Refund an incorrect receipt before recording again.` : "";
  return active;
}

function renderAudit() {
  const totals = summarize(entries);
  const cards = [["Players paid", totals.players], ["Balance after court rent", money(totals.balance)], ["Player payments net", money(totals.collected)], ["Court rent (net)", money(totals.rent)], ["Cash balance", money(totals.cash)], ["GCash balance", money(totals.gcash)], ["Cash received from players", money(totals.received)], ["Change returned", money(totals.change)], ["Player refunds returned", money(totals.refunds)], ["Court rent refunds received", money(totals.rentRefunds)]];
  el("audit-summary").innerHTML = cards.map(([label, value]) => `<div class="audit-stat"><span>${label}</span><strong>${esc(value)}</strong></div>`).join("");
  el("audit-rows").innerHTML = entries.length ? entries.map(entry => `<tr class="${entryImpact(entry) < 0 ? "audit-refund-row" : ""}">
    <td><strong>${esc(entry.playerName)}</strong><small>${esc(receiptNumber(entry))}</small><small>${esc(timeLabel(entry))} · ${esc(entryLabel(entry))}</small></td>
    <td>${esc(entry.method)}</td><td>${esc(money(entry.feeCents))}</td><td>${esc(money(entry.receivedCents))}</td><td>${esc(money(entry.changeCents))}</td>
    <td>${esc(money(entryImpact(entry)))}</td><td><button type="button" class="btn-secondary text-xs" data-audit-receipt="${esc(entry.id)}">Receipt</button></td>
    </tr>`).join("") : `<tr><td colspan="7" class="text-center text-slate-400 py-8">${auditReady ? "No payments recorded for this day." : "Waiting for confirmed payment records..."}</td></tr>`;
  el("audit-print").disabled = !auditReady;
  el("audit-export").disabled = !auditReady;
}

async function saveCourtRent(event) {
  event.preventDefault();
  if (saving) return;
  const button = el("court-rent-save");
  try {
    el("court-rent-error").textContent = "";
    if (!navigator.onLine) throw new Error("Connect to the internet to record court rent.");
    const payee = el("court-rent-payee").value.trim();
    if (!payee) throw new Error("Enter the court or venue you paid.");
    const feeCents = toCents(el("court-rent-amount").value);
    const method = el("court-rent-method").value;
    if (!["Cash", "GCash"].includes(method)) throw new Error("Choose Cash or GCash.");
    saving = true;
    button.disabled = true;
    button.textContent = "Confirming court rent...";
    const ref = doc(ledger());
    const data = { type: "rent", playerId: "", playerName: payee, feeCents, receivedCents: 0, changeCents: 0,
      method, note: el("court-rent-note").value.trim(), relatedReceiptId: "", staffId: context.user.uid,
      staffName: (context.user.email || context.user.displayName || "Owner").slice(0, 120), createdAt: serverTimestamp() };
    await runTransaction(db, async transaction => {
      const previous = await transaction.get(ref);
      if (previous.exists()) throw new Error("This court rent receipt already exists.");
      transaction.set(ref, data);
    });
    const saved = await getDoc(ref);
    const receipt = { ...saved.data(), id: ref.id };
    el("court-rent-form").reset();
    el("audit-date").value = auditDate(entryDate(receipt));
    watchAudit();
    context.showToast("Court rent saved and deducted from the daily balance.");
    await showReceipt(receipt);
  } catch (error) { el("court-rent-error").textContent = friendlyError(error); }
  finally { saving = false; button.disabled = false; button.textContent = "Save court rent & generate receipt"; }
}

function updateChange() {
  const isGCash = el("payment-method").value === "GCash";
  el("payment-received").readOnly = isGCash;
  if (isGCash) el("payment-received").value = el("payment-fee").value;
  try {
    const amounts = paymentAmounts(el("payment-fee").value, el("payment-received").value, el("payment-method").value);
    el("payment-change").textContent = money(amounts.changeCents);
    el("payment-error").textContent = "";
  } catch (error) {
    el("payment-change").textContent = "—";
    el("payment-error").textContent = el("payment-fee").value && el("payment-received").value ? error.message : "";
  }
}

function openAudit(playerId = "") {
  returnFocus = document.activeElement;
  if (todayKey !== auditDate()) watchToday();
  el("audit-date").value = auditDate();
  refreshPlayers(playerId);
  el("payment-error").textContent = "";
  el("payment-audit-modal").classList.remove("hidden");
  const sidebar = el("sidebar");
  if (window.innerWidth < 768 && !sidebar.classList.contains("-translate-x-full")) el("mobile-menu-btn").click();
  watchAudit();
  el(playerId ? "payment-fee" : "audit-date").focus();
}

export function openPlayerPayment(playerId) {
  if (context) openAudit(playerId);
}

async function savePayment(event) {
  event.preventDefault();
  if (saving) return;
  const button = el("payment-save");
  try {
    if (!navigator.onLine) throw new Error("Connect to the internet to save a payment.");
    if (todayKey !== auditDate()) { watchToday(); throw new Error("A new day has started. Please review and save the payment again."); }
    if (!todayReady) throw new Error("Wait for today's payments to finish syncing before recording a payment.");
    const player = context.getPlayers().find(player => player.id === el("payment-player").value);
    if (!player) throw new Error("Select an existing player.");
    if (updatePlayerStatus().length) throw new Error("This player has already paid today. Open their receipt to record a refund before correcting it.");
    const amounts = paymentAmounts(el("payment-fee").value, el("payment-received").value, el("payment-method").value);
    saving = true;
    button.disabled = true;
    button.textContent = "Confirming payment...";
    const ref = doc(ledger());
    const paymentDay = todayKey;
    const data = { type: "payment", playerId: player.id, playerName: player.name, ...amounts,
      method: el("payment-method").value, note: el("payment-note").value.trim(), relatedReceiptId: "",
      staffId: context.user.uid, staffName: (context.user.email || context.user.displayName || "Owner").slice(0, 120), createdAt: serverTimestamp() };
    // A per-player daily lock prevents two tabs from charging the same player.
    const lock = doc(db, "paymentAudits", context.user.uid, "dailyPlayers", `${paymentDay}_${player.id}`);
    await runTransaction(db, async transaction => {
      const previous = await transaction.get(lock);
      if (previous.exists()) {
        const refund = await transaction.get(entryRef(`refund_${previous.data().receiptId}`));
        if (!refund.exists()) throw new Error("This player already has a payment today. Refund that receipt before recording again.");
      }
      if (paymentDay !== auditDate()) throw new Error("A new day has started. Please save this payment again.");
      transaction.set(ref, data);
      transaction.set(lock, { receiptId: ref.id, playerId: player.id, day: paymentDay });
    });
    const saved = await getDoc(ref);
    const receipt = { ...saved.data(), id: ref.id };
    el("payment-form").reset();
    updateChange();
    el("audit-date").value = auditDate(entryDate(receipt));
    watchAudit();
    context.showToast("Payment saved. Receipt generated.");
    await showReceipt(receipt);
  } catch (error) { el("payment-error").textContent = friendlyError(error); }
  finally { saving = false; button.disabled = false; button.textContent = "Save payment & generate receipt"; }
}

function receiptMarkup(entry) {
  const fields = [["Receipt number", receiptNumber(entry)], [isCourtRent(entry) ? "Court / Paid to" : "Player", entry.playerName], ["Recorded at", `${timeLabel(entry)} (UTC+8)`], ["Payment method", entry.method]];
  if (entry.type === "payment") fields.push(["Fee", money(entry.feeCents)], ["Amount received", money(entry.receivedCents)], ["Change returned", money(entry.changeCents)]);
  fields.push([{ payment: "Collected", refund: "Refund returned", rent: "Court rent paid", rent_refund: "Court rent refund received" }[entry.type], money(entry.feeCents)], ["Recorded by", entry.staffName]);
  if (entry.note) fields.push([isReversal(entry) ? "Refund reason" : "Note / Reference", entry.note]);
  if (entry.relatedReceiptId) fields.push(["Original receipt ID", entry.relatedReceiptId]);
  return `<p class="audit-receipt-brand">${esc(currentPrintBranding().name)} · ${esc(entryLabel(entry))} receipt</p><dl class="audit-receipt-fields">${fields.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl><p class="audit-receipt-footnote">Payment acknowledgement for club records.</p>`;
}

async function showReceipt(entry) {
  const version = ++receiptVersion;
  selectedReceipt = entry;
  el("payment-receipt-title").textContent = `${entryLabel(entry)} receipt`;
  el("payment-receipt-content").innerHTML = receiptMarkup(entry);
  el("payment-refund-form").classList.toggle("hidden", isReversal(entry));
  el("payment-refund-save").textContent = entry.type === "rent" ? "Record full rent refund received" : "Record full refund";
  el("payment-refund-reason-label").textContent = entry.type === "rent" ? "Reason for court rent refund" : "Reason for full refund";
  el("payment-refund-reason").value = "";
  el("payment-refund-save").disabled = true;
  el("payment-refund-status").textContent = "Checking refund status...";
  el("payment-receipt-modal").classList.remove("hidden");
  el("close-payment-receipt").focus();
  if (isReversal(entry)) return;
  try {
    const refund = await getDoc(entryRef(`refund_${entry.id}`));
    if (version !== receiptVersion) return;
    el("payment-refund-save").disabled = refund.exists();
    el("payment-refund-status").textContent = refund.exists() ? `Fully refunded: ${timeLabel(refund.data())}. Original receipt preserved.` : entry.type === "rent" ? "Record this only after the venue returns the full rent through the original payment method." : "Refunds return the full fee through the original payment method.";
  } catch (error) { if (version === receiptVersion) el("payment-refund-status").textContent = friendlyError(error); }
}

async function saveRefund(event) {
  event.preventDefault();
  const original = selectedReceipt;
  const reason = el("payment-refund-reason").value.trim();
  if (!original || isReversal(original) || refundSaving || el("payment-refund-save").disabled) return;
  refundSaving = true;
  el("payment-refund-save").disabled = true;
  try {
    if (!reason) throw new Error("Enter a reason for this refund.");
    if (!navigator.onLine) throw new Error("Connect to the internet to record a refund.");
    const ref = entryRef(`refund_${original.id}`);
    await runTransaction(db, async transaction => {
      const payment = await transaction.get(entryRef(original.id));
      const previousRefund = await transaction.get(ref);
      if (!payment.exists() || !["payment", "rent"].includes(payment.data().type)) throw new Error("Original payment or court rent not found.");
      if (previousRefund.exists()) throw new Error("This receipt has already been refunded.");
      const source = payment.data();
      transaction.set(ref, { ...source, type: source.type === "rent" ? "rent_refund" : "refund", relatedReceiptId: original.id, receivedCents: source.type === "rent" ? source.feeCents : 0,
        changeCents: 0, note: reason, staffId: context.user.uid,
        staffName: (context.user.email || context.user.displayName || "Owner").slice(0, 120), createdAt: serverTimestamp() });
    });
    const saved = await getDoc(ref);
    context.showToast("Refund recorded. Original receipt preserved.");
    await showReceipt({ ...saved.data(), id: ref.id });
  } catch (error) {
    el("payment-refund-status").textContent = friendlyError(error);
    el("payment-refund-save").disabled = false;
  }
  finally { refundSaving = false; }
}

function printDocument(title, documentHtml) {
  const frame = document.createElement("iframe");
  frame.title = title;
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;";
  frame.onload = async () => {
    const target = frame.contentWindow;
    // Ensure the club logo has decoded before opening the print preview.
    await target.document.fonts.ready;
    await Promise.allSettled([...target.document.images].map(image => image.decode()));
    if (!frame.isConnected) return;
    target.addEventListener("afterprint", () => frame.remove(), { once: true });
    target.focus();
    target.print();
    setTimeout(() => frame.remove(), 60000);
  };
  frame.srcdoc = documentHtml;
  document.body.append(frame);
}

function printAudit() {
  if (!auditReady) return;
  printDocument(`Daily Payment Audit · ${el("audit-date").value}`, buildAuditPrint({
    entries, day: el("audit-date").value, brand: currentPrintBranding(),
    preparedBy: context.user.displayName || context.user.email || "Owner"
  }));
}

function closeReceipt() {
  if (refundSaving) { context.showToast("Wait for the refund confirmation before closing."); return; }
  receiptVersion++;
  el("payment-receipt-modal").classList.add("hidden");
  el("close-payment-audit").focus();
}

function closeAudit() {
  if (saving) { context.showToast("Wait for the payment confirmation before closing."); return; }
  el("payment-audit-modal").classList.add("hidden");
  stopAudit?.();
  returnFocus?.focus();
}

export function initPaymentAudit(options) {
  context = options;
  watchToday();
  el("view-payment-audit-btn").addEventListener("click", () => openAudit());
  el("close-payment-audit").addEventListener("click", closeAudit);
  el("close-payment-receipt").addEventListener("click", closeReceipt);
  el("audit-date").addEventListener("change", watchAudit);
  el("audit-today").addEventListener("click", () => { el("audit-date").value = auditDate(); watchAudit(); });
  el("payment-player").addEventListener("change", updatePlayerStatus);
  el("payment-player").addEventListener("focus", () => refreshPlayers());
  for (const id of ["payment-fee", "payment-received", "payment-method"]) el(id).addEventListener("input", updateChange);
  el("payment-form").addEventListener("submit", savePayment);
  el("court-rent-form").addEventListener("submit", saveCourtRent);
  el("payment-refund-form").addEventListener("submit", saveRefund);
  el("audit-rows").addEventListener("click", event => {
    const button = event.target.closest("[data-audit-receipt]");
    const receipt = entries.find(entry => entry.id === button?.dataset.auditReceipt);
    if (receipt) showReceipt(receipt);
  });
  el("payment-receipt-print").addEventListener("click", () => { if (selectedReceipt) printDocument("Club receipt", buildReceiptPrint({ entry: selectedReceipt, brand: currentPrintBranding() })); });
  el("audit-print").addEventListener("click", printAudit);
  el("audit-export").addEventListener("click", () => {
    if (!auditReady) return;
    const url = URL.createObjectURL(new Blob([auditCsv(entries)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `payment-audit-${el("audit-date").value}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.addEventListener("keydown", event => {
    const modal = !el("payment-receipt-modal").classList.contains("hidden") ? el("payment-receipt-modal") : !el("payment-audit-modal").classList.contains("hidden") ? el("payment-audit-modal") : null;
    if (!modal) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); modal.id === "payment-receipt-modal" ? closeReceipt() : closeAudit(); }
    if (event.key === "Tab") {
      const fields = [...modal.querySelectorAll("button, input, select, [tabindex='0']")].filter(field => !field.disabled && field.getClientRects().length);
      const first = fields[0], last = fields.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }, true);
  // Start a new daily subscription when a long-running dashboard crosses midnight.
  setInterval(() => { if (auth.currentUser && todayKey !== auditDate()) { watchToday(); updatePlayerStatus(); } }, 30000);
}
