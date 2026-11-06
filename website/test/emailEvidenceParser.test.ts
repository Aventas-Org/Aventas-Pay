import { describe, expect, test } from "bun:test";
import { parseUntrustedPaymentEmail, type UntrustedPaymentEmail } from "../src/services/payment/emailEvidenceParser";

const fake: UntrustedPaymentEmail = {
  from: "Slice Bank <noreply@slice.bank.in>",
  subject: "Received ₹1,234.50 from a customer",
  body: "UPI Ref No: 629401841605. Received INR 1234.50.",
  authenticationResults: "dkim=pass; spf=pass",
};
describe("untrusted bank-mail extraction (manual review only)", () => {
  test("parses same rupee amount and labeled RRN without verifying payment", () => {
    const parsed = parseUntrustedPaymentEmail(fake);
    expect(parsed.reportedAmountPaise).toBe(123450);
    expect(parsed.reportedRrn).toBe("629401841605");
    expect(parsed.classification).toBe("NEEDS_REVIEW");
    expect(parsed.paymentVerified).toBe(false);
    expect(parsed.canFulfill).toBe(false);
    expect(parsed.warnings).toContain("UNTRUSTED_EMAIL_SOURCE");
    expect(parsed).not.toHaveProperty("status", "PAID");
  });

  test.each(["noreply@slice.bank.in", "attacker@example.test", "Slice <noreply@slice.bank.in>"])(
    "never trusts purported sender %s even with DKIM/SPF-looking header", (from) => {
      const parsed = parseUntrustedPaymentEmail({ ...fake, from });
      expect(parsed.paymentVerified).toBe(false);
      expect(parsed.canFulfill).toBe(false);
    },
  );

  test("rejects conflicting rupee amounts and separate reference numbers", () => {
    const parsed = parseUntrustedPaymentEmail({
      ...fake,
      subject: "Received ₹500.00",
      body: "Amount INR 600.00. RRN: 629401841605, UTR: 629401841606",
    });
    expect(parsed.reportedAmountPaise).toBeNull();
    expect(parsed.reportedRrn).toBeNull();
    expect(parsed.warnings).toContain("CONFLICTING_AMOUNTS");
    expect(parsed.warnings).toContain("CONFLICTING_REFERENCES");
  });

  test.each(["₹1,23,456.78", "INR 1,234.50", "Rs. 99.05", "₹1"])(
    "accepts valid explicit rupee formats %s without a float rounding path", (amount) => {
      const parsed = parseUntrustedPaymentEmail({ ...fake, subject: amount, body: "RRN: 629401841605" });
      expect(parsed.reportedAmountPaise).toBeGreaterThan(0);
      expect(Number.isSafeInteger(parsed.reportedAmountPaise)).toBe(true);
    },
  );

  test.each(["₹1,2", "₹0", "₹-20", "₹9999999999999999999999999", "INR 1.234"])(
    "does not convert invalid, nonpositive, overlarge or sub-paise amount %s", (amount) => {
      const parsed = parseUntrustedPaymentEmail({ ...fake, subject: amount, body: "RRN: 629401841605" });
      expect(parsed.reportedAmountPaise).toBeNull();
      expect(parsed.paymentVerified).toBe(false);
    },
  );

  test("accepts a sentence-ending period after a valid exact INR amount", () => {
    const parsed = parseUntrustedPaymentEmail({
      ...fake,
      subject: "Received ₹500.00.",
      body: "Amount INR 600.00. RRN: 629401841605",
    });
    expect(parsed.reportedAmountPaise).toBeNull();
    expect(parsed.warnings).toContain("CONFLICTING_AMOUNTS");
    // Still review-only despite plausible bank-style wording.
    expect(parsed.canFulfill).toBe(false);
  });

  test("does not mistake any 12-digit customer/order ID for an RRN", () => {
    const parsed = parseUntrustedPaymentEmail({
      ...fake, subject: "Received ₹100", body: "Customer number 629401841605",
    });
    expect(parsed.reportedRrn).toBeNull();
    expect(parsed.warnings).toContain("MISSING_REFERENCE");
  });

  test("requires an exact 12-digit labeled reference", () => {
    const parsed = parseUntrustedPaymentEmail({
      ...fake, body: "RRN: 62940184160533",
    });
    expect(parsed.reportedRrn).toBeNull();
  });

  test.each([
    ["a space before the end-tag bracket", "</script >"],
    ["a tab in the end tag", "</script\t>"],
    ["a newline and mixed-case end tag", "</ScRiPt\n>"],
    ["an end tag with an HTML parsing-error attribute", '</script foo="bar">'],
  ])("discards script content with %s", (_scenario, closeTag) => {
    const parsed = parseUntrustedPaymentEmail({
      ...fake,
      subject: "Account activity",
      body: `<script type="text/javascript">Received INR 9999.99. RRN: 999888777666${closeTag}<p>Received INR 75.50. RRN: 629401841605</p>`,
    });
    expect(parsed.reportedAmountPaise).toBe(7550);
    expect(parsed.reportedRrn).toBe("629401841605");
    expect(parsed.warnings).not.toContain("CONFLICTING_AMOUNTS");
    expect(parsed.warnings).not.toContain("CONFLICTING_REFERENCES");
    expect(parsed.classification).toBe("NEEDS_REVIEW");
    expect(parsed.canFulfill).toBe(false);
  });

  test.each(["</style >", "</STYLE\t>", '</style class="x">'])(
    "discards non-rendered style content with %s", (closeTag) => {
      const parsed = parseUntrustedPaymentEmail({
        ...fake,
        subject: "Account activity",
        body: `<style>content: "INR 9999.99 RRN: 999888777666";${closeTag}<div>INR 75.50 RRN: 629401841605</div>`,
      });
      expect(parsed.reportedAmountPaise).toBe(7550);
      expect(parsed.reportedRrn).toBe("629401841605");
      expect(parsed.canFulfill).toBe(false);
    },
  );

  test.each(["script", "style"])(
    "drops an unclosed %s block through EOF rather than parsing hidden fake receipts", (tag) => {
      const parsed = parseUntrustedPaymentEmail({
        ...fake,
        subject: "Account activity",
        body: `<${tag}>INR 9999.99 RRN: 999888777666<p>INR 75.50 RRN: 629401841605</p>`,
      });
      expect(parsed.reportedAmountPaise).toBeNull();
      expect(parsed.reportedRrn).toBeNull();
      expect(parsed.warnings).toContain("MISSING_AMOUNT");
      expect(parsed.warnings).toContain("MISSING_REFERENCE");
      expect(parsed.paymentVerified).toBe(false);
    },
  );

  test("decodes UTF8 MIME subject and ignores script tags during extraction", () => {
    const parsed = parseUntrustedPaymentEmail({
      ...fake,
      subject: "=?UTF-8?B?" + Buffer.from("Received ₹300.00").toString("base64") + "?=",
      body: "<script>Received ₹999999 and RRN: 999888777666</script><p>RRN: 629401841605</p>",
    });
    expect(parsed.reportedAmountPaise).toBe(30000);
    expect(parsed.reportedRrn).toBe("629401841605");
  });

  test("decodes UTF8 Q-encoded email subjects solely for manual-review evidence", () => {
    const parsed = parseUntrustedPaymentEmail({
      ...fake,
      subject: "=?UTF-8?Q?Received_=E2=82=B9100.00?=",
      body: "RRN: 629401841605",
    });
    expect(parsed.reportedAmountPaise).toBe(10000);
    expect(parsed.reportedRrn).toBe("629401841605");
    expect(parsed.paymentVerified).toBe(false);
  });

  test("malformed MIME base64 is untrusted and never treated as a payment", () => {
    const parsed = parseUntrustedPaymentEmail({
      ...fake,
      subject: "=?UTF-8?B?!!!?=",
      body: "RRN: 629401841605",
    });
    expect(parsed.reportedAmountPaise).toBeNull();
    expect(parsed.warnings).toContain("MISSING_AMOUNT");
    expect(parsed.canFulfill).toBe(false);
  });

  test("oversized/malformed inputs are rejected with safe diagnostic codes", () => {
    for (const email of [
      { ...fake, body: "x".repeat(16_385) },
      { ...fake, from: "x".repeat(513) },
      { ...fake, subject: "x".repeat(513) },
      { ...fake, body: null } as unknown as UntrustedPaymentEmail,
    ]) {
      const parsed = parseUntrustedPaymentEmail(email);
      expect(parsed.reportedAmountPaise).toBeNull();
      expect(parsed.reportedRrn).toBeNull();
      expect(parsed.warnings).toContain("INVALID_OR_OVERSIZED_INPUT");
      expect(JSON.stringify(parsed)).not.toContain(fake.from);
    }
  });

  test("no email metadata or untrusted auth result can trigger fulfillment", () => {
    const parsed = parseUntrustedPaymentEmail({
      ...fake, authenticationResults: "dkim=pass; spf=pass; dmarc=pass",
    });
    expect(parsed.paymentVerified).toBe(false);
    expect(parsed.canFulfill).toBe(false);
  });
});
