import test from 'node:test';
import assert from 'node:assert/strict';
import { auditDate, dayBounds, paymentAmounts, summarize, auditCsv, escapeHtml, entryImpact, receiptNumber } from '../public/js/payment-utils.js';

test('audit dates follow UTC+8 across midnight and select only that day', () => {
  assert.equal(auditDate(new Date('2026-10-06T15:59:59Z')), '2026-10-06');
  assert.equal(auditDate(new Date('2026-10-06T16:00:00Z')), '2026-10-07');
  const [start, end] = dayBounds('2026-10-07');
  assert.equal(start.toISOString(), '2026-10-06T16:00:00.000Z');
  assert.equal(end.toISOString(), '2026-10-07T16:00:00.000Z');
  assert.throws(() => dayBounds('2026-02-30'));
});

test('cash change uses exact cents and GCash receives the fee without change', () => {
  assert.deepEqual(paymentAmounts('100', '500', 'Cash'), { feeCents: 10000, receivedCents: 50000, changeCents: 40000 });
  assert.deepEqual(paymentAmounts('0.10', '0.30', 'Cash'), { feeCents: 10, receivedCents: 30, changeCents: 20 });
  assert.deepEqual(paymentAmounts('100.25', '500', 'GCash'), { feeCents: 10025, receivedCents: 10025, changeCents: 0 });
  for (const fee of ['-1', '0', 'NaN', '1e3', '1.001', '1000000.01', '']) assert.throws(() => paymentAmounts(fee, '500', 'Cash'));
  assert.throws(() => paymentAmounts('100', '99.99', 'Cash'));
  assert.throws(() => paymentAmounts('100', '500', 'Other'));
});

const makeEntry = (overrides = {}) => ({ id: 'abc', type: 'payment', playerId: 'juan', playerName: 'Juan', method: 'Cash', feeCents: 10000, receivedCents: 50000, changeCents: 40000, createdAt: new Date('2026-10-07T04:00:00Z'), staffName: 'Owner', note: '', relatedReceiptId: '', ...overrides });

test('audit reconciles cash received minus change minus refunds; counts distinct players', () => {
  const entries = [makeEntry(), makeEntry({ id: 'def', playerId: 'maria', method: 'GCash', receivedCents: 10000, changeCents: 0 }), makeEntry({ id: 'refund_abc', type: 'refund', receivedCents: 0, changeCents: 0, relatedReceiptId: 'abc' })];
  assert.deepEqual(summarize(entries), { players: 2, collected: 10000, cash: 0, gcash: 10000, received: 50000, change: 40000, refunds: 10000, rent: 0, rentPaid: 0, rentRefunds: 0, expenses: 0, expensesPaid: 0, expenseRefunds: 0, totalExpenses: 0, water: 0, ice: 0, other: 0, balance: 10000 });
  // A later-day refund belongs to its own day and can yield a negative net.
  assert.equal(summarize([entries[2]]).collected, -10000);
  assert.equal(summarize([makeEntry(), makeEntry()]).players, 1);
});

test('court rent deducts from the correct method without changing player collections or counts', () => {
  const rent = makeEntry({ id: 'rent1', type: 'rent', playerId: '', playerName: 'Court A', feeCents: 5000, receivedCents: 0, changeCents: 0 });
  const otherRent = { ...rent, id: 'rent2', method: 'GCash', feeCents: 3000 };
  const returnedRent = { ...otherRent, id: 'refund_rent2', type: 'rent_refund', receivedCents: 3000, relatedReceiptId: 'rent2', note: 'Venue returned rent' };
  const totals = summarize([makeEntry(), makeEntry({ playerId: 'maria', method: 'GCash', receivedCents: 10000, changeCents: 0 }), rent, otherRent, returnedRent]);
  assert.deepEqual(totals, { players: 2, collected: 20000, cash: 5000, gcash: 10000, received: 50000, change: 40000, refunds: 0, rent: 5000, rentPaid: 8000, rentRefunds: 3000, expenses: 0, expensesPaid: 0, expenseRefunds: 0, totalExpenses: 5000, water: 0, ice: 0, other: 0, balance: 15000 });
  assert.equal(totals.cash + totals.gcash, totals.balance);
  assert.equal(totals.collected - totals.rent, totals.balance);
  assert.equal(entryImpact(rent), -5000);
  assert.equal(entryImpact(returnedRent), 3000);
  assert.match(receiptNumber(rent), /^RENT-/);
  assert.match(receiptNumber(returnedRent), /^RENT-REF-/);
  assert.ok(auditCsv([rent]).includes('"-50.00"'));
});

test('rent payments and returns belong to the day money moves and allow negative balances', () => {
  const rent = makeEntry({ type: 'rent', playerId: '', feeCents: 100000, receivedCents: 0, changeCents: 0 });
  assert.equal(summarize([rent]).balance, -100000);
  assert.equal(summarize([rent]).players, 0);
  assert.equal(summarize([rent]).collected, 0);
  const returnedRent = { ...rent, type: 'rent_refund', receivedCents: 100000 };
  assert.equal(summarize([returnedRent]).balance, 100000);
  assert.equal(summarize([returnedRent]).rent, -100000);
});

test('CSV preserves quote/newline data and neutralizes spreadsheet formulas', () => {
  const csv = auditCsv([makeEntry({ playerName: '=HYPERLINK("bad")', note: 'One,"two"\nthree' })]);
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"One,""two""\nthree"'));
  assert.ok(csv.includes('"100.00","500.00","400.00","100.00"'));
  assert.equal(escapeHtml('<img onerror="bad">'), '&lt;img onerror=&quot;bad&quot;&gt;');
});

test('water, ice and other expenses reconcile by category and payment method', () => {
  const expense = (category, amount) => makeEntry({ type: 'expense', category, playerId: '', playerName: category, feeCents: amount, receivedCents: 0, changeCents: 0 });
  const water = expense('Water', 2500);
  const ice = { ...expense('Ice', 1500), method: 'GCash' };
  const other = expense('Other', 1000);
  const returnedWater = { ...water, type: 'expense_refund', receivedCents: 2500, relatedReceiptId: water.id };
  const totals = summarize([makeEntry(), water, ice, other, returnedWater]);
  assert.equal(totals.players, 1);
  assert.equal(totals.collected, 10000);
  assert.equal(totals.water, 0);
  assert.equal(totals.ice, 1500);
  assert.equal(totals.other, 1000);
  assert.equal(totals.expensesPaid, 5000);
  assert.equal(totals.expenseRefunds, 2500);
  assert.equal(totals.totalExpenses, 2500);
  assert.equal(totals.balance, 7500);
  assert.equal(totals.cash, 9000);
  assert.equal(totals.gcash, -1500);
  assert.equal(totals.cash + totals.gcash, totals.balance);
  assert.equal(totals.collected - totals.totalExpenses, totals.balance);
  assert.match(receiptNumber(water), /^EXP-/);
  assert.match(receiptNumber(returnedWater), /^EXP-REF-/);
  assert.ok(auditCsv([water, ice]).includes('"Water"'));
  assert.ok(auditCsv([water, ice]).includes('"Ice"'));
});
