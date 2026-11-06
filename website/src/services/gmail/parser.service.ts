// AventasPay - Slice Email Parser Service
// Extracts and validates payment details strictly from Slice Bank notification emails.
// Supports raw text, Gmail API payloads, HTML table structures, MIME encodings, and .eml files.

import { isSenderAllowlisted, isDkimOrSpfPassed } from '../../config/security.ts';

export interface RawEmailInput {
  gmailMessageId: string;
  from: string;
  subject: string;
  body: string;
  dateHeader?: string;
  internalDate?: string | number; // Gmail internal epoch ms
  authResults?: string; // Authentication-Results header (DKIM / SPF)
}

export interface ParsedSlicePayment {
  gmailMessageId: string;
  senderEmail: string;
  subject: string;
  amount: number;
  senderName: string;
  rrn: string;
  receivedAt: Date;
}

export class SliceEmailParser {
  public static readonly ALLOWED_SENDER = 'noreply@slice.bank.in';
  public static readonly REQUIRED_SUBJECT_PREFIX = 'Received';

  /**
   * Decodes RFC 2047 MIME encoded words (e.g. =?UTF-8?q?Received_=E2=82=B9200...=?)
   */
  public decodeMimeWord(str: string): string {
    if (!str || !str.includes('=?')) return str;
    return str.replace(/=\?UTF-8\?([QB])\?(.+?)\?=/gi, (_, enc, encodedText) => {
      if (enc.toUpperCase() === 'Q') {
        const decoded = encodedText
          .replace(/_/g, ' ')
          .replace(/=([A-F0-9]{2})/gi, (_: string, hex: string) =>
            String.fromCharCode(parseInt(hex, 16))
          );
        return Buffer.from(decoded, 'binary').toString('utf-8');
      }
      if (enc.toUpperCase() === 'B') {
        return Buffer.from(encodedText, 'base64').toString('utf-8');
      }
      return encodedText;
    });
  }

  /**
   * Decodes Quoted-Printable content transfer encoding
   */
  public decodeQuotedPrintable(str: string): string {
    if (!str) return '';
    const unlined = str.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < unlined.length; i++) {
      if (unlined[i] === '=' && i + 2 < unlined.length && /[0-9A-Fa-f]{2}/.test(unlined.substring(i + 1, i + 3))) {
        bytes.push(parseInt(unlined.substring(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(unlined.charCodeAt(i));
      }
    }
    return Buffer.from(bytes).toString('utf-8');
  }

  /**
   * Verifies if the email sender is allowlisted per BANK_FROM_ALLOWLIST policy
   */
  public isSliceSender(fromHeader: string): boolean {
    if (!fromHeader) return false;
    return isSenderAllowlisted(fromHeader);
  }

  /**
   * Verifies DKIM / SPF authentication results if REQUIRE_DKIM is enabled
   */
  public isDkimValid(authResultsHeader?: string): boolean {
    return isDkimOrSpfPassed(authResultsHeader);
  }

  /**
   * Verifies if the subject begins with "Received"
   */
  public hasReceivedSubject(subject: string): boolean {
    if (!subject) return false;
    const decoded = this.decodeMimeWord(subject).trim();
    return decoded.toLowerCase().startsWith(SliceEmailParser.REQUIRED_SUBJECT_PREFIX.toLowerCase());
  }

  /**
   * Extracts monetary amount (e.g. ₹200, ₹499.37, Rs. 499.37)
   */
  public extractAmount(text: string): number | null {
    const patterns = [
      /(?:₹|Rs\.?|INR)\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
      /(?:Amount|Paid|Received|credited with|transferred)[:\s]*(?:₹|Rs\.?|INR)?\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
      /\b([0-9]+\.[0-9]{2})\b/, // exact 2 decimal number fallback
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const val = parseFloat(match[1]);
        if (!isNaN(val) && val > 0) {
          return Math.round(val * 100) / 100;
        }
      }
    }
    return null;
  }

  /**
   * Extracts 12-digit UPI Reference Number (RRN)
   */
  public extractRrn(text: string): string | null {
    const patterns = [
      /(?:UPI\s*Ref(?:\s*No|\s*#)?|RRN|Ref\s*No|Transaction\s*ID)[:\s#]*([0-9]{12})\b/i,
      /\b([0-9]{12})\b/, // 12 contiguous digits anywhere
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  }

  /**
   * Extracts the sender name from subject or email body
   */
  public extractSenderName(subject: string, body: string): string {
    const subMatch = subject.match(/from\s+([A-Za-z\s.'-]+?)(?:\s+via\s+UPI|\s+into\s+your|$|\.)/i);
    if (subMatch && subMatch[1] && subMatch[1].trim().length > 1) {
      return subMatch[1].trim();
    }

    const bodyMatch = body.match(/(?:From|Sender|Payer)(?:\s*Name)?[:\s]+([A-Za-z\s.'-]+?)(?:\n|\r|<br|$)/i);
    if (bodyMatch && bodyMatch[1] && bodyMatch[1].trim().length > 1) {
      return bodyMatch[1].trim();
    }

    return 'Verified UPI User';
  }

  /**
   * Parses timestamp from internalDate epoch or Date header
   */
  public extractReceivedDate(raw: RawEmailInput): Date {
    if (raw.internalDate) {
      const epoch = typeof raw.internalDate === 'string' ? parseInt(raw.internalDate, 10) : raw.internalDate;
      if (!isNaN(epoch) && epoch > 0) {
        return new Date(epoch);
      }
    }

    if (raw.dateHeader) {
      const parsed = new Date(raw.dateHeader);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    return new Date();
  }

  /**
   * Clean text representation from HTML bodies
   */
  public stripHtml(html: string): string {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#8377;/g, '₹')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Parses a raw email payload and returns validated payment details
   */
  public parseEmail(raw: RawEmailInput): ParsedSlicePayment {
    if (!this.isSliceSender(raw.from)) {
      throw new Error(`Email sender '${raw.from}' does not match ${SliceEmailParser.ALLOWED_SENDER}`);
    }

    const decodedSubject = this.decodeMimeWord(raw.subject);
    if (!this.hasReceivedSubject(decodedSubject)) {
      throw new Error(`Subject does not match required format: '${decodedSubject}'`);
    }

    const decodedBody = this.decodeQuotedPrintable(raw.body);
    const cleanBodyText = this.stripHtml(decodedBody);
    const combinedContent = `${decodedSubject}\n${cleanBodyText}\n${decodedBody}`;

    const amount = this.extractAmount(decodedSubject) || this.extractAmount(cleanBodyText);
    if (!amount) {
      throw new Error(`Unable to extract monetary amount from email: '${decodedSubject}'`);
    }

    const rrn = this.extractRrn(cleanBodyText) || this.extractRrn(decodedSubject);
    if (!rrn) {
      throw new Error('Unable to extract 12-digit UPI RRN / Reference number from email');
    }

    const senderName = this.extractSenderName(decodedSubject, cleanBodyText);
    const receivedAt = this.extractReceivedDate(raw);

    return {
      gmailMessageId: raw.gmailMessageId,
      senderEmail: SliceEmailParser.ALLOWED_SENDER,
      subject: decodedSubject,
      amount,
      senderName,
      rrn,
      receivedAt,
    };
  }
}

export const sliceParser = new SliceEmailParser();
