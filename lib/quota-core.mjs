import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const GEMINI_DIR = join(HOME, '.gemini');
const SNAPSHOT_FILE = join(GEMINI_DIR, 'config', '.agy-quota-snapshots.json');
const FLAVORS = ['antigravity', 'antigravity-cli', 'antigravity-ide'];

const ARGON_WEEKLY_BUCKET_ID = 'gemini-argon-wtu-weekly';
const ARGON_5H_BUCKET_ID = 'gemini-argon-wtu-5h';

// Match full model label including decimals like "3.8" or "5.5", stripping only trailing period before newline/<
const MODEL_CHANGE_RE = /Model Selection`\s+from\s+.*?\s+to\s+([^\n<]+?)\.?\s*(?:<|\n|$)/i;

// In-memory cache for parsed conversation SQLite databases keyed by filepath -> { mtimeMs, size, calls }
const dbCallsCache = new Map();
let cachedSqliteMod;

async function getSqliteModule() {
  if (cachedSqliteMod !== undefined) return cachedSqliteMod;
  const origEmit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    const name = type || warning?.name;
    if (name === 'ExperimentalWarning' && /sqlite/i.test(String(warning?.message ?? warning))) {
      return undefined;
    }
    return origEmit.call(this, warning, ...rest);
  };
  try {
    cachedSqliteMod = await import('node:sqlite');
  } catch (_) {
    cachedSqliteMod = null;
  } finally {
    process.emitWarning = origEmit;
  }
  return cachedSqliteMod;
}

// Minimal protobuf wire reader for Antigravity conversation SQLite `gen_metadata` & `steps` blobs
function readVarint(buf, pos) {
  let value = 0;
  for (let shift = 0; shift < 64; shift += 7) {
    if (pos >= buf.length) throw new Error('truncated varint');
    const byte = buf[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return [value, pos];
  }
  throw new Error('varint too long');
}

function decodeProto(buf, depth = 0) {
  if (depth > 8 || !(buf instanceof Uint8Array) || buf.length > 8 * 1024 * 1024) {
    throw new Error('invalid proto blob');
  }
  const fields = new Map();
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    let value;
    if (wire === 0) {
      [value, pos] = readVarint(buf, pos);
    } else if (wire === 2) {
      let length;
      [length, pos] = readVarint(buf, pos);
      if (pos + length > buf.length) throw new Error('truncated bytes');
      value = buf.subarray(pos, pos + length);
      pos += length;
    } else if (wire === 1 || wire === 5) {
      pos += wire === 1 ? 8 : 4;
      if (pos > buf.length) throw new Error('truncated fixed');
      continue;
    } else {
      throw new Error('unsupported wire');
    }
    if (field < 1) throw new Error('bad field');
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field).push(value);
  }
  return { fields, depth };
}

function pChild(msg, field) {
  const v = msg?.fields.get(field)?.[0];
  return v instanceof Uint8Array ? decodeProto(v, msg.depth + 1) : null;
}

function pNum(msg, field) {
  const v = msg?.fields.get(field)?.[0];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function pStr(msg, field) {
  const v = msg?.fields.get(field)?.[0];
  return v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : '';
}

function pTs(msg) {
  const sec = pNum(msg, 1);
  return sec > 0 ? sec * 1000 + Math.floor(pNum(msg, 2) / 1e6) : null;
}

function normalizeBaseModel(rawLabel, rawSlug = '', modelEnum = 0) {
  const combined = `${rawLabel || ''} ${rawSlug || ''}`.toLowerCase();
  if (combined.includes('argon') || (modelEnum >= 1417 && modelEnum <= 1419)) {
    return 'Gemini 4 Argon';
  }
  if (
    combined.includes('3.8-flash') ||
    combined.includes('3.8 flash') ||
    (modelEnum >= 1318 && modelEnum <= 1322)
  ) {
    return 'Gemini 3.8 Flash';
  }
  if (combined.includes('flash-lite') || combined.includes('flash lite')) {
    return 'Gemini Flash Lite';
  }
  if ((combined.includes('opus') && combined.includes('5')) || (modelEnum >= 1400 && modelEnum <= 1402)) {
    return 'Claude Opus 5.5';
  }
  if ((combined.includes('sonnet') && combined.includes('5')) || (modelEnum >= 1403 && modelEnum <= 1405)) {
    return 'Claude Sonnet 5.5';
  }
  if (combined.includes('opus')) return 'Claude Opus';
  if (combined.includes('sonnet')) return 'Claude Sonnet';
  if (combined.includes('gpt-oss') || combined.includes('gpt oss')) {
    return 'GPT-OSS 120B';
  }
  const cleaned = (rawLabel || rawSlug || '未知模型')
    .trim()
    .replace(/\s*\((?:low|medium|high|auto|minimal|max|thinking|tiered)\)\s*$/i, '')
    .replace(/-(?:low|medium|high|tiered)$/i, '')
    .trim();
  return cleaned || '未知模型';
}

// Official API pay-as-you-go pricing per 1M tokens (USD), separating uncached input, cache read, cache write, and output (incl. thinking)
const ARGON_STD_DATE_MS = Date.parse('2026-12-01T00:00:00Z');
const FLASH38_STD_DATE_MS = Date.parse('2027-01-01T00:00:00Z');

export function estimateApiCostUsd(baseModel, { inTok = 0, cacheReadTok = 0, cacheWriteTok = 0, outTok = 0 }, tsMs = Date.now()) {
  const M = 1_000_000;
  let r;
  switch (baseModel) {
    case 'Gemini 4 Argon':
      r =
        tsMs >= ARGON_STD_DATE_MS
          ? { in: 4.0, cacheRead: 0.2, cacheWrite: 4.0, out: 20.0 }
          : { in: 2.0, cacheRead: 0.1, cacheWrite: 2.0, out: 10.0 };
      break;
    case 'Gemini 3.8 Flash':
      r =
        tsMs >= FLASH38_STD_DATE_MS
          ? { in: 1.5, cacheRead: 0.15, cacheWrite: 1.5, out: 7.5 }
          : { in: 0.75, cacheRead: 0.075, cacheWrite: 0.75, out: 3.75 };
      break;
    case 'Gemini Flash Lite':
      r = { in: 0.1, cacheRead: 0.025, cacheWrite: 0.1, out: 0.4 };
      break;
    case 'Claude Opus 5.5':
    case 'Claude Opus':
      r = { in: 4.0, cacheRead: 0.2, cacheWrite: 5.0, out: 20.0 };
      break;
    case 'Claude Sonnet 5.5':
    case 'Claude Sonnet':
      r = { in: 2.0, cacheRead: 0.1, cacheWrite: 2.5, out: 10.0 };
      break;
    case 'GPT-OSS 120B':
      r = { in: 0.15, cacheRead: 0.075, cacheWrite: 0.15, out: 0.6 };
      break;
    default:
      r = { in: 1.0, cacheRead: 0.1, cacheWrite: 1.0, out: 5.0 };
      break;
  }
  return (inTok * r.in + cacheReadTok * r.cacheRead + cacheWriteTok * r.cacheWrite + outTok * r.out) / M;
}

function classifyModelFamily(modelName) {
  const m = (modelName || '').toLowerCase();
  if (m.includes('argon')) return 'argon';
  if (m.includes('claude') || m.includes('opus') || m.includes('sonnet') || m.includes('gpt')) {
    return 'third_party';
  }
  return 'gemini_regular';
}

function readCallsFromConversationDb(DatabaseSync, dbFile, fallbackMtimeMs) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const stepTs = new Map();
    try {
      for (const sr of db.prepare('SELECT idx, metadata FROM steps').all()) {
        if (!(sr.metadata instanceof Uint8Array)) continue;
        const sm = decodeProto(sr.metadata);
        const t = pTs(pChild(sm, 8)) ?? pTs(pChild(sm, 1));
        if (t) stepTs.set(sr.idx, t);
      }
    } catch (_) {
      // Optional steps timestamp table
    }

    const seen = new Set();
    const calls = [];
    for (const row of db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all()) {
      if (!(row.data instanceof Uint8Array)) continue;
      let chat;
      try {
        chat = pChild(decodeProto(row.data), 1);
      } catch (_) {
        continue;
      }
      if (!chat) continue;

      let callTs = pTs(pChild(pChild(chat, 9), 4));
      if (!callTs) {
        for (const kvBuf of chat.fields.get(20) || []) {
          if (!(kvBuf instanceof Uint8Array)) continue;
          try {
            const kv = decodeProto(kvBuf, chat.depth + 1);
            if (pStr(kv, 1) === 'last_step_index') {
              const sIdx = Number(pStr(kv, 2));
              callTs = stepTs.get(sIdx) || stepTs.get(sIdx + 1) || stepTs.get(sIdx - 1) || null;
              break;
            }
          } catch (_) {
            // Ignore malformed kv
          }
        }
      }
      const ts = callTs || fallbackMtimeMs;

      const usageMsgs = [];
      const primaryUsage = pChild(chat, 4);
      if (primaryUsage) usageMsgs.push(primaryUsage);
      for (const retryBuf of chat.fields.get(17) || []) {
        if (!(retryBuf instanceof Uint8Array)) continue;
        try {
          const retryMsg = decodeProto(retryBuf, chat.depth + 1);
          const retryUsage = pChild(retryMsg, 2);
          if (retryUsage) usageMsgs.push(retryUsage);
        } catch (_) {
          // Ignore malformed retry blob
        }
      }

      const rawLabel = pStr(chat, 21);
      const rawSlug = pStr(chat, 19);

      for (const usage of usageMsgs) {
        const respId = pStr(usage, 11) || pStr(usage, 12) || pStr(usage, 7);
        if (respId) {
          if (seen.has(respId)) continue;
          seen.add(respId);
        }

        const inTok = pNum(usage, 2);
        const outTok = pNum(usage, 3);
        const cacheWriteTok = pNum(usage, 4);
        const cacheReadTok = pNum(usage, 5);
        const totalTok = inTok + cacheReadTok + cacheWriteTok + outTok;
        if (totalTok <= 0) continue;

        const modelEnum = pNum(usage, 1);
        const model = normalizeBaseModel(rawLabel, rawSlug, modelEnum);
        const costUsd = estimateApiCostUsd(model, { inTok, cacheReadTok, cacheWriteTok, outTok }, ts);

        calls.push({
          ts,
          model,
          family: classifyModelFamily(model),
          tokens: totalTok,
          inTok,
          cacheReadTok,
          cacheWriteTok,
          outTok,
          costUsd,
        });
      }
    }
    return calls;
  } finally {
    db.close();
  }
}

/**
 * Scan exact per-base-model token usage and API-equivalent USD cost over the last 5h and 7d.
 * Primary source: ~/.gemini/<flavor>/conversations/*.db (`gen_metadata` exact per-call protobuf usage).
 * Fallback source: ~/.gemini/<flavor>/brain/<id>/.system_generated/logs/transcript.jsonl.
 */
export async function scanLocalModelTokenLedger() {
  const nowMs = Date.now();
  const fiveHourCutoff = nowMs - 5 * 3600 * 1000;
  const sevenDayCutoff = nowMs - 7 * 24 * 3600 * 1000;

  // Map baseModelName -> aggregated stats
  const byModel = new Map();
  const addUsage = ({ model, family, tokens, inTok = 0, cacheReadTok = 0, outTok = 0, costUsd = 0, ts }) => {
    if (tokens <= 0 || ts < sevenDayCutoff) return;
    let rec = byModel.get(model);
    if (!rec) {
      rec = {
        model,
        family,
        tokens5h: 0,
        cost5hUsd: 0,
        tokens7d: 0,
        cost7dUsd: 0,
        inputTokens7d: 0,
        cacheReadTokens7d: 0,
        outputTokens7d: 0,
      };
      byModel.set(model, rec);
    }
    rec.tokens7d += tokens;
    rec.cost7dUsd += costUsd;
    rec.inputTokens7d += inTok;
    rec.cacheReadTokens7d += cacheReadTok;
    rec.outputTokens7d += outTok;
    if (ts >= fiveHourCutoff) {
      rec.tokens5h += tokens;
      rec.cost5hUsd += costUsd;
    }
  };

  const sqliteMod = await getSqliteModule();
  const DatabaseSync = sqliteMod?.DatabaseSync;
  let usedSqlite = false;

  if (DatabaseSync) {
    for (const flavor of FLAVORS) {
      const convDir = join(GEMINI_DIR, flavor, 'conversations');
      if (!existsSync(convDir)) continue;
      let names = [];
      try {
        names = readdirSync(convDir);
      } catch (_) {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.db')) continue;
        const dbFile = join(convDir, name);
        let mtimeMs = 0;
        let size = 0;
        try {
          const st = statSync(dbFile);
          mtimeMs = st.mtimeMs;
          size = st.size;
          try {
            const wal = statSync(`${dbFile}-wal`);
            mtimeMs = Math.max(mtimeMs, wal.mtimeMs);
            size += wal.size;
          } catch (_) {
            // No WAL file
          }
        } catch (_) {
          continue;
        }
        if (mtimeMs < sevenDayCutoff) continue;

        let cached = dbCallsCache.get(dbFile);
        if (!cached || cached.mtimeMs !== mtimeMs || cached.size !== size) {
          try {
            const calls = readCallsFromConversationDb(DatabaseSync, dbFile, mtimeMs);
            cached = { mtimeMs, size, calls };
            dbCallsCache.set(dbFile, cached);
          } catch (_) {
            continue;
          }
        }
        usedSqlite = true;
        for (const c of cached.calls) {
          addUsage(c);
        }
      }
    }
  }

  // Fallback to transcript.jsonl only if node:sqlite found nothing
  if (!usedSqlite) {
    for (const flavor of FLAVORS) {
      const brainDir = join(GEMINI_DIR, flavor, 'brain');
      if (!existsSync(brainDir)) continue;
      let entries = [];
      try {
        entries = readdirSync(brainDir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const tp = join(brainDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!existsSync(tp)) continue;
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(tp).mtimeMs;
        } catch (_) {
          continue;
        }
        if (mtimeMs < sevenDayCutoff) continue;
        let raw = '';
        try {
          raw = readFileSync(tp, 'utf8');
        } catch (_) {
          continue;
        }
        let currentModel = 'Gemini 3.8 Flash';
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          let step;
          try {
            step = JSON.parse(line);
          } catch (_) {
            continue;
          }
          if (
            step.type === 'USER_INPUT' &&
            typeof step.content === 'string' &&
            step.content.includes('<USER_SETTINGS_CHANGE>')
          ) {
            const m = step.content.match(MODEL_CHANGE_RE);
            if (m && m[1]) currentModel = normalizeBaseModel(m[1].trim());
          }
          if (step.type === 'PLANNER_RESPONSE') {
            const stepMs = step.created_at ? Date.parse(step.created_at) : mtimeMs;
            const inTok = Number(step.input_tokens || 0);
            const cacheReadTok = Number(step.cache_read_tokens || 0);
            const outTok = Number(step.output_tokens || 0);
            const tokens = inTok + cacheReadTok + outTok;
            const costUsd = estimateApiCostUsd(currentModel, { inTok, cacheReadTok, outTok }, stepMs);
            addUsage({
              model: currentModel,
              family: classifyModelFamily(currentModel),
              tokens,
              inTok,
              cacheReadTok,
              outTok,
              costUsd,
              ts: stepMs,
            });
          }
        }
      }
    }
  }

  // Only keep base models with > 0 tokens in 7d, sorted descending by 7d API cost (then tokens)
  const activeModels = [...byModel.values()]
    .filter((m) => m.tokens7d > 0)
    .map((m) => ({
      ...m,
      cost5hUsd: Number(m.cost5hUsd.toFixed(4)),
      cost7dUsd: Number(m.cost7dUsd.toFixed(4)),
    }))
    .sort((a, b) => b.cost7dUsd - a.cost7dUsd || b.tokens7d - a.tokens7d);

  const total5hTokens = activeModels.reduce((acc, m) => acc + m.tokens5h, 0);
  const total5hCostUsd = Number(activeModels.reduce((acc, m) => acc + m.cost5hUsd, 0).toFixed(2));
  const total7dTokens = activeModels.reduce((acc, m) => acc + m.tokens7d, 0);
  const total7dCostUsd = Number(activeModels.reduce((acc, m) => acc + m.cost7dUsd, 0).toFixed(2));

  return {
    total5hTokens,
    total5hCostUsd,
    total7dTokens,
    total7dCostUsd,
    models: activeModels,
    argonModels: activeModels.filter((m) => m.family === 'argon'),
    regularGeminiModels: activeModels.filter((m) => m.family === 'gemini_regular'),
    allGeminiModels: activeModels.filter((m) => m.family === 'argon' || m.family === 'gemini_regular'),
    thirdPartyModels: activeModels.filter((m) => m.family === 'third_party'),
  };
}

async function callLsRpc(method, body = {}) {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) return null;
  const baseUrl = lsAddr.startsWith('http') ? lsAddr : `http://${lsAddr}`;
  const res = await fetch(`${baseUrl}/exa.language_server_pb.LanguageServerService/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'x-codeium-csrf-token': csrf,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`LS RPC ${method} HTTP ${res.status}`);
  return res.json();
}

function fetchViaAgyCli(slashCmd) {
  try {
    const agyBin = existsSync(join(HOME, '.local', 'bin', 'agy'))
      ? join(HOME, '.local', 'bin', 'agy')
      : 'agy';
    const out = execFileSync(agyBin, ['-p', slashCmd, '--output-format', 'json'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const firstBrace = out.indexOf('{');
    if (firstBrace >= 0) return JSON.parse(out.slice(firstBrace));
  } catch (_) {
    // Ignore fallback errors
  }
  return null;
}

function recordSnapshot({ argonSeparateFraction, bucketsMap }) {
  let history = [];
  try {
    if (existsSync(SNAPSHOT_FILE)) {
      history = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
      if (!Array.isArray(history)) history = [];
    }
  } catch (_) {
    history = [];
  }

  const now = Date.now();
  const currentPoint = {
    ts: now,
    argonWeekly: argonSeparateFraction ?? null,
    geminiWeekly: bucketsMap['gemini-weekly']?.remainingFraction ?? null,
    gemini5h: bucketsMap['gemini-5h']?.remainingFraction ?? null,
    thirdPartyWeekly: bucketsMap['3p-weekly']?.remainingFraction ?? null,
    thirdParty5h: bucketsMap['3p-5h']?.remainingFraction ?? null,
  };

  const last = history[history.length - 1];
  const diff = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) > 1e-6;
  const changed =
    !last ||
    diff(last.argonWeekly, currentPoint.argonWeekly) ||
    diff(last.gemini5h, currentPoint.gemini5h) ||
    diff(last.geminiWeekly, currentPoint.geminiWeekly) ||
    diff(last.thirdPartyWeekly, currentPoint.thirdPartyWeekly);

  if (
    changed &&
    (currentPoint.argonWeekly !== null || currentPoint.geminiWeekly !== null || currentPoint.gemini5h !== null)
  ) {
    history.push(currentPoint);
    if (history.length > 240) history = history.slice(-240);
    try {
      mkdirSync(join(GEMINI_DIR, 'config'), { recursive: true });
      writeFileSync(SNAPSHOT_FILE, JSON.stringify(history, null, 2), 'utf8');
    } catch (_) {
      // Ignore write failures
    }
  }
}

export function formatCountdown(isoTime) {
  if (!isoTime) return '未知';
  const diffMs = Date.parse(isoTime) - Date.now();
  if (Number.isNaN(diffMs)) return isoTime;
  if (diffMs <= 0) return '即将刷新';
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${mins}分`;
  return `${mins}分钟`;
}

function clamp01(num) {
  if (typeof num !== 'number' || !Number.isFinite(num)) return 0;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

export async function fetchQuotaReport(activeConversationId = '') {
  let summaryRaw = null;
  let userStatusRaw = null;
  let availModelsRaw = null;
  let sourceMode = 'lsrpc';

  try {
    [summaryRaw, userStatusRaw, availModelsRaw] = await Promise.all([
      callLsRpc('RetrieveUserQuotaSummary', { forceRefresh: true }),
      callLsRpc('GetUserStatus', {}),
      callLsRpc('GetAvailableModels', {}),
    ]);
  } catch (_) {
    // Fallback below if LS is unreachable
  }

  if (!summaryRaw) {
    sourceMode = 'agy-cli';
    const cliUsage = fetchViaAgyCli('/usage');
    if (cliUsage?.command?.data?.groups) {
      summaryRaw = {
        response: {
          description: cliUsage.command.data.description,
          groups: cliUsage.command.data.groups.map((g) => ({
            displayName: g.name,
            description: g.description,
            disabled: g.disabled,
            buckets: (g.buckets || []).map((b) => ({
              bucketId: b.id,
              displayName: b.name,
              description: b.description,
              window: b.window,
              disabled: b.disabled,
              remainingFraction: b.remaining_fraction,
              resetTime: b.reset_time,
            })),
          })),
        },
      };
    }
  }

  const groups = summaryRaw?.response?.groups || [];
  const bucketsMap = {};
  for (const g of groups) {
    if (g?.disabled) continue;
    for (const b of g.buckets || []) {
      if (!b?.bucketId || b.disabled) continue;
      const frac = clamp01(typeof b.remainingFraction === 'number' ? b.remainingFraction : 0);
      const pct = Number((frac * 100).toFixed(2));
      bucketsMap[b.bucketId] = {
        id: b.bucketId,
        groupName: g.displayName || '',
        displayName: b.displayName || b.bucketId,
        window: b.window || (b.bucketId.includes('5h') ? '5h' : 'weekly'),
        remainingFraction: frac,
        remainingPct: pct,
        usedPct: Number((100 - pct).toFixed(2)),
        resetTime: b.resetTime || '',
        resetCountdown: formatCountdown(b.resetTime),
      };
    }
  }

  let argonWeeklyBucket = bucketsMap[ARGON_WEEKLY_BUCKET_ID] || null;
  let argon5hBucket = bucketsMap[ARGON_5H_BUCKET_ID] || null;
  if (!argonWeeklyBucket) {
    const dynArgon = Object.values(bucketsMap).find(
      (b) => (b.id.toLowerCase().includes('argon') || b.groupName.toLowerCase().includes('argon')) && b.window !== '5h',
    );
    if (dynArgon) argonWeeklyBucket = dynArgon;
  }
  if (!argon5hBucket) {
    const dynArgon5h = Object.values(bucketsMap).find(
      (b) => (b.id.toLowerCase().includes('argon') || b.groupName.toLowerCase().includes('argon')) && b.window === '5h',
    );
    if (dynArgon5h) argon5hBucket = dynArgon5h;
  }

  const gemini5h = bucketsMap['gemini-5h'] || null;
  const geminiWeekly = bucketsMap['gemini-weekly'] || null;
  const thirdParty5h = bucketsMap['3p-5h'] || null;
  const thirdPartyWeekly = bucketsMap['3p-weekly'] || null;

  const userStatus = userStatusRaw?.userStatus || {};
  const availMap = availModelsRaw?.response?.models || {};
  const clientConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs || [];

  const clientModels = clientConfigs.map((m) => {
    const label = m.label || '';
    const isArgon = /argon/i.test(label);
    const isThirdParty = /claude|opus|sonnet|gpt/i.test(label);
    const category = isArgon ? 'argon' : isThirdParty ? 'third_party' : 'gemini_regular';
    const frac = clamp01(typeof m.quotaInfo?.remainingFraction === 'number' ? m.quotaInfo.remainingFraction : 0);
    const resetTime = m.quotaInfo?.resetTime || '';
    return {
      label,
      modelId: m.modelOrAlias?.model || '',
      category,
      isArgon,
      remainingFraction: frac,
      remainingPct: Number((frac * 100).toFixed(2)),
      resetTime,
      resetCountdown: formatCountdown(resetTime),
    };
  });

  if (clientModels.length === 0 && Object.keys(availMap).length > 0) {
    for (const [slug, info] of Object.entries(availMap)) {
      if (!info.displayName || info.isInternal) continue;
      const isArgon = /argon/i.test(slug) || /argon/i.test(info.displayName);
      const isThirdParty = /claude|opus|sonnet|gpt/i.test(slug);
      const frac = clamp01(typeof info.quotaInfo?.remainingFraction === 'number' ? info.quotaInfo.remainingFraction : 0);
      const resetTime = info.quotaInfo?.resetTime || '';
      clientModels.push({
        label: info.displayName,
        modelId: slug,
        category: isArgon ? 'argon' : isThirdParty ? 'third_party' : 'gemini_regular',
        isArgon,
        remainingFraction: frac,
        remainingPct: Number((frac * 100).toFixed(2)),
        resetTime,
        resetCountdown: formatCountdown(resetTime),
      });
    }
  }

  const planInfo = userStatus.planStatus?.planInfo || {};
  const tierName = userStatus.userTier?.name || planInfo.planName || 'Antigravity User';
  const tierId = userStatus.userTier?.id || planInfo.teamsTier || '';
  const isUltra = /ultra/i.test(tierId) || /ultra/i.test(tierName);
  const showArgonCard = !isUltra && Boolean(argonWeeklyBucket || argon5hBucket);

  const ledger = await scanLocalModelTokenLedger();
  recordSnapshot({
    argonSeparateFraction: argonWeeklyBucket?.remainingFraction ?? argon5hBucket?.remainingFraction ?? null,
    bucketsMap,
  });

  return {
    fetchedAt: new Date().toISOString(),
    sourceMode,
    activeConversationId,
    tierName,
    tierId,
    isUltra,
    showArgonCard,
    argon: {
      hasSeparateBucket: Boolean(argonWeeklyBucket || argon5hBucket),
      weeklyBucket: argonWeeklyBucket,
      fiveHourBucket: argon5hBucket,
      usageModels: ledger.argonModels,
    },
    groups: {
      gemini: {
        title: 'Gemini 组',
        fiveHour: gemini5h,
        weekly: geminiWeekly,
        usageModels: showArgonCard ? ledger.regularGeminiModels : ledger.allGeminiModels,
      },
      thirdParty: {
        title: 'Claude & GPT 组',
        fiveHour: thirdParty5h,
        weekly: thirdPartyWeekly,
        usageModels: ledger.thirdPartyModels,
      },
    },
    clientModels,
    ledger,
  };
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function barColor(pct) {
  if (pct <= 15) return '#ef4444';
  if (pct <= 35) return '#f59e0b';
  return '#10b981';
}

function fmtTok(n) {
  const v = Number(n || 0);
  if (v <= 0) return '—';
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

function fmtUsd(n) {
  const v = Number(n || 0);
  if (v <= 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

function renderTokenCostCell(tokens, costUsd, { bold = false, stacked = false } = {}) {
  if (!tokens || tokens <= 0) {
    return `<span class="text-[var(--muted-foreground)]">—</span>`;
  }
  const tokCls = bold ? 'font-semibold text-[var(--foreground)]' : 'font-medium text-[var(--foreground)]';
  if (stacked) {
    return `<div class="${tokCls} leading-tight">${fmtTok(tokens)}</div><div class="text-[var(--muted-foreground)] leading-tight">${fmtUsd(costUsd)}</div>`;
  }
  return `<span class="${tokCls}">${fmtTok(tokens)}</span> <span class="text-[var(--muted-foreground)]">· ${fmtUsd(costUsd)}</span>`;
}

function renderUsageBreakdownHtml(models, { stacked = false } = {}) {
  const list = (models || []).filter((m) => m.tokens7d > 0);
  if (list.length === 0) {
    return `<div class="pt-2 border-t border-[var(--border)] text-xs text-[var(--muted-foreground)]">近 7 天暂无调用</div>`;
  }
  const sum5h = list.reduce((acc, m) => acc + m.tokens5h, 0);
  const sum5hCost = list.reduce((acc, m) => acc + (m.cost5hUsd || 0), 0);
  const sum7d = list.reduce((acc, m) => acc + m.tokens7d, 0);
  const sum7dCost = list.reduce((acc, m) => acc + (m.cost7dUsd || 0), 0);

  const rows = list
    .map((m) => {
      const tip = `7d 明细 — 未缓存输入: ${fmtTok(m.inputTokens7d)} · 缓存读取: ${fmtTok(m.cacheReadTokens7d)} · 输出(含思考): ${fmtTok(m.outputTokens7d)}`;
      return `
        <tr title="${escapeHtml(tip)}">
          <td class="py-1 pr-1 text-[var(--foreground)] truncate max-w-[9.5rem]">${escapeHtml(m.model)}</td>
          <td class="py-1 pl-2 text-right tabular-nums whitespace-nowrap align-top">${renderTokenCostCell(m.tokens5h, m.cost5hUsd, { stacked })}</td>
          <td class="py-1 pl-2 text-right tabular-nums whitespace-nowrap align-top">${renderTokenCostCell(m.tokens7d, m.cost7dUsd, { stacked })}</td>
        </tr>`;
    })
    .join('');

  const totalRow =
    list.length > 1
      ? `
        <tr class="border-t border-[var(--border)]/60">
          <td class="pt-1.5 pr-1 text-[var(--muted-foreground)]">合计</td>
          <td class="pt-1.5 pl-2 text-right tabular-nums whitespace-nowrap align-top">${renderTokenCostCell(sum5h, sum5hCost, { bold: true, stacked })}</td>
          <td class="pt-1.5 pl-2 text-right tabular-nums whitespace-nowrap align-top">${renderTokenCostCell(sum7d, sum7dCost, { bold: true, stacked })}</td>
        </tr>`
      : '';

  return `
    <div class="pt-2 border-t border-[var(--border)]">
      <table class="w-full text-xs border-collapse">
        <thead>
          <tr class="text-[var(--muted-foreground)]">
            <th class="font-normal text-left pb-1">已调用模型</th>
            <th class="font-normal text-right pb-1 pl-2 whitespace-nowrap">5h (Token / API)</th>
            <th class="font-normal text-right pb-1 pl-2 whitespace-nowrap">7d (Token / API)</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
          ${totalRow}
        </tbody>
      </table>
    </div>`;
}

export function buildQuotaInlineWidgetHtml(report) {
  const g5 = report.groups.gemini.fiveHour;
  const gw = report.groups.gemini.weekly;
  const c5 = report.groups.thirdParty.fiveHour;
  const cw = report.groups.thirdParty.weekly;
  const aw = report.argon.weeklyBucket;
  const a5 = report.argon.fiveHourBucket;
  const stacked = Boolean(report.showArgonCard);

  const renderBucketRow = (label, bucket) => {
    if (!bucket) return '';
    const pct = Number(bucket.remainingPct ?? 0);
    const color = barColor(pct);
    return `
      <div class="space-y-1">
        <div class="flex items-center justify-between text-xs gap-1">
          <span class="font-medium text-[var(--foreground)] truncate">${escapeHtml(label)}</span>
          <span class="text-[var(--muted-foreground)] shrink-0"><strong class="text-[var(--foreground)]">${pct.toFixed(2)}%</strong> · ${escapeHtml(bucket.resetCountdown)}</span>
        </div>
        <div class="w-full h-2 rounded-full bg-[var(--secondary)] overflow-hidden">
          <div class="h-2 rounded-full transition-all" style="width:${Math.max(1, Math.min(100, pct))}%; background:${color};"></div>
        </div>
      </div>`;
  };

  const argonCardHtml = report.showArgonCard
    ? `
      <div class="border border-sky-500/40 rounded-lg p-3 space-y-2.5 flex flex-col justify-between">
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold">🎯 Gemini 4 Argon</span>
          </div>
          ${renderBucketRow('每周独立限额', aw)}
          ${a5 ? renderBucketRow('5小时窗口限额', a5) : ''}
        </div>
        ${renderUsageBreakdownHtml(report.argon.usageModels, { stacked })}
      </div>`
    : '';

  const gridCols = report.showArgonCard ? 'grid-cols-3' : 'grid-cols-2';
  const total5hCost = report.ledger?.total5hCostUsd ?? 0;
  const total7dCost = report.ledger?.total7dCostUsd ?? 0;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <script src="https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js"></script>
</head>
<body class="bg-transparent text-[var(--foreground)] antialiased p-2.5">
  <div class="bg-[var(--card)] text-[var(--foreground)] border border-[var(--border)] rounded-xl p-3.5 shadow-sm space-y-3">
    <div class="flex items-center justify-between border-b border-[var(--border)] pb-2 gap-2 flex-wrap">
      <div class="flex items-center gap-2">
        <span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
        <h2 class="font-semibold text-sm">模型额度实时监控</h2>
      </div>
      <div class="flex items-center gap-1.5 flex-wrap">
        <span class="text-xs px-2 py-0.5 rounded-md bg-[var(--secondary)] text-[var(--muted-foreground)] tabular-nums" title="按官方 API 价格折算（严格区分未缓存输入 / 缓存命中读取 / 含思考输出 Token）">等额 API: 5h <strong class="text-[var(--foreground)]">${fmtUsd(total5hCost)}</strong> · 7d <strong class="text-[var(--foreground)]">${fmtUsd(total7dCost)}</strong></span>
        <span class="text-xs px-2 py-0.5 rounded-md bg-[var(--secondary)] text-[var(--muted-foreground)]">${escapeHtml(report.tierName)}</span>
      </div>
    </div>

    <div class="grid ${gridCols} gap-3 items-start">
      ${argonCardHtml}

      <div class="border border-[var(--border)] rounded-lg p-3 space-y-2.5">
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold">⚡ Gemini 组</span>
          </div>
          ${renderBucketRow('5小时窗口限额', g5)}
          ${renderBucketRow('每周总额度池', gw)}
        </div>
        ${renderUsageBreakdownHtml(report.groups.gemini.usageModels, { stacked })}
      </div>

      <div class="border border-[var(--border)] rounded-lg p-3 space-y-2.5">
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold">🤖 Claude &amp; GPT 组</span>
          </div>
          ${renderBucketRow('5小时窗口限额', c5)}
          ${renderBucketRow('每周总额度池', cw)}
        </div>
        ${renderUsageBreakdownHtml(report.groups.thirdParty.usageModels, { stacked })}
      </div>
    </div>
  </div>
</body>
</html>`;
}
