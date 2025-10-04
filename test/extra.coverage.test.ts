import { describe, it, expect } from 'vitest';
import { transformReceipt, redactReceipt, validateReceipt, computeReceiptId } from '../receipt.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'node:path';

// Helper to build a synthetic API receipt
function buildApi(overrides: any = {}) {
  return {
    currency_code: 'AUD',
    basket_items: [
      { product: { name: 'Dup Item', pricing: { price: 5.00, currency_code: 'AUD', discount: 0.5 }, quantity_purchased: 1, item_properties: [{ title: 'SKU: D-01' }] } },
      // Second item intentionally identical key fields (name, sku, unitPrice, currency) so it aggregates
      { product: { name: 'Dup Item', pricing: { price: 5.00, currency_code: 'AUD' }, quantity_purchased: 2, item_properties: [{ title: 'SKU: D-01' }] } },
      { product: { name: 'Apple Pay Thing', pricing: { price: 2.00, currency_code: 'AUD' }, quantity_purchased: 1 } },
    ],
    payments: [
      { name: 'MASTERCARD (**** 2222)', amount: 5.50, payment_method_type: 'MASTERCARD' },
      { name: 'AMERICAN EXPRESS (**** 3333)', amount: 3.50, payment_method_type: 'AMERICAN EXPRESS' },
      { name: 'Apple Pay (**** 4444)', amount: 3.00, payment_method_type: 'APPLE PAY' },
    ],
    total_price: 12.00,
    total_tax: 1.09,
    tax_details: [ { title: 'GST', amount: { price: 1.09, tax_type: 'GST' } } ],
    merchant_detail: { phone_number: '0299912345', abn: '12 999 888 777', address: { street: 'X', suburb: 'Y', state: 'NSW', postcode: '2000', country_code: 'AU' } },
    root_merchant: { trading_name: 'Synthetic Merchant' },
    raw_payment_data: 'MERCHANT ID: 12345\nTERMINAL ID: T987\nSTAN: 555\nRRN: 999\nAUTH: OK123\nACCT TYPE: CREDIT\nTRANS TYPE: PURCHASE',
    total_discount: 1.25,
    ...overrides,
  };
}

describe('additional coverage paths', () => {
  it('aggregates duplicate items and normalizes multiple payment methods', () => {
    const api = buildApi();
    const receipt = transformReceipt(api);
    // Items length 3 but aggregated should collapse duplicates to fewer
    expect(receipt.items.length).toBe(3);
    expect(receipt.aggregatedItems.length).toBe(2); // one aggregated row for the two dup items + one for Apple Pay
    // Methods normalized
    expect(receipt.paymentSummary.methods).toEqual(expect.arrayContaining(['MASTERCARD','AMEX','APPLE_PAY']));
    // Payment card meta parsed
    expect(receipt.paymentCardMeta?.merchantId).toBe('12345');
    expect(receipt.paymentCardMeta?.terminalId).toBe('T987');
  });

  it('redaction masks fields and enforces no residual long digit sequences', () => {
    const api = buildApi();
    const receipt = transformReceipt(api);
    // Force an over-exposed maskedCard to trigger branch
    receipt.payments[0].maskedCard = '**** 123456';
    redactReceipt(receipt); // should correct maskedCard pattern
    expect(receipt.payments[0].maskedCard).toMatch(/\*{4} \d{4}$/);
    // Enforce should NOT throw after redaction masking
    expect(() => redactReceipt(receipt, { enforce: true })).not.toThrow();
  });

  it('computeReceiptId deterministic fallback when no external_id', () => {
    const base = buildApi();
    delete (base as any).external_id;
    const r1 = transformReceipt(base);
    const r2 = transformReceipt(base);
    expect(r1.meta.receiptId).toBe(r2.meta.receiptId);
  });

  it('validation detects integrity issues when aggregated sums diverge', () => {
    const api = buildApi();
    const receipt = transformReceipt(api);
    // Tamper aggregatedItems to cause mismatch
    if (receipt.aggregatedItems.length) {
      receipt.aggregatedItems[0].lineTotal += 10;
    }
    const val = validateReceipt(receipt);
    expect(val.issues.some(i => i.includes('aggregatedSum'))).toBe(true);
  });

  it('integrity detects itemCount mismatch and subtotal+tax mismatch', () => {
    const api = buildApi();
    const receipt = transformReceipt(api);
    // Tamper itemCount
    receipt.totals.itemCount = (receipt.items.length || 0) + 5;
    // Tamper subtotal vs total
    if (receipt.totals.subtotal != null && receipt.totals.taxTotal != null) {
      receipt.totals.subtotal = (receipt.totals.subtotal || 0) + 3;
    }
    const val = validateReceipt(receipt);
    expect(val.issues.some(i => i.includes('itemCount'))).toBe(true);
    if (receipt.totals.subtotal != null && receipt.totals.taxTotal != null) {
      expect(val.issues.some(i => i.includes('subtotal + tax'))).toBe(true);
    }
  });

  it('validation surfaces schema issues for invalid item quantity', () => {
    const api = buildApi();
    const receipt = transformReceipt(api);
    receipt.items[0].quantity = -5 as any; // force invalid
    const val = validateReceipt(receipt);
    expect(val.validationSuccess).toBe(false);
    expect(val.issues.find(i => i.includes('items') && i.includes('quantity'))).toBeTruthy();
  });

});

describe('branch coverage expansions', () => {
  it('covers normalizeMethod branches for GOOGLE_PAY and fallback', () => {
    const api: any = buildApi({
      payments: [
        { name: 'Google Pay (**** 9999)', amount: 1.00, payment_method_type: 'GOOGLE PAY' },
        { name: 'WeirdThing (**** 1234)', amount: 2.00, payment_method_type: 'WeirdThing' }
      ],
      total_price: 3.00,
      total_tax: 0.27,
      tax_details: [{ title: 'GST', amount: { price: 0.27, tax_type: 'GST' } }]
    });
    const r = transformReceipt(api);
    expect(r.paymentSummary.methods).toEqual(expect.arrayContaining(['GOOGLE_PAY', 'WEIRDTHING']));
  });

  it('handles zero quantity fallback to 1 and missing payments', () => {
    const api: any = {
      currency_code: 'AUD',
      basket_items: [ { product: { name: 'ZeroQty', pricing: { price: 4, currency_code: 'AUD' }, quantity_purchased: 0 } } ],
      total_price: 4,
      total_tax: 0.36,
      tax_details: [ { title: 'GST', amount: { price: 0.36, tax_type: 'GST' } } ],
      merchant_detail: { phone_number: '0212345678', abn: '12 345 678 999' },
      root_merchant: { trading_name: 'Zero Co' }
    };
    const r = transformReceipt(api);
    expect(r.items[0].quantity).toBe(1);
    expect(r.payments.length).toBe(0);
  });

  it('parses tax line where amount is a plain number', () => {
    const api: any = buildApi({ tax_details: [ { title: 'GST', amount: 1.11 } ], total_tax: 1.11 });
    const r = transformReceipt(api);
    expect(r.totals.taxes?.[0].amount).toBe(1.11);
  });

  it('omits address & returns policy when absent, includes when present', () => {
    const base: any = buildApi();
    // Without address & returns
    delete base.merchant_detail.address;
    delete base.returns;
    let r = transformReceipt(base);
    expect(r.merchant.address).toBeUndefined();
    // With returns policy
    base.returns = { return_barcode: 'ABC123', return_period: 30, return_policy_text: 'Return within 30 days' };
    r = transformReceipt(base);
    expect(r.returnsPolicy?.periodDays).toBe(30);
  });

  it('extracts loyalty masked ID from description', () => {
    const api: any = buildApi({ loyalty: [ { title: 'VIP', description: 'Thank you Loyalty ID: ****9999' } ] });
    const r = transformReceipt(api);
    expect(r.loyaltyPrograms?.[0].maskedId).toContain('9999');
  });

  it('redaction enforce path does not throw after masking phone and abn', () => {
    const api: any = buildApi({ merchant_detail: { phone_number: '029991234567890', abn: '12 999 888 777' } });
    const r = transformReceipt(api);
    expect(() => redactReceipt(r, { enforce: true })).not.toThrow();
  });

  it('subtotal undefined path when taxTotal missing', () => {
    const api: any = buildApi();
    delete api.total_tax;
    delete api.tax_details;
    const r = transformReceipt(api);
    expect(r.totals.subtotal).toBeUndefined();
  });

  it('handles short phone/abn (no masking change branch)', () => {
    const api: any = buildApi({ merchant_detail: { phone_number: '1234', abn: '1234' } });
    const r = transformReceipt(api);
    const beforePhone = r.merchant.phone;
    const beforeAbn = r.merchant.abn;
    redactReceipt(r);
    expect(r.merchant.phone).toBe(beforePhone); // unchanged
    expect(r.merchant.abn).toBe(beforeAbn); // unchanged
  });

  it('missing tax_details but taxTotal present (branch)', () => {
    const api: any = buildApi();
    delete api.tax_details; // keep total_tax
    const r = transformReceipt(api);
    expect(r.totals.taxTotal).toBeDefined();
    expect(r.totals.taxes.length).toBe(0);
  });


  it('computeReceiptId fallback on error path', () => {
    const badApi: any = { get external_id() { throw new Error('boom'); }, total_price: 10, issued_at: 1 };
    const id = computeReceiptId(badApi, { rawHash: 'abc' });
    expect(id).toMatch(/^[a-f0-9-]{36}$/); // uuid fallback
  });
});

describe('additional branch stress', () => {
  it('discount branch: present numeric vs absent vs non-numeric', () => {
    const withDiscount = buildApi({ total_discount: 2.5 });
    const r1 = transformReceipt(withDiscount);
    expect(r1.totals.discountTotal).toBe(2.5);
    const noDiscount = buildApi({});
    delete (noDiscount as any).total_discount;
    const r2 = transformReceipt(noDiscount);
    expect(r2.totals.discountTotal).toBeNull();
    const badDiscount = buildApi({ total_discount: 'N/A' });
    const r3 = transformReceipt(badDiscount);
    expect(r3.totals.discountTotal).toBeNull();
  });

  it('payment branches: undefined method & no masked digits', () => {
    const api: any = buildApi({ payments: [ { name: 'UNKNOWNPAY', amount: 1.23 } ], total_price: 1.23, total_tax: 0.11, tax_details: [{ title:'GST', amount:{ price:0.11, tax_type:'GST'}}] });
    const r = transformReceipt(api);
    expect(r.payments[0].method).toBe('UNKNOWNPAY'); // fallback uppercase path
    expect(r.payments[0].maskedCard).toBeUndefined();
  });

  it('loyalty filtering drops empty entries', () => {
    const api: any = buildApi({ loyalty: [ { title: '', description: '' }, { title: 'VIP', description: '' } ] });
    const r = transformReceipt(api);
    expect(r.loyaltyPrograms?.length).toBe(1);
  });

  it('integrity mismatch for sum(lineTotals) triggers issue', () => {
    const api = buildApi();
    const r = transformReceipt(api);
    // Tamper totals.total
    r.totals.total += 5;
    // Also tamper an item lineTotal to keep aggregated sums original vs modified
    r.items[0].lineTotal += 1;
    const v = validateReceipt(r);
    expect(v.issues.some(i => i.includes('sum(lineTotals)'))).toBe(true);
  });

  it('totalPaid mismatch triggers issue', () => {
    const api = buildApi();
    api.payments = [ { name: 'VISA (**** 1234)', amount: 0.5, payment_method_type: 'VISA' } ];
    api.total_price = 5;
    api.total_tax = 0.45;
    api.tax_details = [{ title: 'GST', amount: { price: 0.45, tax_type: 'GST' } }];
    const r = transformReceipt(api);
    const v = validateReceipt(r);
    expect(v.issues.some(i => i.includes('totalPaid'))).toBe(true);
  });

  it('handles payment with empty method -> undefined fallback', () => {
    const api: any = buildApi({ payments: [ { name: '', amount: 1.00 } ], total_price: 1, total_tax: 0.09, tax_details: [{ title:'GST', amount:{ price:0.09, tax_type:'GST'}}] });
    const r = transformReceipt(api);
    expect(r.payments[0].method).toBeUndefined();
  });

  it('missing basket_items yields zero items and aggregatedItems', () => {
    const api: any = buildApi();
    delete api.basket_items;
    const r = transformReceipt(api);
    expect(r.items.length).toBe(0);
    expect(r.aggregatedItems.length).toBe(0);
  });

  it('negative quantity coerces to 1', () => {
    const api: any = buildApi({ basket_items: [ { product: { name: 'Neg', pricing: { price: 3, currency_code: 'AUD' }, quantity_purchased: -5, item_properties: [{ title: 'SKU: N-1' }, { bogus: 'ignore' }] } } ] });
    const r = transformReceipt(api);
    expect(r.items[0].quantity).toBe(1);
  });
});
