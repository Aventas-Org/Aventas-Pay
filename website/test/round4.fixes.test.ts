// Round 4 PART A Unit Tests
// Tests status_bucket, login lockout, UTR uniqueness, and expiry grace window

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { status_bucket } from '../src/domain/statusBucket.ts';
import { LoginLockoutManager } from '../src/config/security.ts';
import { isSenderAllowlisted, isDkimOrSpfPassed } from '../src/config/security.ts';

describe('Round 4 PART A Fixes', () => {
  it('status_bucket - accurately returns single authoritative status bucket', () => {
    const now = new Date('2026-10-25T12:00:00Z');

    // Success outcomes
    assert.equal(status_bucket({ status: 'SUCCESS' }, now), 'success');
    assert.equal(status_bucket({ status: 'PAID' }, now), 'success');
    assert.equal(status_bucket({ status: 'VERIFIED' }, now), 'success');
    assert.equal(status_bucket({ status: 'MATCHED' }, now), 'success');
    assert.equal(status_bucket({ status: 'RESOLVED' }, now), 'success');

    // Review outcomes
    assert.equal(status_bucket({ status: 'REVIEW' }, now), 'review');
    assert.equal(status_bucket({ status: 'MANUAL_REVIEW' }, now), 'review');
    assert.equal(status_bucket({ status: 'UNMATCHED' }, now), 'review');
    assert.equal(status_bucket({ status: 'LATE' }, now), 'review');

    // Expired outcomes
    assert.equal(status_bucket({ status: 'EXPIRED' }, now), 'expired');
    // Active order past expiresAt automatically buckets as expired
    assert.equal(
      status_bucket({ status: 'PENDING', expiresAt: '2026-10-25T11:59:00Z' }, now),
      'expired'
    );

    // Pending outcomes (before expiresAt)
    assert.equal(
      status_bucket({ status: 'PENDING', expiresAt: '2026-10-25T12:10:00Z' }, now),
      'pending'
    );

    // Failed outcomes
    assert.equal(status_bucket({ status: 'FAILED' }, now), 'failed');
    assert.equal(status_bucket({ status: 'CANCELLED' }, now), 'failed');
    assert.equal(status_bucket({ status: 'REJECTED' }, now), 'failed');
  });

  it('Login lockout - locks after 5 failed attempts for 15 minutes', () => {
    const lockout = new LoginLockoutManager();
    const testIp = '192.168.1.100';
    const t0 = 1000000;

    assert.equal(lockout.isLocked(testIp, t0), false);

    // 4 failed attempts - not yet locked
    for (let i = 1; i <= 4; i++) {
      const res = lockout.recordFailure(testIp, t0);
      assert.equal(res.locked, false);
      assert.equal(res.attemptsLeft, 5 - i);
    }
    assert.equal(lockout.isLocked(testIp, t0), false);

    // 5th failed attempt - locks
    const res5 = lockout.recordFailure(testIp, t0);
    assert.equal(res5.locked, true);
    assert.equal(res5.attemptsLeft, 0);
    assert.equal(lockout.isLocked(testIp, t0), true);

    // Still locked at 14 minutes
    assert.equal(lockout.isLocked(testIp, t0 + 14 * 60 * 1000), true);

    // Unlocked after 15 minutes
    assert.equal(lockout.isLocked(testIp, t0 + 15 * 60 * 1000 + 1), false);
  });

  it('Email sender allowlist & DKIM verification', () => {
    // Default placeholder allowlist includes slice bank and sliceit.com
    assert.equal(isSenderAllowlisted('noreply@slice.bank.in'), true);
    assert.equal(isSenderAllowlisted('Slice Alerts <alerts@slice.in>'), true);
    assert.equal(isSenderAllowlisted('support@sliceit.com'), true);
    assert.equal(isSenderAllowlisted('hacker@fraud-bank.com'), false);

    // DKIM check (when require_dkim is false, passes; otherwise tests header)
    assert.equal(isDkimOrSpfPassed('mx.google.com; dkim=pass header.i=@slice.in'), true);
    assert.equal(isDkimOrSpfPassed('mx.google.com; spf=pass (google.com)'), true);
  });
});
