// scrape-slyp-receipt.ts
// Minimal, API-first extraction of a Slyp receipt.
// (Removes previous DOM heuristics, tracing, raw text + full network capture.)
import * as pw from 'playwright';
import fs from 'fs/promises';
import path from 'node:path';
import { transformReceipt, validateReceipt, writeJsonSchema, SCHEMA_VERSION } from './receipt.js';

// ---- tiny CLI (no deps) ----
type Cli = { url?: string; outDir?: string; strict?: boolean; batchFile?: string; quiet?: boolean; concurrency?: number; logFile?: string };
function parseCli(argv: string[]): Cli {
  const out: Cli = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a?.startsWith('--url=')) out.url = a.slice(6);
    else if (a === '--outDir') out.outDir = argv[++i];
    else if (a?.startsWith('--outDir=')) out.outDir = a.slice(9);
    else if (a === '--strict') out.strict = true;
    else if (a === '--batch') out.batchFile = argv[++i];
    else if (a?.startsWith('--batch=')) out.batchFile = a.slice(8);
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--concurrency') { const v = Number(argv[++i]); if (Number.isFinite(v) && v > 0) out.concurrency = v; }
    else if (a?.startsWith('--concurrency=')) { const v = Number(a.slice(14)); if (Number.isFinite(v) && v > 0) out.concurrency = v; }
    else if (a === '--log') out.logFile = argv[++i];
    else if (a?.startsWith('--log=')) out.logFile = a.slice(6);
  }
  return out;
}
const cli = parseCli(process.argv.slice(2));

const DEFAULT_URL = 'https://receipts.slyp.com.au/ERA-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyZWNlaXB0WHJlZiI6IlItWC0xZThhOGMwYmVlYjk0OGI5YjBiYjQyZjg2YTYwMzM1OCIsImlhdCI6MTc1OTQ4OTkxMCwiZXhwIjoxNzY0NjczOTEwfQ.p6j9qMGlNs-aSWjecZB_KVPb_ketUMfdbYTgXz_9ajc';
const OUT_DIR = path.resolve(process.cwd(), cli.outDir || 'out');
await fs.mkdir(OUT_DIR, { recursive: true });

// -------- logging ---------
type LogLevel = 'info' | 'warn' | 'error' | 'debug';
let logStream: import('node:fs').WriteStream | undefined;
import fsNode from 'node:fs';
function initLogStream() {
  if (cli.logFile && !logStream) {
    const abs = path.resolve(cli.logFile);
    fsNode.mkdirSync(path.dirname(abs), { recursive: true });
    logStream = fsNode.createWriteStream(abs, { flags: 'a' });
  }
}
function log(level: LogLevel, message: string, meta?: Record<string, any>) {
  if (cli.quiet && level === 'info') return; // suppress info when quiet
  const rec: any = { ts: new Date().toISOString(), level, msg: message };
  if (meta) rec.meta = meta;
  const line = JSON.stringify(rec);
  if (!cli.logFile) {
    // eslint-disable-next-line no-console
    console.log(line);
  } else {
    if (!logStream) initLogStream();
    logStream!.write(line + '\n');
    if (level === 'error') {
      // also mirror errors to stderr for visibility
      console.error(line);
    }
  }
}

// Simple retry helper
async function retry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 500): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { lastErr = e; if (i < attempts - 1) await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, i))); }
  }
  throw lastErr;
}

// Single receipt processor
async function processSingle(url: string, index?: number) {
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 1600 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36' });
  const page = await context.newPage();
  log('info', 'navigate.start', { url });
  const resp = await retry(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }), 2).catch(e => { log('warn', 'navigate.failed', { url, error: String(e) }); return undefined; });
  if (!resp || !resp.ok()) log('warn', 'navigation.status', { status: resp?.status(), statusText: resp?.statusText() });

  const isReceiptish = (j: any) => j && typeof j === 'object' && ('total_price' in j || 'basket_items' in j || 'merchant_detail' in j);
  let capturedReceiptJson: any | undefined; let fallbackUsed = false; let apiReceiptData: any;
  const apiResponse = await page.waitForResponse(async r => {
    if (!r.ok()) return false; const ct = r.headers()['content-type'] ?? ''; if (!ct.includes('application/json')) return false; try { const j = await r.json(); if (isReceiptish(j)) { capturedReceiptJson = j; return true; } } catch { /* ignore */ } return false;
  }, { timeout: 15_000 }).catch(() => undefined);
  if (!apiResponse) {
    const fallback = await page.waitForResponse(r => r.ok() && (r.headers()['content-type'] || '').includes('application/json'), { timeout: 10_000 }).catch(() => undefined);
    if (fallback) { try { apiReceiptData = await fallback.json(); fallbackUsed = true; } catch {/* ignore */} }
  } else { apiReceiptData = capturedReceiptJson; }
  if (!apiReceiptData) { log('error', 'receipt.fetch.failed', { url }); await browser.close(); return { ok: false, url, reason: 'no_api_response' }; }
  if (fallbackUsed) log('warn', 'receipt.heuristic.fallback', { url });

  const rawFile = index != null ? `receipt.${index}.api.raw.json` : 'receipt.api.raw.json';
  await fs.writeFile(path.join(OUT_DIR, rawFile), JSON.stringify(apiReceiptData, null, 2), 'utf-8').catch(()=>{});

  const receipt = transformReceipt(apiReceiptData, { schemaVersion: SCHEMA_VERSION });
  const validation = validateReceipt(receipt);
  if (cli.strict && (!validation.validationSuccess || validation.issues.length)) {
    log('error', 'strict.validation.fail', { url, issues: validation.issues });
    await browser.close();
    return { ok: false, url, reason: 'validation_failed', issues: validation.issues };
  }
  // Persist outputs (index aware)
  const cleanFile = index != null ? `receipt.${index}.clean.json` : 'receipt.clean.json';
  const valFile = index != null ? `receipt.${index}.validation.json` : 'receipt.validation.json';
  await fs.writeFile(path.join(OUT_DIR, cleanFile), JSON.stringify(receipt, null, 2), 'utf-8');
  await fs.writeFile(path.join(OUT_DIR, valFile), JSON.stringify(validation, null, 2), 'utf-8');
  if (index == null) { await writeJsonSchema(OUT_DIR); }
  await browser.close();
  log('info', 'receipt.processed', { url, total: receipt.totals.total, items: receipt.items.length });
  return { ok: true, url, total: receipt.totals.total, items: receipt.items.length };
}

async function main() {
  if (cli.batchFile) {
    const listRaw = await fs.readFile(path.resolve(cli.batchFile), 'utf-8').catch(()=>undefined);
    if (!listRaw) { console.error('[fatal] Cannot read batch file'); process.exit(1); }
    const urls = listRaw.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    if (!urls.length) { console.error('[fatal] Batch file empty'); process.exit(1); }
    const concurrency = cli.concurrency && cli.concurrency > 0 ? cli.concurrency : 1;
    log('info', 'batch.start', { count: urls.length, concurrency });
    const results: any[] = [];
    if (concurrency === 1) {
      for (let i=0;i<urls.length;i++) {
        const u = urls[i];
        const r = await processSingle(u, i+1);
        results.push(r);
      }
    } else {
      // simple work queue
      let idx = 0; let processed = 0;
      async function worker(workerId: number) {
        while (true) {
          const my = idx++;
            if (my >= urls.length) break;
          const u = urls[my];
          log('debug', 'worker.start', { workerId, index: my+1 });
          const r = await processSingle(u, my+1);
          results[my] = r;
          processed++;
          log('debug', 'worker.done', { workerId, index: my+1, processed });
        }
      }
      const workers = Array.from({ length: Math.min(concurrency, urls.length) }, (_, i)=> worker(i+1));
      await Promise.all(workers);
    }
    await writeJsonSchema(OUT_DIR); // write once
    const manifest = { ts: new Date().toISOString(), count: results.length, ok: results.filter(r=>r.ok).length, failed: results.filter(r=>!r.ok).length, results };
    await fs.writeFile(path.join(OUT_DIR, 'batch.manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    log('info', 'batch.done', { ok: manifest.ok, failed: manifest.failed });
    if (cli.strict && manifest.failed) process.exit(2);
    return;
  }
  // single mode
  const RECEIPT_URL = cli.url || process.env.SLYP_URL || DEFAULT_URL;
  await processSingle(RECEIPT_URL);
  console.log('Saved:');
  console.log(' - out/receipt.api.raw.json');
  console.log(' - out/receipt.clean.json');
  console.log(' - out/receipt.validation.json');
  console.log(' - out/receipt.schema.json');
}

await main();