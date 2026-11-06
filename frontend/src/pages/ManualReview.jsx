import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ShieldAlert, AlertTriangle, Clock, Check, X,
  MessageCircle, Send, RefreshCw, CheckCircle2, User, ShieldCheck, FileText, XCircle, Info
} from 'lucide-react';
import { TopBar, PageHead, StatCard, Tabs, Badge, Pager, usePaged, EmptyState, Copyable, useToast } from '../components/ui.jsx';
import Drawer from '../components/Drawer.jsx';
import { inr } from '../data.js';

export default function ManualReview() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [list, setList] = useState([]);
  const [unmatchedEmails, setUnmatchedEmails] = useState([]);
  const [tab, setTab] = useState('All');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [loading, setLoading] = useState(true);

  // Active sub-tab in drawer: 'chat' | 'info'
  const [panelTab, setPanelTab] = useState('chat');

  // Chat state
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [sendingMsg, setSendingMsg] = useState(false);
  const chatPollRef = useRef(null);
  const chatScrollRef = useRef(null);

  // Approve Modal state
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [approveUtr, setApproveUtr] = useState('');
  const [approveNotes, setApproveNotes] = useState('');
  const [approving, setApproving] = useState(false);
  const [approveErr, setApproveErr] = useState('');
  const [confirmMismatch, setConfirmMismatch] = useState(false);

  // Rule A18: Two-step confirm approve on mismatch
  const [confirmArmed, setConfirmArmed] = useState(false);
  const confirmTimeoutRef = useRef(null);

  const handleTwoStepApprove = () => {
    if (hasUtrMismatch && !confirmArmed) {
      setConfirmArmed(true);
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = setTimeout(() => {
        setConfirmArmed(false);
      }, 3000);
      return;
    }
    setApproveUtr(autoExtractedUtr || sel?.reportedUtr || '');
    setShowApproveModal(true);
    setConfirmArmed(false);
  };

  const { showToast } = useToast();
  const getAdminKey = () => localStorage.getItem('aventas_admin_key') || '';

  const loadReviews = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/admin/manual-reviews', {
        headers: { 'x-admin-key': getAdminKey() },
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setList(data);

          const selParam = searchParams.get('selected');
          if (selParam) {
            const found = data.find((r) => r.id === selParam || r.orderId === selParam);
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
      console.warn('Failed to load manual reviews:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectRow = (r) => {
    setSel(r);
    searchParams.set('selected', r.orderId || r.id);
    setSearchParams(searchParams, { replace: true });
  };

  const handleCloseDrawer = () => {
    setSel(null);
    if (searchParams.has('selected')) {
      searchParams.delete('selected');
      setSearchParams(searchParams, { replace: true });
    }
  };

  const loadEmails = async () => {
    try {
      const res = await fetch('/api/admin/emails', {
        headers: { 'x-admin-key': getAdminKey() },
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setUnmatchedEmails(data.filter((e) => e.status !== 'Matched'));
        }
      }
    } catch (e) {
      console.warn('Failed to load emails for candidate match:', e);
    }
  };

  useEffect(() => {
    loadReviews();
    loadEmails();
  }, []);

  // Poll chat messages for selected order
  useEffect(() => {
    if (!sel || !sel.orderId) {
      setChatMessages([]);
      return;
    }

    const fetchChat = async () => {
      try {
        const res = await fetch(`/api/chat/${sel.orderId}/messages`);
        if (res.ok) {
          const msgs = await res.json();
          setChatMessages(msgs);
        }
      } catch (e) {
        console.warn('Chat poll error:', e);
      }
    };

    fetchChat();
    chatPollRef.current = setInterval(fetchChat, 2000);
    return () => clearInterval(chatPollRef.current);
  }, [sel?.orderId]);

  useEffect(() => {
    if (panelTab === 'chat') {
      chatScrollRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, panelTab]);

  // Auto-extract any 12-digit number from customer chat messages
  const autoExtractedUtr = useMemo(() => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const m = chatMessages[i];
      if (m.sender === 'customer') {
        const match = m.message.match(/\b(\d{12})\b/);
        if (match) return match[1];
      }
    }
    return sel?.reportedUtr || '';
  }, [chatMessages, sel]);

  useEffect(() => {
    if (autoExtractedUtr && !approveUtr) {
      setApproveUtr(autoExtractedUtr);
    }
  }, [autoExtractedUtr, approveUtr]);

  // Candidate unmatched email with matching amount
  const candidateEmail = useMemo(() => {
    if (!sel) return null;
    return unmatchedEmails.find(
      (e) => Math.abs(Number(e.amount) - Number(sel.amount)) < 0.05
    );
  }, [sel, unmatchedEmails]);

  // UTR mismatch check
  const hasUtrMismatch = useMemo(() => {
    if (!candidateEmail || !autoExtractedUtr) return false;
    return candidateEmail.utr && candidateEmail.utr !== '—' && candidateEmail.utr !== autoExtractedUtr;
  }, [candidateEmail, autoExtractedUtr]);

  const handleSendAdminMessage = async (msgText) => {
    const msg = (msgText || chatInput).trim();
    if (!msg || !sel?.orderId) return;
    if (!msgText) setChatInput('');
    setSendingMsg(true);

    try {
      const res = await fetch(`/api/chat/${sel.orderId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': getAdminKey() },
        body: JSON.stringify({
          sender: 'admin',
          message: msg,
        }),
      });
      if (res.ok) {
        const created = await res.json();
        setChatMessages((prev) => [...prev, created]);
      }
    } catch (err) {
      console.error('Send admin message error:', err);
    } finally {
      setSendingMsg(false);
    }
  };

  const handleApproveAndMatch = async (e) => {
    e.preventDefault();
    setApproveErr('');

    const cleanUtr = approveUtr.trim();
    if (!/^\d{12}$/.test(cleanUtr)) {
      setApproveErr('UTR must be exactly 12 digits');
      return;
    }

    if (hasUtrMismatch && !confirmMismatch) {
      setApproveErr('Warning: UTR mismatch detected. Please check the confirmation checkbox to proceed.');
      return;
    }

    setApproving(true);
    try {
      const res = await fetch('/api/admin/manual-reviews/approve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': getAdminKey(),
        },
        body: JSON.stringify({
          orderId: sel.orderId,
          utr: cleanUtr,
          adminNotes: approveNotes.trim() || 'Verified via customer live chat',
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to approve review');
      }

      showToast(`Payment approved! Order ${sel.orderId} marked Success with UTR ${cleanUtr}`);
      setShowApproveModal(false);
      loadReviews();
    } catch (err) {
      setApproveErr(err.message || 'Error approving payment');
    } finally {
      setApproving(false);
    }
  };

  const rows = useMemo(() => {
    return list.filter((r) => {
      const t = q.toLowerCase();
      const hit = !t || [r.orderId, r.customerName, r.reportedUtr, r.issue].some((x) => x && x.toLowerCase().includes(t));
      return hit && (tab === 'All' || r.status === tab);
    });
  }, [list, q, tab]);

  const paged = usePaged(rows, 12);

  const stats = useMemo(() => {
    const pending = list.filter((r) => r.status === 'Pending').length;
    const resolved = list.filter((r) => r.status === 'Resolved').length;
    const high = list.filter((r) => r.priority === 'High' && r.status === 'Pending').length;
    return { pending, resolved, high, total: list.length };
  }, [list]);

  const isResolved = sel?.status === 'Resolved';

  return (
    <>
      <TopBar placeholder="Search reviews by Order ID, Customer, UTR..." onSearch={setQ} />

      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div className="page-container" style={{ flex: 1, overflowY: 'auto' }}>
          <PageHead
            title="Manual Review &amp; Live Support"
            desc="Review flagged orders, chat live with customers who timed out, and approve verified payments with UTR."
          >
            <button className="btn secondary sm" onClick={loadReviews} disabled={loading}>
              <RefreshCw size={13} strokeWidth={1.5} className={loading ? 'spin' : ''} />
              <span>Refresh</span>
            </button>
          </PageHead>

          {/* Stat Cards */}
          <div className="stat-grid">
            <StatCard
              icon={ShieldAlert}
              label="Pending Review"
              value={stats.pending}
              footDot={stats.pending > 0 ? "var(--warn)" : "var(--ok)"}
              foot="Awaiting admin action"
            />
            <StatCard
              icon={AlertTriangle}
              label="High Priority"
              value={stats.high}
              footDot={stats.high > 0 ? "var(--bad)" : "var(--muted)"}
              foot="Active customer inquiries"
            />
            <StatCard
              icon={CheckCircle2}
              label="Resolved"
              value={stats.resolved}
              footDot={stats.resolved > 0 ? "var(--ok)" : "var(--muted)"}
              foot="Approved and matched"
            />
            <StatCard
              icon={Clock}
              label="Total Inquiries"
              value={stats.total}
              foot="All recorded tickets"
            />
          </div>

          {/* Filter Tabs */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { key: 'All', label: 'All Reviews', count: stats.total },
                { key: 'Pending', label: 'Pending', count: stats.pending },
                { key: 'Resolved', label: 'Resolved', count: stats.resolved },
              ]}
            />
          </div>

          {/* Reviews Table */}
          <div className="table-wrap">
            {rows.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                title="No reviews pending"
                description="Orders that encounter timeouts or customer inquiries will automatically be routed here."
              />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Order &amp; Customer</th>
                    <th>Amount</th>
                    <th>Reported UTR</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(paged.slice || []).map((r, idx) => {
                    const isSelected = sel && sel.id === r.id;
                    const displayUtr = r.reportedUtr || (isSelected ? autoExtractedUtr : '—');

                    return (
                      <tr
                        key={r.id}
                        className={`motion-tbl-row ${isSelected ? 'selected' : ''}`}
                        style={{ '--row-i': Math.min(idx, 12), cursor: 'pointer' }}
                        onClick={() => handleSelectRow(r)}
                      >
                        <td>
                          <Badge>{r.status}</Badge>
                        </td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{r.customerName || 'Customer'}</div>
                          <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                            {r.orderId}
                          </div>
                        </td>
                        <td className="mono" style={{ fontWeight: 600, color: 'var(--bone)' }}>
                          {inr(r.amount)}
                        </td>
                        <td className="mono">
                          {displayUtr && displayUtr !== '—' ? (
                            <Copyable text={displayUtr} />
                          ) : (
                            <span style={{ color: 'var(--muted)' }}>—</span>
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              className="btn ghost sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSel(r);
                                setPanelTab('chat');
                              }}
                            >
                              <MessageCircle size={13} /> Chat
                            </button>
                            {r.status !== 'Resolved' && (
                              <button
                                className="btn primary sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSel(r);
                                  setApproveUtr(displayUtr && displayUtr !== '—' ? displayUtr : '');
                                  setShowApproveModal(true);
                                }}
                              >
                                Match UTR
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <Pager paged={paged} label="reviews" />
          </div>
        </div>

        {/* Shared Unified Drawer with Live Support Chat and Review Info Tabs */}
        <Drawer
          open={Boolean(sel)}
          onClose={handleCloseDrawer}
          type="Review"
          id={sel?.orderId}
          status={sel?.status}
          amount={sel?.amount}
          actions={
            sel?.status !== 'Resolved' ? (
              <button
                className={`btn ${confirmArmed ? 'danger motion-shake' : 'primary'}`}
                style={{ width: '100%', transition: 'all 0.2s' }}
                onClick={handleTwoStepApprove}
              >
                <CheckCircle2 size={15} strokeWidth={1.5} />
                <span>{confirmArmed ? 'Confirm Approve Mismatch (3s)' : 'Approve & Match UTR'}</span>
              </button>
            ) : (
              <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--ok)', padding: '6px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <Check size={14} /> Resolved &amp; Confirmed
              </div>
            )
          }
        >
          {/* Sub-Tabs: Live Chat vs Review Info */}
          <div style={{ display: 'flex', background: 'var(--raised)', borderRadius: 8, padding: 3, marginBottom: 8 }}>
            <button
              onClick={() => setPanelTab('chat')}
              style={{
                flex: 1,
                padding: '6px 10px',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: panelTab === 'chat' ? 600 : 500,
                background: panelTab === 'chat' ? 'var(--surface)' : 'transparent',
                color: panelTab === 'chat' ? 'var(--bone)' : 'var(--muted)',
                border: panelTab === 'chat' ? '1px solid var(--border)' : '1px solid transparent',
              }}
            >
              Live Chat ({chatMessages.length})
            </button>
            <button
              onClick={() => setPanelTab('info')}
              style={{
                flex: 1,
                padding: '6px 10px',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: panelTab === 'info' ? 600 : 500,
                background: panelTab === 'info' ? 'var(--surface)' : 'transparent',
                color: panelTab === 'info' ? 'var(--bone)' : 'var(--muted)',
                border: panelTab === 'info' ? '1px solid var(--border)' : '1px solid transparent',
              }}
            >
              Review Info {hasUtrMismatch && <span style={{ color: 'var(--bad)', fontWeight: 800 }}>!</span>}
            </button>
          </div>

          {/* TAB 1: LIVE CHAT */}
          {panelTab === 'chat' && (
            <div style={{ display: 'flex', flexDirection: 'column', height: 420 }}>
              {/* Pinned System Notice */}
              <div
                style={{
                  padding: '7px 10px',
                  background: 'var(--raised)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 6,
                  textAlign: 'center',
                  fontSize: 10.5,
                  color: 'var(--muted)',
                  lineHeight: 1.4,
                  marginBottom: 6,
                }}
              >
                Support ticket initiated. Customer has been asked for payment details / UTR.
              </div>

              {/* Message Stream */}
              <div
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  padding: '6px 0',
                }}
              >
                {chatMessages.filter((m) => m.sender !== 'system').length === 0 ? (
                  <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 12, margin: 'auto' }}>
                    No messages yet. Customer has not replied.
                  </div>
                ) : (
                  chatMessages
                    .filter((m) => m.sender !== 'system')
                    .map((m) => {
                      const isCustomer = m.sender === 'customer';

                      return (
                        <div
                          key={m.id}
                          className="motion-chat-bubble"
                          style={{
                            alignSelf: isCustomer ? 'flex-start' : 'flex-end',
                            maxWidth: '82%',
                          }}
                        >
                          <div style={{ fontSize: 9.5, color: 'var(--muted)', marginBottom: 2, textAlign: isCustomer ? 'left' : 'right' }}>
                            {isCustomer ? `${sel?.customerName || 'UPI Customer'}` : 'Admin (You)'}
                          </div>
                          <div
                            style={{
                              padding: '9px 13px',
                              borderRadius: 8,
                              fontSize: 12,
                              lineHeight: 1.45,
                              // Neutral tones: Customer = raised surface, Admin = bone background with dark text
                              background: isCustomer ? 'var(--raised)' : 'var(--bone)',
                              color: isCustomer ? 'var(--bone)' : 'var(--bg)',
                              border: isCustomer ? '1px solid var(--border)' : '1px solid var(--bone)',
                              fontWeight: isCustomer ? 400 : 600,
                            }}
                          >
                            {m.message}
                          </div>
                          {m.createdAt && (
                            <div className="mono" style={{ fontSize: 9, color: 'var(--muted)', marginTop: 2, textAlign: isCustomer ? 'left' : 'right' }}>
                              {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </div>
                          )}
                        </div>
                      );
                    })
                )}
                {sendingMsg && (
                  <div style={{ alignSelf: 'flex-end', maxWidth: '82%' }}>
                    <div
                      className="motion-chat-bubble"
                      style={{
                        padding: '6px 12px',
                        borderRadius: 8,
                        background: 'var(--raised)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <div className="motion-typing-indicator" style={{ padding: 2 }}>
                        <i /><i /><i />
                      </div>
                    </div>
                  </div>
                )}
                <div ref={chatScrollRef} />
              </div>

              {/* Quick Reply Chips */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 8, overflowX: 'auto', paddingBottom: 2 }}>
                {[
                  { label: 'Ask for UTR', text: 'Hello! Could you please share the 12-digit UPI UTR / RRN from your Slice app transaction receipt?' },
                  { label: 'Checking now', text: 'Checking our Slice Bank IMAP listener now. One moment...' },
                  { label: 'Payment confirmed', text: 'Payment confirmed! Your transaction has been verified and settled.' },
                ].map((chip) => (
                  <button
                    key={chip.label}
                    className="btn ghost sm"
                    onClick={() => handleSendAdminMessage(chip.text)}
                    style={{ fontSize: 11, padding: '2px 8px', height: 26, whiteSpace: 'nowrap' }}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>

              {/* Input */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSendAdminMessage();
                }}
                style={{ display: 'flex', gap: 6 }}
              >
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Reply to customer..."
                  style={{ flex: 1, height: 34, padding: '0 10px', fontSize: 12 }}
                />
                <button
                  type="submit"
                  disabled={sendingMsg || !chatInput.trim()}
                  style={{
                    height: 34,
                    padding: '0 12px',
                    borderRadius: 6,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: chatInput.trim() ? '#E9E6DF' : 'var(--raised)',
                    color: chatInput.trim() ? '#0A0A0B' : 'var(--muted)',
                    border: chatInput.trim() ? '1px solid #E9E6DF' : '1px solid var(--border)',
                    cursor: chatInput.trim() ? 'pointer' : 'not-allowed',
                    opacity: chatInput.trim() ? 1 : 0.40,
                    fontWeight: 600,
                    transition: 'all 0.15s ease',
                  }}
                >
                  <Send size={13} />
                </button>
              </form>
            </div>
          )}

          {/* TAB 2: REVIEW INFO & MISMATCH WARNING */}
          {panelTab === 'info' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* UTR Mismatch Alert */}
              {hasUtrMismatch && (
                <div
                  className="motion-warn-banner"
                  style={{
                    color: 'var(--bad)',
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <AlertTriangle size={15} /> UTR Mismatch Detected
                  </div>
                  <div>
                    Customer reported: <strong className="mono">{autoExtractedUtr}</strong>
                  </div>
                  <div>
                    Email shows: <strong className="mono">{candidateEmail?.utr}</strong>
                  </div>
                </div>
              )}

              {/* Candidate Unmatched Email */}
              <div style={{ background: 'var(--raised)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 6 }}>
                  Matching Slice Email Receipt
                </div>
                {candidateEmail ? (
                  <div style={{ fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ color: 'var(--muted)' }}>Sender:</span>
                      <span style={{ color: 'var(--bone)', fontWeight: 500 }}>{candidateEmail.sender}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ color: 'var(--muted)' }}>Email UTR:</span>
                      <span className="mono" style={{ color: 'var(--bone)' }}>{candidateEmail.utr}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--muted)' }}>Received:</span>
                      <span className="mono" style={{ color: 'var(--muted)', fontSize: 11 }}>{candidateEmail.time}</span>
                    </div>
                  </div>
                ) : (
                  <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                    No unmatched email found matching exact amount {inr(sel?.amount)}.
                  </div>
                )}
              </div>

              {/* Extracted Reported UTR */}
              <div style={{ background: 'var(--raised)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 6 }}>
                  Customer Extracted UTR
                </div>
                <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: autoExtractedUtr ? 'var(--bone)' : 'var(--muted)' }}>
                  {autoExtractedUtr || 'No 12-digit UTR found in chat yet'}
                </div>
              </div>
            </div>
          )}
        </Drawer>
      </div>

      {/* Approve & Match UTR Modal */}
      {showApproveModal && sel && (
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
          onClick={() => setShowApproveModal(false)}
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
                Approve &amp; Match UTR
              </div>
              <button onClick={() => setShowApproveModal(false)} className="btn ghost sm" style={{ padding: 4 }}>
                <X size={15} />
              </button>
            </div>

            <form onSubmit={handleApproveAndMatch} style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {approveErr && (
                <div style={{ background: 'var(--bad-bg)', border: '1px solid var(--bad-border)', color: 'var(--bad)', padding: '8px 12px', borderRadius: 8, fontSize: 12 }}>
                  {approveErr}
                </div>
              )}

              {hasUtrMismatch && (
                <div className="motion-warn-banner" style={{ fontSize: 12, color: 'var(--bad)' }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>UTR mismatch: check before approving</div>
                  <div>Customer reported: <span className="mono">{autoExtractedUtr}</span></div>
                  <div>Slice email shows: <span className="mono">{candidateEmail?.utr}</span></div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, cursor: 'pointer', color: 'var(--bone)' }}>
                    <input
                      type="checkbox"
                      checked={confirmMismatch}
                      onChange={(e) => setConfirmMismatch(e.target.checked)}
                    />
                    <span>I have manually verified and confirm this override</span>
                  </label>
                </div>
              )}

              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>
                  12-Digit UPI UTR / RRN Number
                </label>
                <input
                  type="text"
                  maxLength={12}
                  value={approveUtr}
                  onChange={(e) => setApproveUtr(e.target.value.replace(/\D/g, ''))}
                  placeholder="e.g. 429381920491"
                  required
                  style={{ width: '100%', height: 38, padding: '0 12px', fontSize: 13, fontFamily: 'var(--font-mono)' }}
                />
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                  Must be exactly 12 numeric digits from Slice Bank confirmation.
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>
                  Admin Verification Notes
                </label>
                <input
                  type="text"
                  value={approveNotes}
                  onChange={(e) => setApproveNotes(e.target.value)}
                  placeholder="e.g. Matched after customer chat review"
                  style={{ width: '100%', height: 38, padding: '0 12px', fontSize: 13 }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setShowApproveModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={approving || !/^\d{12}$/.test(approveUtr) || (hasUtrMismatch && !confirmMismatch)}
                  className="btn primary"
                >
                  {approving ? 'Verifying...' : 'Approve & Settle Payment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
