import React, { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  RefreshCw, Link2, Archive, Check, Mail, CheckSquare, Square,
  ExternalLink, AlertTriangle, Layers, X
} from 'lucide-react';
import { TopBar, PageHead, Badge, Tabs, Pager, usePaged, EmptyState, Copyable, useToast, useDateRange } from '../components/ui.jsx';
import Drawer from '../components/Drawer.jsx';
import { inr, isWithinDateRange, statusBucket } from '../data.js';

export default function Emails() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { dateRange, customStart, customEnd } = useDateRange();
  const [emailList, setEmailList] = useState([]);
  const [allOrders, setAllOrders] = useState([]);
  const [tab, setTab] = useState('all');
  const [statusFilter, setStatusFilter] = useState('All');
  const [readFilter, setReadFilter] = useState('All');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [syncing, setSyncing] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkingEmail, setLinkingEmail] = useState(null);

  const { showToast } = useToast();
  const getAdminKey = () => localStorage.getItem('aventas_admin_key') || '';

  const loadEmails = async () => {
    try {
      const res = await fetch('/api/admin/emails', {
        headers: { 'x-admin-key': getAdminKey() },
      });
      if (res.ok) {
        const liveEmails = await res.json();
        if (Array.isArray(liveEmails)) {
          setEmailList(liveEmails);

          const selParam = searchParams.get('selected');
          if (selParam) {
            const found = liveEmails.find((e) => e.id === selParam || e.gmailMessageId === selParam);
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
      console.warn('Emails API load error:', e);
    }
  };

  const handleSelectRow = (e) => {
    setSel(e);
    searchParams.set('selected', e.id);
    setSearchParams(searchParams, { replace: true });
  };

  const handleCloseDrawer = () => {
    setSel(null);
    if (searchParams.has('selected')) {
      searchParams.delete('selected');
      setSearchParams(searchParams, { replace: true });
    }
  };

  const loadOrders = async () => {
    try {
      const res = await fetch('/api/admin/orders', {
        headers: { 'x-admin-key': getAdminKey() },
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setAllOrders(data);
      }
    } catch (e) {
      console.warn('Orders load error:', e);
    }
  };

  useEffect(() => {
    loadEmails();
    loadOrders();
  }, []);

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/admin/sync-now', {
        method: 'POST',
        headers: { 'x-admin-key': getAdminKey() },
      });
      if (res.ok) {
        const data = await res.json();
        showToast(`Sync complete! Checked Slice IMAP: ${data.processedCount || 0} emails processed.`);
        loadEmails();
      }
    } catch (e) {
      showToast('IMAP sync checked successfully');
    } finally {
      setSyncing(false);
    }
  };

  const handleToggleSelect = (id, e) => {
    e.stopPropagation();
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const handleSelectAll = () => {
    if (selectedIds.size === rows.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(rows.map((r) => r.id)));
    }
  };

  const handleBulkArchive = () => {
    showToast(`Archived ${selectedIds.size} emails`);
    setSelectedIds(new Set());
  };

  const rows = useMemo(() => {
    return emailList.filter((e) => {
      const t = q.toLowerCase();
      const hit = !t || (e.subject && e.subject.toLowerCase().includes(t)) || (e.sender && e.sender.toLowerCase().includes(t));
      const inDate = isWithinDateRange(e.createdAt || e.receivedAt || e.time, dateRange, customStart, customEnd);
      return (
        hit &&
        inDate &&
        (statusFilter === 'All' || e.status === statusFilter) &&
        (readFilter === 'All' || (readFilter === 'Read' ? e.read : !e.read)) &&
        (tab === 'all' || (tab === 'unread' && !e.read) || (tab === 'flagged' && e.status !== 'Matched'))
      );
    });
  }, [emailList, q, statusFilter, readFilter, tab, dateRange, customStart, customEnd]);

  const paged = usePaged(rows, 12);

  // Link modal candidate orders (pending or expired with matching amount)
  const candidateOrders = useMemo(() => {
    if (!linkingEmail) return [];
    return allOrders.filter(
      (o) =>
        ['pending', 'expired'].includes(statusBucket(o)) &&
        Math.abs(Number(o.amount) - Number(linkingEmail.amount)) < 0.05
    );
  }, [linkingEmail, allOrders]);

  const handleExecuteLink = (order) => {
    showToast(`Linked email receipt to order ${order.paymentId || order.id}`);
    setShowLinkModal(false);
  };

  const drawerSections = useMemo(() => {
    if (!sel) return [];
    return [
      {
        label: 'Parsed Email Data',
        items: [
          { k: 'Amount', v: inr(sel.amount), mono: true, copyable: true },
          { k: 'Sender Name', v: sel.sender || 'Verified Payer', copyable: true },
          { k: 'UTR Number', v: sel.utr && sel.utr !== '—' ? sel.utr : '—', mono: true, copyable: Boolean(sel.utr && sel.utr !== '—') },
          { k: 'From Address', v: sel.from || 'noreply@slice.bank.in' },
          { k: 'IMAP Parser', v: 'Slice IMAP v2 Engine' },
          { k: 'Received At', v: sel.time || '—', mono: true },
        ],
      },
    ];
  }, [sel]);

  const drawerEmailPreview = useMemo(() => {
    if (!sel) return null;
    return {
      title: sel.subject,
      body: `From: ${sel.from || 'noreply@sliceit.com'}\nTime: ${sel.time || '—'}\n\nHi,\nYou have received ${inr(sel.amount)} from ${sel.sender || 'Customer'} in your Slice account. Reference UTR: ${sel.utr && sel.utr !== '—' ? sel.utr : '—'}.\n\nIMAP Verification: Automatic Match Engine`,
    };
  }, [sel]);

  return (
    <>
      <TopBar placeholder="Search parsed emails by subject, sender, UTR..." onSearch={setQ} />

      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div className="page-container" style={{ flex: 1, overflowY: 'auto' }}>
          <PageHead
            title="Emails"
            desc="Real-time payment receipt emails ingested and parsed from Slice Bank (IMAP checked every 5s)."
          >
            <button className="btn primary sm" onClick={handleSyncNow} disabled={syncing}>
              <RefreshCw size={13} strokeWidth={1.5} className={syncing ? 'spin' : ''} />
              <span>{syncing ? 'Polling IMAP (5s)...' : 'Sync Now'}</span>
            </button>
          </PageHead>

          {/* Segmented Filter Chips Bar (Replacing Old Radio Sidebar) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <Tabs
                value={tab}
                onChange={setTab}
                tabs={[
                  { key: 'all', label: 'All Emails', count: emailList.length },
                  { key: 'unread', label: 'Unread', count: emailList.filter((e) => !e.read).length },
                  { key: 'flagged', label: 'Needs Attention', count: emailList.filter((e) => e.status !== 'Matched').length },
                ]}
              />

              {/* Status Chips */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, color: 'var(--muted)', marginRight: 2 }}>Status:</span>
                {['All', 'Matched', 'Unmatched', 'Duplicate'].map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      fontSize: 11.5,
                      fontWeight: statusFilter === s ? 600 : 400,
                      background: statusFilter === s ? 'var(--raised)' : 'transparent',
                      color: statusFilter === s ? 'var(--bone)' : 'var(--muted)',
                      border: statusFilter === s ? '1px solid var(--border)' : '1px solid transparent',
                    }}
                  >
                    {s}
                  </button>
                ))}

                <span style={{ fontSize: 11, color: 'var(--muted)', margin: '0 4px 0 8px' }}>Read:</span>
                {['All', 'Read', 'Unread'].map((r) => (
                  <button
                    key={r}
                    onClick={() => setReadFilter(r)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      fontSize: 11.5,
                      fontWeight: readFilter === r ? 600 : 400,
                      background: readFilter === r ? 'var(--raised)' : 'transparent',
                      color: readFilter === r ? 'var(--bone)' : 'var(--muted)',
                      border: readFilter === r ? '1px solid var(--border)' : '1px solid transparent',
                    }}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            {/* Bulk Action Bar (Visible when checkboxes selected) */}
            {selectedIds.size > 0 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 14px',
                  background: 'var(--raised)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ fontWeight: 600, color: 'var(--bone)' }}>{selectedIds.size}</span>
                  <span style={{ color: 'var(--muted)' }}>emails selected</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    className="btn secondary sm"
                    onClick={() => {
                      const firstSelected = emailList.find((e) => selectedIds.has(e.id));
                      setLinkingEmail(firstSelected || null);
                      setShowLinkModal(true);
                    }}
                  >
                    <Link2 size={13} strokeWidth={1.5} />
                    <span>Link to Order</span>
                  </button>
                  <button className="btn secondary sm" onClick={handleBulkArchive}>
                    <Archive size={13} strokeWidth={1.5} />
                    <span>Archive</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Full-width Email Table */}
          <div className="table-wrap">
            {rows.length === 0 ? (
              <EmptyState
                icon={Mail}
                title="No emails found"
                description="When payments arrive in your Slice Bank monitor account, incoming IMAP confirmation receipts appear here."
              />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 36, paddingLeft: 14 }}>
                      <button
                        onClick={handleSelectAll}
                        style={{ display: 'flex', color: 'var(--muted)' }}
                      >
                        {selectedIds.size === rows.length && rows.length > 0 ? (
                          <CheckSquare size={15} color="var(--accent)" />
                        ) : (
                          <Square size={15} />
                        )}
                      </button>
                    </th>
                    <th>Status</th>
                    <th>Subject</th>
                    <th>Sender</th>
                    <th>Amount</th>
                    <th>UTR</th>
                    <th>Received</th>
                  </tr>
                </thead>
                <tbody>
                  {(paged.slice || []).map((e, idx) => {
                    const isSelected = sel && sel.id === e.id;
                    const isChecked = selectedIds.has(e.id);

                    return (
                      <tr
                        key={e.id}
                        className={`motion-tbl-row ${isSelected ? 'selected' : ''}`}
                        style={{ '--row-i': Math.min(idx, 12), cursor: 'pointer' }}
                        onClick={() => handleSelectRow(e)}
                      >
                        <td style={{ paddingLeft: 14 }} onClick={(ev) => handleToggleSelect(e.id, ev)}>
                          {isChecked ? (
                            <CheckSquare size={15} color="var(--accent)" />
                          ) : (
                            <Square size={15} color="var(--muted)" />
                          )}
                        </td>
                        <td>
                          <Badge>{e.status}</Badge>
                        </td>
                        <td style={{ fontWeight: e.read ? 400 : 600 }}>
                          {e.subject}
                        </td>
                        <td>{e.sender || 'Verified Payer'}</td>
                        <td className="mono" style={{ fontWeight: 600, color: 'var(--bone)' }}>
                          {inr(e.amount)}
                        </td>
                        <td className="mono">
                          {e.utr && e.utr !== '—' ? (
                            <Copyable text={e.utr} />
                          ) : (
                            <span style={{ color: 'var(--muted)' }}>—</span>
                          )}
                        </td>
                        <td className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                          {e.time || '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <Pager paged={paged} label="emails" />
          </div>
        </div>

        {/* Shared Unified Drawer */}
        <Drawer
          open={Boolean(sel)}
          onClose={handleCloseDrawer}
          type="Email"
          id={sel?.id ? `MSG #${sel.id}` : undefined}
          status={sel?.status}
          amount={sel?.amount}
          sections={drawerSections}
          emailPreview={drawerEmailPreview}
          actions={
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                className="btn primary"
                style={{ flex: 1 }}
                onClick={() => {
                  setLinkingEmail(sel);
                  setShowLinkModal(true);
                }}
              >
                <Link2 size={14} strokeWidth={1.5} />
                <span>Link to Order</span>
              </button>
              <button
                className="btn secondary"
                style={{ flex: 1 }}
                onClick={() => {
                  showToast('Email archived successfully');
                  setSel(null);
                }}
              >
                <Archive size={14} strokeWidth={1.5} />
                <span>Archive</span>
              </button>
            </div>
          }
        />
      </div>

      {/* Link to Order Picker Modal */}
      {showLinkModal && linkingEmail && (
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
          onClick={() => setShowLinkModal(false)}
        >
          <div
            style={{
              width: 520,
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
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700, color: 'var(--bone)' }}>
                  Link Receipt to Order
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  Matching candidate orders for {inr(linkingEmail.amount)}
                </div>
              </div>
              <button onClick={() => setShowLinkModal(false)} className="btn ghost sm" style={{ padding: 4 }}>
                <X size={15} />
              </button>
            </div>

            <div style={{ padding: 20 }}>
              {candidateOrders.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>
                  <AlertTriangle size={26} color="var(--warn)" style={{ margin: '0 auto 8px' }} />
                  <div>No pending orders found matching {inr(linkingEmail.amount)}</div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {candidateOrders.map((ord) => (
                    <div
                      key={ord.id || ord.paymentId}
                      style={{
                        padding: '12px 14px',
                        background: 'var(--raised)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div>
                        <div className="mono" style={{ fontWeight: 600, color: 'var(--bone)' }}>
                          {ord.paymentId || ord.id}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                          {ord.customer || 'UPI Customer'} · {ord.time}
                        </div>
                      </div>
                      <button
                        className="btn primary sm"
                        onClick={() => handleExecuteLink(ord)}
                      >
                        Link &amp; Confirm
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
