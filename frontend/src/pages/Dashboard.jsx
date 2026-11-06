import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';
import { IndianRupee, ArrowLeftRight, CheckCircle2, Clock, ArrowUpRight } from 'lucide-react';
import { TopBar, StatCard, Badge, EmptyState, Copyable, useDateRange, MotionBarChart, MotionDonutChart } from '../components/ui.jsx';
import { inr, isWithinDateRange, statusBucket, bucketCounts } from '../data.js';

export default function Dashboard() {
  const nav = useNavigate();
  const { dateRange, customStart, customEnd } = useDateRange();
  const [overview, setOverview] = useState(null);
  const [recentPayments, setRecentPayments] = useState([]);
  const [chartSeries, setChartSeries] = useState([]);
  const [orders, setOrders] = useState(null);

  const getAdminKey = () => localStorage.getItem('aventas_admin_key') || '';

  useEffect(() => {
    fetch('/api/admin/overview', {
      headers: { 'x-admin-key': getAdminKey() },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setOverview(data);

        if (Array.isArray(data.recentPayments)) {
          setRecentPayments(data.recentPayments);
        }
      })
      .catch((e) => console.warn('Could not fetch overview:', e));

    // Single source of truth for every count on this page: the orders list,
    // bucketed by statusBucket() (same function Orders and Analytics use).
    fetch('/api/admin/orders', {
      headers: { 'x-admin-key': getAdminKey() },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => {
        if (Array.isArray(list)) setOrders(list);
      })
      .catch((e) => console.warn('Could not fetch orders:', e));

  }, []);

  // Chart series comes from the server already grouped for the selected range
  useEffect(() => {
    const qs = new URLSearchParams({ range: dateRange });
    if (dateRange === 'custom' || dateRange === 'Custom') {
      if (customStart) qs.set('from', customStart);
      if (customEnd) qs.set('to', customEnd);
    }
    let cancelled = false;
    fetch(`/api/admin/analytics?${qs.toString()}`, {
      headers: { 'x-admin-key': getAdminKey() },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((analytics) => {
        if (!cancelled && analytics?.revenueSeries) setChartSeries(analytics.revenueSeries);
      })
      .catch((e) => console.warn('Could not fetch analytics:', e));
    return () => {
      cancelled = true;
    };
  }, [dateRange, customStart, customEnd]);

  // Filter payments by date range
  const filteredPayments = useMemo(() => {
    return recentPayments.filter((p) =>
      isWithinDateRange(p.createdAt || p.receivedAt || p.time, dateRange, customStart, customEnd)
    );
  }, [recentPayments, dateRange, customStart, customEnd]);

  // Adjust chart slice according to dateRange
  const displayedChartSeries = chartSeries;

  // Counts for the selected date range, all from the same bucket function
  const counts = useMemo(() => {
    if (orders) {
      return bucketCounts(
        orders.filter((o) => isWithinDateRange(o.createdAt || o.time, dateRange, customStart, customEnd))
      );
    }
    // Fallback while orders load / if the endpoint fails
    return {
      total: overview?.totalOrders || 0,
      success: overview?.successfulCount || 0,
      pending: overview?.pendingCount || 0,
      review: overview?.reviewCount || 0,
      closed: overview?.failedCount || 0,
    };
  }, [orders, overview, dateRange, customStart, customEnd]);

  const donut = useMemo(
    () => [
      { name: 'Successful', value: counts.success, color: '#22c55e' },
      { name: 'Pending', value: counts.pending, color: '#f5b700' },
      { name: 'Review', value: counts.review, color: '#7dd3fc' },
      { name: 'Expired / Failed', value: counts.closed, color: '#ef4444' },
    ],
    [counts]
  );

  const revToday = inr(overview?.revenueToday || 0);
  const totOrders = String(counts.total);
  const succOrders = String(counts.success);
  const pendOrders = String(counts.pending);

  // Derive live activity from real recent payments
  const toneFor = { success: 'var(--ok)', pending: 'var(--warn)', review: 'var(--accent)', failed: 'var(--bad)', expired: 'var(--bad)' };
  const textFor = { success: 'Payment verified', pending: 'Order pending', review: 'Sent to manual review', failed: 'Payment failed', expired: 'Order expired' };
  const realLiveActivity = filteredPayments.slice(0, 10).map((p) => ({
    status: p.status,
    tone: toneFor[statusBucket(p)],
    text: textFor[statusBucket(p)],
    sub: `₹${Number(p.amount).toFixed(2)} from ${p.customer || 'Customer'}`,
    time: p.time || 'just now',
  }));

  return (
    <>
      <TopBar placeholder="Search by Order ID, Payment ID, UTR or email…" />
      <div className="content">
        <div className="page">
          <div className="page-head" style={{ alignItems: 'flex-start', marginBottom: 16 }}>
            <div>
              <h1 className="page-title">Admin Dashboard</h1>
              <p className="page-desc">Real-time overview of Slice Bank UPI orders and system activity.</p>
            </div>
            <button className="btn primary" onClick={() => nav('/products')}>
              + Products &amp; Embeds
            </button>
          </div>

          {/* Connected/Auto-fit Stat Cards with A8 Count-up */}
          <div className="stat-grid">
            <StatCard
              icon={IndianRupee}
              label="Revenue Today"
              value={revToday}
              numericValue={overview?.revenueToday || 0}
              prefix="₹"
              decimals={2}
              foot="Slice Bank IMAP (5s)"
              footDot="var(--ok)"
            />
            <StatCard
              icon={ArrowLeftRight}
              label="Total Orders"
              value={totOrders}
              numericValue={counts.total}
              foot="Dynamic Paise Offsets"
              footDot="var(--accent)"
            />
            <StatCard
              icon={CheckCircle2}
              label="Successful"
              value={succOrders}
              numericValue={counts.success}
              foot="Auto-matched via IMAP"
              footDot="var(--ok)"
            />
            <StatCard
              icon={Clock}
              label="Pending"
              value={pendOrders}
              numericValue={counts.pending}
              foot="Awaiting payment"
              footDot="var(--warn)"
            />
          </div>

          <div className="two-col" style={{ marginBottom: 16, gap: 12 }}>
            {/* Chart: Single daily-revenue bar chart (accent color, today highlighted), 1 y-axis, hover tooltip */}
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Daily Settled Revenue ({dateRange})</div>
                  <div className="card-sub">Daily settled amounts. Hover for volume</div>
                </div>
                <div className="legend">
                  <span><i style={{ background: 'var(--accent)' }} />Daily Volume (₹)</span>
                  <span><i style={{ background: 'var(--bone)' }} />Today</span>
                </div>
              </div>

              <MotionBarChart data={displayedChartSeries} height={210} highlightLast={dateRange !== 'Today'} />
            </div>

            {/* Donut Card: Thinner ring (12px), 2px gap, center shows number large with label BELOW it */}
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Payment Status</div>
                  <div className="card-sub">Breakdown across order outcomes</div>
                </div>
              </div>

              <MotionDonutChart items={donut} total={totOrders} size={150} />

              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {donut.map((d) => (
                  <div key={d.name} className="sys-row" style={{ fontSize: 11.5, padding: '3px 0' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <i style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: d.color }} />
                      <span style={{ color: 'var(--muted)' }}>{d.name}</span>
                    </span>
                    <span className="mono" style={{ color: 'var(--bone)', fontWeight: 600 }}>{d.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Recent Payments Table with Sticky First Column */}
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Recent Payments</div>
                <div className="card-sub">Latest Slice UPI customer transfers and matched receipts</div>
              </div>
              <button className="link" onClick={() => nav('/transactions')}>
                View all transactions →
              </button>
            </div>
            {filteredPayments.length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Order ID</th>
                      <th>Amount</th>
                      <th>Customer</th>
                      <th>UTR Number</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPayments.map((p, index) => (
                      <tr
                        key={p.id}
                        className="motion-tbl-row"
                        style={{ '--row-i': Math.min(index, 12), cursor: 'pointer' }}
                        onClick={() => nav(`/transactions?selected=${p.orderId || p.id}`)}
                      >
                        <td><Badge>{p.status}</Badge></td>
                        <td><Copyable text={p.orderId || p.id} /></td>
                        <td className="mono" style={{ fontWeight: 600, color: 'var(--bone)' }}>{inr(p.amount)}</td>
                        <td style={{ color: 'var(--bone)' }}>{p.customer || 'UPI Customer'}</td>
                        <td>{p.utr ? <Copyable text={p.utr} /> : <span className="muted">—</span>}</td>
                        <td className="mono muted" style={{ fontSize: 11 }}>{p.time}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                icon={IndianRupee}
                title="No payments in selected range"
                description="Transactions matching the selected date filter will automatically appear here."
              />
            )}
          </div>
        </div>

        {/* Right-hand Detail Panel: Live Activity ONLY (System status duplicate removed) */}
        <aside className="right-panel">
          <div className="detail-head">
            <div className="detail-title">Live Activity</div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--ok)', background: 'rgba(34,197,94,0.1)', padding: '2px 8px', borderRadius: 12, border: '1px solid rgba(34,197,94,0.25)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ok)', display: 'inline-block' }} />
              <span className="mono" style={{ fontWeight: 600 }}>LIVE</span>
            </div>
          </div>

          {realLiveActivity.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {realLiveActivity.map((a, i) => (
                <div key={i} className="live-item motion-feed-item" style={{ animationDelay: `${i * 60}ms` }}>
                  <div style={{ width: 7, height: 7, borderRadius: '50%', background: a.tone, marginTop: 4, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--bone)' }}>{a.text}</div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.sub}</div>
                  </div>
                  <div className="live-time mono">{a.time}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: '28px 12px', textAlign: 'center', color: 'var(--muted)', fontSize: 11.5 }}>
              Awaiting live payment events...
            </div>
          )}
        </aside>
      </div>
    </>
  );
}