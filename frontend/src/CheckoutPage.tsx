import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  DEFAULT_POLLER_CONFIG,
  PollerState,
  startPolling,
} from "./lib/checkoutPoller";
import { formatInr, PublicSessionView, verifyQrMatchesSession } from "./lib/qr";
import { mockSnapshot, MockScenario } from "./mockApi";

type UiPhase = "loading" | "awaiting" | "confirmed" | "expired" | "cancelled" | "unavailable";

interface Props {
  token: string;
  /** Demo-only state selector; ignored in production wiring. */
  mock?: string | null;
}

/** Where the website API lives. Transplant: point at the Worker origin. */
const API_BASE = (import.meta.env.VITE_CHECKOUT_API_BASE as string | undefined) ?? "";

export function CheckoutPage({ token, mock }: Props) {
  const [phase, setPhase] = useState<UiPhase>("loading");
  const [session, setSession] = useState<PublicSessionView | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrMismatch, setQrMismatch] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pollerState, setPollerState] = useState<PollerState | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const stopPollerRef = useRef<(() => void) | null>(null);
  const mockScenario = mock as MockScenario | null;
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  const applySession = useCallback((next: PublicSessionView) => {
    setSession(next);
    if (next.status === "PAID") setPhase("confirmed");
    else if (next.status === "EXPIRED") setPhase("expired");
    else if (next.status === "CANCELLED") setPhase("cancelled");
    else setPhase("awaiting");
  }, []);

  // Initial load + polling loop.
  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setSession(null);
    setQrDataUrl(null);

    const fetchSnapshot = async (signal: AbortSignal): Promise<unknown> => {
      if (mockScenario) {
        // Demo fixtures: simulate latency, then serve the scenario.
        await new Promise((r) => setTimeout(r, 150));
        if (signal.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        const fixture = mockSnapshot(mockScenario);
        if (!fixture) throw new Error("mock failure");
        return fixture;
      }
      const res = await fetch(`${API_BASE}/api/payments/checkout-sessions/${token}`, {
        signal,
        headers: { accept: "application/json" },
        credentials: "omit",
      });
      if (!res.ok) {
        const err = new Error(`http_${res.status}`);
        (err as { status?: number }).status = res.status;
        throw err;
      }
      return res.json();
    };

    const poller = startPolling(
      fetchSnapshot,
      {
        onState: (state) => {
          if (cancelled) return;
          setPollerState(state);
          const outcome = state.lastOutcome;
          if (outcome?.kind === "ok") {
            // parseSnapshot validated status/expiry and passed the full server
            // payload through, so this is the complete PublicSessionView.
            applySession(outcome.snapshot as unknown as PublicSessionView);
          }
          else if (outcome?.kind === "error" && state.consecutiveFailures >= 1) {
            // Keep showing the last good data; only go unavailable with nothing.
            setSession((prev) => {
              if (prev === null) setPhase("unavailable");
              return prev;
            });
          }
        },
        onStop: () => {
          /* terminal handling happens via onState phases */
        },
      },
      DEFAULT_POLLER_CONFIG,
    );
    stopPollerRef.current = poller.stop;

    // Cancel in-flight work when the page is being left (bfcache, navigation).
    const onPageHide = () => poller.stop();
    window.addEventListener("pagehide", onPageHide);

    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", onPageHide);
      poller.stop();
    };
  }, [token, mockScenario, retryNonce, applySession]);

  // Render the QR strictly from the server-provided payload, verifying it
  // against the stored session details first.
  useEffect(() => {
    let cancelled = false;
    if (!session || phase !== "awaiting") {
      setQrDataUrl(null);
      return;
    }
    const matches = verifyQrMatchesSession(session);
    setQrMismatch(!matches);
    if (!matches) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(session.qr_payload, {
      width: 224,
      margin: 1,
      color: { dark: "#0b1220", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session, phase]);

  const copyUpi = useCallback(async () => {
    // Public status may become stale while the site is unreachable. Never copy
    // payment details unless the latest snapshot and QR agree exactly.
    if (!session || phase !== "awaiting" ||
        (pollerState?.consecutiveFailures ?? 0) > 0 ||
        !verifyQrMatchesSession(session)) {
      setCopyMessage("Payment instructions cannot be verified. Do not transfer money.");
      return;
    }
    const vpa = session.upi.vpa;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(vpa);
      } else {
        // Fallback for non-secure contexts where the async clipboard API is
        // unavailable. The temporary node is removed immediately after use.
        const area = document.createElement("textarea");
        area.value = vpa;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        if (!ok) throw new Error("copy command rejected");
      }
      setCopied(true);
      setCopyMessage("UPI ID copied to clipboard");
      setTimeout(() => {
        setCopied(false);
        setCopyMessage(null);
      }, 2000);
    } catch {
      setCopied(false);
      setCopyMessage("Copy failed — please select the UPI ID manually");
      setTimeout(() => setCopyMessage(null), 4000);
    }
  }, [session, phase, pollerState]);

  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  return (
    <main className="min-h-screen flex items-start justify-center px-4 py-10">
      <div className="w-full max-w-[440px]">
        <Header />
        {phase === "loading" && <LoadingCard />}
        {phase === "unavailable" && <UnavailableCard onRetry={retry} />}
        {(phase === "awaiting" || phase === "confirmed" || phase === "expired" || phase === "cancelled") && session && (
          <SessionCard
            session={session}
            phase={phase}
            qrDataUrl={qrDataUrl}
            qrMismatch={qrMismatch}
            copied={copied}
            onCopy={copyUpi}
            pollerState={pollerState}
          />
        )}
        <SupportFooter />
        {/* Polite live region: announces copy results to screen readers. */}
        <div aria-live="polite" role="status" className="sr-only">
          {copyMessage ?? ""}
        </div>
      </div>
    </main>
  );
}

function Header() {
  return (
    <header className="mb-6 flex items-center gap-3">
      <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-avantas-accent to-avantas-accentDim font-display text-lg font-bold text-avantas-ink">
        A
      </div>
      <div>
        <p className="font-display text-lg font-semibold leading-none text-white">Aventas</p>
        <p className="text-xs text-avantas-muted">Secure checkout</p>
      </div>
    </header>
  );
}

function LoadingCard() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading checkout details"
      className="rounded-2xl border border-avantas-edge bg-avantas-panel/80 p-6"
    >
      <div className="animate-pulse space-y-4">
        <div className="h-4 w-1/3 rounded bg-avantas-edge" />
        <div className="h-8 w-2/3 rounded bg-avantas-edge" />
        <div className="mx-auto h-56 w-56 rounded-xl bg-avantas-edge" />
        <div className="h-4 w-1/2 rounded bg-avantas-edge" />
        <div className="h-4 w-3/4 rounded bg-avantas-edge" />
      </div>
      <p className="mt-4 text-center text-sm text-avantas-muted">Loading your order…</p>
    </section>
  );
}

function UnavailableCard({ onRetry }: { onRetry: () => void }) {
  return (
    <section
      role="alert"
      className="rounded-2xl border border-avantas-danger/40 bg-avantas-panel/80 p-6 text-center"
    >
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-avantas-danger/15 text-avantas-danger">
        !
      </div>
      <h2 className="mt-3 font-display text-lg font-semibold text-white">
        Checkout is temporarily unavailable
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-avantas-muted">
        We could not verify your order or payment status. This does not tell us
        whether money left your bank or UPI account. If you attempted a transfer,
        check your transaction history and contact Aventas support using your order
        reference before attempting another payment. Do not reuse old payment instructions.
      </p>
      <button
        onClick={onRetry}
        className="mt-5 w-full rounded-xl bg-avantas-accent px-4 py-2.5 font-semibold text-avantas-ink transition hover:bg-avantas-accentDim hover:text-white focus:outline-none focus:ring-2 focus:ring-avantas-accent/60"
      >
        Retry
      </button>
    </section>
  );
}

function SessionCard({
  session,
  phase,
  qrDataUrl,
  qrMismatch,
  copied,
  onCopy,
  pollerState,
}: {
  session: PublicSessionView;
  phase: UiPhase;
  qrDataUrl: string | null;
  qrMismatch: boolean;
  copied: boolean;
  onCopy: () => void;
  pollerState: PollerState | null;
}) {
  const confirmed = phase === "confirmed";
  const expired = phase === "expired" || phase === "cancelled";
  const statusStale = (pollerState?.consecutiveFailures ?? 0) > 0;
  const paymentInstructionsVerified = !qrMismatch && !statusStale && verifyQrMatchesSession(session);

  return (
    <section className="overflow-hidden rounded-2xl border border-avantas-edge bg-avantas-panel/80 shadow-2xl shadow-black/40">
      <StatusBanner phase={phase} pollerState={pollerState} />

      <div className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-avantas-muted">Order</p>
            <p className="font-mono text-sm text-white">{session.order_ref}</p>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wider text-avantas-muted">Amount due</p>
            <p className="font-display text-2xl font-bold text-white">
              {formatInr(session.amount_paise)}
            </p>
          </div>
        </div>

        <p className="mt-3 text-sm text-avantas-muted">{session.product.name}</p>

        {!confirmed && !expired && !paymentInstructionsVerified && (
          <div role="alert" className="mt-5 rounded-xl border border-avantas-danger/40 bg-avantas-danger/10 p-4">
            <p className="font-semibold text-avantas-danger">Payment instructions cannot be verified</p>
            <p className="mt-2 text-sm text-avantas-muted">
              Do not transfer money or reuse a copied UPI ID. Check your transaction
              history if you already paid, then contact Aventas support through Discord.
            </p>
          </div>
        )}

        {!confirmed && !expired && paymentInstructionsVerified && (
          <>
            <div className="mt-5 rounded-xl border border-avantas-edge bg-avantas-ink/60 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wider text-avantas-muted">Pay via UPI</p>
                  <p className="truncate font-mono text-sm text-white">{session.upi.vpa}</p>
                  <p className="text-xs text-avantas-muted">{session.upi.display_name}</p>
                </div>
                <button
                  onClick={onCopy}
                  className="shrink-0 rounded-lg border border-avantas-edge px-3 py-1.5 text-xs font-semibold text-avantas-accent transition hover:border-avantas-accent/60 hover:bg-avantas-accent/10 focus:outline-none focus:ring-2 focus:ring-avantas-accent/50"
                >
                  {copied ? "Copied ✓" : "Copy"}
                </button>
              </div>
            </div>

            <div className="mt-5 flex flex-col items-center">
              {qrDataUrl ? (
                <div className="rounded-xl bg-white p-3">
                  <img
                    src={qrDataUrl}
                    width={224}
                    height={224}
                    alt="UPI payment QR code for this order"
                  />
                </div>
              ) : (
                <div className="grid h-[248px] w-[248px] place-items-center rounded-xl border border-dashed border-avantas-edge bg-avantas-ink/40 text-center text-xs text-avantas-muted">
                  {"Preparing payment code…"}
                </div>
              )}
              <p className="mt-3 text-center text-xs text-avantas-muted">
                Scan with any UPI app (GPay, PhonePe, Paytm, BHIM)
              </p>
            </div>

            <ol className="mt-5 space-y-2 text-sm text-avantas-muted">
              <li className="flex gap-2">
                <span className="font-semibold text-avantas-accent">1.</span> Open your UPI app and
                scan the code, or send {formatInr(session.amount_paise)} to the UPI ID above.
              </li>
              <li className="flex gap-2">
                <span className="font-semibold text-avantas-accent">2.</span> Complete the payment
                inside the app.
              </li>
              <li className="flex gap-2">
                <span className="font-semibold text-avantas-accent">3.</span> Keep this page open —
                your order updates automatically once the payment is confirmed by our team.
              </li>
            </ol>
          </>
        )}

        {confirmed && (
          <div className="mt-5 rounded-xl border border-avantas-accent/40 bg-avantas-accent/10 p-4">
            <p className="font-semibold text-avantas-accent">Order marked paid by Aventas</p>
            <p className="mt-1 text-sm text-avantas-muted">
              Aventas has marked this order as paid. Delivery updates follow in Discord.
              If your bank history disagrees, contact support with the order reference.
            </p>
          </div>
        )}

        {expired && (
          <div className="mt-5 rounded-xl border border-avantas-warn/40 bg-avantas-warn/10 p-4">
            <p className="font-semibold text-avantas-warn">
              {phase === "cancelled" ? "This checkout session was cancelled" : "This checkout session has expired"}
            </p>
            <p className="mt-1 text-sm text-avantas-muted">
              This checkout link is no longer payable. Do not send another transfer.
              If you attempted a payment, check your bank history and contact support
              before requesting a fresh checkout link.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function StatusBanner({
  phase,
  pollerState,
}: {
  phase: UiPhase;
  pollerState: PollerState | null;
}) {
  if (phase === "confirmed") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 bg-avantas-accent/15 px-6 py-3 text-sm font-semibold text-avantas-accent"
      >
        <span aria-hidden>✓</span> Order marked paid by Aventas
      </div>
    );
  }
  if (phase === "expired" || phase === "cancelled") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 bg-avantas-warn/15 px-6 py-3 text-sm font-semibold text-avantas-warn"
      >
        <span aria-hidden>!</span> {phase === "cancelled" ? "Session cancelled" : "Session expired"}
      </div>
    );
  }
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 bg-avantas-accentDim/10 px-6 py-3 text-sm text-avantas-muted"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-avantas-accent opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-avantas-accent" />
      </span>
      Awaiting payment confirmation
      {pollerState && pollerState.consecutiveFailures > 0 && (
        <span className="ml-auto text-xs text-avantas-warn">reconnecting…</span>
      )}
    </div>
  );
}

function SupportFooter() {
  return (
    <footer className="mt-6 text-center text-xs leading-relaxed text-avantas-muted">
      Need help? Open a ticket in the Aventas Discord and quote your order reference.
      <br />
      Never share your UPI PIN, OTP or screen with anyone.
    </footer>
  );
}
