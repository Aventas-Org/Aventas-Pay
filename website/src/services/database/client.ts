// AventasPay - Real SQLite Database Client & Transaction Manager
// Direct SQL persistence powered by native SQLite.

import { sqlite } from './sqlite.ts';
import type {
  OrderStatus,
  PaymentStatus,
  OrderRecord,
  IncomingPaymentRecord,
  CreateOrderInput,
  CreateIncomingPaymentInput,
} from './types.ts';

export interface IDatabaseClient {
  order: {
    findUnique(args: { where: { id?: string; rrn?: string; token?: string } }): Promise<OrderRecord | null>;
    findMany(args?: {
      where?: {
        status?: OrderStatus | { in?: OrderStatus[] };
        expiresAt?: { gt?: Date; lte?: Date };
        baseAmount?: number;
        amount?: number;
      };
      orderBy?: { createdAt?: 'asc' | 'desc' };
    }): Promise<OrderRecord[]>;
    create(args: { data: CreateOrderInput }): Promise<OrderRecord>;
    update(args: {
      where: { id: string };
      data: Partial<Omit<OrderRecord, 'id' | 'createdAt'>>;
    }): Promise<OrderRecord>;
    findActiveDecimalOffsets(baseAmount: number, now?: Date): Promise<Set<number>>;
  };
  incomingPayment: {
    findUnique(args: {
      where: { id?: string; gmailMessageId?: string; rrn?: string };
    }): Promise<IncomingPaymentRecord | null>;
    findMany(args?: {
      where?: {
        status?: PaymentStatus | { in?: PaymentStatus[] };
        matchedOrderId?: string;
        amount?: number;
      };
      orderBy?: { receivedAt?: 'asc' | 'desc' };
    }): Promise<IncomingPaymentRecord[]>;
    create(args: { data: CreateIncomingPaymentInput }): Promise<IncomingPaymentRecord>;
    update(args: {
      where: { id: string };
      data: Partial<Omit<IncomingPaymentRecord, 'id' | 'createdAt'>>;
    }): Promise<IncomingPaymentRecord>;
  };
  $transaction<T>(callback: (tx: IDatabaseClient) => Promise<T>): Promise<T>;
  reset(): Promise<void>;
}

export class SqliteDatabaseClient implements IDatabaseClient {
  private db = sqlite.getRawDb();

  constructor(_persistToDisk?: boolean | string) {}

  private mapOrder(row: any): OrderRecord {
    return {
      id: row.id,
      amount: row.amount,
      baseAmount: row.baseAmount,
      decimalOffset: row.decimalOffset,
      currency: row.currency || 'INR',
      status: row.status as OrderStatus,
      productName: row.productName || undefined,
      redirectUrl: row.redirectUrl || undefined,
      rrn: row.rrn || null,
      senderName: row.senderName || null,
      paidAt: row.paidAt ? new Date(row.paidAt) : null,
      expiresAt: new Date(row.expiresAt),
      createdAt: new Date(row.createdAt),
      updatedAt: row.paidAt ? new Date(row.paidAt) : new Date(row.createdAt),
      token: row.token || undefined,
    };
  }

  private mapPayment(row: any): IncomingPaymentRecord {
    return {
      id: row.id,
      gmailMessageId: row.gmailMessageId,
      amount: row.amount,
      rrn: row.rrn,
      senderName: row.senderName || 'Verified Payer',
      status: row.status as PaymentStatus,
      matchedOrderId: row.matchedOrderId || null,
      receivedAt: new Date(row.receivedAt),
      createdAt: new Date(row.receivedAt),
      updatedAt: new Date(row.receivedAt),
    };
  }

  public order = {
    findUnique: async (args: { where: { id?: string; rrn?: string; token?: string } }): Promise<OrderRecord | null> => {
      const { id, rrn, token } = args.where;
      let row = null;
      if (id) {
        row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      } else if (rrn) {
        row = this.db.prepare('SELECT * FROM orders WHERE rrn = ?').get(rrn);
      } else if (token) {
        row = this.db.prepare('SELECT * FROM orders WHERE token = ?').get(token);
      }
      return row ? this.mapOrder(row) : null;
    },

    findMany: async (args?: {
      where?: {
        status?: OrderStatus | { in?: OrderStatus[] };
        expiresAt?: { gt?: Date; lte?: Date };
        baseAmount?: number;
        amount?: number;
      };
      orderBy?: { createdAt?: 'asc' | 'desc' };
    }): Promise<OrderRecord[]> => {
      let sql = 'SELECT * FROM orders WHERE 1=1';
      const params: any[] = [];

      if (args?.where) {
        if (args.where.status) {
          if (typeof args.where.status === 'string') {
            sql += ' AND status = ?';
            params.push(args.where.status);
          } else if (Array.isArray(args.where.status.in)) {
            const placeholders = args.where.status.in.map(() => '?').join(',');
            sql += ` AND status IN (${placeholders})`;
            params.push(...args.where.status.in);
          }
        }
        if (args.where.baseAmount !== undefined) {
          sql += ' AND baseAmount = ?';
          params.push(args.where.baseAmount);
        }
        if (args.where.amount !== undefined) {
          sql += ' AND amount = ?';
          params.push(args.where.amount);
        }
        if (args.where.expiresAt) {
          if (args.where.expiresAt.gt) {
            sql += ' AND expiresAt > ?';
            params.push(args.where.expiresAt.gt.toISOString());
          }
          if (args.where.expiresAt.lte) {
            sql += ' AND expiresAt <= ?';
            params.push(args.where.expiresAt.lte.toISOString());
          }
        }
      }

      const dir = args?.orderBy?.createdAt === 'asc' ? 'ASC' : 'DESC';
      sql += ` ORDER BY createdAt ${dir}`;

      const rows = this.db.prepare(sql).all(...params);
      return rows.map((r: any) => this.mapOrder(r));
    },

    create: async (args: { data: CreateOrderInput }): Promise<OrderRecord> => {
      const d = args.data;
      const createdDate = d.createdAt || new Date();
      if (d.expiresAt.getTime() <= createdDate.getTime()) {
        throw new Error(
          `Invariant violation: expiresAt (${d.expiresAt.toISOString()}) must be later than createdAt (${createdDate.toISOString()})`
        );
      }
      const now = createdDate.toISOString();
      const expiresAt = d.expiresAt.toISOString();

      const stmt = this.db.prepare(`
        INSERT INTO orders (id, paymentId, baseAmount, decimalOffset, amount, currency, status, customer, productName, redirectUrl, createdAt, expiresAt, token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        d.id,
        d.id,
        d.baseAmount,
        d.decimalOffset,
        d.amount,
        d.currency || 'INR',
        d.status || 'PENDING',
        'UPI Customer',
        d.productName || `Direct Order ₹${d.amount}`,
        d.redirectUrl || '',
        now,
        expiresAt,
        d.token || null
      );

      const created = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(d.id);
      return this.mapOrder(created);
    },

    update: async (args: {
      where: { id: string };
      data: Partial<Omit<OrderRecord, 'id' | 'createdAt'>>;
    }): Promise<OrderRecord> => {
      const id = args.where.id;

      if (args.data.expiresAt) {
        const row = this.db.prepare('SELECT createdAt FROM orders WHERE id = ?').get(id) as any;
        if (row && new Date(args.data.expiresAt).getTime() <= new Date(row.createdAt).getTime()) {
          throw new Error('Invariant violation: expiresAt must be later than createdAt');
        }
      }

      const updates: string[] = [];
      const params: any[] = [];

      for (const [key, val] of Object.entries(args.data)) {
        if (val instanceof Date) {
          updates.push(`${key} = ?`);
          params.push(val.toISOString());
        } else {
          updates.push(`${key} = ?`);
          params.push(val);
        }
      }

      if (updates.length > 0) {
        params.push(id);
        const sql = `UPDATE orders SET ${updates.join(', ')} WHERE id = ?`;
        this.db.prepare(sql).run(...params);
      }

      const updated = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      return this.mapOrder(updated);
    },

    findActiveDecimalOffsets: async (baseAmount: number, now: Date = new Date()): Promise<Set<number>> => {
      // Amount matching (Rule 7): Keep paise-offset hold with a 5-minute grace window after expiry
      const GRACE_WINDOW_MS = 5 * 60 * 1000;
      const graceCutoff = new Date(now.getTime() - GRACE_WINDOW_MS).toISOString();
      const rows = this.db.prepare(`
        SELECT decimalOffset FROM orders
        WHERE baseAmount = ? AND expiresAt > ?
      `).all(baseAmount, graceCutoff);

      const set = new Set<number>();
      for (const r of rows) {
        if (typeof r.decimalOffset === 'number') {
          set.add(r.decimalOffset);
        }
      }
      return set;
    },
  };

  public incomingPayment = {
    findUnique: async (args: {
      where: { id?: string; gmailMessageId?: string; rrn?: string };
    }): Promise<IncomingPaymentRecord | null> => {
      const { id, gmailMessageId, rrn } = args.where;
      let row = null;
      if (id) {
        row = this.db.prepare('SELECT * FROM incoming_payments WHERE id = ?').get(id);
      } else if (gmailMessageId) {
        row = this.db.prepare('SELECT * FROM incoming_payments WHERE gmailMessageId = ?').get(gmailMessageId);
      } else if (rrn) {
        row = this.db.prepare('SELECT * FROM incoming_payments WHERE rrn = ?').get(rrn);
      }
      return row ? this.mapPayment(row) : null;
    },

    findMany: async (args?: {
      where?: {
        status?: PaymentStatus | { in?: PaymentStatus[] };
        matchedOrderId?: string;
        amount?: number;
      };
      orderBy?: { receivedAt?: 'asc' | 'desc' };
    }): Promise<IncomingPaymentRecord[]> => {
      let sql = 'SELECT * FROM incoming_payments WHERE 1=1';
      const params: any[] = [];

      if (args?.where) {
        if (args.where.status) {
          if (typeof args.where.status === 'string') {
            sql += ' AND status = ?';
            params.push(args.where.status);
          } else if (Array.isArray(args.where.status.in)) {
            const placeholders = args.where.status.in.map(() => '?').join(',');
            sql += ` AND status IN (${placeholders})`;
            params.push(...args.where.status.in);
          }
        }
        if (args.where.matchedOrderId) {
          sql += ' AND matchedOrderId = ?';
          params.push(args.where.matchedOrderId);
        }
        if (args.where.amount !== undefined) {
          sql += ' AND amount = ?';
          params.push(args.where.amount);
        }
      }

      const dir = args?.orderBy?.receivedAt === 'asc' ? 'ASC' : 'DESC';
      sql += ` ORDER BY receivedAt ${dir}`;

      const rows = this.db.prepare(sql).all(...params);
      return rows.map((r: any) => this.mapPayment(r));
    },

    create: async (args: { data: CreateIncomingPaymentInput }): Promise<IncomingPaymentRecord> => {
      const d = args.data;
      const id = d.id || `inc_${Math.random().toString(36).substring(2, 10)}`;
      const receivedAt = d.receivedAt.toISOString();

      const stmt = this.db.prepare(`
        INSERT INTO incoming_payments (id, gmailMessageId, amount, rrn, senderName, status, receivedAt, matchedOrderId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        id,
        d.gmailMessageId,
        d.amount,
        d.rrn,
        d.senderName || 'Verified Payer',
        d.status || 'NEW',
        receivedAt,
        d.matchedOrderId || null
      );

      const created = this.db.prepare('SELECT * FROM incoming_payments WHERE id = ?').get(id);
      return this.mapPayment(created);
    },

    update: async (args: {
      where: { id: string };
      data: Partial<Omit<IncomingPaymentRecord, 'id' | 'createdAt'>>;
    }): Promise<IncomingPaymentRecord> => {
      const id = args.where.id;
      const updates: string[] = [];
      const params: any[] = [];

      for (const [key, val] of Object.entries(args.data)) {
        if (val instanceof Date) {
          updates.push(`${key} = ?`);
          params.push(val.toISOString());
        } else {
          updates.push(`${key} = ?`);
          params.push(val);
        }
      }

      if (updates.length > 0) {
        params.push(id);
        const sql = `UPDATE incoming_payments SET ${updates.join(', ')} WHERE id = ?`;
        this.db.prepare(sql).run(...params);
      }

      const updated = this.db.prepare('SELECT * FROM incoming_payments WHERE id = ?').get(id);
      return this.mapPayment(updated);
    },
  };

  public async $transaction<T>(callback: (tx: IDatabaseClient) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const result = await callback(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  public async reset(): Promise<void> {
    this.db.exec(`
      DELETE FROM orders;
      DELETE FROM incoming_payments;
      DELETE FROM products;
      DELETE FROM refunds;
      DELETE FROM manual_reviews;
      DELETE FROM chat_messages;
    `);
  }
}

export const db: IDatabaseClient = new SqliteDatabaseClient();
export { SqliteDatabaseClient as InMemoryDatabaseClient };
