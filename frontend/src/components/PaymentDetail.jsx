import { useState } from 'react';
import { X, Mail, RotateCcw, Copy, ExternalLink, Check } from 'lucide-react';
import { Badge, KV, Timeline } from './ui.jsx';
import { inr } from '../data.js';

export default function PaymentDetail({ item, title = 'Details', onClose = () => {}, orderMode = false }) {
  const [copied, setCopied] = useState(false);
  if (!item) return null;
  const done = item.status === 'Success';

  const handleCopy = () => {
    navigator.clipboard?.writeText(item.paymentId || item.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <aside className="detail" style={{ width: 340, display: 'flex', flexDirection: 'column' }}>
      <div className="detail-head">
        <div className="detail-title">{title}</div>
        <button className="link" onClick={onClose} style={{ padding: 4, cursor: 'pointer' }}>
          <X size={14} />
        </button>
      </div>
      <div className="detail-id" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="mono">{item.id}</span>
          <button className="link" onClick={handleCopy} title="Copy ID" style={{ padding: 2, cursor: 'pointer' }}>
            {copied ? <Check size={12} color="#22c55e" /> : <Copy size={12} />}
          </button>
        </div>
        <Badge>{item.status}</Badge>
      </div>
      <div className="detail-amount">{inr(item.amount)}</div>

      {orderMode && (
        <>
          <div className="section-label">Customer</div>
          <KV k="Name" v={item.customer} />
          <KV k="Payment ID" v={<span className="mono">{item.paymentId}</span>} />
        </>
      )}
      <KV k="Order ID" v={<span className="mono">{item.orderId}</span>} />
      <KV k="UTR" v={<span className="mono" style={{ color: item.utr && item.utr !== '—' ? '#38bdf8' : 'inherit' }}>{item.utr}</span>} />
      <KV k="Source" v={item.source} />
      <KV k="Customer" v={item.customer} />
      <KV k="Received" v={item.time} />
      <KV k="Confirmation" v={item.confirmed || '—'} />

      <div className="section-label">Timeline</div>
      <Timeline items={[
        { text: 'Order created', sub: item.time },
        { text: 'Payment email received', sub: item.time, off: !done },
        { text: 'Matched with order', sub: done ? 'Auto-matched' : 'Waiting', off: !done },
        { text: 'Payment confirmed', sub: done ? `in ${item.confirmed}` : 'Pending', off: !done },
      ]} />

      <div className="section-label">Email Preview</div>
      <div className="email-preview">
        <div style={{ fontWeight: 600 }}>Received {inr(item.amount)} in your slice account</div>
        <div className="muted" style={{ fontSize: 10, margin: '3px 0 6px' }}>noreply@sliceit.com</div>
        <div className="muted">Hi, you've received {inr(item.amount)} from {item.customer}. UTR {item.utr}.</div>
      </div>

      <div className="actions">
        <button
          className="btn primary block"
          onClick={() => window.open(`/pay/${item.paymentId || item.id}`, '_blank')}
        >
          <ExternalLink size={16} /> Open Pay Page
        </button>
      </div>
    </aside>
  );
}
