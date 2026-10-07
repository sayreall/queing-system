import { AUDIT_TIME_ZONE, dayBounds, entryDate, receiptNumber, summarize, money, escapeHtml as esc } from "./payment-utils.js";

// Read the same branding that the authenticated dashboard currently displays.
// Do not use a previous account's locally saved club preference.
export function currentPrintBranding() {
  const image = document.querySelector(".header-logo, .sidebar-logo");
  const logoUrl = image?.src || new URL("assets/images/logologinpage-transparent.png", document.baseURI).href;
  const name = (document.querySelector(".header-title")?.textContent || "PicklQ")
    .replace(/\s+(Queuing System|Queuing)$/i, "").trim();
  const accent = logoUrl.includes("deuce-game-logo") ? "#b84918"
    : logoUrl.includes("balian-pc") ? "#245a91" : "#176b58";
  return { name, logoUrl, accent };
}

const dateLabel = date => date.toLocaleDateString("en-PH", { timeZone: AUDIT_TIME_ZONE, year: "numeric", month: "long", day: "numeric" });
const timeLabel = entry => entryDate(entry).toLocaleTimeString("en-PH", { timeZone: AUDIT_TIME_ZONE, hour: "numeric", minute: "2-digit" });

const PRINT_STYLES = `
  :root { color-scheme:light; }
  * { box-sizing:border-box; }
  body { margin:0; color:#202a33; background:#fff; font-family:Arial,Helvetica,sans-serif; font-size:10px; line-height:1.45; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .report { width:100%; }
  .brand-header { display:flex; align-items:center; gap:17px; padding:0 0 20px; border-bottom:3px solid var(--club-accent); }
  .club-logo { width:76px; height:76px; object-fit:contain; border-radius:50%; flex-shrink:0; }
  .club-name { margin:0 0 5px; font-size:24px; line-height:1.15; letter-spacing:-.5px; font-weight:700; }
  .eyebrow { margin:0; color:var(--club-accent); font-size:9px; letter-spacing:1.8px; text-transform:uppercase; font-weight:700; }
  .report-meta { margin-left:auto; text-align:right; min-width:150px; color:#65717c; font-size:9px; }
  .report-meta strong { display:block; color:#202a33; font-size:11px; margin:4px 0; }
  .report-heading { display:flex; justify-content:space-between; align-items:flex-start; margin:23px 0 18px; gap:20px; }
  h1 { font-size:24px; line-height:1.1; margin:0 0 7px; letter-spacing:-.5px; }
  .muted { color:#65717c; }
  .report-heading p { margin:0; font-size:10px; }
  .status-tag { border:1px solid #bacdc7; padding:5px 9px; border-radius:4px; color:var(--club-accent); font-weight:700; font-size:9px; white-space:nowrap; }
  .summary { display:grid; grid-template-columns:1fr 1fr 1.2fr; gap:12px; margin-bottom:16px; break-inside:avoid; }
  .summary-card { border:1px solid #d8e0e5; border-radius:7px; padding:13px 15px; }
  .summary-card span { display:block; color:#65717c; font-size:9px; margin-bottom:5px; }
  .summary-card strong { display:block; font-size:23px; letter-spacing:-.5px; }
  .summary-card.highlight { border:1.5px solid var(--club-accent); background:#f5f8f7; }
  .summary-card.highlight strong { color:var(--club-accent); }
  .reconciliation { display:grid; grid-template-columns:repeat(5,1fr); margin:0 0 24px; border:1px solid #d8e0e5; border-radius:6px; break-inside:avoid; }
  .reconciliation div { padding:10px 11px; border-right:1px solid #d8e0e5; }
  .reconciliation div:last-child { border:0; }
  .reconciliation span { display:block; font-size:8px; color:#65717c; }
  .reconciliation strong { display:block; font-size:12px; margin-top:4px; }
  .section-heading { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:9px; }
  .section-heading h2 { margin:0; font-size:13px; }
  .section-heading span { font-size:9px; color:#65717c; }
  table { width:100%; border-collapse:collapse; table-layout:fixed; font-size:9px; }
  thead { display:table-header-group; }
  th { padding:9px 7px; background:#eef2f4; border-top:1px solid #d8e0e5; border-bottom:1px solid #c4cfd6; text-align:left; font-size:8px; color:#4f5e69; font-weight:700; }
  td { padding:11px 7px; vertical-align:top; border-bottom:1px solid #e0e6ea; }
  tr { break-inside:avoid; }
  th:first-child { width:35%; }
  th:nth-child(2) { width:11%; }
  th:nth-child(n+3) { width:13.5%; }
  .amount { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .player-name { font-size:11px; display:block; margin-bottom:4px; }
  .entry-meta { display:block; font-size:8px; color:#65717c; margin-top:3px; overflow-wrap:anywhere; }
  .entry-id { font-size:7px; color:#7a858e; }
  .refund-row { background:#fcf5f3; }
  .refund-row .collected { color:#a13b2b; }
  .refund-tag { font-size:7px; letter-spacing:.5px; color:#a13b2b; margin-left:5px; }
  .totals-row td { border-top:2px solid #c4cfd6; background:#f5f7f8; font-weight:700; padding:12px 7px; }
  .empty-row { text-align:center; padding:30px; color:#65717c; }
  .report-note { margin:12px 0 0; color:#65717c; font-size:8px; }
  .signatures { display:grid; grid-template-columns:1fr 1fr; gap:45px; margin-top:38px; break-inside:avoid; }
  .signature-line { border-top:1px solid #87949e; padding-top:7px; }
  .signature-line strong { display:block; font-size:9px; overflow-wrap:anywhere; }
  .signature-line span { display:block; font-size:8px; color:#65717c; margin-top:3px; }
  .report-footer { display:flex; justify-content:space-between; gap:20px; padding-top:12px; margin-top:22px; border-top:1px solid #e0e6ea; color:#7a858e; font-size:8px; break-inside:avoid; }
  .receipt-details { border:1px solid #d8e0e5; border-radius:7px; padding:4px 17px; margin:0; }
  .receipt-details div { display:grid; grid-template-columns:145px minmax(0,1fr); gap:15px; padding:11px 0; border-bottom:1px solid #e0e6ea; }
  .receipt-details div:last-child { border:0; }
  dt { color:#65717c; font-size:10px; }
  dd { margin:0; font-size:11px; font-weight:600; text-align:right; overflow-wrap:anywhere; }
  .receipt-total { margin-top:18px; border:1.5px solid var(--club-accent); border-radius:7px; display:flex; align-items:center; justify-content:space-between; padding:17px; background:#f5f8f7; break-inside:avoid; }
  .receipt-total span { font-size:11px; font-weight:700; }
  .receipt-total strong { color:var(--club-accent); font-size:27px; }
  @page { size:A4 portrait; margin:14mm; }
  @media screen { body { padding:35px; } .report { max-width:720px; margin:auto; } }
`;

function pageShell({ brand, title, day, content, preparedBy = "", generatedAt = new Date() }) {
  const date = dateLabel(dayBounds(day)[0]);
  const generated = generatedAt.toLocaleString("en-PH", { timeZone: AUDIT_TIME_ZONE, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(brand.name)} - ${esc(title)} - ${esc(day)}</title><style>${PRINT_STYLES}</style></head>
    <body style="--club-accent:${esc(brand.accent)}"><main class="report">
      <header class="brand-header">
        <img class="club-logo" src="${esc(brand.logoUrl)}" alt="${esc(brand.name)} logo">
        <div><p class="eyebrow">Club payment records</p><p class="club-name">${esc(brand.name)}</p><span class="muted">Payments &amp; receipts</span></div>
        <div class="report-meta">REPORT DATE<strong>${esc(date)}</strong>Philippine time · UTC+8</div>
      </header>
      ${content}
      <section class="signatures"><div class="signature-line"><strong>${esc(preparedBy || brand.name)}</strong><span>Prepared by / Recorded by</span></div><div class="signature-line"><strong>Reviewed by</strong><span>Name &amp; signature</span></div></section>
      <footer class="report-footer"><span>${esc(brand.name)} · Payment acknowledgement for club records</span><span>Generated ${esc(generated)} · UTC+8</span></footer>
    </main></body></html>`;
}

export function buildAuditPrint({ entries, day, brand, preparedBy, generatedAt }) {
  const totals = summarize(entries);
  const incoming = entries.filter(entry => entry.type === "payment");
  const received = incoming.reduce((sum, entry) => sum + entry.receivedCents, 0);
  const rows = entries.map(entry => {
    const refund = entry.type === "refund";
    return `<tr class="${refund ? "refund-row" : ""}"><td><strong class="player-name">${esc(entry.playerName)}${refund ? '<span class="refund-tag">REFUND</span>' : ""}</strong>
      <span class="entry-meta">${esc(timeLabel(entry))} · ${esc(entry.staffName)}</span><span class="entry-meta entry-id">${esc(receiptNumber(entry))}</span>
      ${entry.note ? `<span class="entry-meta">${esc(refund ? "Reason" : "Note")}: ${esc(entry.note)}</span>` : ""}
      ${refund ? `<span class="entry-meta entry-id">Original: ${esc(entry.relatedReceiptId)}</span>` : ""}</td>
      <td>${esc(entry.method)}</td><td class="amount">${refund ? "—" : esc(money(entry.feeCents))}</td><td class="amount">${refund ? "—" : esc(money(entry.receivedCents))}</td><td class="amount">${refund ? "—" : esc(money(entry.changeCents))}</td><td class="amount collected"><strong>${esc(money((refund ? -1 : 1) * entry.feeCents))}</strong></td></tr>`;
  }).join("");
  const detailTotals = [["Cash net", totals.cash], ["GCash net", totals.gcash], ["Cash received", totals.received], ["Change returned", totals.change], ["Refunds returned", totals.refunds]];
  const content = `<section class="report-heading"><div><h1>Daily Payment Audit</h1><p class="muted">Payment activity for ${esc(dateLabel(dayBounds(day)[0]))}</p></div><span class="status-tag">DAILY COLLECTION REPORT</span></section>
    <section class="summary"><div class="summary-card"><span>Players paid</span><strong>${totals.players}</strong></div><div class="summary-card"><span>Total payments before refunds</span><strong>${esc(money(totals.collected + totals.refunds))}</strong></div><div class="summary-card highlight"><span>Net collected</span><strong>${esc(money(totals.collected))}</strong></div></section>
    <section class="reconciliation">${detailTotals.map(([label, value]) => `<div><span>${label}</span><strong>${esc(money(value))}</strong></div>`).join("")}</section>
    <div class="section-heading"><h2>Player payments &amp; receipts</h2><span>${incoming.length} payment${incoming.length === 1 ? "" : "s"} · ${entries.length - incoming.length} refund${entries.length - incoming.length === 1 ? "" : "s"} · All amounts in PHP</span></div>
    <table><thead><tr><th>Player / Receipt</th><th>Method</th><th class="amount">Fee</th><th class="amount">Received</th><th class="amount">Change</th><th class="amount">Collected</th></tr></thead><tbody>${rows || '<tr><td class="empty-row" colspan="6">No payments recorded for this day.</td></tr>'}
    ${entries.length ? `<tr class="totals-row"><td colspan="2">DAILY TOTAL</td><td class="amount">${esc(money(totals.collected + totals.refunds))}</td><td class="amount">${esc(money(received))}</td><td class="amount">${esc(money(totals.change))}</td><td class="amount">${esc(money(totals.collected))}</td></tr>` : ""}</tbody></table>
    <p class="report-note">Net collected = total payments − refunds returned. Refunds appear on the day money is returned; original receipts are preserved. Players paid counts distinct players with a payment that day.</p>`;
  return pageShell({ brand, title: "Daily Payment Audit", day, content, preparedBy, generatedAt });
}

export function buildReceiptPrint({ entry, brand, generatedAt }) {
  const refund = entry.type === "refund";
  const day = new Date(entryDate(entry).getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const fields = [["Player", entry.playerName], ["Receipt number", receiptNumber(entry)], ["Recorded at", `${dateLabel(entryDate(entry))} · ${timeLabel(entry)}`], ["Payment method", entry.method], ["Fee", money(entry.feeCents)]];
  if (!refund) fields.push(["Amount received", money(entry.receivedCents)], ["Change returned", money(entry.changeCents)]);
  fields.push(["Recorded by", entry.staffName]);
  if (entry.note) fields.push([refund ? "Refund reason" : "Note / Reference", entry.note]);
  if (entry.relatedReceiptId) fields.push(["Original receipt ID", entry.relatedReceiptId]);
  const title = refund ? "Refund Receipt" : "Payment Receipt";
  const content = `<section class="report-heading"><div><h1>${title}</h1><p class="muted">${refund ? "Full refund acknowledgement" : "Player payment acknowledgement"}</p></div><span class="status-tag">${refund ? "REFUND RECORDED" : "PAYMENT RECORDED"}</span></section>
    <dl class="receipt-details">${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>
    <div class="receipt-total"><span>${refund ? "Amount refunded" : "Total collected"}</span><strong>${esc(money(entry.feeCents))}</strong></div>
    <p class="report-note">${refund ? "This refund is recorded separately. The original payment receipt remains in the audit history." : "Thank you. Keep this receipt for your club payment records."}</p>`;
  return pageShell({ brand, title, day, content, preparedBy: entry.staffName, generatedAt });
}
