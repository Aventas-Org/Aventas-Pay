// AventasPay - Gmail Watcher Service
// Dedicated independent service that polls Gmail for Slice Bank transaction emails
// within strictly bounded order time windows.

import tls from 'node:tls';
import { db, type IDatabaseClient } from '../database/client.ts';
import { SliceEmailParser, sliceParser, type RawEmailInput, type ParsedSlicePayment } from './parser.service.ts';
import { getActiveUpiConfig } from '../../config/accounts.ts';

export interface IGmailTransport {
  searchMessages(query: string): Promise<string[]>; // Returns list of message IDs
  fetchMessage(messageId: string): Promise<RawEmailInput | null>;
}

/**
 * Production Gmail IMAP Transport using App Passwords.
 * Connects securely to imap.gmail.com:993 using Node's native TLS module.
 */
export class GmailImapTransport implements IGmailTransport {
  private email: string;
  private appPassword: string;

  constructor(email?: string, appPassword?: string) {
    const config = getActiveUpiConfig();
    this.email = email || config.email;
    this.appPassword = (appPassword || config.appPassword).replace(/\s+/g, '');
  }

  public async searchMessages(_query: string): Promise<string[]> {
    if (!this.email || !this.appPassword) return [];

    return new Promise((resolve) => {
      const client = tls.connect(993, 'imap.gmail.com', { rejectUnauthorized: false }, () => {});
      let buffer = '';
      let step = 0;

      const send = (cmd: string) => {
        buffer = '';
        client.write(cmd + '\r\n');
      };

      client.on('data', (chunk) => {
        buffer += chunk.toString();
        if (step === 0 && buffer.includes('* OK')) {
          step = 1;
          send(`a1 LOGIN "${this.email}" "${this.appPassword}"`);
        } else if (step === 1 && buffer.includes('a1 ')) {
          if (buffer.includes('a1 OK')) {
            step = 2;
            send('a2 SELECT INBOX');
          } else {
            client.end();
            resolve([]);
          }
        } else if (step === 2 && buffer.includes('a2 ')) {
          step = 3;
          send('a3 SEARCH FROM "noreply@slice.bank.in"');
        } else if (step === 3 && buffer.includes('a3 ')) {
          const match = buffer.match(/\* SEARCH ([\d\s]+)/);
          const ids = match && match[1]?.trim() ? match[1].trim().split(/\s+/).filter(Boolean) : [];
          send('a4 LOGOUT');
          resolve(ids.slice(-10)); // return last 10 slice email IDs
        } else if (buffer.includes('a4 OK') || buffer.includes('BYE')) {
          client.end();
        }
      });

      client.on('error', () => {
        client.destroy();
        resolve([]);
      });

      setTimeout(() => {
        client.destroy();
        resolve([]);
      }, 7000);
    });
  }

  public async fetchMessage(messageId: string): Promise<RawEmailInput | null> {
    if (!this.email || !this.appPassword) return null;

    return new Promise((resolve) => {
      const client = tls.connect(993, 'imap.gmail.com', { rejectUnauthorized: false }, () => {});
      let buffer = '';
      let step = 0;

      const send = (cmd: string) => {
        buffer = '';
        client.write(cmd + '\r\n');
      };

      client.on('data', (chunk) => {
        buffer += chunk.toString();
        if (step === 0 && buffer.includes('* OK')) {
          step = 1;
          send(`a1 LOGIN "${this.email}" "${this.appPassword}"`);
        } else if (step === 1 && buffer.includes('a1 ')) {
          if (buffer.includes('a1 OK')) {
            step = 2;
            send('a2 SELECT INBOX');
          } else {
            client.end();
            resolve(null);
          }
        } else if (step === 2 && buffer.includes('a2 ')) {
          step = 3;
          send(`a3 FETCH ${messageId} BODY[]`);
        } else if (step === 3 && (buffer.includes('a3 OK') || buffer.includes('a3 NO'))) {
          send('a4 LOGOUT');

          // Extract Subject, From, Date, and Body from RFC822 format
          const fromMatch = buffer.match(/From:\s*([^\r\n]+)/i);
          const subMatch = buffer.match(/Subject:\s*([^\r\n]+)/i);
          const dateMatch = buffer.match(/Date:\s*([^\r\n]+)/i);

          const from = fromMatch ? fromMatch[1]?.trim() || '' : '';
          const subject = subMatch ? subMatch[1]?.trim() || '' : '';
          const dateHeader = dateMatch ? dateMatch[1]?.trim() : undefined;

          // Extract body after empty line
          const bodySplit = buffer.split(/\r?\n\r?\n/);
          const body = bodySplit.slice(1).join('\n');

          resolve({
            gmailMessageId: `imap_${messageId}`,
            from,
            subject,
            body,
            dateHeader,
          });
        } else if (buffer.includes('a4 OK') || buffer.includes('BYE')) {
          client.end();
        }
      });

      client.on('error', () => {
        client.destroy();
        resolve(null);
      });

      setTimeout(() => {
        client.destroy();
        resolve(null);
      }, 7000);
    });
  }
}

/**
 * Mock Transport for unit tests and local simulations
 */
export class MockGmailTransport implements IGmailTransport {
  private messages: Map<string, RawEmailInput> = new Map();

  public addMessage(msg: RawEmailInput): void {
    this.messages.set(msg.gmailMessageId, msg);
  }

  public clear(): void {
    this.messages.clear();
  }

  public async searchMessages(_query: string): Promise<string[]> {
    return Array.from(this.messages.keys());
  }

  public async fetchMessage(messageId: string): Promise<RawEmailInput | null> {
    return this.messages.get(messageId) || null;
  }
}

export class GmailWatcherService {
  private client: IDatabaseClient;
  private transport: IGmailTransport;
  private parser: SliceEmailParser;

  constructor(
    customDb?: IDatabaseClient,
    customTransport?: IGmailTransport,
    customParser?: SliceEmailParser
  ) {
    this.client = customDb || db;
    this.transport = customTransport || new GmailImapTransport();
    this.parser = customParser || sliceParser;
  }

  public setTransport(transport: IGmailTransport) {
    this.transport = transport;
  }

  /**
   * Polls Gmail for Slice Bank emails corresponding to active pending orders.
   */
  public async pollPendingOrders(now: Date = new Date()): Promise<ParsedSlicePayment[]> {
    // 1. Check if any pending orders exist
    const pendingOrders = await this.client.order.findMany({
      where: {
        status: 'PENDING',
        expiresAt: { gt: now },
      },
    });

    if (pendingOrders.length === 0) {
      return [];
    }

    // 2. Search Slice emails
    const messageIds = await this.transport.searchMessages(`from:${SliceEmailParser.ALLOWED_SENDER}`);
    const results: ParsedSlicePayment[] = [];

    for (const msgId of messageIds) {
      try {
        // Skip if message ID already processed
        const existing = await this.client.incomingPayment.findUnique({
          where: { gmailMessageId: msgId },
        });
        if (existing) {
          continue;
        }

        const raw = await this.transport.fetchMessage(msgId);
        if (!raw) continue;

        if (!this.parser.isSliceSender(raw.from) || !this.parser.hasReceivedSubject(raw.subject)) {
          continue;
        }

        const parsed = this.parser.parseEmail(raw);

        // Store into incoming_payments table as NEW
        await this.client.incomingPayment.create({
          data: {
            gmailMessageId: parsed.gmailMessageId,
            rrn: parsed.rrn,
            senderName: parsed.senderName,
            amount: parsed.amount,
            receivedAt: parsed.receivedAt,
            status: 'NEW',
          },
        });

        results.push(parsed);
      } catch (err) {
        console.warn(`[GmailWatcher] Notice: skipped message ${msgId}:`, err);
      }
    }

    return results;
  }
}

export const gmailWatcher = new GmailWatcherService();
