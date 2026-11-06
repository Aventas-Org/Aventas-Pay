import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { ToastProvider, DateRangeProvider } from './components/ui.jsx';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Products from './pages/Products.jsx';
import Transactions from './pages/Transactions.jsx';
import Orders from './pages/Orders.jsx';
import Emails from './pages/Emails.jsx';
import Analytics from './pages/Analytics.jsx';
import ManualReview from './pages/ManualReview.jsx';
import Settings from './pages/Settings.jsx';
import DirectPay from './pages/DirectPay.jsx';
import EmbedCheckout from './pages/EmbedCheckout.jsx';
import Login from './pages/Login.jsx';
import { CheckoutPage } from './CheckoutPage';

function AdminGuard({ children }: { children: React.ReactNode }) {
  const adminKey = localStorage.getItem('aventas_admin_key');
  if (!adminKey) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function CheckoutRoute() {
  const { token } = useParams<{ token: string }>();
  const params = new URLSearchParams(window.location.search);
  const mock = params.get('mock');

  if (!token) {
    return <Navigate to="/" replace />;
  }

  // Customer-facing page: no admin chrome, no links back to the dashboard.
  return <CheckoutPage token={token} mock={mock} />;
}

export default function App() {
  return (
    <ToastProvider>
      <DateRangeProvider>
        <BrowserRouter>
          <Routes>
          {/* Admin Login Route */}
          <Route path="/login" element={<Login />} />

          {/* Protected Admin Dashboard Routes */}
          <Route
            path="/"
            element={
              <AdminGuard>
                <Layout />
              </AdminGuard>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="products" element={<Products />} />
            <Route path="transactions" element={<Transactions />} />
            <Route path="orders" element={<Orders />} />
            <Route path="emails" element={<Emails />} />
            <Route path="analytics" element={<Analytics />} />
            <Route path="manual-review" element={<ManualReview />} />
            <Route path="settings" element={<Settings />} />
          </Route>

          {/* Public Customer Checkout Routes */}
          <Route path="/pay/:productId" element={<DirectPay />} />
          <Route path="/embed/:productId" element={<EmbedCheckout />} />
          <Route path="/checkout/:token" element={<CheckoutRoute />} />

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      </DateRangeProvider>
    </ToastProvider>
  );
}
