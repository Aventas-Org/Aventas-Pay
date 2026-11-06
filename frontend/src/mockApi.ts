import type { PublicSessionView } from "./lib/qr";

/**
 * Demo fixtures so every checkout state can be inspected without a live
 * backend. The page uses these only when the URL carries ?mock=<scenario>.
 * They are NOT reachable in production wiring (mock is ignored there).
 */

const base: Omit<PublicSessionView, "expires_at"> = {
  order_ref: "AVT-2026-000482",
  product: { name: "1000 Valorant Points" },
  amount_paise: 99900,
  amount_display: "999.00",
  currency: "INR",
  upi: { vpa: "avantas@okhdfcbank", display_name: "Aventas Store" },
  qr_payload:
    "upi://pay?pa=avantas%40okhdfcbank&pn=Aventas%20Store&am=999.00&cu=INR&tn=Aventas%20order%20AVT-2026-000482",
};

function future(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export type MockScenario = "pending" | "paid" | "expired" | "cancelled" | "mismatch" | "error" | "missing";

export function mockSnapshot(scenario: MockScenario): PublicSessionView | null {
  switch (scenario) {
    case "pending":
      return { ...base, expires_at: future(1800), status: "PENDING" };
    case "paid":
      return { ...base, expires_at: future(1800), status: "PAID" };
    case "expired":
      return {
        ...base,
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        status: "EXPIRED",
      };
    case "cancelled":
      return { ...base, expires_at: future(1800), status: "CANCELLED" };
    case "mismatch":
      return {
        ...base, expires_at: future(1800), status: "PENDING",
        qr_payload: base.qr_payload.replace("am=999.00", "am=999.01"),
      };
    case "error":
    case "missing":
      return null;
  }
}
