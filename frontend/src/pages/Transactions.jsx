import React, { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, RefreshCw, ArrowLeftRight, ExternalLink } from 'lucide-react';
import { TopBar, PageHead, Badge, Pager, usePaged, EmptyState, Copyable, useDateRange } from '../components/ui.jsx';
import Drawer from '../components/Drawer.jsx';
import { inr, isWithinDateRange, statusBucket } from '../data.js';

export default function Transactions() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { dateRange, customStart, customEnd } = useDateRange();
  const [transactionList, setTransactionList] = useState([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('All');
  const [source, setSource] = useState('All');
  const [sel, setSel] = useState(null);
  const [loading, setLoading] = useState(false);

  const getAdminKey = () => localStorage.getItem('aventas_admin_key') || '';

  const loadTransactions = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/admin/transactions', {
        headers: { 'x-admin-key': getAdminKey() },
      });
      if (res.ok) {
        const liveTxs = await res.json();
        if (Array.isArray(liveTxs)) {
          setTransactionList(liveTxs);

          const selParam = searchParams.get('selected');
          if (selParam) {
            const found = liveTxs.find((t) => t.id === selParam || t.orderId === selParam);
            if (found) {
              setSel(found);
            } else {
              setSel(null);
              searchParams.delete('selected');
              setSearchParams(searchParams, { replace: true });
            }
          }
        }
      }
    } catch (e) {
      console.warn('Transactions API error:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTransactions();
  }, []);

  const handleSelectRow = (p) => {
    setSel(p);
    searchParams.set('selected', p.id);
    setSearchParams(searchParams, { replace: true });
  };

  const handleCloseDrawer = () => {
    setSel(null);
    if (searchParams.has('selected')) {
      searchParams.delete('selected');
      setSearchParams(searchParams, { replace: true });
    }
  };

  const exportCsv = () => {
    if (transactionList.length === 0) return;
    const headers = ['Status', 'Payment ID', 'Order ID', 'Amount', 'Customer', 'UTR', 'Source', 'Received Time'];
    // Quote every text cell and neutralise spreadsheet formulas (=,+,-,@)
    const cell = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@]/.test(s)) s = "'" + s;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const rows = transactionList.map((t) => [
      cell(t.status),
      cell(t.id),
      cell(t.orderId || ''),
      t.amount,
      cell(t.customer || ''),
      cell(t.utr || ''),
      cell(t.source || 'Slice'),
      cell(t.time || ''),
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `aventas_transactions_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const rows = useMemo(() => {
    return transactionList.filter((p) => {
      const t = q.toLowerCase();
      const hit = !t || [p.id, p.orderId, p.customer, p.utr].some((x) => x && x.toLowerCase().includes(t));
      const inDate = isWithinDateRange(p.createdAt || p.receivedAt || p.time, dateRange, customStart, customEnd);
      const okStatus = status === 'All' || statusBucket(p) === status.toLowerCase();
      const okSource = source === 'All' || String(p.source || 'Slice').toLowerCase().includes(source.toLowerCase());
      return hit && inDate && okStatus && okSource;
    });
  }, [transactionList, q, status, source, dateRange, customStart, customEnd]);

  const paged = usePaged(rows, 12);

  const isDone = sel ? statusBucket(sel) === 'success' : false;
  const confirmationText = sel?.confirmed && sel.confirmed !== '—'
    ? `Auto-confirmed in ${sel.confirmed}`
    : isDone
    ? 'Auto-confirmed'
    : 'Awaiting confirmation';

  const drawerSections = useMemo(() => {
    if (!sel) return [];
    return [
      {
        label: 'Transaction Details',
        items: [
          { k: 'Customer', v: sel.customer || 'UPI Payer' },
          { k: 'Payment ID', v: sel.id, mono: true, copyable: true },
          { k: 'Order ID', v: sel.orderId || '—', mono: true, copyable: Boolean(sel.orderId && sel.orderId !== '—') },
          { k: 'UTR / RRN', v: sel.utr && sel.utr !== '—' ? sel.utr : '—', mono: true, copyable: Boolean(sel.utr && sel.utr !== '—') },
          { k: 'Settlement Source', v: sel.source || 'Slice Bank UPI' },
          { k: 'Confirmation Rate', v: confirmationText, mono: true },
          { k: 'Received Time', v: sel.time || '—', mono: true },
        ],
      },
    ];
  }, [sel, confirmationText]);

  const drawerTimeline = useMemo(() => {
    if (!sel) return [];
    return [
      { text: 'Incoming Slice email parsed', sub: sel.time, completed: true },
      { text: 'Paise offset matched with order', sub: isDone ? sel.orderId : 'Waiting / Review', completed: isDone, pending: !isDone },
      { text: 'Transaction settled to merchant', sub: confirmationText, completed: isDone, pending: !isDone },
    ];
  }, [sel, isDone, confirmationText]);

  const drawerEmailPreview = useMemo(() => {
    if (!sel) return null;
    return {
      title: `Received ${inr(sel.amount)} from ${sel.customer} via UPI`,
      body: `noreply@sliceit.com\nHi, you've received ${inr(sel.amount)} in your Slice Account. Reference UTR: ${sel.utr && sel.utr !== '—' ? sel.utr : '—'}.`,
    };
  }, [sel]);

  return (
    <>
      <TopBar placeholder="Search transactions by ID, Customer, UTR..." onSearch={setQ} />

      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div className="page-container" style={{ flex: 1, overflowY: 'auto' }}>
          <PageHead
            title="Transactions"
            desc="View and manage all real-time payment transaction records via Slice Bank."
          >
            <button className="btn secondary sm" onClick={exportCsv} disabled={transactionList.length === 0}>
              <Download size={14} strokeWidth={1.5} />
              <span>Export CSV</span>
            </button>
            <button className="btn secondary sm" onClick={loadTransactions} disabled={loading}>
              <RefreshCw size={13} strokeWidth={1.5} className={loading ? 'spin' : ''} />
              <span>Refresh</span>
            </button>
          </PageHead>

          {/* Filter Bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
              <span>Status:</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                style={{ height: 32, padding: '0 8px', fontSize: 12 }}
              >
                {['All', 'Success', 'Pending', 'Review', 'Failed', 'Expired'].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
              <span>Source:</span>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                style={{ height: 32, padding: '0 8px', fontSize: 12 }}
              >
                {['All', 'Slice', 'UPI'].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Transactions Table */}
          <div className="table-wrap">
            {rows.length === 0 ? (
              <EmptyState
                icon={ArrowLeftRight}
                title="No transactions yet"
                description="Transactions ingested from Slice Bank confirmation emails will appear here automatically."
                action={
                  <a href="/products" className="btn primary sm" style={{ textDecoration: 'none' }}>
                    Create a test order
                  </a>
                }
              />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Payment ID</th>
                    <th>Amount</th>
                    <th>Customer</th>
                    <th>UTR</th>
                    <th>Source</th>
                    <th>Auto-Confirmed</th>
                    <th>Received</th>
                  </tr>
                </thead>
                <tbody>
                  {(paged.slice || []).map((p, idx) => {
                    const isSelected = sel && sel.id === p.id;
                    const conf = p.confirmed && p.confirmed !== '—' ? `in ${p.confirmed}` : '—';

                    return (
                      <tr
                        key={p.id}
                        className={`motion-tbl-row ${isSelected ? 'selected' : ''}`}
                        style={{ '--row-i': Math.min(idx, 12), cursor: 'pointer' }}
                        onClick={() => handleSelectRow(p)}
                      >
                        <td><Badge>{p.status}</Badge></td>
                        <td><Copyable text={p.id} /></td>
                        <td className="mono" style={{ fontWeight: 600, color: 'var(--bone)' }}>{inr(p.amount)}</td>
                        <td>{p.customer || 'Verified Payer'}</td>
                        <td className="mono">
                          {p.utr && p.utr !== '—' ? (
                            <Copyable text={p.utr} />
                          ) : (
                            <span style={{ color: 'var(--muted)' }}>—</span>
                          )}
                        </td>
                        <td>
                          <span className="badge status-muted" style={{ padding: '2px 6px', fontSize: 10 }}>
                            {p.source || 'Slice'}
                          </span>
                        </td>
                        <td className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                          {conf}
                        </td>
                        <td className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                          {p.time || '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <Pager paged={paged} label="transactions" />
          </div>
        </div>

        {/* Shared Unified Drawer */}
        <Drawer
          open={Boolean(sel)}
          onClose={handleCloseDrawer}
          type="Transaction"
          id={sel?.id}
          status={sel?.status}
          amount={sel?.amount}
          sections={drawerSections}
          timeline={drawerTimeline}
          emailPreview={drawerEmailPreview}
          actions={
            sel?.orderId && sel.orderId !== '—' ? (
              <a
                href={`/pay/${sel.orderId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn primary"
                style={{ width: '100%', textDecoration: 'none' }}
              >
                <ExternalLink size={15} strokeWidth={1.5} />
                <span>Open Pay Page</span>
              </a>
            ) : null
          }
        />
      </div>
    </>
  );
}
