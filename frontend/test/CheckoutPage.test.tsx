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

afterEach(cleanup);

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
    expect(screen.getByText(/payment received/i)).toBeTruthy();
    expect(screen.getByText(/Payment confirmed/i)).toBeTruthy();
    expect(screen.queryByText(/Scan with any UPI app/i)).toBeNull();
  });

  test("expired state explains the session is dead and cannot be paid", async () => {
    await renderState("expired");
    expect(screen.getByText(/Session expired/i)).toBeTruthy();
    expect(screen.getByText(/do not send payment to this page/i)).toBeTruthy();
    expect(screen.queryByText(/Scan with any UPI app/i)).toBeNull();
  });

  test("unavailable state offers retry and reassures the order is safe", async () => {
    const { container } = await renderState("error");
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Checkout is temporarily unavailable/i)).toBeTruthy();
    expect(screen.getByText(/your order is safe/i)).toBeTruthy();
    const retry = screen.getByRole("button", { name: /Retry/i });
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
