import { describe, expect, test } from "bun:test";
import { parseUntrustedPaymentEmail, type UntrustedPaymentEmail } from "../src/services/payment/emailEvidenceParser";

const fake: UntrustedPaymentEmail = {
  from: "bank-alert@example.test",
  subject: "Received ₹1,234.50 from a customer",
  body: "UPI Ref No: 629401841605. Received INR 1234.50.",
  authenticationResults: "dkim=pass; spf=pass",
};

describe("untrusted amount-only bank-mail extraction (manual review only)", () => {
  test("parses paise but does not extract UTR, RRN or authorize payment", () => {
    const parsed = parseUntrustedPaymentEmail(fake);
    expect(parsed.reportedAmountPaise).toBe(123450);
    expect(parsed).not.toHaveProperty("reportedRrn");
    expect(parsed.warnings).not.toContain("MISSING_REFERENCE");
    expect(parsed.classification).toBe("NEEDS_REVIEW");
    expect(parsed.paymentVerified).toBe(false);
    expect(parsed.canFulfill).toBe(false);
    expect(parsed).not.toHaveProperty("status");
  });

  test.each(["bank-alert@example.test", "attacker@example.test", "Bank <bank-alert@example.test>"])(
    "never trusts claimed sender %s or email auth headers as settlement", (from) => {
      const parsed = parseUntrustedPaymentEmail({ ...fake, from });
      expect(parsed.paymentVerified).toBe(false);
      expect(parsed.canFulfill).toBe(false);
    },
  );

  test("rejects contradictory amounts, regardless of transaction references", () => {
    const parsed = parseUntrustedPaymentEmail({
      ...fake,
      subject: "Received ₹500.00",
      body: "Amount INR 600.00. RRN: 629401841605, UTR: 629401841606",
    });
    expect(parsed.reportedAmountPaise).toBeNull();
    expect(parsed.warnings).toContain("CONFLICTING_AMOUNTS");
    expect(parsed).not.toHaveProperty("reportedRrn");
  });

  test.each(["₹1,23,456.78", "INR 1,234.50", "Rs. 99.05", "₹1", "₹480.24"])(
    "parses exact INR paise for %s", (amount) => {
      const parsed = parseUntrustedPaymentEmail({ ...fake, subject: amount, body: "No money amount in body" });
      expect(parsed.reportedAmountPaise).toBeGreaterThan(0);
      expect(Number.isSafeInteger(parsed.reportedAmountPaise)).toBe(true);
      expect(parsed.paymentVerified).toBe(false);
    },
  );

  test.each(["₹1,2", "₹0", "₹-20", "₹9999999999999999999999999", "INR 1.234"])(
    "rejects invalid, nonpositive, overlarge or sub-paise amount %s", (amount) => {
      const parsed = parseUntrustedPaymentEmail({ ...fake, subject: amount, body: "No money amount in body" });
      expect(parsed.reportedAmountPaise).toBeNull();
      expect(parsed.paymentVerified).toBe(false);
    },
  );

  test("treats a sentence-ending period as punctuation, not an extra decimal digit", () => {
    const parsed = parseUntrustedPaymentEmail({
      ...fake,
      subject: "Received ₹500.00.",
      body: "Amount INR 600.00.",
    });
    expect(parsed.reportedAmountPaise).toBeNull();
    expect(parsed.warnings).toContain("CONFLICTING_AMOUNTS");
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
      body: `<script type="text/javascript">Received INR 9999.99.${closeTag}<p>Received INR 75.50.</p>`,
    });
    expect(parsed.reportedAmountPaise).toBe(7550);
    expect(parsed.warnings).not.toContain("CONFLICTING_AMOUNTS");
    expect(parsed.canFulfill).toBe(false);
  });

  test.each(["</style >", "</STYLE\t>", '</style class="x">'])(
    "discards non-rendered style content with %s", (closeTag) => {
      const parsed = parseUntrustedPaymentEmail({
        ...fake, subject: "Account activity",
        body: `<style>content: "INR 9999.99";${closeTag}<div>INR 75.50</div>`,
      });
      expect(parsed.reportedAmountPaise).toBe(7550);
    },
  );

  test.each(["script", "style"])(
    "drops an unclosed %s block through EOF", (tag) => {
      const parsed = parseUntrustedPaymentEmail({
        ...fake, subject: "Account activity",
        body: `<${tag}>INR 9999.99<p>INR 75.50</p>`,
      });
      expect(parsed.reportedAmountPaise).toBeNull();
      expect(parsed.warnings).toContain("MISSING_AMOUNT");
    },
  );

  test("decodes UTF-8 MIME base64 subject without trusting sender or RRN", () => {
    const parsed = parseUntrustedPaymentEmail({
      ...fake,
      subject: "=?UTF-8?B?" + Buffer.from("Received ₹300.00").toString("base64") + "?=",
      body: "<script>Received ₹999999</script><p>RRN: 629401841605</p>",
    });
    expect(parsed.reportedAmountPaise).toBe(30000);
    expect(parsed).not.toHaveProperty("reportedRrn");
  });

  test("decodes MIME Q-encoded subject for evidence only", () => {
    const parsed = parseUntrustedPaymentEmail({
      ...fake, subject: "=?UTF-8?Q?Received_=E2=82=B9100.00?=", body: "",
    });
    expect(parsed.reportedAmountPaise).toBe(10000);
    expect(parsed.paymentVerified).toBe(false);
  });

  test("invalid MIME base64 cannot imply a payment", () => {
    const parsed = parseUntrustedPaymentEmail({ ...fake, subject: "=?UTF-8?B?!!!?=", body: "" });
    expect(parsed.reportedAmountPaise).toBeNull();
    expect(parsed.warnings).toContain("MISSING_AMOUNT");
    expect(parsed.canFulfill).toBe(false);
  });

  test("oversized/malformed inputs get safe diagnostics with no extracted reference", () => {
    for (const email of [
      { ...fake, body: "x".repeat(16_385) },
      { ...fake, from: "x".repeat(513) },
      { ...fake, subject: "x".repeat(513) },
      { ...fake, body: null } as unknown as UntrustedPaymentEmail,
    ]) {
      const parsed = parseUntrustedPaymentEmail(email);
      expect(parsed.reportedAmountPaise).toBeNull();
      expect(parsed).not.toHaveProperty("reportedRrn");
      expect(parsed.warnings).toContain("INVALID_OR_OVERSIZED_INPUT");
      expect(JSON.stringify(parsed)).not.toContain(fake.from);
    }
  });

  test("even purported DKIM, SPF and DMARC success cannot authorize fulfillment", () => {
    const parsed = parseUntrustedPaymentEmail({
      ...fake, authenticationResults: "dkim=pass; spf=pass; dmarc=pass",
    });
    expect(parsed.paymentVerified).toBe(false);
    expect(parsed.canFulfill).toBe(false);
  });
});

describe("Slice credit alert template (synthetic; evidence only)", () => {
  const slice = (subject: string, body: string): UntrustedPaymentEmail => ({
    from: "attacker-can-spoof-this@example.test",
    subject, body,
    authenticationResults: "dkim=pass; spf=pass; dmarc=pass",
  });
  const actualStyleSubject = "Received ₹1,626.24 in your slice account";
  const actualStyleBody =
    "You have received ₹1,626.24 via UPI in your slice bank account xx0000. Avl. Bal. ₹25,189.71";

  test("extracts only the received credit, never the account balance", () => {
    const result = parseUntrustedPaymentEmail(slice(actualStyleSubject, actualStyleBody));
    expect(result.reportedAmountPaise).toBe(162624);
    expect(result.warnings).not.toContain("CONFLICTING_AMOUNTS");
    expect(result.classification).toBe("NEEDS_REVIEW");
    expect(result.paymentVerified).toBe(false);
    expect(result.canFulfill).toBe(false);
    expect(result).not.toHaveProperty("availableBalancePaise");
  });
  test("independent subject and body credit amount must be identical", () => {
    const result = parseUntrustedPaymentEmail(slice(
      actualStyleSubject, actualStyleBody.replace("received ₹1,626.24", "received ₹1,626.25"),
    ));
    expect(result.reportedAmountPaise).toBeNull();
    expect(result.warnings).toContain("CONFLICTING_AMOUNTS");
  });
  test("rejects debit notifications even if they contain an exact pending amount", () => {
    const r = parseUntrustedPaymentEmail(slice(
      "₹1,626.24 debited from your slice account",
      "₹1,626.24 was debited from your slice account.",
    ));
    expect(r.reportedAmountPaise).toBeNull();
    expect(r.warnings).toContain("NON_CREDIT_NOTIFICATION");
  });
  test("rejects duplicate transaction anchors rather than picking a favorable one", () => {
    const r = parseUntrustedPaymentEmail(slice(
      actualStyleSubject, actualStyleBody + " " + actualStyleBody,
    ));
    expect(r.reportedAmountPaise).toBeNull();
    expect(r.warnings).toContain("CONFLICTING_AMOUNTS");
  });
  test("rejects edited or missing credit body, even if subject appears valid", () => {
    for (const body of [
      "Avl. Bal. ₹1,626.24", "You have received ₹1,626.24", "", "Your account was debited ₹1,626.24",
    ]) {
      const r = parseUntrustedPaymentEmail(slice(actualStyleSubject, body));
      expect(r.reportedAmountPaise).toBeNull();
      expect(r.canFulfill).toBe(false);
    }
  });
  test("subject encoded as base64 still follows strict Slice credit template", () => {
    const encoded = "=?UTF-8?B?" + Buffer.from(actualStyleSubject).toString("base64") + "?=";
    const r = parseUntrustedPaymentEmail(slice(encoded, actualStyleBody));
    expect(r.reportedAmountPaise).toBe(162624);
    expect(r.canFulfill).toBe(false);
  });
  test("unusual fractional formats and invalid paise never match", () => {
    for (const amount of ["₹1,626.234", "₹0", "₹1,2", "₹9999999999999999999999"]) {
      const r = parseUntrustedPaymentEmail(slice(
        `Received ${amount} in your slice account`,
        `You have received ${amount} via UPI in your slice bank account xx0000. Avl. Bal. ₹20,000`,
      ));
      expect(r.reportedAmountPaise).toBeNull();
      expect(r.paymentVerified).toBe(false);
    }
  });
  test("an attacker can forge this template; email never makes payment verified", () => {
    const r = parseUntrustedPaymentEmail(slice(actualStyleSubject, actualStyleBody));
    expect(r.warnings).toContain("UNTRUSTED_EMAIL_SOURCE");
    expect(r.paymentVerified).toBe(false);
    expect(r.canFulfill).toBe(false);
  });
});
