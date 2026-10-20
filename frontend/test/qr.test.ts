import { describe, expect, test } from "bun:test";
import {
  expectedQrPayload,
  formatInr,
  paiseToRupees,
  verifyQrMatchesSession,
  PublicSessionView,
} from "../src/lib/qr";

const session: PublicSessionView = {
  order_ref: "AVT-2026-000123",
  product: { name: "1000 Valorant Points" },
  amount_paise: 99900,
  amount_display: "999.00",
  currency: "INR",
  upi: { vpa: "merchant@upi", display_name: "Aventas Store" },
  qr_payload: "upi://pay?pa=merchant%40upi&pn=Aventas%20Store&am=999.00&cu=INR&tn=Aventas%20order%20AVT-2026-000123",
  expires_at: "2099-10-20T10:30:00Z",
};

describe("verifyQrMatchesSession", () => {
  test("accepts a payload that matches the stored session", () => {
    expect(verifyQrMatchesSession(session)).toBe(true);
  });

  test("rejects a payload with a different recipient", () => {
    const tampered: PublicSessionView = {
      ...session,
      qr_payload: session.qr_payload.replace("merchant%40upi", "attacker%40upi"),
    };
    expect(verifyQrMatchesSession(tampered)).toBe(false);
  });

  test("rejects a payload with a different amount", () => {
    const tampered: PublicSessionView = {
      ...session,
      qr_payload: session.qr_payload.replace("am=999.00", "am=1.00"),
    };
    expect(verifyQrMatchesSession(tampered)).toBe(false);
  });

  test("rejects an empty or non-string payload", () => {
    expect(verifyQrMatchesSession({ ...session, qr_payload: "" })).toBe(false);
    expect(
      verifyQrMatchesSession({ ...session, qr_payload: undefined as unknown as string }),
    ).toBe(false);
  });

  test("expectedQrPayload is deterministic and uses %20 for spaces", () => {
    const payload = expectedQrPayload(session);
    expect(payload).toBe(expectedQrPayload(session));
    expect(payload).not.toContain("+");
    expect(payload).toContain("pn=Aventas%20Store");
  });
});

describe("amount formatting", () => {
  test("paiseToRupees always has two decimals", () => {
    expect(paiseToRupees(1)).toBe("0.01");
    expect(paiseToRupees(100)).toBe("1.00");
    expect(paiseToRupees(99900)).toBe("999.00");
  });

  test("formatInr uses Indian digit grouping", () => {
    expect(formatInr(100)).toBe("₹1.00");
    expect(formatInr(100000)).toBe("₹1,000.00");
    expect(formatInr(123456789)).toBe("₹12,34,567.89");
    expect(formatInr(100000000)).toBe("₹10,00,000.00");
  });
});
