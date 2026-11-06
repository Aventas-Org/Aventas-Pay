// AventasPay - Core Constants and Formatter Utilities
// Monochrome-first status map per design tokens specification

export const payments = [];
export const orders = [];
export const emails = [];
export const reviews = [];
export const refunds = [];
export const revenueSeries = [];
export const liveActivity = [];

export const systemStatus = [
  { name: 'Email Listener', val: 'Online (Every 5s)' },
  { name: 'Payment Parser', val: 'Online (Slice Bank)' },
  { name: 'Webhook Service', val: 'Online' },
  { name: 'Database', val: 'Healthy (Persistent)' },
];

export const spark = () => Array.from({ length: 12 }, () => ({ v: 0 }));

export const inr = (n) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Single authoritative status function (Rule 3)
 * Returns exactly one of: 'success' | 'pending' | 'review' | 'failed' | 'expired'
 */
export function statusBucket(item, now = new Date()) {
  if (!item) return 'pending';
  // If backend already provided pre-computed bucket
  if (item.statusBucket) return item.statusBucket;

  const raw = String(item.status || '').trim().toUpperCase();

  // 1. Success
  if (
    raw === 'SUCCESS' ||
    raw === 'PAID' ||
    raw === 'VERIFIED' ||
    raw === 'MATCHED' ||
    raw === 'CONFIRMED' ||
    raw === 'RESOLVED'
  ) {
    return 'success';
  }

  // 2. Review
  if (
    raw === 'REVIEW' ||
    raw === 'MANUAL_REVIEW' ||
    raw === 'UNMATCHED' ||
    raw === 'LATE' ||
    raw === 'FLAGGED'
  ) {
    return 'review';
  }

  // 3. Expired
  if (raw === 'EXPIRED') {
    return 'expired';
  }

  // 4. Failed
  if (
    raw === 'FAILED' ||
    raw === 'CANCELLED' ||
    raw === 'CANCELED' ||
    raw === 'REJECTED' ||
    raw === 'DUPLICATE'
  ) {
    return 'failed';
  }

  // 5. Pending / Check Expiry
  if (raw === 'PENDING' || raw === 'NEW' || !raw) {
    if (item.expiresAt) {
      const expDate = new Date(item.expiresAt);
      if (!isNaN(expDate.getTime()) && expDate.getTime() <= now.getTime()) {
        return 'expired';
      }
    }
    return 'pending';
  }

  return 'pending';
}

/**
 * One place that turns any list of orders/payments into bucket counts, so the
 * Dashboard, Orders and Analytics pages can never disagree.
 * closed = expired + failed (shown as "Expired / Failed").
 */
export function bucketCounts(list = [], now = new Date()) {
  const c = { success: 0, pending: 0, review: 0, failed: 0, expired: 0 };
  const arr = Array.isArray(list) ? list : [];
  for (const o of arr) c[statusBucket(o, now)] += 1;
  return { ...c, closed: c.failed + c.expired, total: arr.length };
}

// Status map per design tokens (Rule 3):
// success=ok, pending=warn, review=accent, failed/expired=bad
export const statusTone = {
  success: 'status-ok',
  pending: 'status-warn',
  review: 'status-review',
  failed: 'status-bad',
  expired: 'status-bad',
  Success: 'status-ok',
  Paid: 'status-ok',
  VERIFIED: 'status-ok',
  Matched: 'status-ok',
  Confirmed: 'status-ok',
  Resolved: 'status-ok',
  Pending: 'status-warn',
  Unmatched: 'status-warn',
  NEW: 'status-warn',
  Review: 'status-review',
  Failed: 'status-bad',
  Expired: 'status-bad',
  Cancelled: 'status-muted',
  Duplicate: 'status-muted',
  DUPLICATE: 'status-muted',
  High: 'status-bad',
  Medium: 'status-warn',
  Low: 'status-review',
};

// Backwards compatibility alias for older statusColor
export const statusColor = {
  ...statusTone,
  'c-green': 'status-ok',
  'c-yellow': 'status-warn',
  'c-blue': 'status-review',
  'c-red': 'status-bad',
  'c-gray': 'status-muted',
  'c-orange': 'status-review',
  'c-purple': 'status-muted',
};


export function isWithinDateRange(timestamp, range = '7D', customStart = '', customEnd = '') {
  if (!timestamp || timestamp === '—') return true;
  let str = String(timestamp).trim();
  // Fallback: If formatted date string has no 4-digit year, inject current year to avoid 2001 default
  if (!/\b\d{4}\b/.test(str)) {
    const currentYear = new Date().getFullYear();
    str = `${str}, ${currentYear}`;
  }
  const d = new Date(str);
  if (isNaN(d.getTime())) return true;
  const now = new Date();

  if (range === 'Today') {
    // Compare date boundary in Asia/Kolkata (UTC+05:30)
    const dKolkata = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const nowKolkata = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    return dKolkata === nowKolkata;
  }
  if (range === '7D') {
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return d >= sevenDaysAgo;
  }
  if (range === '30D') {
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return d >= thirtyDaysAgo;
  }
  if (range === 'Custom' && customStart) {
    const start = new Date(customStart + 'T00:00:00+05:30');
    const end = customEnd ? new Date(customEnd + 'T23:59:59+05:30') : now;
    return d >= start && d <= end;
  }
  return true;
}
