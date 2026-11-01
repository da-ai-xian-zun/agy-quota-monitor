#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildQuotaInlineWidgetHtml, fetchQuotaReport } from '../lib/quota-core.mjs';

const args = process.argv.slice(2);
let outPath = '';
let convId = process.env.ANTIGRAVITY_CONVERSATION_ID || '';
let jsonOnly = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && args[i + 1]) {
    outPath = resolve(args[++i]);
  } else if (args[i] === '--conversation' && args[i + 1]) {
    convId = args[++i];
  } else if (args[i] === '--json') {
    jsonOnly = true;
  }
}

const report = await fetchQuotaReport(convId);

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const html = buildQuotaInlineWidgetHtml(report);
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, 'utf8');
  console.log(JSON.stringify({ ok: true, outPath, fetchedAt: report.fetchedAt, sourceMode: report.sourceMode }));
} else {
  process.stdout.write(html);
}
