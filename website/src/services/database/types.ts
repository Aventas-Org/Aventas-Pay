// AventasPay - Shared Database Types and Enums

export type OrderStatus =
  | 'PENDING'
  | 'MATCHED'
  | 'VERIFIED'
  | 'SUCCESS'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

export type PaymentStatus =
  | 'NEW'
  | 'MATCHED'
  | 'VERIFIED'
  | 'DUPLICATE'
  | 'UNMATCHED'
  | 'LATE'
  | 'REJECTED';

export interface OrderRecord {
  id: string;
  amount: number; // e.g. 499.37
  baseAmount: number; // e.g. 499.00
  decimalOffset: number; // e.g. 37
  currency: string;
  status: OrderStatus;
  productName?: string;
  redirectUrl?: string;
  rrn: string | null;
  senderName: string | null;
  paidAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  token?: string; // Optional reference to website checkout_token
}

export interface IncomingPaymentRecord {
  id: string;
  gmailMessageId: string;
  rrn: string;
  senderName: string;
  amount: number;
  receivedAt: Date;
  status: PaymentStatus;
  matchedOrderId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOrderInput {
  id: string;
  amount: number;
  baseAmount: number;
  decimalOffset: number;
  currency?: string;
  status?: OrderStatus;
  productName?: string;
  redirectUrl?: string;
  expiresAt: Date;
  createdAt?: Date;
  token?: string;
}

export interface CreateIncomingPaymentInput {
  id?: string;
  gmailMessageId: string;
  rrn: string;
  senderName: string;
  amount: number;
  receivedAt: Date;
  status?: PaymentStatus;
  matchedOrderId?: string | null;
}
