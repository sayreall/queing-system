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
  return `${entry.type === "refund" ? "REF" : "PAY"}-${auditDate(entryDate(entry)).replaceAll("-", "")}-${entry.id}`;
}

export function summarize(entries) {
  const summary = { players: 0, collected: 0, cash: 0, gcash: 0, received: 0, change: 0, refunds: 0 };
  const paidPlayers = new Set();
  for (const entry of entries) {
    const sign = entry.type === "refund" ? -1 : 1;
    summary.collected += sign * entry.feeCents;
    summary[entry.method === "Cash" ? "cash" : "gcash"] += sign * entry.feeCents;
    if (entry.type === "payment") {
      paidPlayers.add(entry.playerId);
      if (entry.method === "Cash") {
        summary.received += entry.receivedCents;
        summary.change += entry.changeCents;
      }
    } else summary.refunds += entry.feeCents;
  }
  summary.players = paidPlayers.size;
  return summary;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function auditCsv(entries) {
  const rows = [["Receipt", "Type", "Player", "Paid at (Philippine time)", "Method", "Fee PHP", "Received PHP", "Change PHP", "Collected PHP", "Staff", "Note / Reason", "Original receipt ID"]];
  for (const entry of entries) rows.push([
    receiptNumber(entry), entry.type, entry.playerName,
    entryDate(entry).toLocaleString("en-PH", { timeZone: AUDIT_TIME_ZONE }), entry.method,
    (entry.feeCents / 100).toFixed(2), (entry.receivedCents / 100).toFixed(2), (entry.changeCents / 100).toFixed(2),
    ((entry.type === "refund" ? -1 : 1) * entry.feeCents / 100).toFixed(2), entry.staffName, entry.note, entry.relatedReceiptId
  ]);
  return "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n");
}
