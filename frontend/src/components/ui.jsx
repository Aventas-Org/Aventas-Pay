import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { Search, Calendar, ChevronLeft, ChevronRight, Copy, Check, Inbox, AlertTriangle } from 'lucide-react';
import { statusTone, statusBucket, inr } from '../data.js';
import { countUp, updateSegmentedPill } from '../motion.js';

// ============================================================================
// Toast Notification Context & Hook (Rule A23)
// ============================================================================
const ToastContext = createContext({
  showToast: () => {},
});

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const showToast = (message, type = 'ok') => {
    const id = Date.now() + Math.random().toString(36).substring(2, 5);
    setToasts((prev) => {
      // Stack max 3 toasts
      const next = [...prev, { id, message, type }];
      if (next.length > 3) return next.slice(-3);
      return next;
    });

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  const removeToast = (id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div id="motionToastContainer">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`motion-toast toast-${t.type}`}
            onClick={() => removeToast(t.id)}
            title="Click to dismiss"
          >
            {t.type === 'ok' ? (
              <Check size={15} color="var(--ok)" style={{ flexShrink: 0 }} />
            ) : t.type === 'bad' ? (
              <AlertTriangle size={15} color="var(--bad)" style={{ flexShrink: 0 }} />
            ) : (
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
            )}
            <span style={{ flex: 1, minWidth: 0 }}>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

// ============================================================================
// Status Pill / Badge (Rule 3 & Rule A12)
// Pending dots pulse with 1.8s loop; success dots are static.
// ============================================================================
export function Badge({ children, tone, className = '' }) {
  const bucket = statusBucket({ status: children });
  const toneClass = tone || statusTone[bucket] || statusTone[children] || 'status-muted';
  const shouldPulse = bucket === 'pending' || children === 'Pending' || children === 'NEW';

  return (
    <span className={`badge ${toneClass} ${className}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className={`motion-pulse-dot ${shouldPulse ? 'pulse' : ''}`} style={{ flexShrink: 0 }} />
      <span>{children}</span>
    </span>
  );
}

// ============================================================================
// Date Range Context & Hook
// ============================================================================
const DateRangeContext = createContext({
  dateRange: '7D',
  setDateRange: () => {},
  customStart: '',
  setCustomStart: () => {},
  customEnd: '',
  setCustomEnd: () => {},
});

export function DateRangeProvider({ children }) {
  const [dateRange, setDateRange] = useState('7D');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  return (
    <DateRangeContext.Provider
      value={{
        dateRange,
        setDateRange,
        customStart,
        setCustomStart,
        customEnd,
        setCustomEnd,
      }}
    >
      {children}
    </DateRangeContext.Provider>
  );
}

export function useDateRange() {
  return useContext(DateRangeContext);
}

// ============================================================================
// StatCard (Rule A3: Card spotlight & Rule A8: Count-up & Live Flash)
// ============================================================================
export function StatCard({
  icon: Icon,
  label,
  value,
  foot,
  footDot,
  down,
  isUp,
  className = '',
  numericValue,
  decimals = 0,
  prefix = '',
  suffix = '',
}) {
  const dotColor = down ? 'var(--bad)' : isUp ? 'var(--ok)' : footDot || null;
  const numRef = useRef(null);
  const prevValRef = useRef(null);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (typeof numericValue === 'number' && numRef.current) {
      countUp(numRef.current, numericValue, { decimals, prefix, suffix });
      if (prevValRef.current !== null && prevValRef.current !== numericValue) {
        setFlash(true);
        const t = setTimeout(() => setFlash(false), 600);
        return () => clearTimeout(t);
      }
      prevValRef.current = numericValue;
    }
  }, [numericValue, decimals, prefix, suffix]);

  return (
    <div className={`card stat motion-card-spotlight ${className}`}>
      <div className="stat-icon">
        {Icon ? <Icon size={17} strokeWidth={1.5} /> : null}
      </div>
      <div className="stat-body">
        <div className="stat-label">{label}</div>
        <div className={`stat-value motion-num ${flash ? 'motion-vflash' : ''}`}>
          {typeof numericValue === 'number' ? (
            <span ref={numRef}>
              {prefix}
              {numericValue.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
              {suffix}
            </span>
          ) : (
            value
          )}
        </div>
        {foot && (
          <div
            className="stat-foot"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              color: 'var(--muted)',
              fontSize: 11,
              marginTop: 4,
            }}
          >
            {dotColor && (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: dotColor,
                  flexShrink: 0,
                  display: 'inline-block',
                }}
              />
            )}
            <span>{foot}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Page Head & TopBar with Working Date Range Controls
// ============================================================================
export function PageHead({ title, desc, children }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {desc && <p className="page-desc">{desc}</p>}
      </div>
      {children && <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{children}</div>}
    </div>
  );
}

export function TopBar({ placeholder = 'Search by Order ID, Payment ID, UTR...', onSearch }) {
  const { dateRange, setDateRange, customStart, setCustomStart, customEnd, setCustomEnd } = useDateRange();
  const [showCustomModal, setShowCustomModal] = useState(false);

  const ranges = ['Today', '7D', '30D', 'Custom'];

  const handleSelectRange = (r) => {
    setDateRange(r);
    if (r === 'Custom') {
      setShowCustomModal(true);
    }
  };

  return (
    <header className="topbar">
      <div className="search">
        <Search size={15} strokeWidth={1.5} />
        <input placeholder={placeholder} onChange={(e) => onSearch?.(e.target.value)} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Working Date Range Selector */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 2,
            gap: 2,
          }}
        >
          {ranges.map((r) => {
            const active = dateRange === r;
            return (
              <button
                key={r}
                type="button"
                onClick={() => handleSelectRange(r)}
                style={{
                  padding: '4px 10px',
                  borderRadius: 6,
                  fontSize: 11.5,
                  fontFamily: 'var(--font-mono)',
                  fontWeight: active ? 600 : 500,
                  color: active ? 'var(--bone)' : 'var(--muted)',
                  background: active ? 'var(--raised)' : 'transparent',
                  border: active ? '1px solid var(--border)' : '1px solid transparent',
                  transition: 'all 0.15s ease',
                  cursor: 'pointer',
                }}
              >
                {r}
              </button>
            );
          })}
        </div>

        {/* Custom Date Modal / Popover */}
        {showCustomModal && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.6)',
              backdropFilter: 'blur(3px)',
              display: 'grid',
              placeItems: 'center',
              zIndex: 9999,
            }}
            onClick={() => setShowCustomModal(false)}
          >
            <div
              className="card"
              style={{ width: 340, padding: 20 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="card-title" style={{ marginBottom: 12 }}>Select Custom Date Range</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <div className="form-label">Start Date</div>
                  <input
                    type="date"
                    value={customStart}
                    onChange={(e) => setCustomStart(e.target.value)}
                    style={{ width: '100%', padding: '6px 10px' }}
                  />
                </div>
                <div>
                  <div className="form-label">End Date</div>
                  <input
                    type="date"
                    value={customEnd}
                    onChange={(e) => setCustomEnd(e.target.value)}
                    style={{ width: '100%', padding: '6px 10px' }}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                  <button className="btn ghost sm" onClick={() => setShowCustomModal(false)}>
                    Close
                  </button>
                  <button className="btn primary sm" onClick={() => setShowCustomModal(false)}>
                    Apply Range
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

// ============================================================================
// Tabs / Segmented Controls (Rule A13: Sliding pill indicator element)
// ============================================================================
export function Tabs({ tabs, value, onChange, className = '' }) {
  const containerRef = useRef(null);
  const pillRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !pillRef.current) return;
    const activeBtn = containerRef.current.querySelector('button.active');
    if (activeBtn) {
      updateSegmentedPill(containerRef.current, activeBtn, pillRef.current);
    }
  }, [value, tabs]);

  return (
    <div
      ref={containerRef}
      className={`motion-seg-wrap ${className}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 3,
        position: 'relative',
      }}
    >
      <div
        ref={pillRef}
        className="motion-seg-pill"
        style={{
          position: 'absolute',
          top: 3,
          bottom: 3,
          left: 0,
          borderRadius: 6,
          background: 'var(--raised)',
          boxShadow: '0 0 0 1px var(--border)',
          transition: 'transform 0.25s var(--ease-out), width 0.25s var(--ease-out)',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      {tabs.map((t) => {
        const active = value === t.key;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={`motion-seg-btn ${active ? 'active' : ''}`}
            style={{
              position: 'relative',
              zIndex: 1,
              padding: '6px 14px',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: active ? 600 : 500,
              color: active ? 'var(--bone)' : 'var(--muted)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span>{t.label}</span>
            {t.count != null && (
              <span
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  padding: '1px 5px',
                  borderRadius: 4,
                  background: active ? 'var(--border)' : 'var(--raised)',
                  color: 'var(--muted)',
                }}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ============================================================================
// Click to Copy Component
// ============================================================================
export function Copyable({ text, display, children, label = 'Copied to clipboard' }) {
  const [copied, setCopied] = useState(false);
  const { showToast } = useToast();

  const handleCopy = (e) => {
    e.stopPropagation();
    if (!text) return;
    navigator.clipboard?.writeText(text);
    setCopied(true);
    showToast(label);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <span
      className="copyable mono"
      onClick={handleCopy}
      title="Click to copy"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
    >
      <span>{display || children || text}</span>
      {copied ? <Check size={12} color="var(--ok)" /> : <Copy size={12} className="copy-icon" />}
    </span>
  );
}

// ============================================================================
// Skeleton Loader Placeholder
// ============================================================================
export function Skeleton({ width = '100%', height = 20, style = {}, className = '' }) {
  return (
    <div
      className={`skeleton ${className}`}
      style={{ width, height, ...style }}
    />
  );
}

// ============================================================================
// Empty State Component
// ============================================================================
export function EmptyState({ icon: Icon = Inbox, title = 'No records found', description, action }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={22} strokeWidth={1.5} />
      </div>
      <div className="empty-title">{title}</div>
      {description && <div className="empty-desc">{description}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

// Backwards-compatible Empty alias
export function Empty({ text = 'No results' }) {
  return <EmptyState title={text} />;
}

// ============================================================================
// Pagination Helpers
// ============================================================================
export function usePaged(rows, size = 12) {
  const [page, setPage] = useState(1);
  const safeRows = Array.isArray(rows) ? rows : [];
  const pages = Math.max(1, Math.ceil(safeRows.length / size));
  const p = Math.min(page, pages);
  const slice = safeRows.slice((p - 1) * size, p * size);
  return { page: p, pages, slice, items: slice, setPage, total: safeRows.length, size };
}

export function Pager(props) {
  const paged = props.paged || props;
  const { page = 1, pages = 1, setPage = () => {}, total = 0, size = 12 } = paged;
  const label = props.label || 'records';
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(page * size, total);
  const nums = Array.from({ length: Math.min(pages, 5) }, (_, i) => i + 1);

  if (total <= size) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        borderTop: '1px solid var(--border)',
        fontSize: 12,
        color: 'var(--muted)',
      }}
    >
      <span className="mono">
        Showing {from}–{to} of {total} {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button
          className="btn ghost sm"
          disabled={page <= 1}
          onClick={() => setPage(Math.max(1, page - 1))}
          style={{ width: 28, height: 28, padding: 0 }}
        >
          <ChevronLeft size={14} />
        </button>
        {nums.map((n) => (
          <button
            key={n}
            onClick={() => setPage(n)}
            className="mono"
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              fontSize: 12,
              fontWeight: n === page ? 700 : 500,
              background: n === page ? 'var(--bone)' : 'transparent',
              color: n === page ? 'var(--bg)' : 'var(--muted)',
              border: n === page ? '1px solid var(--bone)' : '1px solid transparent',
            }}
          >
            {n}
          </button>
        ))}
        <button
          className="btn ghost sm"
          disabled={page >= pages}
          onClick={() => setPage(Math.min(pages, page + 1))}
          style={{ width: 28, height: 28, padding: 0 }}
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

// Label-Value row
export function KV({ k, v, mono = false }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 0',
        borderBottom: '1px solid var(--border-subtle)',
        fontSize: 12,
      }}
    >
      <span style={{ color: 'var(--muted)' }}>{k}</span>
      <span className={mono ? 'mono' : ''} style={{ color: 'var(--bone)', fontWeight: 500 }}>
        {v}
      </span>
    </div>
  );
}

// ============================================================================
// Rule A9: Daily Settled Revenue Bar Chart (from aventaspay-motion-demo.html)
// ============================================================================
// 1-2-2.5-5 "nice" axis maximum so ticks read cleanly for any scale (₹1 up to ₹10L)
function niceAxis(maxVal) {
  const rough = Math.max(maxVal, 0.01) / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { step, max: step * 4 };
}

function fmtAxisInr(v, step) {
  if (v === 0) return '₹0';
  if (v >= 1e7) return `₹${+(v / 1e7).toFixed(2)}Cr`;
  if (v >= 1e5) return `₹${+(v / 1e5).toFixed(2)}L`;
  if (v >= 1e4) return `₹${+(v / 1e3).toFixed(1)}k`;
  const dp = step < 1 ? 2 : step < 10 && v % 1 !== 0 ? 1 : 0;
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

export function MotionBarChart({
  data = [],
  height = 210,
  highlightLast = true,
  emptyMessage = 'No payment volume recorded for this period.',
}) {
  const [grown, setGrown] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState(null);
  const count = data ? data.length : 0;

  // Bars grow from the baseline whenever a new set of bars arrives (first load or a
  // range change that alters the bar count); same-count updates just morph in place.
  useEffect(() => {
    if (count === 0) return undefined;
    setGrown(false);
    let id2;
    const id1 = requestAnimationFrame(() => {
      id2 = requestAnimationFrame(() => setGrown(true));
    });
    return () => {
      cancelAnimationFrame(id1);
      if (id2) cancelAnimationFrame(id2);
    };
  }, [count]);

  if (!data || count === 0) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height, color: 'var(--muted)', fontSize: 13 }}>
        {emptyMessage}
      </div>
    );
  }

  const maxVal = Math.max(...data.map((d) => d.revenue || 0), 0);
  const { step, max: niceMax } = niceAxis(maxVal);
  const yTicks = [0, 1, 2, 3, 4];
  const gap = count > 45 ? 1 : count > 20 ? 3 : count > 12 ? 6 : 12;
  const labelEvery = Math.ceil(count / 8);
  const stagger = Math.min(65, 900 / count);

  return (
    <div className="motion-chart" style={{ position: 'relative', height, marginTop: 12, paddingLeft: 50 }}>
      <div style={{ position: 'absolute', left: 50, right: 0, top: 0, bottom: 26 }}>
        {/* Y Axis grid lines */}
        {yTicks.map((k) => (
          <div
            key={k}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `${100 - k * 25}%`,
              borderTop: '1px dashed #222226',
            }}
          >
            <span
              className="mono"
              style={{ position: 'absolute', left: -50, top: -7, fontSize: 10, color: 'var(--muted)' }}
            >
              {fmtAxisInr(step * k, step)}
            </span>
          </div>
        ))}

        {/* Bars Container */}
        <div style={{ position: 'absolute', inset: 0, display: 'flex', gap, alignItems: 'flex-end' }}>
          {data.map((item, i) => {
            const rev = item.revenue || 0;
            const h = (rev / niceMax) * 100;
            const isLast = highlightLast && i === count - 1;
            const isHovered = hoveredIdx === i;
            const showLabel = i % labelEvery === 0 || i === count - 1;

            return (
              <div
                key={i}
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
                style={{
                  position: 'relative',
                  flex: 1,
                  minWidth: 0,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'flex-end',
                  cursor: 'pointer',
                }}
              >
                {/* Interactive Tooltip */}
                <div
                  style={{
                    position: 'absolute',
                    bottom: `calc(${Math.max(h, 2)}% + 10px)`,
                    left: i < 2 ? 0 : i > count - 3 ? 'auto' : '50%',
                    right: i > count - 3 ? 0 : 'auto',
                    transform:
                      i < 2 || i > count - 3
                        ? isHovered ? 'translateY(0)' : 'translateY(6px)'
                        : isHovered ? 'translate(-50%, 0)' : 'translate(-50%, 6px)',
                    background: 'var(--raised)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: '6px 10px',
                    whiteSpace: 'nowrap',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    lineHeight: 1.4,
                    opacity: isHovered ? 1 : 0,
                    pointerEvents: 'none',
                    transition: 'opacity 0.2s, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)',
                    zIndex: 20,
                    textAlign: 'center',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                  }}
                >
                  <div style={{ color: 'var(--muted)', fontSize: 10 }}>{item.d}</div>
                  <div style={{ color: 'var(--bone)', fontWeight: 600 }}>
                    ₹{Number(rev).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: 10 }}>
                    {item.payments || 0} {item.payments === 1 ? 'payment' : 'payments'}
                  </div>
                </div>

                {/* Staggered Animated Bar */}
                <i
                  style={{
                    display: 'block',
                    width: '100%',
                    maxWidth: 56,
                    margin: '0 auto',
                    borderRadius: count > 45 ? '2px 2px 0 0' : '6px 6px 0 0',
                    background: isLast ? 'var(--bone)' : 'var(--accent)',
                    height: grown ? (rev > 0 ? `${Math.max(h, 2)}%` : '0%') : '0%',
                    opacity: isLast || isHovered ? 1 : 0.85,
                    filter: isHovered ? 'brightness(1.15)' : 'none',
                    transform: isHovered ? 'scaleX(1.06)' : 'none',
                    transition: `height 0.9s cubic-bezier(0.22, 1, 0.36, 1) ${i * stagger}ms, filter 0.2s, opacity 0.2s, transform 0.25s`,
                  }}
                />

                {/* X Axis Label (thinned out when there are many bars) */}
                {showLabel && (
                  <span
                    className="mono"
                    style={{
                      position: 'absolute',
                      left: '50%',
                      transform: 'translateX(-50%)',
                      bottom: -22,
                      textAlign: 'center',
                      fontSize: 10,
                      color: isHovered ? 'var(--bone)' : 'var(--muted)',
                      whiteSpace: 'nowrap',
                      transition: 'color 0.2s',
                    }}
                  >
                    {item.d}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Rule A10: Donut Chart with drawing arc transitions & center label below number
// ============================================================================
export function MotionDonutChart({ items = [], total = 0, size = 160 }) {
  const r = 62;
  const C = 2 * Math.PI * r;
  const gap = 5;

  let cum = 0;
  const computedArcs = items.map((item) => {
    const val = item.value || 0;
    const f = total > 0 ? val / total : 0;
    const len = Math.max(0, f * C - (val ? gap : 0));
    const offset = -(cum * C + gap / 2);
    cum += f;
    return {
      name: item.name,
      color: item.color,
      value: val,
      dashArray: `${len} ${C - len}`,
      dashOffset: offset,
    };
  });

  return (
    <div style={{ position: 'relative', width: size, height: size, margin: '14px auto 10px' }}>
      <svg
        viewBox="0 0 160 160"
        style={{
          width: '100%',
          height: '100%',
          transform: 'rotate(-90deg)',
          overflow: 'visible',
        }}
      >
        {computedArcs.map((arc) => (
          <circle
            key={arc.name}
            cx="80"
            cy="80"
            r={r}
            stroke={arc.color}
            strokeWidth="12"
            fill="none"
            strokeDasharray={arc.dashArray}
            strokeDashoffset={arc.dashOffset}
            style={{
              transition: 'stroke-dasharray 1.1s cubic-bezier(0.22, 1, 0.36, 1), stroke-dashoffset 1.1s cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          />
        ))}
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          pointerEvents: 'none',
        }}
      >
        <b className="mono" style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: 'var(--bone)' }}>
          {total}
        </b>
        <span
          style={{
            fontSize: 10,
            letterSpacing: '0.14em',
            color: 'var(--muted)',
            marginTop: 4,
            fontWeight: 700,
            fontFamily: 'var(--font-brand)',
          }}
        >
          TOTAL
        </span>
      </div>
    </div>
  );
}
