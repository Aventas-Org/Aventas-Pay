// AventasPay - Product Management Service
// Direct SQLite persistence for products and embed widgets.

import { sqlite } from './database/sqlite.ts';

export interface ProductRecord {
  id: string;
  name: string;
  description: string;
  baseAmount: number;
  currency: string;
  category?: string;
  active: boolean;
  redirectUrl?: string;
  createdAt: string;
}

export interface CreateProductInput {
  id?: string;
  name: string;
  description?: string;
  baseAmount: number;
  currency?: string;
  category?: string;
  redirectUrl?: string;
}

export class ProductService {
  private db = sqlite.getRawDb();

  public async getProducts(): Promise<ProductRecord[]> {
    const rows = this.db.prepare('SELECT * FROM products ORDER BY createdAt DESC').all();
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      description: r.description || '',
      baseAmount: r.baseAmount,
      currency: r.currency || 'INR',
      category: r.category || 'Digital Goods',
      active: Boolean(r.active),
      redirectUrl: r.redirectUrl || '',
      createdAt: r.createdAt,
    }));
  }

  public async getProduct(id: string): Promise<ProductRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      baseAmount: row.baseAmount,
      currency: row.currency || 'INR',
      category: row.category || 'Digital Goods',
      active: Boolean(row.active),
      redirectUrl: row.redirectUrl || '',
      createdAt: row.createdAt,
    };
  }

  public async createProduct(input: CreateProductInput): Promise<ProductRecord> {
    const slug =
      input.id ||
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') ||
      `prod_${Date.now()}`;

    const id = slug.startsWith('prod_') ? slug : `prod_${slug}`;
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO products (id, name, description, baseAmount, currency, category, active, redirectUrl, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      input.name,
      input.description || '',
      input.baseAmount,
      input.currency || 'INR',
      input.category || 'Digital Goods',
      1,
      input.redirectUrl || '',
      now
    );

    const product = await this.getProduct(id);
    return product!;
  }

  public async deleteProduct(id: string): Promise<boolean> {
    const res = this.db.prepare('DELETE FROM products WHERE id = ?').run(id);
    return res.changes > 0;
  }
}

export const productService = new ProductService();
