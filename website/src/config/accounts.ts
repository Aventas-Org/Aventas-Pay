// AventasPay - Dual Account & Dual UPI Configuration Manager
// Supports accounts configuration with runtime switching and environment fallbacks.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PaymentAccountProfile {
  id: 1 | 2;
  email: string;
  appPassword: string;
  upiId: string;
  maxDecimal: number;
  pollIntervalSeconds: number;
}

export function findAccountsConfigPath(): string | null {
  const currentDir = typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

  const candidates = [
    path.resolve(process.cwd(), 'config', 'accounts.json'),
    path.resolve(process.cwd(), 'website', 'config', 'accounts.json'),
    path.resolve(currentDir, '..', '..', 'config', 'accounts.json'),
    path.resolve(currentDir, '..', 'config', 'accounts.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function getActiveUpiConfig(): PaymentAccountProfile {
  try {
    const configPath = findAccountsConfigPath();
    if (configPath) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const activeId: 1 | 2 = data.active === 2 ? 2 : 1;
      const account = activeId === 2 ? data.account_2 : data.account_1;
      const pollIntervalSeconds = data.poll_interval_seconds || 5;
      return {
        id: activeId,
        upiId: process.env.AVENTAS_UPI_VPA || account?.upi_id || 'cvvbypasser@slc',
        email: process.env.GMAIL_USER || account?.email || '',
        appPassword: (process.env.GMAIL_APP_PASSWORD || account?.app_password || '').replace(/\s+/g, ''),
        maxDecimal: data.max_decimal_offset || 49,
        pollIntervalSeconds,
      };
    }
  } catch (err) {
    console.error('[Config] Error reading accounts.json:', err);
  }

  return {
    id: 1,
    upiId: process.env.AVENTAS_UPI_VPA || 'cvvbypasser@slc',
    email: process.env.GMAIL_USER || '',
    appPassword: (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''),
    maxDecimal: 49,
    pollIntervalSeconds: 5,
  };
}
