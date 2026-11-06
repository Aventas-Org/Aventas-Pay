import { CheckoutPage } from "./CheckoutPage";

/**
 * Minimal path routing: /checkout/:token. The Aventas-website transplant will
 * mount <CheckoutPage token={...} apiBase={...}/> inside its existing router.
 */
export default function App() {
  const match = window.location.pathname.match(/^\/checkout\/([A-Za-z0-9_-]+)$/);
  const token = match?.[1] ?? null;
  const params = new URLSearchParams(window.location.search);
  const mock = params.get("mock");

  if (!token) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-md w-full rounded-2xl border border-avantas-edge bg-avantas-panel/80 p-8 text-center">
          <h1 className="font-display text-xl font-semibold text-white">Aventas Checkout</h1>
          <p className="mt-3 text-sm text-avantas-muted">
            This link is incomplete. Open the checkout link from your Aventas order again, or
            contact support with your order reference.
          </p>
        </div>
      </main>
    );
  }

  return <CheckoutPage token={token} mock={mock} />;
}
