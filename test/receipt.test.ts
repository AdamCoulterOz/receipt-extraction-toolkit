import { describe, it, expect } from 'vitest';
import { transformReceipt, validateReceipt, SCHEMA_VERSION, TRANSFORM_VERSION, redactReceipt, computeReceiptId } from '../receipt.js';
import sampleReceipt from './fixtures.sample-receipt.json';
import invalidTotal from './fixtures.invalid-total.json';
import multiPayment from './fixtures.multi-payment.json';

describe('transformReceipt', () => {
  const receipt = transformReceipt(sampleReceipt);

  it('adds meta with schemaVersion, transformVersion and hash', () => {
    expect(receipt.meta.schemaVersion).toBe(SCHEMA_VERSION);
    expect(receipt.meta.transformVersion).toBe(TRANSFORM_VERSION);
    expect(receipt.meta.rawHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('computes totals and item aggregation correctly', () => {
    expect(receipt.items.length).toBe(2);
    expect(receipt.totals.total).toBeCloseTo(30.15, 2);
    expect(receipt.totals.taxTotal).toBeCloseTo(2.74, 2);
    const sumLines = receipt.items.reduce((a,i)=>a+i.lineTotal,0);
    expect(sumLines).toBeCloseTo(receipt.totals.total, 2);
  });

  it('normalizes payment summary', () => {
    expect(receipt.payments.length).toBe(1);
    expect(receipt.paymentSummary.totalPaid).toBeCloseTo(30.15, 2);
    expect(receipt.paymentSummary.methods).toContain('VISA');
  });

  it('validates with no issues', () => {
    const validation = validateReceipt(receipt);
    expect(validation.validationSuccess).toBe(true);
    expect(validation.issues).toHaveLength(0);
  });

  it('produces stable receiptId for same input', () => {
    const r2 = transformReceipt(sampleReceipt, { schemaVersion: SCHEMA_VERSION });
    expect(receipt.meta.receiptId).toBe(r2.meta.receiptId);
  });
});

describe('invalid total detection', () => {
  const receipt = transformReceipt(invalidTotal);
  const validation = validateReceipt(receipt);
  it('flags integrity issue when paid != total', () => {
    expect(validation.validationSuccess).toBe(true); // shape still valid
    const hasMismatch = validation.issues.some(i => i.includes('totalPaid'));
    expect(hasMismatch).toBe(true);
  });
});

describe('redaction & multi-payment', () => {
  const receipt = transformReceipt(multiPayment);
  it('aggregates payments correctly (sum)', () => {
    expect(receipt.payments.length).toBe(2);
    expect(receipt.paymentSummary.totalPaid).toBeCloseTo(receipt.totals.total, 2);
  });
  it('redacts merchant PII fields', () => {
    redactReceipt(receipt, { enforce: true });
    expect(receipt.merchant.phone).toMatch(/\*{3}\d{4}$/);
    if (receipt.merchant.abn) expect(receipt.merchant.abn).toMatch(/\*{3}\d{4}$/);
  });
  it('receiptId consistent with computeReceiptId()', () => {
    const recId = computeReceiptId(multiPayment, { rawHash: receipt.meta.rawHash });
    expect(recId).toBe(receipt.meta.receiptId);
  });
});
