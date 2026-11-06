// AventasPay - Pure SQLite Database Engine (Native node:sqlite)
// Replaces .json files with a real, persistent SQL database.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Use dynamic require to load node:sqlite safely across environments
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
  DatabaseSync: new (path: string, options?: unknown) => any;
};

export function getDatabaseFilePath(): string {
  const candidates = [
    path.resolve(process.cwd(), 'website', 'data'),
    path.resolve(process.cwd(), 'data'),
  ];
  try {
    const currentDir = typeof __dirname !== 'undefined'
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(currentDir, '..', '..', '..', 'data'));
  } catch {}

  for (const dir of candidates) {
    if (dir.includes('Aventas-Pay') && (fs.existsSync(dir) || fs.existsSync(path.dirname(dir)))) {
      if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      }
      return path.resolve(dir, 'aventas.sqlite');
    }
  }

  const fallbackDir = path.resolve(process.cwd(), 'website', 'data');
  if (!fs.existsSync(fallbackDir)) {
    try { fs.mkdirSync(fallbackDir, { recursive: true }); } catch {}
  }
  return path.resolve(fallbackDir, 'aventas.sqlite');
}

export class SqliteEngine {
  private db: any;
  private static instance: SqliteEngine;

  private constructor() {
    const dbPath = getDatabaseFilePath();
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
    this.seedIfEmpty();
  }

  public static getInstance(): SqliteEngine {
    if (!SqliteEngine.instance) {
      SqliteEngine.instance = new SqliteEngine();
    }
    return SqliteEngine.instance;
  }

  public getRawDb(): any {
    return this.db;
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        baseAmount REAL NOT NULL,
        currency TEXT DEFAULT 'INR',
        category TEXT DEFAULT 'Digital Goods',
        active INTEGER DEFAULT 1,
        redirectUrl TEXT DEFAULT '',
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        paymentId TEXT NOT NULL,
        baseAmount REAL NOT NULL,
        decimalOffset INTEGER DEFAULT 0,
        amount REAL NOT NULL,
        currency TEXT DEFAULT 'INR',
        status TEXT DEFAULT 'PENDING',
        customer TEXT DEFAULT 'UPI Customer',
        productName TEXT DEFAULT '',
        redirectUrl TEXT DEFAULT '',
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        paidAt TEXT,
        rrn TEXT,
        senderName TEXT,
        token TEXT
      );

      CREATE TABLE IF NOT EXISTS incoming_payments (
        id TEXT PRIMARY KEY,
        gmailMessageId TEXT UNIQUE,
        amount REAL NOT NULL,
        rrn TEXT,
        senderName TEXT DEFAULT 'Verified Payer',
        rawSubject TEXT DEFAULT '',
        rawBody TEXT DEFAULT '',
        status TEXT DEFAULT 'NEW',
        receivedAt TEXT NOT NULL,
        matchedOrderId TEXT
      );

      CREATE TABLE IF NOT EXISTS refunds (
        id TEXT PRIMARY KEY,
        orderId TEXT NOT NULL,
        amount REAL NOT NULL,
        reason TEXT NOT NULL,
        customer TEXT DEFAULT 'Customer',
        method TEXT DEFAULT 'Slice UPI',
        status TEXT DEFAULT 'Pending',
        debitUtr TEXT,
        createdAt TEXT NOT NULL,
        processedAt TEXT,
        notes TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS manual_reviews (
        id TEXT PRIMARY KEY,
        orderId TEXT NOT NULL UNIQUE,
        customerName TEXT DEFAULT 'Customer',
        amount REAL NOT NULL,
        expected REAL NOT NULL,
        issue TEXT DEFAULT 'Payment Timeout / Unmatched',
        priority TEXT DEFAULT 'High',
        status TEXT DEFAULT 'Pending',
        reportedUtr TEXT,
        adminNotes TEXT DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        orderId TEXT NOT NULL,
        sender TEXT NOT NULL,
        message TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS debited_emails (
        id TEXT PRIMARY KEY,
        gmailMessageId TEXT UNIQUE,
        amount REAL NOT NULL,
        utr TEXT UNIQUE,
        recipientName TEXT,
        subject TEXT,
        body TEXT,
        receivedAt TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_incoming_payments_rrn_unique 
      ON incoming_payments(rrn) 
      WHERE rrn IS NOT NULL AND rrn != '' AND rrn != '—';
    `);

    // Ensure columns exist if table was created in an older version
    try { this.db.exec("ALTER TABLE products ADD COLUMN redirectUrl TEXT DEFAULT ''"); } catch {}
    try { this.db.exec("ALTER TABLE orders ADD COLUMN redirectUrl TEXT DEFAULT ''"); } catch {}
  }

  public getSetting(key: string, defaultValue: string = ''): string {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  }

  public setSetting(key: string, value: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO settings (key, value, updatedAt)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt
    `).run(key, value, now);
  }

  public wipeDatabase(resetProducts = true): void {
    // Clear all test/mock orders, incoming payments, reviews, chats, refunds, debited emails
    this.db.exec(`
      DELETE FROM orders;
      DELETE FROM incoming_payments;
      DELETE FROM refunds;
      DELETE FROM manual_reviews;
      DELETE FROM chat_messages;
      DELETE FROM debited_emails;
    `);

    if (resetProducts) {
      this.db.exec(`DELETE FROM products;`);
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO products (id, name, description, baseAmount, currency, category, active, redirectUrl, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'test_slice_1rs',
        'Test Payment (₹1)',
        'Slice Bank UPI auto-verification test with unique decimal paise',
        1,
        'INR',
        'Test & QA',
        1,
        '',
        now
      );
    }
  }

  private seedIfEmpty() {
    // 1. Admin Secret Key
    const existingKey = this.getSetting('admin_secret_key');
    if (!existingKey) {
      const generatedKey = 'aventas_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 8);
      this.setSetting('admin_secret_key', generatedKey);
      console.log('\n=============================================================');
      console.log(' [AventasPay Admin] Initial Admin Secret Key Generated:');
      console.log(` ===>  ${generatedKey}  <===`);
      console.log(' Use this key to log in at /login. You can change it in Settings.');
      console.log('=============================================================\n');
    }

    // Default configuration settings
    if (!this.getSetting('discord_webhook_url')) this.setSetting('discord_webhook_url', '');
    if (!this.getSetting('secondary_upi_id')) this.setSetting('secondary_upi_id', '');
    if (!this.getSetting('secondary_account_name')) this.setSetting('secondary_account_name', '');
    if (!this.getSetting('notifications_email_alerts')) this.setSetting('notifications_email_alerts', 'true');
    if (!this.getSetting('notifications_payment_alerts')) this.setSetting('notifications_payment_alerts', 'true');
    if (!this.getSetting('notifications_timeout_alerts')) this.setSetting('notifications_timeout_alerts', 'true');

    // 2. Products - ONLY seed the 1 RS demo product
    const productCount = this.db.prepare('SELECT COUNT(*) as count FROM products').get().count;
    if (productCount === 0) {
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO products (id, name, description, baseAmount, currency, category, active, redirectUrl, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'test_slice_1rs',
        'Test Payment (₹1)',
        'Slice Bank UPI auto-verification test with unique decimal paise',
        1,
        'INR',
        'Test & QA',
        1,
        '',
        now
      );
    } else {
      // Ensure any extra mock products are cleaned out if they exist
      this.db.exec(`
        DELETE FROM products WHERE id IN ('prod_vp_1000', 'prod_discord_vip', 'prod_software_pro');
      `);
    }

    // Zero mock orders, zero mock payments, zero mock emails, zero mock reviews in production!
    // Demo data gating: Only seed demo rows when DEMO_MODE=true
    if (process.env.DEMO_MODE === 'true') {
      const orderCount = this.db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
      if (orderCount === 0) {
        this.seedDemoRows();
      }
    }
  }

  public seedDemoRows() {
    console.log('[AventasPay] DEMO_MODE=true: Seeding realistic demo records...');
    const now = new Date();
    const isoNow = now.toISOString();

    const demoOrders = [
      { id: 'demo_ord_01', base: 499, offset: 5, amt: 499.05, name: 'Siddharth Malhotra', st: 'PENDING', utr: null, minsAgo: 5, ttl: 10 },
      { id: 'demo_ord_07', base: 599, offset: 9, amt: 599.09, name: 'Neha Kapoor', st: 'PENDING', utr: null, minsAgo: 7, ttl: 10 },
      { id: 'pay_4fda56cfa3674697', base: 1, offset: 4, amt: 1.04, name: 'UPI Customer', st: 'PENDING', utr: null, minsAgo: 9, ttl: 10 },
      { id: 'demo_ord_11', base: 350, offset: 4, amt: 350.04, name: 'Amit Kumar', st: 'EXPIRED', utr: null, minsAgo: 32, ttl: 10 },
      { id: 'demo_ord_02', base: 1299, offset: 12, amt: 1299.12, name: 'Priya Sharma', st: 'SUCCESS', utr: '492819203912', minsAgo: 37, ttl: 10 },
      { id: 'demo_ord_05', base: 99, offset: 4, amt: 99.04, name: 'Kavita Rao', st: 'EXPIRED', utr: null, minsAgo: 47, ttl: 10 },
      { id: 'demo_ord_03', base: 249, offset: 2, amt: 249.02, name: 'Rohan Mehra', st: 'SUCCESS', utr: '492819203913', minsAgo: 92, ttl: 10 },
      { id: 'demo_ord_04', base: 799, offset: 18, amt: 799.18, name: 'Ananya Patel', st: 'SUCCESS', utr: '492819203914', minsAgo: 182, ttl: 10 },
    ];

    for (const o of demoOrders) {
      const createdAt = new Date(now.getTime() - o.minsAgo * 60 * 1000);
      const expiresAt = new Date(createdAt.getTime() + o.ttl * 60 * 1000);
      const paidAt = o.st === 'SUCCESS' ? new Date(createdAt.getTime() + 2 * 60 * 1000).toISOString() : null;

      this.db.prepare(`
        INSERT OR IGNORE INTO orders (id, paymentId, baseAmount, decimalOffset, amount, currency, status, customer, productName, redirectUrl, createdAt, expiresAt, paidAt, rrn, senderName)
        VALUES (?, ?, ?, ?, ?, 'INR', ?, ?, 'Direct UPI Payment', '', ?, ?, ?, ?, ?)
      `).run(
        o.id,
        o.id,
        o.base,
        o.offset,
        o.amt,
        o.st,
        o.name,
        createdAt.toISOString(),
        expiresAt.toISOString(),
        paidAt,
        o.utr,
        o.name
      );

      if (o.st === 'SUCCESS' && o.utr) {
        this.db.prepare(`
          INSERT OR IGNORE INTO incoming_payments (id, gmailMessageId, amount, rrn, senderName, rawSubject, rawBody, status, receivedAt, matchedOrderId)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?, ?)
        `).run(
          `pay_${o.id}`,
          `msg_${o.id}`,
          o.amt,
          o.utr,
          o.name,
          `Received ₹${o.amt.toFixed(2)} from ${o.name}`,
          `Received payment of ₹${o.amt.toFixed(2)} from ${o.name}. UTR: ${o.utr}`,
          paidAt || createdAt.toISOString(),
          o.id
        );
      }
    }

    // Two weeks of history so the charts have something to show (DEMO_MODE only).
    // Deterministic pseudo-random so every demo run looks the same.
    let seed = 20261026;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const names = ['Arjun Das', 'Vikram Singh', 'Deepak Joshi', 'Sunita Reddy', 'Meera Iyer', 'Karan Bhatia', 'Isha Gupta', 'Rahul Nair', 'Pooja Menon', 'Sameer Khan'];
    let seq = 100;
    for (let daysAgo = 1; daysAgo <= 13; daysAgo++) {
      const perDay = daysAgo % 5 === 0 ? 0 : 1 + Math.floor(rnd() * 4);
      for (let k = 0; k < perDay; k++) {
        seq++;
        const base = [99, 149, 249, 349, 499, 799, 999, 1499][Math.floor(rnd() * 8)];
        const offset = 1 + Math.floor(rnd() * 40);
        const amt = Math.round((base + offset / 100) * 100) / 100;
        const createdAt = new Date(now.getTime() - daysAgo * 86400000 - Math.floor(rnd() * 12) * 3600000);
        const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000);
        const ok = rnd() > 0.28;
        const paidAt = ok ? new Date(createdAt.getTime() + 90 * 1000).toISOString() : null;
        const id = `demo_hist_${seq}`;
        const name = names[Math.floor(rnd() * names.length)];
        const utr = ok ? String(500000000000 + seq * 7919) : null;
        this.db.prepare(`
          INSERT OR IGNORE INTO orders (id, paymentId, baseAmount, decimalOffset, amount, currency, status, customer, productName, redirectUrl, createdAt, expiresAt, paidAt, rrn, senderName)
          VALUES (?, ?, ?, ?, ?, 'INR', ?, ?, 'Direct UPI Payment', '', ?, ?, ?, ?, ?)
        `).run(id, id, base, offset, amt, ok ? 'SUCCESS' : 'EXPIRED', name, createdAt.toISOString(), expiresAt.toISOString(), paidAt, utr, name);
        if (ok) {
          this.db.prepare(`
            INSERT OR IGNORE INTO incoming_payments (id, gmailMessageId, amount, rrn, senderName, rawSubject, rawBody, status, receivedAt, matchedOrderId)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?, ?)
          `).run(`pay_${id}`, `msg_${id}`, amt, utr, name, `Received ₹${amt.toFixed(2)} from ${name}`, `Received payment of ₹${amt.toFixed(2)} from ${name}. UTR: ${utr}`, paidAt, id);
        }
      }
    }

    // Demo manual review: belongs to the real expired order demo_ord_11 (Amit Kumar)
    this.db.prepare(`
      INSERT OR IGNORE INTO manual_reviews (id, orderId, customerName, amount, expected, issue, priority, status, reportedUtr, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'rev_demo_01',
      'demo_ord_11',
      'Amit Kumar',
      350.04,
      350.04,
      'Payment Timeout / Customer Contact',
      'High',
      'Pending',
      '492019382012',
      isoNow,
      isoNow
    );
    const chat = [
      ['system', 'Support ticket initiated. Please tell us your payment details or UTR number below.'],
      ['admin', 'Hi Amit! Please share the 12-digit UPI UTR number from your Slice receipt.'],
      ['customer', 'My Slice UTR is 492019382012'],
    ];
    chat.forEach(([sender, message], i) => {
      this.db.prepare(`INSERT OR IGNORE INTO chat_messages (id, orderId, sender, message, createdAt) VALUES (?, ?, ?, ?, ?)`)
        .run(`demo_msg_${i}`, 'demo_ord_11', sender, message, new Date(now.getTime() - (3 - i) * 60000).toISOString());
    });
  }
}

export const sqlite = SqliteEngine.getInstance();
