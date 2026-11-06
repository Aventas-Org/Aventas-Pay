import { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';
import { IndianRupee, ArrowLeftRight, Percent, Timer, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { TopBar, PageHead, StatCard, Badge, EmptyState, useDateRange, MotionBarChart, MotionDonutChart } from '../components/ui.jsx';
import { inr, isWithinDateRange, bucketCounts } from '../data.js';

export default function Analytics() {
  const { dateRange, setDateRange, customStart, customEnd } = useDateRange();
  const [data, setData] = useState({
    totalRevenue: 0,
    totalOrders: 0,
    successOrders: 0,
    pendingOrders: 0,
    failedOrders: 0,
    successRate: null,
    avgConfirmation: null,
    revenueSeries: [],
    sources: [{ name: 'Slice Bank UPI', value: 0, color: 'var(--ok)' }],
  });
  const [topOrders, setTopOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  const getAdminKey = () => localStorage.getItem('aventas_admin_key') || '';

  useEffect(() => {
    async function loadAnalytics() {
      try {
        setLoading(true);
        const qs = new URLSearchParams({ range: dateRange });
        if (String(dateRange).toLowerCase() === 'custom') {
          if (customStart) qs.set('from', customStart);
          if (customEnd) qs.set('to', customEnd);
        }
        const res = await fetch(`/api/admin/analytics?${qs.toString()}`, {
          headers: { 'x-admin-key': getAdminKey() },
        });
        if (res.ok) {
          const json = await res.json();
          setData(json);
        }

        const ordersRes = await fetch('/api/admin/orders', {
          headers: { 'x-admin-key': getAdminKey() },
        });
        if (ordersRes.ok) {
          const orders = await ordersRes.json();
          if (Array.isArray(orders)) {
            setTopOrders(orders);
          }
        }
      } catch (e) {
        console.warn('Analytics fetch error:', e);
      } finally {
        setLoading(false);
      }
    }

    loadAnalytics();
  }, [dateRange, customStart, customEnd]);

  // Filter orders by dateRange
  const filteredOrders = useMemo(() => {
    return topOrders.filter((o) =>
      isWithinDateRange(o.time || o.createdAt, dateRange, customStart, customEnd)
    );
  }, [topOrders, dateRange, customStart, customEnd]);

  // Adjust chart series according to date range
  const displayedChartSeries = data.revenueSeries || [];

  const totalVol = inr(data.totalRevenue);

  // Same bucket function as Dashboard and Orders, so the numbers always agree.
  // Falls back to the API counts only if the orders list could not be loaded.
  const counts = useMemo(() => {
    if (topOrders.length > 0) return bucketCounts(filteredOrders);
    return {
      total: data.totalOrders || 0,
      success: data.successOrders || 0,
      pending: data.pendingOrders || 0,
      review: 0,
      closed: data.failedOrders || 0,
    };
  }, [topOrders, filteredOrders, data]);

  const successRate = counts.total > 0 ? `${((counts.success / counts.total) * 100).toFixed(1)}%` : '0.0%';
  const sources = [{ name: 'Slice Bank UPI', value: counts.success, color: 'var(--ok)' }];

  // Status Ratio Stack Calculations
  const totalRatio = counts.success + counts.pending + counts.review + counts.closed;
  const pct = (n) => (totalRatio > 0 ? Math.round((n / totalRatio) * 100) : 0);
  const successPct = pct(counts.success);
  const pendingPct = pct(counts.pending);
  const reviewPct = pct(counts.review);
  const failedPct = totalRatio > 0 ? Math.max(0, 100 - successPct - pendingPct - reviewPct) : 0;

  return (
    <>
      <TopBar placeholder="Search analytics…" />
      <div className="content">
        <div className="page">
          <PageHead title="Analytics" desc="Real-time settlement metrics and volume analytics from your SQLite database.">
            <div className="segmented-control">
              {['Today', '7D', '30D', '90D'].map((r) => (
                <button
                  key={r}
                  className={`segment-btn ${dateRange === r ? 'active' : ''}`}
                  onClick={() => setDateRange(r)}
                >
                  {r}
                </button>
              ))}
            </div>
          </PageHead>

          {/* Metric Stat Cards in Auto-fit Grid */}
          <div className="stat-grid">
            <StatCard
              icon={IndianRupee}
              label="Total Revenue"
              value={totalVol}
              foot="Slice Bank auto-verified"
              footDot="var(--ok)"
            />
            <StatCard
              icon={ArrowLeftRight}
              label="Total Transactions"
              value={String(counts.total)}
              foot="Database records"
              footDot="var(--accent)"
            />
            <StatCard
              icon={Percent}
              label="Success Rate"
              value={successRate}
              foot={`${counts.success} successful`}
              footDot="var(--ok)"
            />
            <StatCard
              icon={Timer}
              label="Avg. Auto-Confirmation"
              value={data.avgConfirmation || '—'}
              foot="Slice IMAP (5s cycle)"
              footDot="var(--warn)"
            />
          </div>

          {/* Revenue Chart and Source Breakdown */}
          <div className="two-col" style={{ marginBottom: 16, gap: 12 }}>
            {/* Single daily-revenue bar chart (accent color, today highlighted), 1 y-axis, hover tooltip */}
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Daily Settled Revenue ({dateRange})</div>
                  <div className="card-sub">Cumulative UPI volume auto-verified via Slice Bank</div>
                </div>
                <div className="legend">
                  <span><i style={{ background: 'var(--accent)' }} />Settled Revenue (₹)</span>
                  <span><i style={{ background: 'var(--bone)' }} />Today</span>
                </div>
              </div>
              <MotionBarChart data={displayedChartSeries} height={210} highlightLast={dateRange !== 'Today'} emptyMessage="No transaction volume recorded for this period." />
            </div>

            {/* Thinner Donut: Settlement by Processor */}
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Settlement by Processor</div>
                  <div className="card-sub">Active gateway distribution</div>
                </div>
              </div>

              <MotionDonutChart items={sources} total={counts.success} size={150} />

              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {sources.map((s, idx) => (
                  <div key={s.name || idx} className="sys-row" style={{ fontSize: 11.5, padding: '3px 0' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <i
                        style={{
                          display: 'inline-block',
                          width: 7,
                          height: 7,
                          borderRadius: 2,
                          background: s.color || 'var(--ok)',
                        }}
                      />
                      <span style={{ color: 'var(--muted)' }}>{s.name}</span>
                    </span>
                    <span className="mono" style={{ color: 'var(--bone)', fontWeight: 600 }}>{s.value} payments</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Stacked Horizontal Bar for Order Status Ratio & Recent Transactions */}
          <div className="two-col" style={{ marginBottom: 16, gap: 12 }}>
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Order Status Ratio</div>
                  <div className="card-sub">Health metrics across verification pipeline</div>
                </div>
              </div>

              {/* Stacked Horizontal Bar */}
              <div style={{ marginTop: 8, marginBottom: 14 }}>
                <div
                  style={{
                    display: 'flex',
                    height: 12,
                    borderRadius: 6,
                    overflow: 'hidden',
                    background: 'var(--raised)',
                    gap: 2,
                  }}
                >
                  {totalRatio > 0 ? (
                    <>
                      {successPct > 0 && (
                        <div
                          style={{ width: `${successPct}%`, background: 'var(--ok)' }}
                          title={`Successful: ${counts.success} (${successPct}%)`}
                        />
                      )}
                      {pendingPct > 0 && (
                        <div
                          style={{ width: `${pendingPct}%`, background: 'var(--warn)' }}
                          title={`Pending: ${counts.pending} (${pendingPct}%)`}
                        />
                      )}
                      {reviewPct > 0 && (
                        <div
                          style={{ width: `${reviewPct}%`, background: 'var(--accent)' }}
                          title={`Review: ${counts.review} (${reviewPct}%)`}
                        />
                      )}
                      {failedPct > 0 && (
                        <div
                          style={{ width: `${failedPct}%`, background: 'var(--bad)' }}
                          title={`Expired / Failed: ${counts.closed} (${failedPct}%)`}
                        />
                      )}
                    </>
                  ) : (
                    <div style={{ width: '100%', background: 'var(--border)' }} />
                  )}
                </div>
              </div>

              {/* Legend Grid with Counts and Percentages */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ok)' }} />
                    <span>Successful</span>
                  </div>
                  <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--bone)', marginTop: 4 }}>
                    {counts.success} <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)' }}>({successPct}%)</span>
                  </div>
                </div>
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warn)' }} />
                    <span>Pending</span>
                  </div>
                  <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--bone)', marginTop: 4 }}>
                    {counts.pending} <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)' }}>({pendingPct}%)</span>
                  </div>
                </div>
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }} />
                    <span>Review</span>
                  </div>
                  <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--bone)', marginTop: 4 }}>
                    {counts.review} <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)' }}>({reviewPct}%)</span>
                  </div>
                </div>
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--bad)' }} />
                    <span>Expired / Failed</span>
                  </div>
                  <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--bone)', marginTop: 4 }}>
                    {counts.closed} <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)' }}>({failedPct}%)</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Recent Transactions */}
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Filtered Activity</div>
                  <div className="card-sub">Transactions within {dateRange}</div>
                </div>
              </div>
              {filteredOrders.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {filteredOrders.slice(0, 5).map((o, i) => (
                    <div
                      key={o.id || i}
                      className="sys-row"
                      style={{ fontSize: 12, padding: '9px 0', borderBottom: '1px solid var(--border)' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span className="mono muted" style={{ fontSize: 11 }}>#{i + 1}</span>
                        <span style={{ color: 'var(--bone)', fontWeight: 500 }}>{o.customer || 'UPI Customer'}</span>
                        <Badge>{o.status}</Badge>
                      </div>
                      <span className="mono" style={{ fontWeight: 600, color: 'var(--bone)' }}>
                        {inr(o.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={IndianRupee}
                  title="No transactions recorded"
                  description="Transactions matching the date range will appear here."
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}