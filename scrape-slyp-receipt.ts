// scrape-slyp-receipt.ts
import * as pw from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

type ReceiptItem = {
  name: string;
  price: string;
  apn?: string;
  sku?: string;
  colour?: string;
  size?: string;
};

type ReceiptGuess = {
  merchant?: string;
  location?: string;
  total?: string;
  gst?: string;
  datetime?: string;
  saleNumber?: string;
  totalItems?: string;
  receiptNumber?: string;
  items?: ReceiptItem[];
  paymentMethod?: string;
  paymentLastDigits?: string;
  rawText?: string;
  apiData?: any;
  networkData?: any[];
};

const RECEIPT_URL = 'https://receipts.slyp.com.au/ERA-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyZWNlaXB0WHJlZiI6IlItWC0xZThhOGMwYmVlYjk0OGI5YjBiYjQyZjg2YTYwMzM1OCIsImlhdCI6MTc1OTQ4OTkxMCwiZXhwIjoxNzY0NjczOTEwfQ.p6j9qMGlNs-aSWjecZB_KVPb_ketUMfdbYTgXz_9ajc';

const OUT_DIR = path.resolve(process.cwd(), 'out');

await fs.mkdir(OUT_DIR, { recursive: true });

const browser = await pw.chromium.launch({ headless: true });
const context = await browser.newContext({
  // Helps some SPAs behave; tweak if needed
  viewport: { width: 1200, height: 1600 },
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36',
});
const page = await context.newPage();

// --- 1) Collect candidate JSON from network ---
const networkPayloads: any[] = [];
let apiReceiptData: any = null;

page.on('response', async (res) => {
  try {
    const ct = res.headers()['content-type'] ?? '';
    const url = res.url();
    if (ct.includes('application/json') || url.includes('/receipt') || url.includes('/api')) {
      const bodyText = await res.text();
      // Avoid crashing on non-JSON despite JSON-ish headers
      try {
        const json = JSON.parse(bodyText);
        networkPayloads.push({ url, json });
        
        // Capture the main receipt API response
        if (url.includes('api.slyp.com.au/v1/loyalty/web-receipts')) {
          apiReceiptData = json;
        }
      } catch {
        // Keep raw as fallback
        networkPayloads.push({ url, text: bodyText });
      }
    }
  } catch {}
});

// Optional: record a HAR for debugging (comment out if you don’t want a file)
await context.tracing.start({ screenshots: true, snapshots: true });

// --- 2) Navigate and wait until the SPA settles ---
const resp = await page.goto(RECEIPT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
if (!resp || !resp.ok()) {
  console.warn(`Navigation status: ${resp?.status()} ${resp?.statusText()}`);
}

// Heuristic: wait for network to go calm and the UI to render something non-trivial.
await page.waitForLoadState('networkidle').catch(() => {});
// Also wait for any texty content to appear
await page.waitForTimeout(1200); // small settle

// --- 3) Extract data from API response if available ---
let merchant: string | undefined;
let location: string | undefined;
let total: string | undefined;
let gst: string | undefined;
let datetime: string | undefined;
let saleNumber: string | undefined;
let totalItems: string | undefined;
let receiptNumber: string | undefined;
let items: ReceiptItem[] = [];
let paymentMethod: string | undefined;
let paymentLastDigits: string | undefined;

if (apiReceiptData) {
  // Extract merchant and store info
  merchant = apiReceiptData.root_merchant?.trading_name || apiReceiptData.issuing_merchant?.trading_name;
  location = apiReceiptData.store?.name;
  
  // Extract receipt metadata
  receiptNumber = apiReceiptData.external_id;
  
  // Format datetime from Unix timestamp or ISO string
  if (apiReceiptData.issued_at) {
    const date = new Date(apiReceiptData.issued_at * 1000);
    datetime = date.toLocaleString('en-AU', { 
      day: '2-digit', 
      month: '2-digit', 
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true 
    });
  } else if (apiReceiptData.issued_at_iso) {
    datetime = apiReceiptData.issued_at_iso;
  }
  
  // Extract totals from top-level fields
  if (apiReceiptData.total_price !== undefined) {
    total = `$${apiReceiptData.total_price.toFixed(2)}`;
  }
  
  if (apiReceiptData.total_tax !== undefined) {
    gst = `$${apiReceiptData.total_tax.toFixed(2)}`;
  }
  
  // Extract sale number from order_number_detail
  if (apiReceiptData.order_number_detail) {
    saleNumber = apiReceiptData.order_number_detail.order_number || apiReceiptData.order_number_detail.value;
  }
  
  // Extract items
  if (apiReceiptData.basket_items && Array.isArray(apiReceiptData.basket_items)) {
    items = apiReceiptData.basket_items.map((item: any) => {
      const product = item.product;
      const itemProps = product.item_properties || [];
      
      // Extract properties from item_properties array
      const apnProp = itemProps.find((p: any) => p.title?.startsWith('APN:'));
      const skuProp = itemProps.find((p: any) => p.title?.startsWith('SKU:'));
      const colourProp = itemProps.find((p: any) => p.title?.startsWith('Colour:'));
      const sizeProp = itemProps.find((p: any) => p.title?.startsWith('Size:'));
      
      return {
        name: product.name || product.title,
        price: product.pricing?.price !== undefined ? `$${product.pricing.price.toFixed(2)}` : '',
        apn: apnProp?.title?.replace('APN: ', '').trim(),
        sku: skuProp?.title?.replace('SKU: ', '').trim(),
        colour: colourProp?.title?.replace('Colour: ', '').trim(),
        size: sizeProp?.title?.replace('Size: ', '').trim(),
      };
    });
    
    totalItems = items.length.toString();
  }
  
  // Extract payment info
  if (apiReceiptData.payments && Array.isArray(apiReceiptData.payments) && apiReceiptData.payments.length > 0) {
    const payment = apiReceiptData.payments[0];
    
    // Parse payment name like "VISA (*****659)"
    const paymentName = payment.name || '';
    const methodMatch = paymentName.match(/^([A-Z]+)/);
    const digitsMatch = paymentName.match(/\*+(\d{3,4})\)/);
    
    paymentMethod = methodMatch ? methodMatch[1] : payment.payment_method_type;
    paymentLastDigits = digitsMatch ? `**** *${digitsMatch[1]}` : payment.pan_suffix;
  }
}

// --- 4) Visible text fallback dump (helps when structure is opaque) ---
const rawText = await page.locator('body').innerText();

// --- 5) Save artifacts ---
await page.screenshot({ path: path.join(OUT_DIR, 'receipt.png'), fullPage: true }).catch(() => {});
// Chromium-only: PDF (works well for receipts)
await page.pdf({
  path: path.join(OUT_DIR, 'receipt.pdf'),
  printBackground: true,
  preferCSSPageSize: true,
  margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
}).catch(() => {});

await context.tracing.stop({ path: path.join(OUT_DIR, 'trace.zip') }).catch(() => {});

// --- 6) Emit a best-effort structured result ---
const result: ReceiptGuess = {
  merchant,
  location,
  total,
  gst,
  datetime,
  saleNumber,
  totalItems,
  receiptNumber,
  items: items.length ? items : undefined,
  paymentMethod,
  paymentLastDigits,
  rawText,
  apiData: apiReceiptData,
  networkData: networkPayloads,
};

await fs.writeFile(path.join(OUT_DIR, 'receipt.json'), JSON.stringify(result, null, 2), 'utf-8');

console.log('Saved:');
console.log(' - out/receipt.png');
console.log(' - out/receipt.pdf');
console.log(' - out/receipt.json');
console.log(' - out/trace.zip');

await browser.close();