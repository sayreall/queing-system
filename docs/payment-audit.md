# Daily Payment Audit

Open **Daily Payment Audit** in the dashboard sidebar. You can also click a
player's name, then **Record payment / View today's receipts**.

Select the player, enter the full fee and amount received, and choose Cash or
GCash. Cash change is calculated automatically. GCash receives the exact fee
and has no cash change. Save generates a numbered receipt with the player,
amounts, payment time, payment method, account recording it, and optional note.
Amounts are saved as integer centavos.

The audit defaults to today in Philippine time (UTC+8). It selects receipts
using the confirmed server payment timestamp, rather than the date a player
joined the queue. Use the date picker for earlier days. Print / Save PDF uses
the browser print dialog; Export CSV downloads the day's detailed ledger.
Printed audits and receipts use the current dashboard's club name and logo,
with a summary, itemized payments and review signatures. For a clean PDF,
turn off **Headers and footers** in the browser's print settings.
Complete audit exports require a confirmed connection. Cached results are
clearly marked, and payments and refunds require an internet connection.

Players paid counts distinct players with payment entries that day. Player
payments net is fees received minus player refunds recorded that day.
**Balance after court rent** deducts rental expenses and adds returned court
rent. Cash balance and GCash balance use the same calculation for their
respective methods. Cash received and
change returned count incoming cash payments only. A refund of an earlier
day's payment appears on the day the money is returned and can make that day's
net negative.

Use **Record court rent** to enter the court / venue paid, amount, Cash or GCash,
and an optional reference or note. Rent is recorded for the actual payment day,
even while viewing an earlier audit, and generates its own expense receipt.
It does not add any charge to individual players. For example, PHP 1,000 in
player payments minus PHP 600 in rent leaves PHP 400. Expenses can exceed daily
collections, in which case the remaining balance is negative.

Open a rent receipt to record a **full rent refund received** with a reason,
after the venue returns the money. The original expense is preserved and the
returned amount increases the balance on the day it is received. Rent refunds
are kept separate from refunds returned to players. Only one full refund is
allowed for each rent receipt; partial rent refunds are not supported.
The branded PDF includes an itemized court rent section, rental totals and the
remaining balance. CSV exports include signed money-in / money-out values.

Open a receipt to record a **full refund**, with a required reason. Return the
fee using the original payment method. The original receipt stays intact.
For a correction, refund the original and record a replacement payment.
The daily payment lock prevents duplicate charges from concurrent dashboard
tabs. Only one refund may be recorded per original payment.

Removing or archiving a player does not remove their receipts. Payment records
are private to the authenticated account and live outside the public tenant
collections used by the TV share link.

## Deployment

This feature includes new Firestore rules for `paymentAudits/{ownerId}/entries`
and `paymentAudits/{ownerId}/dailyPlayers`. Deploy those rules alongside the
updated site before using live payments. The previous rules deny access to
these new private paths. No existing records need to be migrated.

## Validation

- `node --test tests/payment-utils.test.mjs` checks exact cash arithmetic,
  invalid amounts, UTC+8 day boundaries, refunds, rent and returned-rent
  reconciliation, method balances, negative balances, and CSV safety.
- `node tests/payment-browser.mjs` uses an isolated Firebase stub. It checks
  payment entry, automatic receipts, duplicate prevention, refund and replacement
  workflows, court rent and rental refunds, method balances, preservation of
  receipts after player removal, daily filtering, branded PDFs, and mobile
  overflow. It never writes to production Firebase.
- Firebase rules compilation was checked with
  `firebase deploy --only firestore:rules --dry-run --project pickleball-e0ed6`.
  This validates compilation without publishing the rules.

## Rules review

The following is a source-level attack review of the added ledger rules;
it is not a substitute for emulator tests of authenticated production SDK
requests. The existing public queue rules are outside this change.

| Attempt | Result in added rules |
| --- | --- |
| Anonymous or TV link reads / lists of payment entries | Denied; ledger owner authentication is required. |
| Another authenticated account reads, writes, refunds, or locks | Denied; UID must match the owner path. |
| Update / delete an existing payment, court rent or refund | Denied, including owner requests. |
| Change owner or staff identity | Denied; authenticated UID and stored staff ID must match the owner path. |
| Negative, fractional, excessive amounts or incorrect change | Denied by integer, range and arithmetic validators. |
| GCash with change or overpayment | Denied; GCash change must be zero. |
| Missing fields, extra fields, wrong types or oversized strings | Denied by required/allowed field checks, types and size bounds. |
| Backdated or future creation timestamp | Denied; timestamp must equal the server request time. |
| Refund nonexistent receipt, a refund, or another owner's receipt | Denied; original must be a payment or rent expense in the same owner's ledger. |
| Return rent using a player refund entry, or refund players using a rent-refund entry | Denied; reversal type must match the original payment or rent type. |
| Rent expense tied to a player, or with received cash / change | Denied; rent must have an empty player ID and zero incoming cash / change. |
| Rent refund has wrong amount, method, court or incoming amount | Denied; the original expense is compared, and incoming amount must equal the full rent. |
| Refund with a different fee, method, player, or no reason | Denied by original-document comparison and reason validation. |
| Replay a refund under another ID | Denied; refund ID must be `refund_` plus original ID. |
| Repeat refund under the same ID | Denied; creates only, no update. |
| Replace daily lock before previous payment has been refunded | Denied; existing refund is required. |
| Lock points to another player's payment or a missing payment | Denied; getAfter checks the newly committed payment and player ID. |
| Read ledger through permissive existing tenant wildcard | No overlap; ledger uses the separate top-level paymentAudits path. |
| Owner bypasses UI and records a payment without the daily lock | The receipt rules allow this; the daily lock coordinates legitimate app clients, not untrusted owners. |

Owners are the cashiers and may record their own payments; these rules do not
independently verify whether physical cash or a GCash transfer actually arrived.
Financial entries cannot be silently changed afterward. Partial refunds,
partial payments and multiple staff accounts are not implemented in this version.

Auditor assessment for the added ledger: **4/5 (prototype)**. Compilation,
owner isolation, schema validation and immutability were reviewed; emulator
coverage for real SDK transactions is still recommended before broader rollout.
