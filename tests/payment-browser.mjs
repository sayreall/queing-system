import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import puppeteer from 'puppeteer';

// Isolated Firebase stub: this test never authenticates or writes to production.
const mockFirebase = `
export const db = {};
export const auth = { currentUser: { uid: 'test-owner' } };
const records = new Map();
const listeners = new Set();
let counter = 0;
export function collection(db, ...parts) { return { path: parts.join('/') }; }
export function doc(base, ...parts) { const path = base.path ? base.path + '/' + (parts.join('/') || 'test' + (++counter)) : parts.join('/'); return { path, id: path.split('/').at(-1) }; }
export const serverTimestamp = () => ({ serverTimestamp: true });
export const where = (field, operator, value) => ({ field, operator, value });
export const query = (ref, ...filters) => ({ ...ref, filters });
const snapshot = ref => ({ exists: () => records.has(ref.path), data: () => records.get(ref.path) });
export const getDoc = async ref => snapshot(ref);
function publish() {
  for (const listener of listeners) {
    const docs = [...records].filter(([path, data]) => path.startsWith(listener.ref.path + '/') && listener.ref.filters.every(filter => filter.operator === '>=' ? data[filter.field] >= filter.value : data[filter.field] < filter.value))
      .map(([path, data]) => ({ id: path.split('/').at(-1), data: () => data, metadata: { hasPendingWrites: false } }));
    listener.callback({ docs, metadata: { fromCache: false } });
  }
}
export function onSnapshot(ref, options, callback) {
  const listener = { ref, callback }; listeners.add(listener); queueMicrotask(publish);
  return () => listeners.delete(listener);
}
export async function runTransaction(db, work) {
  const pending = [];
  await work({ get: getDoc, set: (ref, data) => pending.push([ref.path, data]) });
  for (const [path, data] of pending) records.set(path, { ...data, ...(data.createdAt ? { createdAt: new Date() } : {}) });
  queueMicrotask(publish);
}
window.paymentTest = { records, publish };
`;
const bootstrap = `
import { initPaymentAudit } from '/js/payments.js';
document.getElementById('splash-screen')?.remove();
const players = [{ id: 'juan', name: 'Juan', status: 'Waiting' }, { id: 'maria', name: 'Maria', status: 'Waiting' }];
initPaymentAudit({ user: { uid: 'test-owner', email: 'cashier@example.test' }, getPlayers: () => players, showToast: message => console.log(message) });
window.paymentTest.players = players;
document.getElementById('mobile-menu-btn').onclick = () => document.getElementById('sidebar').classList.add('-translate-x-full');
`;
const root = resolve('public');
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/js/firebase.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(mockFirebase); return; }
    if (pathname === '/test-bootstrap.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bootstrap); return; }
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + '\\')) { response.writeHead(403).end(); return; }
    let content = await readFile(file);
    if (file.endsWith('index.html')) content = content.toString().replace('js/dashboard.js?v=40', '/test-bootstrap.js').replace(/<script>\s*if \('serviceWorker'[\s\S]*?<\/script>/, '');
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' })[extname(file)] || 'application/octet-stream');
    response.end(content);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  console.log('Launching isolated browser...');
  browser = await puppeteer.launch({ headless: true });
  console.log('Loading dashboard...');
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'log') console.log('Browser:', message.text()); });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.paymentTest?.players);
  console.log('Checking payment and refund workflows...');
  await page.click('#view-payment-audit-btn');
  await page.waitForFunction(() => document.getElementById('audit-status').textContent.includes('Confirmed'));
  await page.select('#payment-player', 'juan');
  await page.type('#payment-fee', '100');
  await page.type('#payment-received', '500');
  assert.match(await page.$eval('#payment-change', el => el.textContent), /400\.00/);
  await page.click('#payment-save');
  await page.waitForFunction(() => !document.getElementById('payment-receipt-modal').classList.contains('hidden'));
  assert.match(await page.$eval('#payment-receipt-content', el => el.textContent), /Juan/);
  assert.match(await page.$eval('#payment-receipt-content', el => el.textContent), /400\.00/);
  await page.click('#close-payment-receipt');
  // Block duplicate payments before another receipt is created.
  await page.select('#payment-player', 'juan');
  await page.type('#payment-fee', '100');
  await page.type('#payment-received', '100');
  await page.click('#payment-save');
  assert.match(await page.$eval('#payment-error', el => el.textContent), /already paid/);
  assert.equal(await page.evaluate(() => [...window.paymentTest.records.values()].filter(entry => entry.type === 'payment').length), 1);
  // Full refund preserves the original and reduces the day's net total.
  await page.click('[data-audit-receipt="test1"]');
  await page.waitForFunction(() => !document.getElementById('payment-refund-save').disabled);
  await page.type('#payment-refund-reason', 'Incorrect fee entered');
  await page.click('#payment-refund-save');
  await page.waitForFunction(() => document.getElementById('payment-receipt-title').textContent === 'Refund receipt');
  await page.click('#close-payment-receipt');
  assert.equal(await page.evaluate(() => [...window.paymentTest.records.values()].filter(entry => entry.type === 'payment').length), 1);
  assert.equal(await page.evaluate(() => [...window.paymentTest.records.values()].filter(entry => entry.type === 'refund').length), 1);
  // A replacement payment is allowed only after the original is refunded.
  await page.waitForFunction(() => !document.getElementById('payment-player-status').textContent.includes('Already'));
  await page.click('#payment-save');
  await page.waitForFunction(() => !document.getElementById('payment-receipt-modal').classList.contains('hidden'));
  await page.click('#close-payment-receipt');
  // GCash automatically uses the fee, with zero change.
  await page.select('#payment-player', 'maria');
  await page.type('#payment-fee', '150');
  await page.select('#payment-method', 'GCash');
  assert.equal(await page.$eval('#payment-received', el => el.value), '150');
  assert.match(await page.$eval('#payment-change', el => el.textContent), /0\.00/);
  await page.click('#payment-save');
  await page.waitForFunction(() => !document.getElementById('payment-receipt-modal').classList.contains('hidden'));
  await page.click('#close-payment-receipt');
  await page.waitForFunction(() => document.querySelectorAll('#audit-rows tr').length === 4);
  assert.match(await page.$eval('#audit-summary', el => el.textContent), /Net collected.*250\.00/);
  // Player removal leaves the money ledger intact.
  await page.evaluate(() => window.paymentTest.players.splice(0));
  assert.equal(await page.$$eval('#audit-rows tr', rows => rows.length), 4);
  await mkdir('artifacts', { recursive: true });
  // Exercise the real print buttons while replacing only Chrome's print dialog.
  await page.evaluate(() => {
    window.printedDocuments = [];
    const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { ...descriptor, get() {
      const target = descriptor.get.call(this);
      if (target) target.print = () => { console.log('Captured print document'); window.printedDocuments.push(this.srcdoc); };
      return target;
    } });
  });
  const printPage = await browser.newPage();
  await printPage.setViewport({ width: 794, height: 1123 });
  await printPage.emulateMediaType('print');
  for (const [club, name, logo] of [
    ['deuce', 'Deuce Club Queuing System', 'deuce-game-logo.png'],
    ['longos', 'Longos Pickleball Club', 'logo-lpc.jpg'],
    ['balian', 'Balian Picklers Queuing', 'balian-pc.jpg']
  ]) {
    console.log('Checking printed branding:', club);
    await page.bringToFront();
    await page.evaluate(({ name, logo }) => {
      document.querySelector('.header-title').textContent = name;
      document.querySelectorAll('.header-logo, .sidebar-logo').forEach(image => image.src = '/assets/images/' + logo);
    }, { name, logo });
    const previous = await page.evaluate(() => window.printedDocuments.length);
    await page.click('#audit-print');
    console.log('Print button clicked');
    await page.waitForFunction(previous => window.printedDocuments.length > previous, {}, previous);
    const html = await page.evaluate(() => window.printedDocuments.at(-1));
    console.log('Rendering PDF document');
    await printPage.bringToFront();
    await printPage.setContent(html, { waitUntil: 'load' });
    assert.ok(await printPage.$eval('.club-logo', image => image.complete && image.naturalWidth > 0));
    assert.match(await printPage.$eval('.club-logo', image => image.src), new RegExp(logo.replace('.', '\\.')));
    assert.equal(await printPage.$eval('.club-name', element => element.textContent), name.replace(/\s+(Queuing System|Queuing)$/i, ''));
    assert.equal(await printPage.$$eval('table button', buttons => buttons.length), 0);
    assert.match(await printPage.$eval('.highlight', element => element.textContent), /250\.00/);
    await printPage.pdf({ path: 'artifacts/payment-audit-' + club + '.pdf', preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
    await printPage.screenshot({ path: 'artifacts/payment-audit-print-' + club + '.png', fullPage: true });
  }
  await page.bringToFront();
  await page.click('[data-audit-receipt="test3"]');
  const priorReceipts = await page.evaluate(() => window.printedDocuments.length);
  await page.click('#payment-receipt-print');
  await page.waitForFunction(previous => window.printedDocuments.length > previous, {}, priorReceipts);
  const receiptHtml = await page.evaluate(() => window.printedDocuments.at(-1));
  await printPage.bringToFront();
  await printPage.setContent(receiptHtml, { waitUntil: 'load' });
  assert.equal(await printPage.$eval('.club-name', element => element.textContent), 'Balian Picklers');
  assert.match(await printPage.$eval('.receipt-total', element => element.textContent), /150\.00/);
  await printPage.pdf({ path: 'artifacts/payment-receipt-balian.pdf', preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
  await printPage.screenshot({ path: 'artifacts/payment-receipt-print-balian.png', fullPage: true });
  await page.bringToFront();
  await page.click('#close-payment-receipt');
  // Long reports repeat table headers and paginate without splitting player rows.
  const longHtml = await page.evaluate(async () => {
    const { buildAuditPrint, currentPrintBranding } = await import('/js/payment-print.js');
    const entry = [...window.paymentTest.records.values()].find(entry => entry.type === 'payment');
    const { auditDate } = await import('/js/payment-utils.js');
    return buildAuditPrint({ entries: Array.from({ length: 60 }, (_, i) => ({ ...entry, id: 'test-long-receipt-' + i, playerId: 'player-' + i, playerName: 'Player ' + (i + 1) })), day: auditDate(), brand: currentPrintBranding(), preparedBy: 'Test cashier' });
  });
  await printPage.setContent(longHtml, { waitUntil: 'load' });
  const longPdf = await printPage.pdf({ path: 'artifacts/payment-audit-multiple-pages.pdf', preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
  assert.ok((Buffer.from(longPdf).toString('latin1').match(/\/Type \/Page\b/g) || []).length > 1);
  await printPage.close();
  await page.screenshot({ path: 'artifacts/payment-audit-desktop.png' });
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/payment-audit-mobile.png' });
  assert.equal(await page.evaluate(() => document.querySelector('.audit-panel').scrollWidth <= document.querySelector('.audit-panel').clientWidth), true);
  // Older audits contain only records from that date.
  await page.$eval('#audit-date', input => { input.value = '2026-01-01'; input.dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => document.getElementById('audit-rows').textContent.includes('No payments'));
  assert.deepEqual(errors, []);
  console.log('PASS: payment workflows, daily filter, mobile layout, club logos for Deuce/Longos/Balian, receipt printing, and multiple-page PDFs.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
