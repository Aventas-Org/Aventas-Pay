# Payment operations runbook — pending operator adoption

This implements the documentation portion of issues #17, #20 and #22. It is
not a completed incident drill, refund execution, legal sign-off or launch
approval. The owner must name a payments lead, second reviewer, support owner
and incident commander, approve response targets and retention periods, then
exercise this procedure with synthetic records in isolated staging.

## Manual verification

- Use the existing Trusted Verifier role. Never approve from a screenshot,
  supplied UTR, email sender/body, QR scan or page status alone.
- Open the merchant's bank/PSP transaction record independently. Confirm
  credited state, exact INR amount after wallet adjustment, intended recipient,
  unique reference, transaction time and correct order/buyer mapping. Do not
  collect a customer's PIN, OTP, credentials or screen sharing.
- Check reference reuse before approving. Unclear, partial, reversed, duplicate
  or unmatched funds remain under review; prevent delivery until resolved.
- Record order reference, verifier identity, timestamp and opaque receipt
  digest in the authorized bot workflow. Keep raw bank evidence in the approved
  restricted evidence store, never checkout logs or GitHub issues.
- Require a second authorized reviewer for any override, duplicate claim,
  recipient mismatch, ambiguous transfer or refund. The owner must decide any
  additional value thresholds before launch. There is no permitted bypass
  that fabricates a successful bank transaction.

## Discrepancies and customer support

| Situation | Staff action | Customer wording |
| --- | --- | --- |
| Customer debited, website PENDING/unavailable | Check merchant account and bot record; examine notification queue | Do not pay again while we check your order |
| Bot VERIFIED, website expired/cancelled | Reconcile bank receipt and delivery; record website discrepancy for review | Your existing payment is being checked; a new link is not a request to pay twice |
| Underpayment, overpayment or duplicate transfer | Restrict fulfillment and escalate to payments lead; independently match each transfer | We need staff review before confirming the order or any refund |
| Wrong recipient or receipt reused | Stop approval; second reviewer and incident owner investigate | We cannot confirm this receipt for this order yet |
| Refund/dispute request | Ticket to payments lead; independently verify original payer and entitlement | We have opened a review ticket; this message does not confirm a refund |

Refunds are separate authorized financial actions. No automated payout,
refund promise, tax adjustment or credit note is created by this runbook.
Record approved outcome and reference in the restricted reconciliation ledger.

## Observability and escalation

The following are **proposed launch targets**, not measured SLOs or configured
alerts. Operators must connect and test alert delivery before closing #20.

| Signal | Proposed trigger | Response |
| --- | --- | --- |
| Auth rejects | Sustained failures from the bot for 5 minutes | Stop hosted create; investigate environment/secret names without copying values |
| Checkout API failures | Repeated 5xx or no successful synthetic check for 5 minutes | Incident owner; preserve manual verification and hide stale instructions |
| Receipt conflict / terminal 409 | Every occurrence | Payments lead review; never retry with a fabricated reference |
| Outbox NEEDS_REVIEW | Every new row | Staff reconcile order, bank record and delivery |
| Pending notification | Older than 15 minutes | Investigate retry delivery before the existing 12-attempt/2-hour review cap |
| Amount or recipient mismatch | Any occurrence | Immediate stop of hosted checkout and second reviewer |

Allowed operational diagnostics: event/category, HTTP status, timestamp,
latency, queue state/age/attempt count and restricted order reference. Never
export secrets, capability URLs, raw receipts/screenshots, Discord buyer IDs,
UPI destinations or free-form exceptions into public issues or alerts.

## Incident and rollback drill

1. Declare incident owner and record time/revisions. Disable hosted checkout
   using the approved operator process so the existing manual route remains
   available. Do not enable email auto approval.
2. Preserve database/queue records and a restricted discrepancy ledger. Do not
   delete sessions, rotate token secrets mid-session, clear receipts or turn
   a failed website notice into a failed bank payment.
3. Roll back to recorded known-good Worker/bot revisions if necessary, under
   the operator's release procedure. Verify database compatibility first.
4. In staging, prove manual order creation, staff review, single fulfillment,
   website-outage behavior, restart/retry and terminal review. Record exact
   deployment IDs, test outcomes and response time; no real money.
5. Reconcile every affected order before closing the incident. Review open
   discrepancies at least daily; retain unresolved entries beyond the daily
   review rather than silently aging them out. Notify customers truthfully.
6. Re-enable only after staging passes and the designated owners sign off.

## Privacy, retention and adoption evidence

Launch remains blocked until the privacy/payment owner approves retention for
proof screenshots, Discord identifiers, receipt digests, audit events and
support tickets; access roles; deletion/hold handling; customer-facing policy
and dispute/refund disclosures. Do not invent legally required periods.

Per drill record: environment/DB/guild identity; approved revisions; synthetic
order references; reviewer identities; observed outcomes; support ticket and
restricted evidence location; alert-delivery evidence; recovery timing;
rollback and reconciliation result; final owner decision. Store no credentials
or actual customer/bank records in repository evidence.
