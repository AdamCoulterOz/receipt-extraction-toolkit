import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { transformReceipt, validateReceipt, SCHEMA_VERSION } from '../receipt.js';

function loadFixture(name: string) {
  const p = path.resolve(__dirname, name);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

describe('transformReceipt', () => {
  const api = loadFixture('fixtures.sample-receipt.json');
  const receipt = transformReceipt(api);
  it('adds meta with schemaVersion and hash', () => {
    expect(receipt.meta.schemaVersion).toBe(SCHEMA_VERSION);
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
});
