import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  DEFAULT_POLLER_CONFIG,
  PollerState,
  startPolling,
} from "./lib/checkoutPoller";
import { formatInr, PublicSessionView, verifyQrMatchesSession } from "./lib/qr";
import { mockSnapshot, MockScenario } from "./mockApi";
import "./checkout.css";

type UiPhase = "loading" | "awaiting" | "confirmed" | "expired" | "unavailable";

interface Props {
  token: string;
  /** Demo-only state selector; ignored in production wiring. */
  mock?: string | null;
}

/** Where the website API lives. Transplant: point at the Worker origin. */
const API_BASE = (import.meta.env.VITE_CHECKOUT_API_BASE as string | undefined) ?? "";

type QrGrid = { size: number; dark: [number, number][] };

export function CheckoutPage({ token, mock }: Props) {
  const [phase, setPhase] = useState<UiPhase>("loading");
  const [session, setSession] = useState<PublicSessionView | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<QrGrid | null>(null);
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
    else if (next.status === "EXPIRED" || next.status === "CANCELLED") setPhase("expired");
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
    if (!session) {
      setQrDataUrl(null);
      return;
    }
    const matches = verifyQrMatchesSession(session);
    setQrMismatch(!matches);
    if (!matches) {
      setQrDataUrl(null);
      return;
    }
    try {
      const q = QRCode.create(session.qr_payload, { errorCorrectionLevel: "H" });
      const size = q.modules.size;
      const dark: [number, number][] = [];
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) if (q.modules.get(y, x)) dark.push([x, y]);
      if (!cancelled) setQrDataUrl({ size, dark });
    } catch {
      if (!cancelled) setQrDataUrl(null);
    }
    return () => {
      cancelled = true;
    };
  }, [session]);

  const copyUpi = useCallback(async () => {
    if (!session) return;
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
  }, [session]);

  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  return (
    <main className="co-page">
      <div className="co-wrap">
        <Header />
        {phase === "loading" && <LoadingCard />}
        {phase === "unavailable" && <UnavailableCard onRetry={retry} />}
        {(phase === "awaiting" || phase === "confirmed" || phase === "expired") && session && (
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
    <header className="co-top">
      <span className="co-brand">Aventas Pay</span>
      <span className="co-secure">Secure checkout</span>
    </header>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="co-card">
      <div className="motion-hazard" aria-hidden />
      {children}
    </section>
  );
}

function LoadingCard() {
  return (
    <Card>
      <div className="co-body" aria-busy="true" aria-label="Loading checkout details">
        <div className="co-skel" style={{ display: "grid", gap: 12 }}>
          <div className="skeleton" style={{ width: "40%" }} />
          <div className="skeleton" style={{ width: "70%", height: 26 }} />
          <div className="skeleton" style={{ width: 224, height: 224, margin: "8px auto" }} />
          <div className="skeleton" style={{ width: "55%" }} />
        </div>
        <p className="co-foot" style={{ margin: 0 }}>Loading your order…</p>
      </div>
    </Card>
  );
}

function UnavailableCard({ onRetry }: { onRetry: () => void }) {
  return (
    <Card>
      <div className="co-body" role="alert">
        <div className="co-center">
          <div className="co-warnmark" aria-hidden>!</div>
          <h2>Checkout is temporarily unavailable</h2>
          <p>
            We couldn&apos;t reach the payment service. Your order is safe and no payment has
            been taken. Please retry in a moment.
          </p>
        </div>
        <button onClick={onRetry} className="btn primary co-btn">Retry</button>
      </div>
    </Card>
  );
}

/** Seconds left until expires_at. total = the largest value seen (for the bar). */
function useCountdown(expiresAt: string | undefined, active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  const totalRef = useRef(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  const end = expiresAt ? new Date(expiresAt).getTime() : NaN;
  const left = Number.isNaN(end) ? 0 : Math.max(0, Math.round((end - now) / 1000));
  if (left > totalRef.current) totalRef.current = left;
  const total = totalRef.current || 1;
  return { left, pct: Math.max(0, Math.min(100, (left / total) * 100)) };
}

function fmtClock(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function SuccessMark() {
  const parts = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    const d = 46 + (i % 3) * 14;
    return { tx: `${Math.cos(a) * d}px`, ty: `${Math.sin(a) * d}px` };
  });
  return (
    <div className="motion-success-mark" aria-hidden>
      <svg viewBox="0 0 80 80">
        <circle className="motion-success-ring" cx="40" cy="40" r="36" pathLength={1} />
        <path className="motion-success-tick" d="M24 41 L35 52 L57 29" pathLength={1} />
      </svg>
      {parts.map((p, i) => (
        <i
          key={i}
          className="motion-particle"
          style={{ ["--tx" as string]: p.tx, ["--ty" as string]: p.ty } as React.CSSProperties}
        />
      ))}
    </div>
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
  qrDataUrl: QrGrid | null;
  qrMismatch: boolean;
  copied: boolean;
  onCopy: () => void;
  pollerState: PollerState | null;
}) {
  const confirmed = phase === "confirmed";
  const expired = phase === "expired";
  const awaiting = !confirmed && !expired;
  const { left, pct } = useCountdown(session.expires_at, awaiting);
  const critical = left <= 60;

  return (
    <Card>
      <div className="co-head">
        <div>
          <div className="co-eyebrow">Pay to Aventas</div>
          <div className="co-prod">{session.product.name}</div>
          <div className="co-ref">{session.order_ref}</div>
        </div>
        <div className="co-amount">{formatInr(session.amount_paise)}</div>
      </div>

      <div className="co-body">
        <StatusBanner phase={phase} pollerState={pollerState} />

        {awaiting && (
          <>
            <div className="co-count">
              <div className="co-count-row">
                <span>Time remaining</span>
                <b className={`motion-countdown-digits${critical ? " critical" : ""}`}>{fmtClock(left)}</b>
              </div>
              <div className={`motion-countdown-bar${critical ? " critical" : ""}`}>
                <i style={{ width: `${pct}%` }} />
              </div>
            </div>

            <div className="co-eyebrow" style={{ textAlign: "center" }}>Scan with any UPI app</div>

            {qrDataUrl ? (
              <div className="co-qrbox motion-qr-wrap" style={{ ["--qr-h" as string]: "232px" } as React.CSSProperties}>
                <svg
                  className="qr-svg"
                  viewBox={`0 0 ${qrDataUrl.size} ${qrDataUrl.size}`}
                  width={224}
                  height={224}
                  shapeRendering="crispEdges"
                  role="img"
                  aria-label="UPI payment QR code for this order"
                >
                  {qrDataUrl.dark.map(([x, y]) => (
                    <rect key={`${x}-${y}`} x={x} y={y} width={1.04} height={1.04} fill="#0A0A0B" style={{ animationDelay: `${(x + y) * 16}ms` }} />
                  ))}
                </svg>
                <div className="co-qrlogo">
                  <span>
                    <img src="/aventas-logo.png" alt="Aventas" />
                  </span>
                </div>
                <div className="motion-scan-line" aria-hidden />
              </div>
            ) : (
              <div className="co-qrph">
                {qrMismatch
                  ? "Payment code could not be verified. Please use the UPI ID below."
                  : "Preparing payment code…"}
              </div>
            )}

            <div className="co-upi">
              <div style={{ minWidth: 0 }}>
                <div className="co-eyebrow">Pay via UPI ID</div>
                <code>{session.upi.vpa}</code>
                <small>{session.upi.display_name}</small>
              </div>
              <button onClick={onCopy} className="btn secondary sm">
                {copied ? "Copied ✓" : "Copy"}
              </button>
            </div>

            <ol className="co-steps">
              <li><b>1.</b> Open your UPI app and scan the code, or send {formatInr(session.amount_paise)} to the UPI ID above.</li>
              <li><b>2.</b> Complete the payment inside the app.</li>
              <li><b>3.</b> Keep this page open. Your order updates automatically once the payment is confirmed.</li>
            </ol>
          </>
        )}

        {confirmed && (
          <div className="co-center co-success">
            <SuccessMark />
            <h2>Payment confirmed</h2>
            <p>
              Your order has been recorded. Delivery follows in Discord, so no further action is
              needed on this page.
            </p>
          </div>
        )}

        {expired && (
          <div className="co-center">
            <div className="motion-expired-clock" aria-hidden>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
            </div>
            <h2>This checkout session has expired</h2>
            <p>
              For your security, payment links expire. Please return to your Aventas order in
              Discord and request a fresh checkout link. Do not send payment to this page.
            </p>
          </div>
        )}
      </div>
    </Card>
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
      <div role="status" aria-live="polite" className="co-status ok">
        <span aria-hidden>✓</span> Payment received
      </div>
    );
  }
  if (phase === "expired") {
    return (
      <div role="status" aria-live="polite" className="co-status bad">
        <span aria-hidden>!</span> Session expired
      </div>
    );
  }
  return (
    <div role="status" aria-live="polite" className="co-status">
      <span className="motion-pulse-dot pulse" aria-hidden />
      Awaiting payment confirmation
      {pollerState && pollerState.consecutiveFailures > 0 && (
        <span className="warnc">reconnecting…</span>
      )}
    </div>
  );
}

function SupportFooter() {
  return (
    <footer className="co-foot">
      Need help? Open a ticket in the Aventas Discord and quote your order reference.
      <br />
      Never share your UPI PIN, OTP or screen with anyone.
    </footer>
  );
}
