// AventasPay - Security Configuration & Policies
// Handles email sender allowlist, DKIM/SPF verification policies, and login lockout.

export const BANK_FROM_ALLOWLIST: string[] = (
  process.env.BANK_FROM_ALLOWLIST || 'noreply@slice.bank.in,alerts@slice.in,*@sliceit.com'
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export const REQUIRE_DKIM: boolean = process.env.REQUIRE_DKIM === 'true';

/** Pulls the bare address out of "Name <addr@host>" or "addr@host". */
export function extractEmailAddress(fromHeader: string): string {
  const raw = String(fromHeader || '').trim().toLowerCase();
  const angle = raw.match(/<([^<>\s]+@[^<>\s]+)>/);
  const addr = (angle ? angle[1] : raw).trim();
  return /^[^@\s<>]+@[^@\s<>]+$/.test(addr) ? addr : '';
}

/**
 * Validates the sender against BANK_FROM_ALLOWLIST using the parsed address,
 * never a substring match (so "noreply@slice.bank.in.evil.com" is rejected).
 * Note: a forged From on the REAL domain is only stopped by the DKIM/SPF check
 * below, so set REQUIRE_DKIM=true once you know your bank's headers.
 * Supports exact addresses and "*@domain" (exact domain only).
 */
export function isSenderAllowlisted(fromHeader: string): boolean {
  const addr = extractEmailAddress(fromHeader);
  if (!addr) return false;
  const domain = addr.slice(addr.lastIndexOf('@') + 1);

  return BANK_FROM_ALLOWLIST.some((pattern) => {
    if (pattern.startsWith('*@')) return domain === pattern.slice(2);
    return addr === pattern;
  });
}

/**
 * Validates DKIM/SPF authentication from RFC5322 Authentication-Results header.
 * When REQUIRE_DKIM is false (default placeholder), passes through with logging.
 */
export function isDkimOrSpfPassed(authResultsHeader?: string): boolean {
  if (!REQUIRE_DKIM) {
    return true;
  }
  if (!authResultsHeader) {
    return false;
  }
  const lower = authResultsHeader.toLowerCase();
  return lower.includes('dkim=pass') || lower.includes('spf=pass');
}

export interface LockoutRecord {
  failures: number;
  lockedUntil: number | null;
  firstAttemptAt: number;
}

/**
 * IP-based Login Lockout Manager.
 * Locks an IP address for 15 minutes after 5 failed admin login attempts.
 */
export class LoginLockoutManager {
  private attempts = new Map<string, LockoutRecord>();
  public readonly MAX_ATTEMPTS = 5;
  public readonly LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
  public readonly ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

  public isLocked(ip: string, nowMs: number = Date.now()): boolean {
    const record = this.attempts.get(ip);
    if (!record) return false;

    if (record.lockedUntil !== null) {
      if (nowMs < record.lockedUntil) {
        return true;
      }
      // Lockout expired, reset
      this.attempts.delete(ip);
      return false;
    }

    return false;
  }

  public recordFailure(ip: string, nowMs: number = Date.now()): { locked: boolean; attemptsLeft: number } {
    let record = this.attempts.get(ip);

    // If window expired, start fresh
    if (!record || nowMs - record.firstAttemptAt > this.ATTEMPT_WINDOW_MS) {
      record = { failures: 1, lockedUntil: null, firstAttemptAt: nowMs };
      this.attempts.set(ip, record);
      return { locked: false, attemptsLeft: this.MAX_ATTEMPTS - 1 };
    }

    record.failures += 1;

    if (record.failures >= this.MAX_ATTEMPTS) {
      record.lockedUntil = nowMs + this.LOCKOUT_DURATION_MS;
      console.warn(`[Security] IP ${ip} is locked out for 15 minutes due to ${record.failures} failed login attempts.`);
      return { locked: true, attemptsLeft: 0 };
    }

    return { locked: false, attemptsLeft: this.MAX_ATTEMPTS - record.failures };
  }

  public recordSuccess(ip: string): void {
    this.attempts.delete(ip);
  }

  public clear(): void {
    this.attempts.clear();
  }
}

export const loginLockoutManager = new LoginLockoutManager();
