import { describe, it, expect } from 'vitest';
import { transformReceipt, validateReceipt, redactReceipt } from '../receipt.js';
import raw from './kmart.raw.fixture.json';

describe('Kmart raw receipt integration', () => {
  it('transforms and validates the raw receipt data', () => {
    const receipt = transformReceipt(raw);
    // Item quantity fallback: quantity_purchased 0 -> should become 1 except explicit >0 entries
    const quantities = receipt.items.map(i => i.quantity);
    expect(quantities).toEqual([1,1,2,1]);
    // Totals
    expect(receipt.totals.total).toBeCloseTo(110.3, 2);
    expect(receipt.totals.taxTotal).toBeCloseTo(10.03, 2);
    // Payment summary
    expect(receipt.paymentSummary.totalPaid).toBeCloseTo(110.3, 2);
    expect(receipt.paymentSummary.methods).toContain('VISA');
    // Loyalty extraction
    expect(receipt.loyaltyPrograms?.[0].program).toBe('flybuys');
    expect(receipt.loyaltyPrograms?.[0].maskedId).toContain('7110');
    // Redaction run should not throw
    redactReceipt(receipt, { enforce: true });
    const validation = validateReceipt(receipt);
    expect(validation.validationSuccess).toBe(true);
    // After discount inference and correct itemCount evaluation, there should be no integrity issues.
    expect(validation.issues).toHaveLength(0);
  });
});
