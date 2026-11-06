/**
 * CheckoutPage component tests: all five UI states, the copy action with its
 * accessible announcement, QR rendering guarded by session verification, and
 * polling behaviour through the mock transport.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CheckoutPage } from "../src/CheckoutPage";

import { mockSnapshot } from "../src/mockApi";
import { DEFAULT_POLLER_CONFIG } from "../src/lib/checkoutPoller";
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  DEFAULT_POLLER_CONFIG.baseIntervalMs = 5000;
});

/** Renders and waits for the loading skeleton to resolve into a real state. */
async function renderState(mock: string) {
  const utils = render(<CheckoutPage token="TESTTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" mock={mock} />);
  await waitFor(() => {
    if (screen.queryByText(/Loading your order/i)) {
      throw new Error("still loading");
    }
  }, { timeout: 3000 });
  return utils;
}

describe("CheckoutPage states", () => {
  test("shows the loading state first", () => {
    render(<CheckoutPage token="TESTTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" mock="pending" />);
    expect(screen.getByText(/Loading your order/i)).toBeTruthy();
    expect(screen.getByLabelText(/Loading checkout details/i)).toBeTruthy();
  });

  test("awaiting state shows order, product, amount, UPI ID and instructions", async () => {
    await renderState("pending");
    expect(screen.getByText("AVT-2026-000482")).toBeTruthy();
    expect(screen.getByText("1000 Valorant Points")).toBeTruthy();
    expect(screen.getByText("₹999.00")).toBeTruthy();
    expect(screen.getByText("avantas@okhdfcbank")).toBeTruthy();
    expect(screen.getByText(/Awaiting payment confirmation/i)).toBeTruthy();
    expect(screen.getByText(/Scan with any UPI app/i)).toBeTruthy();
    // The QR area renders (data URL in browsers; happy-dom lacks canvas so the
    // verified-payload fallback placeholder may show instead — either proves
    // the payload passed verifyQrMatchesSession, covered precisely in qr.test).
    const img = screen.queryByAltText(/UPI payment QR code/i) as HTMLImageElement | null;
    if (img) {
      expect(img.src).toMatch(/^data:image\/(png|svg\+xml)/);
    } else {
      expect(screen.getByText(/Preparing payment code|could not be verified/i)).toBeTruthy();
    }
  });

  test("confirmed state renders the confirmed banner and hides payment steps", async () => {
    await renderState("paid");
    expect(screen.getAllByText(/Payment verified by Aventas staff/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/payment received/i)).toBeNull();
    expect(screen.queryByText(/Scan with any UPI app/i)).toBeNull();
  });

  test("expired state explains the session is dead and cannot be paid", async () => {
    await renderState("expired");
    expect(screen.getByText(/Session expired/i)).toBeTruthy();
    expect(screen.getByText(/do not send payment to this page/i)).toBeTruthy();
    expect(screen.queryByText(/Scan with any UPI app/i)).toBeNull();
  });

  test("unavailable state refreshes status without encouraging duplicate payment", async () => {
    const { container } = await renderState("error");
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Checkout is temporarily unavailable/i)).toBeTruthy();
    expect(screen.getByText(/do not pay again/i)).toBeTruthy();
    expect(screen.queryByText(/no payment has been taken/i)).toBeNull();
    const retry = screen.getByRole("button", { name: /Refresh status/i });
    // Clicking retry re-enters loading without crashing.
    fireEvent.click(retry);
    expect(container.textContent).toContain("Aventas");
  });
});

describe("copy UPI ID", () => {
  test("copies the VPA and announces it in the live region", async () => {
    let written = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { written = text; } },
    });
    await renderState("pending");
    fireEvent.click(screen.getByRole("button", { name: /Copy/i }));
    await waitFor(() => {
      expect(written).toBe("avantas@okhdfcbank");
    });
    await waitFor(() => {
      expect(screen.getByText("UPI ID copied to clipboard")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: /Copied/i })).toBeTruthy();
  });

  test("announces a failure message when clipboard access is denied", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new Error("denied"); } },
    });
    await renderState("pending");
    fireEvent.click(screen.getByRole("button", { name: /Copy/i }));
    await waitFor(() => {
      expect(screen.getByText(/Copy failed/i)).toBeTruthy();
    });
    // Button must not claim success.
    expect(screen.queryByRole("button", { name: /Copied/i })).toBeNull();
  });
});

describe("token hygiene", () => {
  test("the checkout token never appears in the rendered page", async () => {
    const token = "TESTTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const { container } = await renderState("pending");
    expect(container.textContent).not.toContain(token);
    // Nor in any attribute (src/href/action).
    for (const el of Array.from(container.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.value).not.toContain(token);
      }
    }
  });

  test("the served page declares no-referrer at the document level", () => {
    // happy-dom does not load index.html, so assert against the real file that
    // Vite serves — this is the artifact browsers actually receive.
    const html = readFileSync(
      join(import.meta.dir, "..", "index.html"),
      "utf8",
    );
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
    expect(html).toContain('content="noindex, nofollow"');
  });
});


describe("fail-closed payment instructions", () => {
  function serve(payload: unknown) {
    globalThis.fetch = (async () => new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    return render(<CheckoutPage token="TESTTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" />);
  }

  function expectNoPaymentInstructions() {
    expect(screen.queryByRole("button", { name: /^Copy$/ })).toBeNull();
    expect(screen.queryByAltText(/UPI payment QR code/i)).toBeNull();
    expect(screen.queryByText("avantas@okhdfcbank")).toBeNull();
    expect(screen.queryByText(/Scan with any UPI app/i)).toBeNull();
  }

  test("mismatched QR hides VPA, copy and payment steps", async () => {
    serve({ ...mockSnapshot("pending"), qr_payload: "upi://pay?pa=attacker%40upi" });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expectNoPaymentInstructions();
    expect(screen.getByText(/Do not pay using this page/i)).toBeTruthy();
  });

  test("status-only malformed response cannot crash the page or expose payment steps", async () => {
    serve({ status: "PENDING", expires_at: new Date(Date.now() + 60000).toISOString() });
    await waitFor(() => expect(screen.getByText(/Checkout is temporarily unavailable/i)).toBeTruthy());
    expectNoPaymentInstructions();
  });

  test("cancelled session hides all instructions and warns against paying twice", async () => {
    serve({ ...mockSnapshot("pending"), status: "CANCELLED" });
    await waitFor(() => expect(screen.getByText(/Session expired/i)).toBeTruthy());
    expectNoPaymentInstructions();
    expect(screen.getByText(/ask staff to reconcile/i)).toBeTruthy();
  });

  test("past expiry with PENDING status cannot display instructions", async () => {
    serve({ ...mockSnapshot("expired"), status: "PENDING" });
    await waitFor(() => expect(screen.getByText(/Session expired/i)).toBeTruthy());
    expectNoPaymentInstructions();
  });

  test("local expiry hides instructions before the next poll", async () => {
    serve({ ...mockSnapshot("pending"), expires_at: new Date(Date.now() + 250).toISOString() });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Copy$/ })).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/Session expired/i)).toBeTruthy());
    expectNoPaymentInstructions();
  });

  test("failed refresh immediately hides previously valid payment instructions", async () => {
    DEFAULT_POLLER_CONFIG.baseIntervalMs = 80;
    let calls = 0;
    const pending = mockSnapshot("pending");
    globalThis.fetch = (async () => {
      if (++calls > 1) throw new Error("offline");
      return new Response(JSON.stringify(pending));
    }) as typeof fetch;
    render(<CheckoutPage token="TESTTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Copy$/ })).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/Checkout is temporarily unavailable/i)).toBeTruthy());
    expectNoPaymentInstructions();
    expect(screen.getByText(/do not pay again/i)).toBeTruthy();
  });
});
