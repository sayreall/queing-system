import test from 'node:test';
import assert from 'node:assert/strict';
import { auditDate, dayBounds, paymentAmounts, summarize, auditCsv, escapeHtml } from '../public/js/payment-utils.js';

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
  assert.deepEqual(summarize(entries), { players: 2, collected: 10000, cash: 0, gcash: 10000, received: 50000, change: 40000, refunds: 10000 });
  // A later-day refund belongs to its own day and can yield a negative net.
  assert.equal(summarize([entries[2]]).collected, -10000);
  assert.equal(summarize([makeEntry(), makeEntry()]).players, 1);
});

test('CSV preserves quote/newline data and neutralizes spreadsheet formulas', () => {
  const csv = auditCsv([makeEntry({ playerName: '=HYPERLINK("bad")', note: 'One,"two"\nthree' })]);
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"One,""two""\nthree"'));
  assert.ok(csv.includes('"100.00","500.00","400.00","100.00"'));
  assert.equal(escapeHtml('<img onerror="bad">'), '&lt;img onerror=&quot;bad&quot;&gt;');
});
