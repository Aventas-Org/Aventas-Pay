// AventasPay - Unified Status Bucket Function
// Single authoritative status function returning exactly one of:
// 'success' | 'pending' | 'review' | 'failed' | 'expired'

export type StatusBucket = 'success' | 'pending' | 'review' | 'failed' | 'expired';

export function status_bucket(
  item: {
    status?: string | null;
    expiresAt?: Date | string | null;
    paidAt?: Date | string | null;
    rrn?: string | null;
  } | null | undefined,
  now: Date = new Date()
): StatusBucket {
  if (!item) return 'pending';

  const raw = String(item.status || '').trim().toUpperCase();

  // 1. Definite Success
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

  // 2. Definite Review
  if (
    raw === 'REVIEW' ||
    raw === 'MANUAL_REVIEW' ||
    raw === 'UNMATCHED' ||
    raw === 'LATE' ||
    raw === 'FLAGGED'
  ) {
    return 'review';
  }

  // 3. Definite Expired
  if (raw === 'EXPIRED') {
    return 'expired';
  }

  // 4. Definite Failed
  if (
    raw === 'FAILED' ||
    raw === 'CANCELLED' ||
    raw === 'CANCELED' ||
    raw === 'REJECTED' ||
    raw === 'DUPLICATE'
  ) {
    return 'failed';
  }

  // 5. Pending / New -> Check Expiry
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

export const STATUS_COLORS: Record<StatusBucket, string> = {
  success: 'var(--ok)',
  pending: 'var(--warn)',
  review: 'var(--accent)',
  failed: 'var(--bad)',
  expired: 'var(--bad)',
};
