import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createHash } from 'node:crypto';
import fs from 'fs/promises';
import path from 'node:path';

// ----------------------
// Schema / Version Meta
// ----------------------
export const SCHEMA_VERSION = '1.0.0';

// ----------------------
// Domain Types
// ----------------------
export interface ReceiptItem {
  name: string;
  sku?: string; apn?: string; colour?: string; size?: string;
  unitPrice: number; unitPriceFormatted: string;
  quantity: number; lineTotal: number; lineTotalFormatted: string;
  discount?: number; tax?: number; currency: string;
}
export interface AggregatedItem extends Omit<ReceiptItem, 'lineTotal' | 'lineTotalFormatted'> {
  lineTotal: number; lineTotalFormatted: string;
}
export interface TaxLine { title?: string; amount: number; amountFormatted: string; type?: string; }
export interface PaymentDetail { method?: string; maskedCard?: string; amount: number; amountFormatted: string; rawName?: string; type?: string; }
export interface PaymentCardMeta { merchantId?: string; terminalId?: string; stan?: string; rrn?: string; authCode?: string; accountType?: string; transactionType?: string; rawText?: string; }
export interface ReturnsPolicy { barcode?: string; periodDays?: number; policyText?: string; }
export interface LoyaltyProgram { program?: string; maskedId?: string; }
export interface StoreAddress { street?: string; street2?: string; suburb?: string; state?: string; postcode?: string; countryCode?: string; full?: string; }
export interface ReceiptTotals { currency: string; total: number; totalFormatted: string; subtotal?: number; subtotalFormatted?: string; taxTotal?: number; taxTotalFormatted?: string; discountTotal?: number | null; itemCount?: number; computedItemQuantity?: number; taxes?: TaxLine[]; }
export interface ReceiptIdentities { externalReceiptId?: string; orderNumber?: string; receiptType?: string; isTaxInvoice?: boolean; }
export interface ReceiptTimestamps { issuedAtEpoch?: number; issuedAtISO?: string; issuedDate?: string; issuedTime?: string; timezone?: string; }
export interface MerchantInfo { merchantName?: string; storeName?: string; abn?: string; phone?: string; address?: StoreAddress; }
export interface ReceiptMeta { schemaVersion: string; source: 'slyp'; fetchedAtISO: string; rawHash?: string; }
export interface Receipt {
  meta: ReceiptMeta;
  identities: ReceiptIdentities;
  timestamps: ReceiptTimestamps;
  merchant: MerchantInfo;
  totals: ReceiptTotals;
  items: ReceiptItem[];
  aggregatedItems: AggregatedItem[];
  payments: PaymentDetail[];
  paymentSummary: { totalPaid: number; totalPaidFormatted: string; methods: string[]; };
  paymentCardMeta?: PaymentCardMeta;
  returnsPolicy?: ReturnsPolicy;
  loyaltyPrograms?: LoyaltyProgram[];
  notes?: string[];
}

// ----------------------
// Utilities
// ----------------------
const fmtMoney = (amount: number, ccy: string) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: ccy }).format(amount);
const normalizeMethod = (s?: string) => {
  const x = (s || '').toUpperCase();
  if (/VISA/.test(x)) return 'VISA';
  if (/MASTERCARD|MC/.test(x)) return 'MASTERCARD';
  if (/AMEX|AMERICAN EXPRESS/.test(x)) return 'AMEX';
  if (/APPLE PAY/.test(x)) return 'APPLE_PAY';
  if (/GOOGLE PAY|G PAY/.test(x)) return 'GOOGLE_PAY';
  return x || undefined;
};
const round2 = (n: number) => Number(n.toFixed(2));

function parseRawPaymentMeta(raw?: string): PaymentCardMeta | undefined {
  if (!raw) return undefined;
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const meta: PaymentCardMeta = { rawText: raw };
  const grab = (re: RegExp) => { const line = lines.find(l => re.test(l)); if (!line) return undefined; const [, val] = line.match(re) || []; return val?.trim(); };
  meta.merchantId = grab(/^MERCHANT ID:\s*(.+)$/i);
  meta.terminalId = grab(/^TERMINAL ID:\s*(.+)$/i);
  meta.stan = grab(/^STAN:\s*(.+)$/i);
  meta.rrn = grab(/^RRN:\s*(.+)$/i);
  meta.authCode = grab(/^AUTH:\s*(.+)$/i);
  meta.accountType = grab(/^ACCT TYPE:\s*(.+)$/i);
  meta.transactionType = grab(/^TRANS TYPE:\s*(.+)$/i);
  return meta;
}

// ----------------------
// Zod Schema
// ----------------------
const zAddress = z.object({ street: z.string().optional(), street2: z.string().optional(), suburb: z.string().optional(), state: z.string().optional(), postcode: z.string().optional(), countryCode: z.string().optional(), full: z.string().optional() });
const zReceiptItem = z.object({ name: z.string(), sku: z.string().optional(), apn: z.string().optional(), colour: z.string().optional(), size: z.string().optional(), unitPrice: z.number(), unitPriceFormatted: z.string(), quantity: z.number().int().positive(), lineTotal: z.number(), lineTotalFormatted: z.string(), discount: z.number().optional(), tax: z.number().optional(), currency: z.string() });
const zTaxLine = z.object({ title: z.string().optional(), type: z.string().optional(), amount: z.number(), amountFormatted: z.string() });
const zPaymentDetail = z.object({ method: z.string().optional(), maskedCard: z.string().optional(), amount: z.number(), amountFormatted: z.string(), rawName: z.string().optional(), type: z.string().optional() });
const zPaymentSummary = z.object({ totalPaid: z.number(), totalPaidFormatted: z.string(), methods: z.array(z.string()) });
const zTotals = z.object({ currency: z.string(), total: z.number(), totalFormatted: z.string(), subtotal: z.number().optional(), subtotalFormatted: z.string().optional(), taxTotal: z.number().optional(), taxTotalFormatted: z.string().optional(), discountTotal: z.number().nullable().optional(), itemCount: z.number().int().nonnegative().optional(), computedItemQuantity: z.number().int().nonnegative().optional(), taxes: z.array(zTaxLine) });
const zIdentities = z.object({ externalReceiptId: z.string().optional(), orderNumber: z.string().optional(), receiptType: z.string().optional(), isTaxInvoice: z.boolean().optional() });
const zTimestamps = z.object({ issuedAtEpoch: z.number().optional(), issuedAtISO: z.string().optional(), issuedDate: z.string().optional(), issuedTime: z.string().optional(), timezone: z.string().optional() });
const zMerchant = z.object({ merchantName: z.string().optional(), storeName: z.string().optional(), abn: z.string().optional(), phone: z.string().optional(), address: zAddress.optional() });
const zPaymentCardMeta = z.object({ merchantId: z.string().optional(), terminalId: z.string().optional(), stan: z.string().optional(), rrn: z.string().optional(), authCode: z.string().optional(), accountType: z.string().optional(), transactionType: z.string().optional(), rawText: z.string().optional() });
const zReturnsPolicy = z.object({ barcode: z.string().optional(), periodDays: z.number().optional(), policyText: z.string().optional() });
const zLoyalty = z.object({ program: z.string().optional(), maskedId: z.string().optional() });
const zAggregatedItem = zReceiptItem; // identical currently
const zMeta = z.object({ schemaVersion: z.string(), source: z.literal('slyp'), fetchedAtISO: z.string(), rawHash: z.string().optional() });
export const zReceipt = z.object({
  meta: zMeta,
  identities: zIdentities,
  timestamps: zTimestamps,
  merchant: zMerchant,
  totals: zTotals,
  items: z.array(zReceiptItem),
  aggregatedItems: z.array(zAggregatedItem),
  payments: z.array(zPaymentDetail),
  paymentSummary: zPaymentSummary,
  paymentCardMeta: zPaymentCardMeta.optional(),
  returnsPolicy: zReturnsPolicy.optional(),
  loyaltyPrograms: z.array(zLoyalty).optional(),
  notes: z.array(z.string()).optional().nullable(),
});

// ----------------------
// Transform
// ----------------------
export function transformReceipt(apiReceiptData: any, opts?: { schemaVersion?: string }): Receipt {
  const rawItems = Array.isArray(apiReceiptData?.basket_items) ? apiReceiptData.basket_items : [];
  const items: ReceiptItem[] = rawItems.map((entry: any) => {
    const product = entry.product || {};
    const pricing = product.pricing || {};
    const rawQty: number | undefined = typeof product.quantity_purchased === 'number' ? product.quantity_purchased : undefined;
    const quantity = (rawQty && rawQty > 0) ? rawQty : 1;
    const unitPriceRaw: number = typeof pricing.price === 'number' ? pricing.price : 0;
    const unitPrice = round2(unitPriceRaw);
    const currencyGuess = pricing.currency_code || apiReceiptData?.currency_code || 'AUD';
    const unitPriceFormatted = fmtMoney(unitPrice, currencyGuess);
    const lineTotal = round2(unitPrice * quantity);
    const lineTotalFormatted = fmtMoney(lineTotal, currencyGuess);
    const itemProps: any[] = product.item_properties || [];
    const propMap: Record<string, string> = {};
    itemProps.forEach(p => { if (p?.title) { const [k, ...rest] = p.title.split(':'); if (k && rest.length) propMap[k.trim()] = rest.join(':').trim(); } });
    return { name: product.name || product.title || 'Unknown Item', sku: propMap['SKU'], apn: propMap['APN'], colour: propMap['Colour'], size: propMap['Size'], unitPrice, unitPriceFormatted, quantity, lineTotal, lineTotalFormatted, discount: typeof pricing.discount === 'number' ? pricing.discount : undefined, tax: typeof pricing.tax === 'number' ? pricing.tax : undefined, currency: currencyGuess } as ReceiptItem;
  });

  // Aggregation
  const aggregatedMap = new Map<string, AggregatedItem>();
  for (const it of items) {
    const key = [it.name, it.sku, it.apn, it.colour, it.size, it.unitPrice, it.currency].join('|');
    const existing = aggregatedMap.get(key);
    if (!existing) aggregatedMap.set(key, { ...it });
    else { existing.quantity += it.quantity; existing.lineTotal = round2(existing.lineTotal + it.lineTotal); existing.lineTotalFormatted = fmtMoney(existing.lineTotal, it.currency); }
  }
  const aggregatedItems = Array.from(aggregatedMap.values());

  // Taxes
  const taxLines: TaxLine[] = (apiReceiptData?.tax_details || []).map((t: any) => {
    const amountNum = typeof t?.amount?.price === 'number' ? t.amount.price : (typeof t?.amount === 'number' ? t.amount : 0);
    return { title: t.title, type: t.tax_type || t.amount?.tax_type, amount: amountNum, amountFormatted: amountNum.toFixed(2) } as TaxLine;
  });

  // Payments
  const paymentDetails: PaymentDetail[] = (apiReceiptData?.payments || []).map((p: any) => {
    const amountNum = round2(typeof p.amount === 'number' ? p.amount : 0);
    const rawName: string = p.name || '';
    const digitsMatch = rawName.match(/\*+(\d{2,4})/);
    const maskedCard = digitsMatch ? `**** *${digitsMatch[1]}` : undefined;
    const methodMatch = rawName.match(/^([A-Za-z ]+?)(?:\s*\(|$)/);
    const methodGuess = p.payment_method_type || (methodMatch ? methodMatch[1].trim() : undefined);
    const method = normalizeMethod(methodGuess);
    return { method, maskedCard, amount: amountNum, amountFormatted: fmtMoney(amountNum, apiReceiptData?.currency_code || 'AUD'), rawName, type: p.payment_type || p.payment_method_type } as PaymentDetail;
  });

  // Totals
  const discountAny = apiReceiptData?.total_discount;
  let discountTotal: number | null = null;
  if (discountAny != null) { const dNum = Number(discountAny); if (Number.isFinite(dNum)) discountTotal = dNum; }
  const currency = apiReceiptData?.currency_code || items[0]?.currency || 'AUD';
  const taxTotalRaw = typeof apiReceiptData?.total_tax === 'number' ? apiReceiptData.total_tax : undefined;
  const taxTotal = taxTotalRaw != null ? round2(taxTotalRaw) : undefined;
  const totalValRaw = typeof apiReceiptData?.total_price === 'number' ? apiReceiptData.total_price : 0;
  const totalVal = round2(totalValRaw);
  const subtotalVal = (taxTotal != null) ? round2(totalVal - taxTotal) : undefined;
  const totalPaid = round2(paymentDetails.reduce((acc, p) => acc + p.amount, 0));

  // Timestamps
  const issuedAtEpoch = typeof apiReceiptData?.issued_at === 'number' ? apiReceiptData.issued_at : undefined;
  const issuedAtISO = apiReceiptData?.issued_at_iso;
  let issuedDate: string | undefined; let issuedTime: string | undefined;
  if (issuedAtISO) { const d = new Date(issuedAtISO); if (!isNaN(d.getTime())) { issuedDate = d.toISOString().slice(0,10); issuedTime = d.toISOString().slice(11,16); } }
  else if (issuedAtEpoch) { const d = new Date(issuedAtEpoch * 1000); issuedDate = d.toISOString().slice(0,10); issuedTime = d.toISOString().slice(11,16); }

  // Address
  const addrSrc = apiReceiptData?.merchant_detail?.address || {};
  const address: StoreAddress | undefined = Object.keys(addrSrc).length ? { street: addrSrc.street || undefined, street2: addrSrc.street_2 || undefined, suburb: addrSrc.suburb || undefined, state: addrSrc.state || undefined, postcode: addrSrc.postcode || undefined, countryCode: addrSrc.country_code || undefined, full: [addrSrc.street, addrSrc.street_2, addrSrc.suburb, addrSrc.state, addrSrc.postcode].filter(Boolean).join(', ') } : undefined;

  // Returns
  const returnsPolicy: ReturnsPolicy | undefined = apiReceiptData?.returns ? { barcode: apiReceiptData.returns.return_barcode || undefined, periodDays: apiReceiptData.returns.return_period || undefined, policyText: apiReceiptData.returns.return_policy_text || undefined } : undefined;

  // Loyalty
  const loyaltyPrograms: LoyaltyProgram[] = (apiReceiptData?.loyalty || []).map((l: any) => {
    let maskedId: string | undefined;
    if (typeof l.description === 'string') { const m = l.description.match(/Loyalty ID:\s*(.*)$/i); if (m) maskedId = m[1].trim(); }
    return { program: l.title, maskedId } as LoyaltyProgram; }).filter(l => l.program || l.maskedId);

  // Payment meta
  const paymentCardMeta = parseRawPaymentMeta(apiReceiptData?.raw_payment_data);

  const cleanReceipt: Receipt = {
    meta: { schemaVersion: opts?.schemaVersion || SCHEMA_VERSION, source: 'slyp', fetchedAtISO: new Date().toISOString(), rawHash: sha256Object(apiReceiptData) },
    identities: { externalReceiptId: apiReceiptData?.external_id, orderNumber: apiReceiptData?.order_number_detail?.value || apiReceiptData?.order_number_detail?.order_number, receiptType: apiReceiptData?.receipt_type, isTaxInvoice: !!apiReceiptData?.is_tax_invoice },
    timestamps: { issuedAtEpoch, issuedAtISO, issuedDate, issuedTime, timezone: apiReceiptData?.merchant_detail?.timezone || apiReceiptData?.issued_at_timezone },
    merchant: { merchantName: apiReceiptData?.root_merchant?.trading_name || apiReceiptData?.issuing_merchant?.trading_name, storeName: apiReceiptData?.store?.name || apiReceiptData?.merchant_detail?.name, abn: apiReceiptData?.merchant_detail?.abn, phone: apiReceiptData?.merchant_detail?.phone_number, address },
    totals: { currency, total: totalVal, totalFormatted: fmtMoney(totalVal, currency), subtotal: subtotalVal, subtotalFormatted: subtotalVal != null ? fmtMoney(subtotalVal, currency) : undefined, taxTotal, taxTotalFormatted: taxTotal != null ? fmtMoney(taxTotal, currency) : undefined, discountTotal, itemCount: typeof apiReceiptData?.item_count === 'number' ? apiReceiptData.item_count : items.length, computedItemQuantity: items.reduce((a, i) => a + i.quantity, 0), taxes: taxLines.map(t => ({ ...t, amountFormatted: fmtMoney(t.amount, currency) })) },
    items,
    aggregatedItems,
    payments: paymentDetails,
    paymentSummary: { totalPaid, totalPaidFormatted: fmtMoney(totalPaid, currency), methods: Array.from(new Set(paymentDetails.map(p => p.method).filter(Boolean))) as string[] },
    paymentCardMeta,
    returnsPolicy,
    loyaltyPrograms: loyaltyPrograms.length ? loyaltyPrograms : undefined,
    notes: undefined,
  };
  return cleanReceipt;
}

// Hash helper
function sha256Object(obj: any): string | undefined {
  try { const h = createHash('sha256'); h.update(JSON.stringify(obj)); return h.digest('hex'); } catch { return undefined; }
}

// ----------------------
// Validation & Integrity
// ----------------------
export function validateReceipt(receipt: Receipt) {
  const validation = zReceipt.safeParse(receipt);
  const issues: string[] = [];
  if (!validation.success) validation.error.issues.forEach(i => issues.push(`${i.path.join('.')} - ${i.message}`));
  // integrity checks
  const sumLineTotals = round2(receipt.items.reduce((a,i)=>a+i.lineTotal,0));
  if (Math.abs(sumLineTotals - receipt.totals.total) > 0.01) issues.push(`sum(lineTotals)=${sumLineTotals.toFixed(2)} != total=${receipt.totals.total.toFixed(2)}`);
  const totalPaid = round2(receipt.payments.reduce((a,p)=>a+p.amount,0));
  if (Math.abs(totalPaid - receipt.totals.total) > 0.01) issues.push(`totalPaid=${totalPaid.toFixed(2)} != total=${receipt.totals.total.toFixed(2)}`);
  if (receipt.totals.subtotal != null && receipt.totals.taxTotal != null) {
    const recombined = round2(receipt.totals.subtotal + receipt.totals.taxTotal);
    if (Math.abs(recombined - receipt.totals.total) > 0.01) issues.push(`subtotal + tax (${recombined.toFixed(2)}) != total (${receipt.totals.total.toFixed(2)})`);
  }
  if (receipt.totals.itemCount != null && receipt.totals.itemCount !== receipt.items.length) issues.push(`itemCount=${receipt.totals.itemCount} != items.length=${receipt.items.length}`);
  const aggregatedSum = round2(receipt.aggregatedItems.reduce((a,i)=>a+i.lineTotal,0));
  if (Math.abs(aggregatedSum - sumLineTotals) > 0.01) issues.push(`aggregatedSum=${aggregatedSum.toFixed(2)} != sumLineTotals=${sumLineTotals.toFixed(2)}`);
  return { validationSuccess: validation.success, issues, sums: { sumLineTotals, aggregatedSum, totalPaid, total: receipt.totals.total, subtotal: receipt.totals.subtotal, taxTotal: receipt.totals.taxTotal } };
}

// ----------------------
// JSON Schema Emission
// ----------------------
export async function writeJsonSchema(outDir: string) {
  try {
    const schema = zodToJsonSchema(zReceipt, 'Receipt');
    (schema as any).$id = `https://schemas.local/receipt/${SCHEMA_VERSION}/receipt.schema.json`;
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, 'receipt.schema.json'), JSON.stringify(schema, null, 2), 'utf-8');
  } catch {/* ignore */}
}
