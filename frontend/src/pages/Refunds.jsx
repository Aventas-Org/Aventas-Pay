import { useMemo, useState, useEffect } from 'react';
import {
  Undo2, Clock, CheckCircle2, IndianRupee, Plus, Download,
  RefreshCw, X, ShieldCheck, Check, AlertCircle, XCircle
} from 'lucide-react';
import { TopBar, PageHead, StatCard, Tabs, Badge, KV, Timeline, Pager, usePaged, Empty } from '../components/ui.jsx';
import { inr } from '../data.js';

export default function Refunds() {
  const [refundList, setRefundList] = useState([]);
  const [tab, setTab] = useState('All');
  const [sel, setSel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  // Issue Refund Modal
  const [showIssueModal, setShowIssueModal] = useState(false);
  const [issueOrderId, setIssueOrderId] = useState('');
  const [issueAmount, setIssueAmount] = useState('');
  const [issueCustomer, setIssueCustomer] = useState('');
  const [issueReason, setIssueReason] = useState('Customer duplicate payment');
  const [issuing, setIssuing] = useState(false);
  const [issueErr, setIssueErr] = useState('');

  // Confirm with Debit UTR Modal / Form State
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [debitUtrInput, setDebitUtrInput] = useState('');
  const [confirmNotes, setConfirmNotes] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmErr, setConfirmErr] = useState('');
  const [confirmSuccess, setConfirmSuccess] = useState('');

  const loadRefunds = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/admin/refunds');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setRefundList(data);
          if (data.length > 0) {
            setSel((prev) => (prev ? data.find((r) => r.id === prev.id) || data[0] : data[0]));
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load refunds:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRefunds();
  }, []);

  const handleIssueRefund = async (e) => {
    e.preventDefault();
    setIssueErr('');
    const amt = parseFloat(issueAmount);
    if (!issueOrderId.trim()) {
      setIssueErr('Order ID is required');
      return;
    }
    if (isNaN(amt) || amt <= 0) {
      setIssueErr('Enter a valid refund amount > 0');
      return;
    }

    setIssuing(true);
    try {
      const res = await fetch('/api/admin/refunds/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: issueOrderId.trim(),
          amount: amt,
          customer: issueCustomer.trim() || 'UPI Customer',
          reason: issueReason,
          method: 'Slice UPI',
          notes: 'Initiated via Admin Dashboard',
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to issue refund');
      }

      const created = await res.json();
      setShowIssueModal(false);
      setIssueOrderId('');
      setIssueAmount('');
      setIssueCustomer('');
      await loadRefunds();
      setSel(created);
    } catch (err) {
      setIssueErr(err.message);
    } finally {
      setIssuing(false);
    }
  };

  const handleConfirmRefund = async (e) => {
    e.preventDefault();
    setConfirmErr('');
    setConfirmSuccess('');
    if (!debitUtrInput.trim()) {
      setConfirmErr('Debit UTR number from bank mail is required');
      return;
    }

    setConfirming(true);
    try {
      const res = await fetch('/api/admin/refunds/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refundId: sel.id,
          debitUtr: debitUtrInput.trim(),
          notes: confirmNotes.trim() || `Confirmed with Slice debit UTR ${debitUtrInput.trim()}`,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Refund confirmation failed');
      }

      const resData = await res.json();
      setConfirmSuccess(`Refund confirmed and matched with debit mail UTR: ${resData.refund?.debitUtr}`);
      setShowConfirmModal(false);
      setDebitUtrInput('');
      setConfirmNotes('');
      await loadRefunds();
      if (resData.refund) setSel(resData.refund);
    } catch (err) {
      setConfirmErr(err.message);
    } finally {
      setConfirming(false);
    }
  };

  const handleCancelRefund = async () => {
    if (!sel) return;
    if (!window.confirm(`Are you sure you want to cancel refund ${sel.id}?`)) return;
    try {
      const res = await fetch('/api/admin/refunds/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refundId: sel.id, reason: 'Cancelled by administrator' }),
      });
      if (res.ok) {
        await loadRefunds();
      }
    } catch (e) {
      console.warn('Failed to cancel refund:', e);
    }
  };

  const rows = useMemo(() => {
    return refundList.filter((r) => {
      const t = q.toLowerCase();
      const matchQ =
        !t ||
        [r.id, r.orderId, r.customer, r.debitUtr, r.reason].some(
          (field) => field && String(field).toLowerCase().includes(t)
        );
      const matchTab = tab === 'All' || r.status === tab;
      return matchQ && matchTab;
    });
  }, [refundList, tab, q]);

  const paged = usePaged(rows, 12);
  const total = refundList.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const count = (s) => refundList.filter((r) => r.status === s).length;

  return (
    <>
      <TopBar
        placeholder="Search refunds by ID, order, customer or UTR…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="content">
        <div className="page">
          <PageHead
            title="Refunds"
            desc="Manage, process and reconcile refunds with Slice debited transaction emails."
          >
            <button className="btn primary" onClick={() => setShowIssueModal(true)}>
              <Plus size={15} /> Issue Refund
            </button>
            <button className="btn" onClick={loadRefunds}>
              <RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh
            </button>
          </PageHead>

          {confirmSuccess && (
            <div
              style={{
                background: 'rgba(34, 197, 94, 0.1)',
                border: '1px solid #22c55e',
                color: '#22c55e',
                padding: '10px 14px',
                borderRadius: 8,
                marginBottom: 14,
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <CheckCircle2 size={16} /> {confirmSuccess}
            </div>
          )}

          <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 14 }}>
            <StatCard icon={Undo2} tone="c-blue" label="Total Refunds" value={refundList.length} />
            <StatCard icon={IndianRupee} tone="c-purple" label="Refunded Amount" value={inr(total)} />
            <StatCard icon={Clock} tone="c-yellow" label="Pending" value={count('Pending')} />
            <StatCard icon={CheckCircle2} tone="c-green" label="Processed" value={count('Processed')} />
          </div>

          <Tabs
            value={tab}
            onChange={setTab}
            tabs={['All', 'Pending', 'Processed', 'Failed'].map((k) => ({
              key: k,
              label: k === 'All' ? 'All Refunds' : k,
              count: k === 'All' ? refundList.length : count(k),
            }))}
          />

          <div className="card" style={{ padding: 6 }}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Refund &amp; Order ID</th>
                    <th>Amount</th>
                    <th>Debit UTR</th>
                    <th>Reason &amp; Customer</th>
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.slice.map((r) => (
                    <tr
                      key={r.id}
                      className={sel?.id === r.id ? 'selected' : ''}
                      onClick={() => setSel(r)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <Badge
                          tone={
                            r.status === 'Processed'
                              ? 'c-green'
                              : r.status === 'Pending'
                              ? 'c-yellow'
                              : 'c-red'
                          }
                        >
                          {r.status}
                        </Badge>
                      </td>
                      <td>
                        <div
                          className="mono"
                          style={{ fontWeight: 600, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={r.id}
                        >
                          {r.id}
                        </div>
                        <div
                          className="mono muted"
                          style={{ fontSize: 10, maxWidth: 125, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}
                          title={r.orderId}
                        >
                          {r.orderId}
                        </div>
                      </td>
                      <td style={{ fontWeight: 600 }}>{inr(r.amount)}</td>
                      <td
                        className="mono"
                        style={{ color: r.debitUtr ? '#38bdf8' : '#64748b', maxWidth: 95, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={r.debitUtr || ''}
                      >
                        {r.debitUtr || '—'}
                      </td>
                      <td>
                        <div
                          style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5 }}
                          title={r.reason}
                        >
                          {r.reason}
                        </div>
                        <div
                          className="muted"
                          style={{ fontSize: 10.5, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}
                          title={r.customer}
                        >
                          {r.customer}
                        </div>
                      </td>
                      <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                        {r.status === 'Pending' ? (
                          <button
                            className="btn sm success"
                            title="Confirm refund against bank debit mail"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSel(r);
                              setDebitUtrInput('');
                              setConfirmNotes('');
                              setConfirmErr('');
                              setShowConfirmModal(true);
                            }}
                          >
                            <CheckCircle2 size={12} /> Confirm UTR
                          </button>
                        ) : r.status === 'Processed' ? (
                          <span className="badge c-green plain" style={{ fontSize: 10, padding: '3px 6px', display: 'inline-flex', gap: 3, alignItems: 'center' }}>
                            <Check size={10} /> Reconciled
                          </span>
                        ) : (
                          <span className="badge c-red plain" style={{ fontSize: 10, padding: '3px 6px', display: 'inline-flex', gap: 3, alignItems: 'center' }}>
                            <X size={10} /> Cancelled
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 && <Empty text="No refunds found" />}
            </div>
            <div style={{ padding: '0 10px 10px' }}>
              <Pager paged={paged} label="refunds" />
            </div>
          </div>
        </div>

        {/* DETAIL SIDE PANEL */}
        {sel && (
          <aside className="detail" style={{ width: 340, display: 'flex', flexDirection: 'column' }}>
            <div className="detail-head">
              <div className="detail-title">Refund Details</div>
              <Badge
                tone={
                  sel.status === 'Processed'
                    ? 'c-green'
                    : sel.status === 'Pending'
                    ? 'c-yellow'
                    : 'c-red'
                }
              >
                {sel.status}
              </Badge>
            </div>
            <div className="detail-id">
              <span className="mono">{sel.id}</span>
            </div>
            <div className="detail-amount">{inr(sel.amount)}</div>

            <KV k="Order ID" v={<span className="mono">{sel.orderId}</span>} />
            <KV k="Customer" v={sel.customer} />
            <KV k="Reason" v={sel.reason} />
            <KV k="Method" v={sel.method || 'Slice UPI'} />
            <KV
              k="Requested"
              v={sel.createdAt ? new Date(sel.createdAt).toLocaleString() : '—'}
            />

            {sel.debitUtr && (
              <KV
                k="Debit UTR"
                v={
                  <span className="mono" style={{ color: '#38bdf8', fontWeight: 700 }}>
                    {sel.debitUtr}
                  </span>
                }
              />
            )}

            {sel.notes && <KV k="Notes" v={<span style={{ fontSize: 11 }}>{sel.notes}</span>} />}

            <div className="section-label">Refund Timeline</div>
            <Timeline
              items={[
                {
                  text: 'Refund requested',
                  sub: sel.createdAt ? new Date(sel.createdAt).toLocaleString() : 'Pending',
                },
                {
                  text: sel.status === 'Processed' ? 'Bank Debit Confirmed' : 'Awaiting Debit Confirmation',
                  sub: sel.debitUtr ? `Matched UTR: ${sel.debitUtr}` : 'Admin must supply UTR from debit email',
                  off: sel.status !== 'Processed',
                },
                {
                  text: sel.status === 'Processed' ? 'Completed & Reconciled' : 'In Progress',
                  sub: sel.status === 'Processed' ? 'Closed' : 'Waiting for UTR verification',
                  off: sel.status !== 'Processed',
                },
              ]}
            />

            <div className="actions">
              {sel.status === 'Pending' ? (
                <>
                  <button
                    className="btn success block"
                    onClick={() => {
                      setDebitUtrInput('');
                      setConfirmNotes('');
                      setConfirmErr('');
                      setShowConfirmModal(true);
                    }}
                  >
                    <CheckCircle2 size={16} /> Confirm with Debit UTR
                  </button>
                  <button className="btn danger block" onClick={handleCancelRefund}>
                    <XCircle size={16} /> Cancel Refund
                  </button>
                </>
              ) : (
                <div
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    background: 'rgba(34, 197, 94, 0.08)',
                    border: '1px solid rgba(34, 197, 94, 0.25)',
                    fontSize: 11.5,
                    color: '#22c55e',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    fontWeight: 600,
                  }}
                >
                  <CheckCircle2 size={14} /> Reconciled with debited email (UTR: {sel.debitUtr})
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* MODAL: CONFIRM WITH DEBIT UTR */}
      {showConfirmModal && sel && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(4px)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 1000,
            padding: 16,
          }}
          onClick={() => setShowConfirmModal(false)}
        >
          <div
            style={{
              background: '#0f141f',
              border: '1px solid #1e293b',
              borderRadius: 16,
              width: '100%',
              maxWidth: 480,
              padding: 24,
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 8,
                    background: 'rgba(34, 197, 94, 0.12)',
                    color: '#22c55e',
                    display: 'grid',
                    placeItems: 'center',
                    flexShrink: 0,
                  }}
                >
                  <CheckCircle2 size={18} />
                </div>
                <div>
                  <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0, color: '#f8fafc' }}>
                    Confirm Refund with Bank Debit Mail
                  </h3>
                  <p style={{ fontSize: 11.5, color: '#94a3b8', margin: '2px 0 0' }}>
                    Provide UTR from your debited Slice email to reconcile this refund.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowConfirmModal(false)}
                className="link"
                style={{ padding: 4, cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>

            <div
              style={{
                background: '#141b2a',
                padding: '12px 14px',
                borderRadius: 8,
                marginBottom: 16,
                fontSize: 12,
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div style={{ color: '#94a3b8', fontSize: 11 }}>Refund ID</div>
                <div className="mono" style={{ fontWeight: 600 }}>{sel.id}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: '#94a3b8', fontSize: 11 }}>Refund Amount</div>
                <div style={{ fontWeight: 700, color: '#22c55e', fontSize: 14 }}>{inr(sel.amount)}</div>
              </div>
            </div>

            {confirmErr && (
              <div
                style={{
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid #ef4444',
                  color: '#ef4444',
                  padding: '8px 12px',
                  borderRadius: 6,
                  fontSize: 12,
                  marginBottom: 14,
                }}
              >
                {confirmErr}
              </div>
            )}

            <form onSubmit={handleConfirmRefund}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#f8fafc', marginBottom: 6 }}>
                  Debit UTR / Reference Number <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. 629401849102"
                  value={debitUtrInput}
                  onChange={(e) => setDebitUtrInput(e.target.value)}
                  required
                  autoFocus
                  style={{
                    width: '100%',
                    background: '#141b2a',
                    border: '1px solid #334155',
                    borderRadius: 8,
                    padding: '10px 12px',
                    color: '#fff',
                    fontFamily: 'monospace',
                    fontSize: 13,
                    boxSizing: 'border-box',
                  }}
                />
                <span style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 4, display: 'block' }}>
                  The 12-digit UPI reference number from the Slice bank debit notification email.
                </span>
              </div>

              <div style={{ marginBottom: 18 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#f8fafc', marginBottom: 6 }}>
                  Reconciliation Notes (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Reconciled with outgoing Slice debit alert"
                  value={confirmNotes}
                  onChange={(e) => setConfirmNotes(e.target.value)}
                  style={{
                    width: '100%',
                    background: '#141b2a',
                    border: '1px solid #334155',
                    borderRadius: 8,
                    padding: '10px 12px',
                    color: '#fff',
                    fontSize: 12,
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowConfirmModal(false)}
                  disabled={confirming}
                >
                  <X size={13} /> Cancel
                </button>
                <button
                  type="submit"
                  className="btn success lg"
                  style={{ fontWeight: 700 }}
                  disabled={confirming}
                >
                  {confirming ? (
                    <>
                      <RefreshCw size={14} className="spin" /> Reconciling...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={15} /> Confirm &amp; Mark Processed
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: ISSUE NEW REFUND */}
      {showIssueModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(4px)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 1000,
            padding: 16,
          }}
          onClick={() => setShowIssueModal(false)}
        >
          <div
            style={{
              background: '#0f141f',
              border: '1px solid #1e293b',
              borderRadius: 16,
              width: '100%',
              maxWidth: 480,
              padding: 24,
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 8,
                    background: 'rgba(59, 130, 246, 0.12)',
                    color: '#3b82f6',
                    display: 'grid',
                    placeItems: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Plus size={18} />
                </div>
                <div>
                  <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0, color: '#f8fafc' }}>
                    Issue New Refund
                  </h3>
                  <p style={{ fontSize: 11.5, color: '#94a3b8', margin: '2px 0 0' }}>
                    Create a pending refund request to be reconciled against bank debit email.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowIssueModal(false)}
                className="link"
                style={{ padding: 4, cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>

            {issueErr && (
              <div
                style={{
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid #ef4444',
                  color: '#ef4444',
                  padding: '8px 12px',
                  borderRadius: 6,
                  fontSize: 12,
                  marginBottom: 14,
                }}
              >
                {issueErr}
              </div>
            )}

            <form onSubmit={handleIssueRefund}>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#f8fafc', marginBottom: 4 }}>
                  Order ID <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. ORD-20261024-1188"
                  value={issueOrderId}
                  onChange={(e) => setIssueOrderId(e.target.value)}
                  required
                  style={{
                    width: '100%',
                    background: '#141b2a',
                    border: '1px solid #334155',
                    borderRadius: 8,
                    padding: '8px 12px',
                    color: '#fff',
                    fontFamily: 'monospace',
                    fontSize: 12,
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#f8fafc', marginBottom: 4 }}>
                  Refund Amount (₹) <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  placeholder="e.g. 499.00"
                  value={issueAmount}
                  onChange={(e) => setIssueAmount(e.target.value)}
                  required
                  style={{
                    width: '100%',
                    background: '#141b2a',
                    border: '1px solid #334155',
                    borderRadius: 8,
                    padding: '8px 12px',
                    color: '#fff',
                    fontSize: 12,
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#f8fafc', marginBottom: 4 }}>
                  Customer Name / Identifier
                </label>
                <input
                  type="text"
                  placeholder="e.g. Rohit Sharma"
                  value={issueCustomer}
                  onChange={(e) => setIssueCustomer(e.target.value)}
                  style={{
                    width: '100%',
                    background: '#141b2a',
                    border: '1px solid #334155',
                    borderRadius: 8,
                    padding: '8px 12px',
                    color: '#fff',
                    fontSize: 12,
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#f8fafc', marginBottom: 4 }}>
                  Refund Reason
                </label>
                <select
                  value={issueReason}
                  onChange={(e) => setIssueReason(e.target.value)}
                  style={{
                    width: '100%',
                    background: '#141b2a',
                    border: '1px solid #334155',
                    borderRadius: 8,
                    padding: '8px 12px',
                    color: '#fff',
                    fontSize: 12,
                    boxSizing: 'border-box',
                  }}
                >
                  <option value="Customer duplicate payment">Customer duplicate payment</option>
                  <option value="Item out of stock">Item out of stock</option>
                  <option value="Order cancelled by user">Order cancelled by user</option>
                  <option value="Amount mismatch / dispute">Amount mismatch / dispute</option>
                  <option value="Payment timeout discrepancy">Payment timeout discrepancy</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowIssueModal(false)}
                  disabled={issuing}
                >
                  <X size={13} /> Cancel
                </button>
                <button
                  type="submit"
                  className="btn primary lg"
                  disabled={issuing}
                  style={{ fontWeight: 700 }}
                >
                  {issuing ? (
                    <>
                      <RefreshCw size={14} className="spin" /> Creating...
                    </>
                  ) : (
                    <>
                      <Plus size={15} /> Create Refund
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
