import React, { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Plus, ShoppingCart, Clock, CheckCircle2, XCircle, ExternalLink, RefreshCw, Send, X, Layers
} from 'lucide-react';
import { TopBar, PageHead, StatCard, Tabs, Badge, Pager, usePaged, EmptyState, Copyable, useDateRange } from '../components/ui.jsx';
import Drawer from '../components/Drawer.jsx';
import { inr, isWithinDateRange, statusBucket, bucketCounts } from '../data.js';

export default function Orders() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [orderList, setOrderList] = useState([]);
  const [tab, setTab] = useState('All');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createAmount, setCreateAmount] = useState('499');
  const [createCustomer, setCreateCustomer] = useState('');
  const [createRedirectUrl, setCreateRedirectUrl] = useState('');
  const [createdResult, setCreatedResult] = useState(null);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState('');
  const [copiedLink, setCopiedLink] = useState(false);

  const getAdminKey = () => localStorage.getItem('aventas_admin_key') || '';

  const loadOrders = async () => {
    try {
      const res = await fetch('/api/admin/orders', {
        headers: { 'x-admin-key': getAdminKey() },
      });
      if (res.ok) {
        const liveOrders = await res.json();
        if (Array.isArray(liveOrders)) {
          setOrderList(liveOrders);

          // Synchronize selection with ?selected= query param
          const selParam = searchParams.get('selected');
          if (selParam) {
            const found = liveOrders.find(
              (o) => o.id === selParam || o.paymentId === selParam || o.orderId === selParam
            );
            if (found) {
              setSel(found);
            } else {
              // Strip invalid/stale ?selected= param and close drawer
              setSel(null);
              searchParams.delete('selected');
              setSearchParams(searchParams, { replace: true });
            }
          }
        }
      }
    } catch (e) {
      console.warn('Orders fetch error:', e);
    }
  };

  useEffect(() => {
    loadOrders();
  }, []);

  const handleSelectRow = (row) => {
    setSel(row);
    searchParams.set('selected', row.id || row.paymentId);
    setSearchParams(searchParams, { replace: true });
  };

  const handleCloseDrawer = () => {
    setSel(null);
    if (searchParams.has('selected')) {
      searchParams.delete('selected');
      setSearchParams(searchParams, { replace: true });
    }
  };

  const handleCreateOrder = async (e) => {
    e.preventDefault();
    setCreateErr('');
    const amt = parseFloat(createAmount);
    if (isNaN(amt) || amt <= 0) {
      setCreateErr('Valid amount greater than ₹0 is required');
      return;
    }

    setCreating(true);
    try {
      const res = await fetch('/api/payments/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseAmount: amt,
          product_name: createCustomer.trim() ? `Order for ${createCustomer.trim()}` : `Order ₹${amt}`,
          redirectUrl: createRedirectUrl.trim() || '',
        }),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.message || 'Failed to create order');
      }

      const orderData = await res.json();
      setCreatedResult(orderData);
      loadOrders();
    } catch (err) {
      setCreateErr(err.message || 'Error creating order');
    } finally {
      setCreating(false);
    }
  };

  const { dateRange, customStart, customEnd } = useDateRange();

  const rows = useMemo(() => {
    return orderList.filter((o) => {
      const t = q.toLowerCase();
      const hit = !t || [o.id, o.paymentId, o.customer, o.utr].some((x) => x && x.toLowerCase().includes(t));
      const inDate = isWithinDateRange(o.time || o.createdAt, dateRange, customStart, customEnd);
      const b = statusBucket(o);
      const inTab =
        tab === 'All' ||
        (tab === 'Pending' && b === 'pending') ||
        (tab === 'Success' && b === 'success') ||
        (tab === 'Review' && b === 'review') ||
        (tab === 'Expired' && (b === 'expired' || b === 'failed'));
      return hit && inDate && inTab;
    });
  }, [orderList, q, tab, dateRange, customStart, customEnd]);

  const paged = usePaged(rows, 12);

  const stats = useMemo(() => {
    const inRangeOrders = orderList.filter((o) =>
      isWithinDateRange(o.time || o.createdAt, dateRange, customStart, customEnd)
    );
    const c = bucketCounts(inRangeOrders);
    return { total: c.total, succ: c.success, pend: c.pending, rev: c.review, fail: c.closed };
  }, [orderList, dateRange, customStart, customEnd]);

  // Construct sections for the shared Drawer
  const drawerSections = useMemo(() => {
    if (!sel) return [];
    return [
      {
        label: 'Customer & Transaction',
        items: [
          { k: 'Customer', v: sel.customer || 'UPI Customer' },
          { k: 'Order ID', v: sel.orderId || sel.id, mono: true, copyable: true },
          { k: 'Payment ID', v: sel.paymentId || sel.id, mono: true, copyable: true },
          { k: 'Reference UTR', v: sel.utr && sel.utr !== '—' ? sel.utr : '—', mono: true, copyable: Boolean(sel.utr && sel.utr !== '—') },
          { k: 'Processor', v: sel.source || 'Slice UPI' },
          { k: 'Created At', v: sel.time || '—', mono: true },
          { k: 'Expires At', v: sel.expires || '—', mono: true },
        ],
      },
    ];
  }, [sel]);

  const selBucket = sel ? statusBucket(sel) : 'pending';
  const isDone = selBucket === 'success';
  const isPendingSel = selBucket === 'pending';
  const drawerTimeline = useMemo(() => {
    if (!sel) return [];
    return [
      { text: 'Order created', sub: sel.time, completed: true },
      { text: 'Payment receipt email received', sub: isDone ? sel.time : isPendingSel ? 'Awaiting incoming email' : 'No receipt received', completed: isDone, pending: isPendingSel },
      { text: 'Matched with order', sub: isDone ? 'Auto-matched via Slice IMAP' : isPendingSel ? 'Waiting for exact paise match' : 'Not matched', completed: isDone, pending: isPendingSel },
      { text: 'Payment confirmed & verified', sub: isDone ? 'Settled' : isPendingSel ? 'Pending' : selBucket === 'review' ? 'In manual review' : 'Not confirmed', completed: isDone, pending: isPendingSel },
    ];
  }, [sel, isDone, isPendingSel, selBucket]);

  const drawerEmailPreview = useMemo(() => {
    if (!sel) return null;
    return {
      title: `Received ${inr(sel.amount)} in your slice account`,
      body: `noreply@sliceit.com\nHi, you've received ${inr(sel.amount)} from ${sel.customer || 'UPI Customer'}. Reference UTR: ${sel.utr && sel.utr !== '—' ? sel.utr : '—'}.`,
    };
  }, [sel]);

  return (
    <>
      <TopBar placeholder="Search orders by ID, Customer, UTR..." onSearch={setQ} />

      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div className="page-container" style={{ flex: 1, overflowY: 'auto' }}>
          <PageHead
            title="Orders"
            desc="All UPI checkout orders generated by clients and embed checkout widgets."
          >
            <button
              className="btn primary"
              onClick={() => {
                setCreatedResult(null);
                setCreateErr('');
                setShowCreateModal(true);
              }}
            >
              <Plus size={15} strokeWidth={2} />
              <span>Create Order</span>
            </button>
          </PageHead>

          {/* Stat Cards Row with A8 Count-up */}
          <div className="stat-grid">
            <StatCard
              icon={ShoppingCart}
              label="Total Orders"
              value={stats.total}
              numericValue={stats.total}
              foot="All recorded sessions"
              footDot="var(--accent)"
            />
            <StatCard
              icon={CheckCircle2}
              label="Completed"
              value={stats.succ}
              numericValue={stats.succ}
              foot="Auto-matched via IMAP"
              footDot="var(--ok)"
            />
            <StatCard
              icon={Clock}
              label="Pending"
              value={stats.pend}
              numericValue={stats.pend}
              foot="Awaiting payment"
              footDot="var(--warn)"
            />
            <StatCard
              icon={XCircle}
              label="Expired / Failed"
              value={stats.fail}
              numericValue={stats.fail}
              foot="Unpaid past expiry, or failed"
              footDot="var(--bad)"
            />
          </div>

          {/* Filters & Tabs */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { key: 'All', label: 'All Orders', count: stats.total },
                { key: 'Pending', label: 'Pending', count: stats.pend },
                { key: 'Success', label: 'Success', count: stats.succ },
                { key: 'Review', label: 'Review', count: stats.rev },
                { key: 'Expired', label: 'Expired / Failed', count: stats.fail },
              ]}
            />
          </div>

          {/* Orders Table */}
          <div className="table-wrap">
            {rows.length === 0 ? (
              <EmptyState
                icon={Layers}
                title="No orders found"
                description={q ? 'No orders match your search criteria.' : 'Create a test order or embed the payment widget to get started.'}
                action={
                  <button
                    className="btn primary sm"
                    onClick={() => {
                      setCreatedResult(null);
                      setCreateErr('');
                      setShowCreateModal(true);
                    }}
                  >
                    <Plus size={13} /> Create Test Order
                  </button>
                }
              />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Order ID</th>
                    <th>Amount</th>
                    <th>Expected</th>
                    <th>Customer / Ref</th>
                    <th>UTR Number</th>
                    <th>Time</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {(paged.slice || []).map((row, idx) => {
                    const isSelected = sel && (sel.id === row.id || sel.paymentId === row.paymentId);
                    return (
                      <tr
                        key={row.id || row.paymentId}
                        className={`motion-tbl-row ${isSelected ? 'selected' : ''}`}
                        style={{ '--row-i': Math.min(idx, 12), cursor: 'pointer' }}
                        onClick={() => handleSelectRow(row)}
                      >
                        <td>
                          <Badge>{row.status}</Badge>
                        </td>
                        <td>
                          <Copyable text={row.orderId || row.id || row.paymentId} />
                        </td>
                        <td className="mono" style={{ fontWeight: 600, color: 'var(--bone)' }}>
                          {inr(row.amount)}
                        </td>
                        <td className="mono" style={{ color: 'var(--muted)' }}>
                          {inr(row.expected || row.baseAmount || row.amount)}
                        </td>
                        <td>{row.customer || 'UPI Customer'}</td>
                        <td className="mono">
                          {row.utr && row.utr !== '—' ? (
                            <Copyable text={row.utr} />
                          ) : (
                            <span style={{ color: 'var(--muted)' }}>—</span>
                          )}
                        </td>
                        <td className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                          {row.time || '—'}
                        </td>
                        <td className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                          {row.expires || '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <Pager paged={paged} label="orders" />
          </div>
        </div>

        {/* Shared Unified Drawer */}
        <Drawer
          open={Boolean(sel)}
          onClose={handleCloseDrawer}
          type="Order"
          id={sel?.paymentId || sel?.orderId || sel?.id}
          status={sel?.status}
          amount={sel?.amount}
          sections={drawerSections}
          timeline={drawerTimeline}
          emailPreview={drawerEmailPreview}
          actions={
            <a
              href={`/pay/${sel?.paymentId || sel?.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn primary"
              style={{ width: '100%', textDecoration: 'none' }}
            >
              <ExternalLink size={15} strokeWidth={1.5} />
              <span>Open Pay Page</span>
            </a>
          }
        />
      </div>

      {/* Create Order Modal */}
      {showCreateModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: 16,
          }}
          onClick={() => setShowCreateModal(false)}
        >
          <div
            style={{
              width: 440,
              maxWidth: '100%',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 14,
              overflow: 'hidden',
              boxShadow: 'var(--shadow-drawer)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--raised)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700, color: 'var(--bone)' }}>
                Create Direct UPI Order
              </div>
              <button onClick={() => setShowCreateModal(false)} className="btn ghost sm" style={{ padding: 4 }}>
                <X size={15} />
              </button>
            </div>

            <div style={{ padding: 22 }}>
              {createdResult ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, textAlign: 'center' }}>
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: '50%',
                      background: 'var(--ok-bg)',
                      border: '1px solid var(--ok-border)',
                      color: 'var(--ok)',
                      display: 'grid',
                      placeItems: 'center',
                      margin: '0 auto',
                    }}
                  >
                    <CheckCircle2 size={24} />
                  </div>
                  <div>
                    <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700 }}>
                      Order Created Successfully
                    </div>
                    <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                      {createdResult.paymentId}
                    </div>
                  </div>

                  <div style={{ background: 'var(--raised)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, textAlign: 'left', fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ color: 'var(--muted)' }}>Exact Amount:</span>
                      <span className="mono" style={{ fontWeight: 700, color: 'var(--bone)' }}>{inr(createdResult.amount)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--muted)' }}>Pay Link:</span>
                      <span className="mono" style={{ fontSize: 11 }}>/pay/{createdResult.paymentId}</span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                    <a
                      href={`/pay/${createdResult.paymentId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn primary"
                      style={{ flex: 1, textDecoration: 'none' }}
                    >
                      <ExternalLink size={14} /> Open Pay Page
                    </a>
                    <button
                      className="btn secondary"
                      onClick={() => setShowCreateModal(false)}
                      style={{ flex: 1 }}
                    >
                      Done
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleCreateOrder} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {createErr && (
                    <div style={{ background: 'var(--bad-bg)', border: '1px solid var(--bad-border)', color: 'var(--bad)', padding: '8px 12px', borderRadius: 8, fontSize: 12 }}>
                      {createErr}
                    </div>
                  )}

                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>
                      Base Amount (₹)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="1"
                      value={createAmount}
                      onChange={(e) => setCreateAmount(e.target.value)}
                      required
                      style={{ width: '100%', height: 38, padding: '0 12px', fontSize: 13, fontFamily: 'var(--font-mono)' }}
                    />
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>
                      Customer Name / Reference
                    </label>
                    <input
                      type="text"
                      value={createCustomer}
                      onChange={(e) => setCreateCustomer(e.target.value)}
                      placeholder="e.g. John Doe (Optional)"
                      style={{ width: '100%', height: 38, padding: '0 12px', fontSize: 13 }}
                    />
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>
                      Custom Redirect URL (Optional)
                    </label>
                    <input
                      type="url"
                      value={createRedirectUrl}
                      onChange={(e) => setCreateRedirectUrl(e.target.value)}
                      placeholder="https://yourstore.com/checkout/success"
                      style={{ width: '100%', height: 38, padding: '0 12px', fontSize: 13, fontFamily: 'var(--font-mono)' }}
                    />
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => setShowCreateModal(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={creating}
                      className="btn primary"
                    >
                      {creating ? 'Creating...' : 'Generate Order'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
