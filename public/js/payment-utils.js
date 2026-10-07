export const AUDIT_TIME_ZONE = "Asia/Manila";
export const MAX_CENTS = 100000000;

export function auditDate(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function dayBounds(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Choose a valid audit date.");
  const start = new Date(`${day}T00:00:00+08:00`);
  if (!Number.isFinite(start.getTime()) || auditDate(start) !== day) throw new Error("Choose a valid audit date.");
  return [start, new Date(start.getTime() + 86400000)];
}

export function toCents(value) {
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error("Enter an amount with up to two decimal places.");
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_CENTS) throw new Error("Amounts must be between PHP 0.01 and PHP 1,000,000.");
  return cents;
}

export function paymentAmounts(fee, received, method) {
  if (!["Cash", "GCash"].includes(method)) throw new Error("Choose Cash or GCash.");
  const feeCents = toCents(fee);
  const receivedCents = method === "GCash" ? feeCents : toCents(received);
  if (receivedCents < feeCents) throw new Error("Amount received must cover the full fee.");
  return { feeCents, receivedCents, changeCents: receivedCents - feeCents };
}

export function money(cents) {
  return new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(cents / 100);
}

export function entryDate(entry) {
  return entry.createdAt?.toDate?.() || new Date(entry.createdAt);
}

export function receiptNumber(entry) {
  const prefix = { payment: "PAY", refund: "REF", rent: "RENT", rent_refund: "RENT-REF" }[entry.type];
  return `${prefix}-${auditDate(entryDate(entry)).replaceAll("-", "")}-${entry.id}`;
}

export const isReversal = entry => ["refund", "rent_refund"].includes(entry.type);
export const isCourtRent = entry => ["rent", "rent_refund"].includes(entry.type);
export const entryLabel = entry => ({ payment: "Payment", refund: "Refund", rent: "Court rent", rent_refund: "Court rent refund" })[entry.type];
export const entryImpact = entry => (["refund", "rent"].includes(entry.type) ? -1 : 1) * entry.feeCents;

export function summarize(entries) {
  const summary = { players: 0, collected: 0, cash: 0, gcash: 0, received: 0, change: 0, refunds: 0, rent: 0, rentPaid: 0, rentRefunds: 0, balance: 0 };
  const paidPlayers = new Set();
  for (const entry of entries) {
    const impact = entryImpact(entry);
    if (!isCourtRent(entry)) summary.collected += impact;
    else {
      summary.rent -= impact;
      if (entry.type === "rent") summary.rentPaid += entry.feeCents;
      else summary.rentRefunds += entry.feeCents;
    }
    summary.balance += impact;
    summary[entry.method === "Cash" ? "cash" : "gcash"] += impact;
    if (entry.type === "payment") {
      paidPlayers.add(entry.playerId);
      if (entry.method === "Cash") {
        summary.received += entry.receivedCents;
        summary.change += entry.changeCents;
      }
    } else if (entry.type === "refund") summary.refunds += entry.feeCents;
  }
  summary.players = paidPlayers.size;
  return summary;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export function csvCell(value) {
  const numeric = typeof value === "number" && Number.isFinite(value);
  let text = numeric ? value.toFixed(2) : String(value ?? "");
  if (!numeric && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function auditCsv(entries) {
  const rows = [["Receipt", "Type", "Player / Payee", "Recorded at (Philippine time)", "Method", "Fee / Amount PHP", "Received PHP", "Change PHP", "Money In / Out PHP", "Staff", "Note / Reason", "Original receipt ID"]];
  for (const entry of entries) rows.push([
    receiptNumber(entry), entry.type, entry.playerName,
    entryDate(entry).toLocaleString("en-PH", { timeZone: AUDIT_TIME_ZONE }), entry.method,
    (entry.feeCents / 100).toFixed(2), (entry.receivedCents / 100).toFixed(2), (entry.changeCents / 100).toFixed(2),
    entryImpact(entry) / 100, entry.staffName, entry.note, entry.relatedReceiptId
  ]);
  return "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n");
}
