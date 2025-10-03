// scrape-slyp-receipt.ts
// Minimal, API-first extraction of a Slyp receipt.
// (Removes previous DOM heuristics, tracing, raw text + full network capture.)
import * as pw from 'playwright';
import fs from 'fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ---- tiny CLI (no deps) ----
type Cli = { url?: string; outDir?: string; strict?: boolean };
function parseCli(argv: string[]): Cli {
  const out: Cli = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a?.startsWith('--url=')) out.url = a.slice(6);
    else if (a === '--outDir') out.outDir = argv[++i];
    else if (a?.startsWith('--outDir=')) out.outDir = a.slice(9);
    else if (a === '--strict') out.strict = true;
  }
  return out;
}
const cli = parseCli(process.argv.slice(2));

const DEFAULT_URL = 'https://receipts.slyp.com.au/ERA-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyZWNlaXB0WHJlZiI6IlItWC0xZThhOGMwYmVlYjk0OGI5YjBiYjQyZjg2YTYwMzM1OCIsImlhdCI6MTc1OTQ4OTkxMCwiZXhwIjoxNzY0NjczOTEwfQ.p6j9qMGlNs-aSWjecZB_KVPb_ketUMfdbYTgXz_9ajc';
const RECEIPT_URL = cli.url || process.env.SLYP_URL || DEFAULT_URL;

const OUT_DIR = path.resolve(process.cwd(), cli.outDir || 'out');
await fs.mkdir(OUT_DIR, { recursive: true });

const browser = await pw.chromium.launch({ headless: true });
const context = await browser.newContext({
  // Helps some SPAs behave; tweak if needed
  viewport: { width: 1200, height: 1600 },
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36',
});
const page = await context.newPage();

// --- 1) Navigate & directly await the target API response ---
// (Replaced earlier narrow URL matcher with heuristic JSON detector.)
const resp = await page.goto(RECEIPT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
if (!resp || !resp.ok()) {
  console.warn(`[warn] Navigation status: ${resp?.status()} ${resp?.statusText()}`);
}

// Heuristic receipt detector
const isReceiptish = (j: any) =>
  j && typeof j === 'object' &&
  ('total_price' in j || 'basket_items' in j || 'merchant_detail' in j);

let capturedReceiptJson: any | undefined;

const apiResponse = await page
  .waitForResponse(async r => {
    if (!r.ok()) return false;
    const ct = r.headers()['content-type'] ?? '';
    if (!ct.includes('application/json')) return false;
    try {
      // Parse once. Store for reuse; Playwright Response cannot be 'cloned'.
      const j = await r.json();
      if (isReceiptish(j)) {
        capturedReceiptJson = j;
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }, { timeout: 15_000 })
  .catch(() => undefined);

let fallbackUsed = false;
let apiReceiptData: any = undefined;

if (!apiResponse) {
  // Fallback: first OK JSON (best effort)
  const fallback = await page.waitForResponse(r =>
    r.ok() && (r.headers()['content-type'] || '').includes('application/json'),
    { timeout: 10_000 }
  ).catch(() => undefined);
  if (fallback) {
    try {
      apiReceiptData = await fallback.json();
      fallbackUsed = true;
    } catch {
      /* ignore */
    }
  }
} else {
  apiReceiptData = capturedReceiptJson; // already parsed
}

if (!apiReceiptData) {
  console.error('[fatal] Could not obtain receipt API response.');
  await browser.close();
  process.exit(1);
}

if (fallbackUsed) {
  console.warn('[warn] Used fallback JSON response; heuristic receipt detection failed.');
}

// --- Proceed directly to CLEAN functional schema (legacy parsing removed) ---
// Persist raw API for auditing
if (apiReceiptData) {
  await fs.writeFile(
    path.join(OUT_DIR, 'receipt.api.raw.json'),
    JSON.stringify(apiReceiptData, null, 2),
    'utf-8'
  ).catch(() => {});
}

// Clean schema type definitions (functional receipt data only)
interface ReceiptItem {
  name: string;
  sku?: string;
  apn?: string;
  colour?: string;
  size?: string;
  unitPrice: number;        // numeric unit price
  unitPriceFormatted: string; // formatted "$xx.xx"
  quantity: number;         // line quantity (defaulted to 1 if missing/0)
  lineTotal: number;        // unitPrice * quantity
  lineTotalFormatted: string;
  discount?: number;        // numeric discount at unit level (if provided)
  tax?: number;             // numeric tax at unit level (if provided)
  currency: string;
}

interface AggregatedItem extends Omit<ReceiptItem, 'lineTotal' | 'lineTotalFormatted'> {
  lineTotal: number;             // aggregated total
  lineTotalFormatted: string;
}

interface TaxLine {
  title?: string;
  amount: number; // numeric
  amountFormatted: string;
  type?: string;  // e.g. GST, VAT etc.
}

interface PaymentDetail {
  method?: string;        // e.g. VISA
  maskedCard?: string;    // e.g. **** *659
  amount: number;
  amountFormatted: string;
  rawName?: string;       // original payment descriptor (for audit)
  type?: string;          // payment_type or method alias
}

interface PaymentCardMeta {
  merchantId?: string;
  terminalId?: string;
  stan?: string;
  rrn?: string;
  authCode?: string;
  accountType?: string;
  transactionType?: string;
  rawText?: string; // original slip snippet
}

interface ReturnsPolicy {
  barcode?: string;
  periodDays?: number;
  policyText?: string;
}

interface LoyaltyProgram {
  program?: string;       // e.g. flybuys
  maskedId?: string;      // masked membership number
}

interface StoreAddress {
  street?: string;
  street2?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  countryCode?: string;
  full?: string; // convenience, concatenated
}

interface ReceiptTotals {
  currency: string;
  total: number;
  totalFormatted: string;
  subtotal?: number;
  subtotalFormatted?: string;
  taxTotal?: number;
  taxTotalFormatted?: string;
  discountTotal?: number | null;
  itemCount?: number;        // count of line items (as displayed)
  computedItemQuantity?: number; // sum of quantities
  taxes?: TaxLine[];
}

interface ReceiptIdentities {
  externalReceiptId?: string; // original external_id
  orderNumber?: string;       // order_number_detail.value
  receiptType?: string;       // e.g. smart
  isTaxInvoice?: boolean;
}

interface ReceiptTimestamps {
  issuedAtEpoch?: number;
  issuedAtISO?: string;
  issuedDate?: string;   // yyyy-mm-dd
  issuedTime?: string;   // HH:MM (24h) or local preference
  timezone?: string;
}

interface MerchantInfo {
  merchantName?: string;  // trading name
  storeName?: string;     // store.name
  abn?: string;
  phone?: string;
  address?: StoreAddress;
}

interface Receipt {
  identities: ReceiptIdentities;
  timestamps: ReceiptTimestamps;
  merchant: MerchantInfo;
  totals: ReceiptTotals;
  items: ReceiptItem[];
  aggregatedItems: AggregatedItem[]; // grouped by (name, sku, apn, colour, size, unitPrice)
  payments: PaymentDetail[];
  paymentSummary: {
    totalPaid: number;
    totalPaidFormatted: string;
    methods: string[];
  };
  paymentCardMeta?: PaymentCardMeta;
  returnsPolicy?: ReturnsPolicy;
  loyaltyPrograms?: LoyaltyProgram[];
  notes?: string[]; // any extra textual notes (future use)
}

function parseRawPaymentMeta(raw?: string): PaymentCardMeta | undefined {
  if (!raw) return undefined;
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const meta: PaymentCardMeta = { rawText: raw };
  const grab = (re: RegExp) => {
    const line = lines.find(l => re.test(l));
    if (!line) return undefined;
    const [, val] = line.match(re) || [];
    return val?.trim();
  };
  meta.merchantId = grab(/^MERCHANT ID:\s*(.+)$/i);
  meta.terminalId = grab(/^TERMINAL ID:\s*(.+)$/i);
  meta.stan = grab(/^STAN:\s*(.+)$/i);
  meta.rrn = grab(/^RRN:\s*(.+)$/i);
  meta.authCode = grab(/^AUTH:\s*(.+)$/i);
  meta.accountType = grab(/^ACCT TYPE:\s*(.+)$/i);
  meta.transactionType = grab(/^TRANS TYPE:\s*(.+)$/i);
  return meta;
}

// Utility: currency formatting with Intl
const fmtMoney = (amount: number, ccy: string) =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: ccy }).format(amount);

// Normalize payment method names
const normalizeMethod = (s?: string) => {
  const x = (s || '').toUpperCase();
  if (/VISA/.test(x)) return 'VISA';
  if (/MASTERCARD|MC/.test(x)) return 'MASTERCARD';
  if (/AMEX|AMERICAN EXPRESS/.test(x)) return 'AMEX';
  if (/APPLE PAY/.test(x)) return 'APPLE_PAY';
  if (/GOOGLE PAY|G PAY/.test(x)) return 'GOOGLE_PAY';
  return x || undefined;
};

// Rounding helper (round half away from zero via toFixed)
const round2 = (n: number) => Number(n.toFixed(2));

// Build line items (guard basket_items to always be an array)
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
  itemProps.forEach(p => {
    if (p?.title) {
      const [k, ...rest] = p.title.split(':');
      if (k && rest.length) propMap[k.trim()] = rest.join(':').trim();
    }
  });
  return {
    name: product.name || product.title || 'Unknown Item',
    sku: propMap['SKU'],
    apn: propMap['APN'],
    colour: propMap['Colour'],
    size: propMap['Size'],
    unitPrice,
    unitPriceFormatted,
    quantity,
    lineTotal,
    lineTotalFormatted,
    discount: typeof pricing.discount === 'number' ? pricing.discount : undefined,
    tax: typeof pricing.tax === 'number' ? pricing.tax : undefined,
    currency: pricing.currency_code || apiReceiptData?.currency_code || 'AUD',
  } as ReceiptItem;
});

// Aggregated items by a composite key
const aggregatedMap = new Map<string, AggregatedItem>();
for (const it of items) {
  const key = [it.name, it.sku, it.apn, it.colour, it.size, it.unitPrice, it.currency].join('|');
  const existing = aggregatedMap.get(key);
  if (!existing) {
    aggregatedMap.set(key, { ...it });
  } else {
    existing.quantity += it.quantity;
    existing.lineTotal = round2(existing.lineTotal + it.lineTotal);
    existing.lineTotalFormatted = fmtMoney(existing.lineTotal, it.currency);
  }
}
const aggregatedItems = Array.from(aggregatedMap.values());

// Taxes
const taxLines: TaxLine[] = (apiReceiptData?.tax_details || []).map((t: any) => {
  const amountNum = typeof t?.amount?.price === 'number' ? t.amount.price : (typeof t?.amount === 'number' ? t.amount : 0);
  return {
    title: t.title,
    type: t.tax_type || t.amount?.tax_type,
    amount: amountNum,
    // temporary placeholder; final formatting applied via fmtMoney when assembling cleanReceipt
    amountFormatted: amountNum.toFixed(2),
  } as TaxLine;
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
  return {
    method,
    maskedCard,
    amount: amountNum,
    amountFormatted: fmtMoney(amountNum, apiReceiptData?.currency_code || 'AUD'),
    rawName,
    type: p.payment_type || p.payment_method_type,
  } as PaymentDetail;
});

// Totals (harden discount parsing)
const discountAny = apiReceiptData?.total_discount;
let discountTotal: number | null = null;
if (discountAny != null) {
  const dNum = Number(discountAny);
  if (Number.isFinite(dNum)) discountTotal = dNum;
}

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
let issuedDate: string | undefined; // ISO yyyy-mm-dd
let issuedTime: string | undefined; // HH:MM 24h
if (issuedAtISO) {
  const d = new Date(issuedAtISO);
  if (!isNaN(d.getTime())) {
    issuedDate = d.toISOString().slice(0,10);
    issuedTime = d.toISOString().slice(11,16);
  }
} else if (issuedAtEpoch) {
  const d = new Date(issuedAtEpoch * 1000);
  issuedDate = d.toISOString().slice(0,10);
  issuedTime = d.toISOString().slice(11,16);
}

// Address
const addrSrc = apiReceiptData?.merchant_detail?.address || {};
const address: StoreAddress | undefined = Object.keys(addrSrc).length ? {
  street: addrSrc.street || undefined,
  street2: addrSrc.street_2 || undefined,
  suburb: addrSrc.suburb || undefined,
  state: addrSrc.state || undefined,
  postcode: addrSrc.postcode || undefined,
  countryCode: addrSrc.country_code || undefined,
  full: [addrSrc.street, addrSrc.street_2, addrSrc.suburb, addrSrc.state, addrSrc.postcode].filter(Boolean).join(', ')
} : undefined;

// Returns
const returnsPolicy: ReturnsPolicy | undefined = apiReceiptData?.returns ? {
  barcode: apiReceiptData.returns.return_barcode || undefined,
  periodDays: apiReceiptData.returns.return_period || undefined,
  policyText: apiReceiptData.returns.return_policy_text || undefined,
} : undefined;

// Loyalty
const loyaltyPrograms: LoyaltyProgram[] = (apiReceiptData?.loyalty || []).map((l: any) => {
  // description contains e.g. "Loyalty ID: *********7110"
  let maskedId: string | undefined;
  if (typeof l.description === 'string') {
    const m = l.description.match(/Loyalty ID:\s*(.*)$/i);
    if (m) maskedId = m[1].trim();
  }
  return {
    program: l.title,
    maskedId,
  } as LoyaltyProgram;
}).filter(l => l.program || l.maskedId);

// Payment meta from raw slip
const paymentCardMeta = parseRawPaymentMeta(apiReceiptData?.raw_payment_data);

const cleanReceipt: Receipt = {
  identities: {
    externalReceiptId: apiReceiptData?.external_id,
    orderNumber: apiReceiptData?.order_number_detail?.value || apiReceiptData?.order_number_detail?.order_number,
    receiptType: apiReceiptData?.receipt_type,
    isTaxInvoice: !!apiReceiptData?.is_tax_invoice,
  },
  timestamps: {
    issuedAtEpoch,
    issuedAtISO,
    issuedDate,
    issuedTime,
    timezone: apiReceiptData?.merchant_detail?.timezone || apiReceiptData?.issued_at_timezone,
  },
  merchant: {
    merchantName: apiReceiptData?.root_merchant?.trading_name || apiReceiptData?.issuing_merchant?.trading_name,
    storeName: apiReceiptData?.store?.name || apiReceiptData?.merchant_detail?.name,
    abn: apiReceiptData?.merchant_detail?.abn,
    phone: apiReceiptData?.merchant_detail?.phone_number,
    address,
  },
  totals: {
    currency,
    total: totalVal,
    totalFormatted: fmtMoney(totalVal, currency),
    subtotal: subtotalVal,
    subtotalFormatted: subtotalVal != null ? fmtMoney(subtotalVal, currency) : undefined,
    taxTotal: taxTotal,
    taxTotalFormatted: taxTotal != null ? fmtMoney(taxTotal, currency) : undefined,
    discountTotal,
    itemCount: typeof apiReceiptData?.item_count === 'number' ? apiReceiptData.item_count : items.length,
    computedItemQuantity: items.reduce((a, i) => a + i.quantity, 0),
    taxes: taxLines.map(t => ({
      ...t,
      amountFormatted: fmtMoney(t.amount, currency),
    })),
  },
  items,
  aggregatedItems,
  payments: paymentDetails,
  paymentSummary: {
    totalPaid,
    totalPaidFormatted: fmtMoney(totalPaid, currency),
    methods: Array.from(new Set(paymentDetails.map(p => p.method).filter(Boolean))) as string[],
  },
  paymentCardMeta,
  returnsPolicy,
  loyaltyPrograms: loyaltyPrograms.length ? loyaltyPrograms : undefined,
  notes: undefined,
};

// Zod schema definitions
const zAddress = z.object({
  street: z.string().optional(),
  street2: z.string().optional(),
  suburb: z.string().optional(),
  state: z.string().optional(),
  postcode: z.string().optional(),
  countryCode: z.string().optional(),
  full: z.string().optional(),
});
const zReceiptItem = z.object({
  name: z.string(),
  sku: z.string().optional(),
  apn: z.string().optional(),
  colour: z.string().optional(),
  size: z.string().optional(),
  unitPrice: z.number(),
  unitPriceFormatted: z.string(),
  quantity: z.number().int().positive(),
  lineTotal: z.number(),
  lineTotalFormatted: z.string(),
  discount: z.number().optional(),
  tax: z.number().optional(),
  currency: z.string(),
});
const zTaxLine = z.object({
  title: z.string().optional(),
  type: z.string().optional(),
  amount: z.number(),
  amountFormatted: z.string(),
});
const zPaymentDetail = z.object({
  method: z.string().optional(),
  maskedCard: z.string().optional(),
  amount: z.number(),
  amountFormatted: z.string(),
  rawName: z.string().optional(),
  type: z.string().optional(),
});
const zPaymentSummary = z.object({
  totalPaid: z.number(),
  totalPaidFormatted: z.string(),
  methods: z.array(z.string()),
});
const zTotals = z.object({
  currency: z.string(),
  total: z.number(),
  totalFormatted: z.string(),
  subtotal: z.number().optional(),
  subtotalFormatted: z.string().optional(),
  taxTotal: z.number().optional(),
  taxTotalFormatted: z.string().optional(),
  discountTotal: z.number().nullable().optional(),
  itemCount: z.number().int().nonnegative().optional(),
  computedItemQuantity: z.number().int().nonnegative().optional(),
  taxes: z.array(zTaxLine),
});
const zIdentities = z.object({
  externalReceiptId: z.string().optional(),
  orderNumber: z.string().optional(),
  receiptType: z.string().optional(),
  isTaxInvoice: z.boolean().optional(),
});
const zTimestamps = z.object({
  issuedAtEpoch: z.number().optional(),
  issuedAtISO: z.string().optional(),
  issuedDate: z.string().optional(),
  issuedTime: z.string().optional(),
  timezone: z.string().optional(),
});
const zMerchant = z.object({
  merchantName: z.string().optional(),
  storeName: z.string().optional(),
  abn: z.string().optional(),
  phone: z.string().optional(),
  address: zAddress.optional(),
});
const zPaymentCardMeta = z.object({
  merchantId: z.string().optional(),
  terminalId: z.string().optional(),
  stan: z.string().optional(),
  rrn: z.string().optional(),
  authCode: z.string().optional(),
  accountType: z.string().optional(),
  transactionType: z.string().optional(),
  rawText: z.string().optional(),
});
const zReturnsPolicy = z.object({
  barcode: z.string().optional(),
  periodDays: z.number().optional(),
  policyText: z.string().optional(),
});
const zLoyalty = z.object({
  program: z.string().optional(),
  maskedId: z.string().optional(),
});
const zAggregatedItem = zReceiptItem; // identical shape currently; kept separate for clarity/future changes
const zReceipt = z.object({
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

// Emit JSON Schema for external consumers
await fs.writeFile(
  path.join(OUT_DIR, 'receipt.schema.json'),
  JSON.stringify(zodToJsonSchema(zReceipt, 'Receipt'), null, 2),
  'utf-8'
).catch(() => {});

const validation = zReceipt.safeParse(cleanReceipt);
const issues: string[] = [];
if (!validation.success) {
  validation.error.issues.forEach(i => issues.push(`${i.path.join('.')} - ${i.message}`));
}

// Integrity checks
const sumLineTotals = round2(items.reduce((a,i)=>a+i.lineTotal,0));
if (Math.abs(sumLineTotals - cleanReceipt.totals.total) > 0.01) {
  issues.push(`sum(lineTotals)=${sumLineTotals.toFixed(2)} != total=${cleanReceipt.totals.total.toFixed(2)}`);
}
if (Math.abs(totalPaid - cleanReceipt.totals.total) > 0.01) {
  issues.push(`totalPaid=${totalPaid.toFixed(2)} != total=${cleanReceipt.totals.total.toFixed(2)}`);
}
if (cleanReceipt.totals.subtotal != null && cleanReceipt.totals.taxTotal != null) {
  const recombined = round2(cleanReceipt.totals.subtotal + cleanReceipt.totals.taxTotal);
  if (Math.abs(recombined - cleanReceipt.totals.total) > 0.01) {
    issues.push(`subtotal + tax (${recombined.toFixed(2)}) != total (${cleanReceipt.totals.total.toFixed(2)})`);
  }
}
if (cleanReceipt.totals.itemCount != null && cleanReceipt.totals.itemCount !== items.length) {
  issues.push(`itemCount=${cleanReceipt.totals.itemCount} != items.length=${items.length}`);
}
const aggregatedSum = round2(aggregatedItems.reduce((a,i)=>a+i.lineTotal,0));
if (Math.abs(aggregatedSum - sumLineTotals) > 0.01) {
  issues.push(`aggregatedSum=${aggregatedSum.toFixed(2)} != sumLineTotals=${sumLineTotals.toFixed(2)}`);
}

// Strict mode: fail fast before writing outputs if requested
if (cli.strict && (!validation.success || issues.length)) {
  console.error('[strict] Validation or integrity issues detected:', issues);
  await browser.close();
  process.exit(2);
}

await fs.writeFile(
  path.join(OUT_DIR, 'receipt.clean.json'),
  JSON.stringify(cleanReceipt, null, 2),
  'utf-8'
);
await fs.writeFile(
  path.join(OUT_DIR, 'receipt.validation.json'),
  JSON.stringify({ validationSuccess: validation.success, issues, sums: { sumLineTotals, aggregatedSum, totalPaid, total: cleanReceipt.totals.total, subtotal: cleanReceipt.totals.subtotal, taxTotal: cleanReceipt.totals.taxTotal } }, null, 2),
  'utf-8'
);

// End clean schema emission

console.log('Saved:');
console.log(' - out/receipt.api.raw.json');
console.log(' - out/receipt.clean.json');
console.log(' - out/receipt.validation.json');
console.log(' - out/receipt.schema.json');

await browser.close();