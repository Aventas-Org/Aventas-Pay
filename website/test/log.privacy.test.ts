/** The real merchant receipt/UTR must never reach Worker logs. */
import { describe, expect, test, spyOn } from "bun:test";
import { capturingLogger, consoleLogger, redact } from "../src/domain/log";

describe("checkout log sensitive reference redaction", () => {
  test.each([
    "provider_transaction_ref",
    "provider_ref",
    "provider_payment_id",
    "transaction_id",
    "payment_reference",
    "receipt_reference",
    "bank_reference",
    "utr",
    "receipt_id",
  ])("masks short payment identifier under %s", (field) => {
    for (const value of ["ABCD", "UTR-123456789", "r".repeat(39)]) {
      expect(redact({ [field]: value })[field]).toBe("[REDACTED]");
      expect(redact({ [field.toUpperCase()]: value })[field.toUpperCase()]).toBe("[REDACTED]");
    }
  });

  test("preserves non-sensitive bounded operational fields", () => {
    const logger = capturingLogger();
    logger.log("verify_recorded", {
      order_id: "AVT-SYNTHETIC-0001",
      http_status: 200,
      amount_paise: 12300,
      provider_transaction_ref: "UTR-123456789",
      discord_user_id: "123456789012345678",
    });
    expect(logger.events).toHaveLength(1);
    expect(logger.events[0]!.event).toBe("verify_recorded");
    expect(logger.events[0]!.fields.order_id).toBe("AVT-SYNTHETIC-0001");
    expect(logger.events[0]!.fields.http_status).toBe(200);
    expect(logger.events[0]!.fields.provider_transaction_ref).toBe("[REDACTED]");
    expect(logger.events[0]!.fields.discord_user_id).toBe("[REDACTED]");
  });

  test("production console log emits no raw short receipt", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      consoleLogger.log("verify_recorded", {
        provider_transaction_ref: "TXN7",
        receipt_id: "R123",
        order_id: "AVT-SYNTHETIC-0001",
        http_status: 200,
      });
      expect(log).toHaveBeenCalledTimes(1);
      const emitted = String(log.mock.calls[0]?.[0]);
      expect(emitted).not.toContain("TXN7");
      expect(emitted).not.toContain("R123");
      expect(emitted).toContain("[REDACTED]");
      expect(emitted).toContain("AVT-SYNTHETIC-0001");
    } finally {
      log.mockRestore();
    }
  });
});
