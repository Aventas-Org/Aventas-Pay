import React, { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { X, Copy, Check, ExternalLink } from 'lucide-react';
import { Badge, Copyable } from './ui.jsx';
import { inr, statusBucket } from '../data.js';

export default function Drawer({
  open,
  onClose,
  type = 'Item',
  id,
  status,
  amount,
  sections = [],
  timeline = [],
  emailPreview,
  actions,
  children,
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const drawerRef = useRef(null);

  // 1. ESC Key listener & Focus Trap (Rule A15)
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      // Focus trap
      if (e.key === 'Tab' && drawerRef.current) {
        const focusables = drawerRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          last.focus();
          e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === last) {
          first.focus();
          e.preventDefault();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    // Initial focus on close button
    const t = setTimeout(() => {
      const closeBtn = drawerRef.current?.querySelector('button[title*="Close"]');
      closeBtn?.focus();
    }, 50);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(t);
    };
  }, [open, onClose]);

  // 2. URL Sync (?selected=...)
  useEffect(() => {
    if (open && id) {
      if (searchParams.get('selected') !== id) {
        const next = new URLSearchParams(searchParams);
        next.set('selected', id);
        setSearchParams(next, { replace: true });
      }
    } else if (!open && searchParams.has('selected')) {
      const next = new URLSearchParams(searchParams);
      next.delete('selected');
      setSearchParams(next, { replace: true });
    }
  }, [open, id, searchParams, setSearchParams]);

  if (!open) return null;

  return (
    <>
      {/* Scrim Overlay with Blur (Rule A15) */}
      <div className={`drawer-scrim motion-scrim ${open ? 'open' : ''}`} onClick={onClose} />

      {/* Drawer Container (Rule A15) */}
      <aside ref={drawerRef} className={`drawer motion-drawer ${open ? 'open' : ''}`} role="dialog" aria-modal="true">
        {/* Header: consistent title pattern "<Type> details", ID in mono with copy icon, status pill, close button */}
        <div className="drawer-header">
          <div>
            <div className="drawer-title">{type} details</div>
            {id && (
              <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Copyable text={id} label={`${type} ID copied`} />
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {status && <Badge>{status}</Badge>}
            <button
              onClick={onClose}
              className="btn ghost sm"
              style={{ width: 28, height: 28, padding: 0, color: 'var(--muted)' }}
              title="Close (Esc)"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="drawer-body">
          {/* Prominent Amount Header if present */}
          {amount != null && (
            <div
              style={{
                background: 'var(--raised)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '14px 16px',
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Total Amount
              </span>
              <span className="mono" style={{ fontSize: 20, fontWeight: 700, color: 'var(--bone)' }}>
                {inr(amount)}
              </span>
            </div>
          )}

          {/* Custom Children (e.g. chat stream in Manual Review) */}
          {children}

          {/* Sections with Label/Value Rows */}
          {sections.map((sec, idx) => (
            <div key={idx}>
              {sec.label && (
                <div
                  style={{
                    fontSize: 10.5,
                    fontFamily: 'var(--font-brand)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    color: 'var(--muted)',
                    marginBottom: 8,
                  }}
                >
                  {sec.label}
                </div>
              )}
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '4px 12px' }}>
                {sec.items.map((row, rIdx) => (
                  <div
                    key={rIdx}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 0',
                      borderBottom: rIdx === sec.items.length - 1 ? 'none' : '1px solid var(--border-subtle)',
                      fontSize: 12,
                    }}
                  >
                    <span style={{ color: 'var(--muted)' }}>{row.k}</span>
                    <span style={{ color: 'var(--bone)', fontWeight: 500 }}>
                      {row.copyable ? (
                        <Copyable text={row.v} />
                      ) : row.mono ? (
                        <span className="mono">{row.v}</span>
                      ) : (
                        row.v
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Connected Timeline (Rule A16: sequential step-by-step fill) */}
          {timeline.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: 10.5,
                  fontFamily: 'var(--font-brand)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  color: 'var(--muted)',
                  marginBottom: 12,
                }}
              >
                Timeline
              </div>
              <div className="timeline-stepper">
                {timeline.map((step, sIdx) => {
                  const isDone = step.completed !== false;
                  const isCur = step.pending === true;
                  return (
                    <div
                      key={sIdx}
                      className={`timeline-step motion-tl-step ${isDone ? 'done' : isCur ? 'cur' : ''}`}
                      style={{ '--step-delay': `${0.35 + sIdx * 0.12}s` }}
                    >
                      <div className="timeline-dot motion-tl-dot">
                        {isDone ? <Check size={11} strokeWidth={2.5} /> : null}
                      </div>
                      <div>
                        <div className="timeline-step-title" style={{ fontWeight: 600, fontSize: 13 }}>
                          {step.text}
                        </div>
                        {step.sub && (
                          <div className="timeline-step-time mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                            {step.sub}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Mono Email Preview in Raised Surface */}
          {emailPreview && (
            <div>
              <div
                style={{
                  fontSize: 10.5,
                  fontFamily: 'var(--font-brand)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  color: 'var(--muted)',
                  marginBottom: 8,
                }}
              >
                Email Preview
              </div>
              <div className="email-preview-mono">
                {emailPreview.title && (
                  <div style={{ fontWeight: 600, color: 'var(--bone)', marginBottom: 6 }}>
                    {emailPreview.title}
                  </div>
                )}
                <div>{emailPreview.body || emailPreview.raw}</div>
              </div>
            </div>
          )}
        </div>

        {/* Sticky Action Footer */}
        {actions && <div className="drawer-footer">{actions}</div>}
      </aside>
    </>
  );
}
