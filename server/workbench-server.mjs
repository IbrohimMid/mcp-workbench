#!/usr/bin/env node

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const root = path.resolve(process.env.WORKSPACE_DIR || path.join(__dirname, '..'));
const host = process.env.MCP_HOST || '127.0.0.1';
const port = Number(process.env.MCP_PORT || 3333);
const serverName = process.env.MCP_SERVER_NAME || 'mcp-workbench';
const serverVersion = process.env.MCP_SERVER_VERSION || '0.1.0';
const authToken = (process.env.MCP_TOKEN || '').trim();
const allowNoAuth = /^(1|true|yes|on)$/i.test(process.env.MCP_ALLOW_NO_AUTH || '');
const allowQueryToken = /^(1|true|yes|on)$/i.test(process.env.MCP_ALLOW_QUERY_TOKEN || '');
const allowOutside = /^(1|true|yes|on)$/i.test(process.env.MCP_ALLOW_OUTSIDE_WORKSPACE || '');
const enableWriteTools = /^(1|true|yes|on)$/i.test(process.env.MCP_ENABLE_WRITE_TOOLS || '');
const enableBash = /^(1|true|yes|on)$/i.test(process.env.MCP_ENABLE_BASH || '');
const enableWebfetch = /^(1|true|yes|on)$/i.test(process.env.MCP_ENABLE_WEBFETCH || '');
const enableWorkflow = /^(1|true|yes|on)$/i.test(process.env.MCP_ENABLE_WORKFLOW || '1');
const sanitizeBashEnv = /^(1|true|yes|on)$/i.test(process.env.MCP_SANITIZE_BASH_ENV || '1');
const maxBodyBytes = Math.max(1024, Number(process.env.MCP_MAX_BODY_BYTES || 1048576));
const responseMode = String(process.env.MCP_RESPONSE_MODE || 'auto').trim().toLowerCase();
const allowedOrigins = String(process.env.MCP_ALLOWED_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const jobsRoot = path.resolve(process.env.MCP_WORKFLOW_JOB_DIR || path.join(root, '.mcp-workbench', 'jobs'));
const workflowPresetsRoot = path.resolve(process.env.MCP_WORKFLOW_PRESET_DIR || path.join(root, 'workflow-presets'));
const workspaceSignalFiltersRoot = path.resolve(process.env.MCP_SIGNAL_FILTER_DIR || path.join(root, '.mcp-workbench', 'signal-filters'));
const builtinSignalFiltersRoot = path.join(repoRoot, 'signal-filters');
const trustedSignalRegistryPath = path.resolve(process.env.MCP_SIGNAL_TRUST_REGISTRY || path.join(os.homedir(), '.config', 'mcp-workbench', 'trusted-workspaces.json'));
const pollIntervalMs = Math.max(250, Number(process.env.MCP_WORKFLOW_POLL_INTERVAL_MS || 1000));
const jobRetentionHours = Math.max(0, Number(process.env.MCP_JOB_RETENTION_HOURS || 24));
const jobMaxCount = Math.max(0, Number(process.env.MCP_JOB_MAX_COUNT || 200));
const jobCleanupIntervalMs = Math.max(60_000, Number(process.env.MCP_JOB_CLEANUP_INTERVAL_MS || 3_600_000));

const sessions = new Map();
const jobs = new Map();

if (!authToken && !allowNoAuth) {
  console.error('[mcp-workbench] MCP_TOKEN is required. Set MCP_ALLOW_NO_AUTH=1 for local development only.');
  process.exit(1);
}

if (!allowOutside) {
  for (const candidate of [jobsRoot, workflowPresetsRoot, workspaceSignalFiltersRoot]) {
    const rel = path.relative(root, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`configured path escapes workspace: ${candidate}`);
    }
  }
}

await ensureWorkspaceRoot();
const realRoot = await fsp.realpath(root);
await ensureDir(jobsRoot);
await ensureDir(workflowPresetsRoot);
const realJobsRoot = await fsp.realpath(jobsRoot);
const realWorkflowPresetsRoot = await fsp.realpath(workflowPresetsRoot);
if (!allowOutside) {
  if (!isInsideRealWorkspace(realJobsRoot)) {
    throw new Error(`workflow job directory escapes workspace: ${jobsRoot}`);
  }
  if (!isInsideRealWorkspace(realWorkflowPresetsRoot)) {
    throw new Error(`workflow preset directory escapes workspace: ${workflowPresetsRoot}`);
  }
}
restoreJobs().catch((err) => {
  console.error('[mcp-workbench] failed to restore jobs:', err);
});
scheduleJobCleanup();

function nowIso() {
  return new Date().toISOString();
}

function okContent(text) {
  return [{ type: 'text', text }];
}

function jsonContent(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseAcceptHeader(req) {
  const accept = String(req.headers.accept || '');
  return {
    wantsEventStream: accept.includes('text/event-stream'),
    wantsJson: accept.includes('application/json') || !accept,
  };
}

function buildCorsHeaders(req) {
  if (!allowedOrigins.length || allowedOrigins.includes('*')) {
    return { 'Access-Control-Allow-Origin': '*' };
  }

  const origin = String(req.headers.origin || '').trim();
  if (origin && allowedOrigins.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
    };
  }

  return {};
}

function applyCorsHeaders(req, res) {
  for (const [key, value] of Object.entries(buildCorsHeaders(req))) {
    res.setHeader(key, value);
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, mcp-session-id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function sendSseJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...extraHeaders,
  });
  res.end(`data: ${JSON.stringify(body)}\n\n`);
}

function sendRpcResponse(req, res, status, body, extraHeaders = {}) {
  const mode = responseMode === 'json'
    ? 'json'
    : responseMode === 'sse'
      ? 'sse'
      : parseAcceptHeader(req).wantsEventStream
        ? 'sse'
        : 'json';

  if (mode === 'json') {
    sendJson(res, status, body, extraHeaders);
    return;
  }

  sendSseJson(res, status, body, extraHeaders);
}

async function readBody(req) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      const err = new Error(`request body too large: ${total} bytes`);
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

async function ensureWorkspaceRoot() {
  const stat = await fsp.stat(root).catch(() => null);
  if (!stat) {
    throw new Error(`WORKSPACE_DIR does not exist: ${root}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`WORKSPACE_DIR must be a directory: ${root}`);
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function fileExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

function isInsideRealWorkspace(target) {
  const rel = path.relative(realRoot, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function nearestExistingAncestor(target) {
  let current = path.resolve(target);
  for (;;) {
    if (await fileExists(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

async function resolveExistingWorkspacePath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('path is required');
  }
  const resolved = path.resolve(root, inputPath);
  if (allowOutside) return resolved;
  const realTarget = await fsp.realpath(resolved);
  if (!isInsideRealWorkspace(realTarget)) {
    throw new Error(`path escapes workspace: ${inputPath}`);
  }
  return realTarget;
}

async function resolveWritableWorkspacePath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('path is required');
  }
  const resolved = path.resolve(root, inputPath);
  if (allowOutside) return resolved;

  try {
    const realTarget = await fsp.realpath(resolved);
    if (!isInsideRealWorkspace(realTarget)) {
      throw new Error(`path escapes workspace: ${inputPath}`);
    }
    return realTarget;
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
      throw error;
    }
  }

  const ancestor = await nearestExistingAncestor(resolved);
  const realAncestor = await fsp.realpath(ancestor);
  if (!isInsideRealWorkspace(realAncestor)) {
    throw new Error(`path escapes workspace: ${inputPath}`);
  }
  return resolved;
}

async function resolveWorkspaceDirectoryPath(inputPath = '.') {
  const resolved = await resolveExistingWorkspacePath(inputPath);
  const stat = await fsp.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`path is not a directory: ${inputPath}`);
  }
  return resolved;
}

function normalizeLineCount(value, fallback = 200) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2000) : fallback;
}

async function readTail(filePath, lineCount = 200) {
  if (!(await fileExists(filePath))) return '';
  const text = await fsp.readFile(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - lineCount)).join('\n');
}

function stripAnsi(text) {
  return String(text || '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '');
}

function normalizeSignalText(text) {
  return stripAnsi(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function redactSecrets(text) {
  return String(text || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|password|secret|api_key|apikey)=([^\s"'`]+)/gi, '$1=[REDACTED]')
    .replace(/\b(token|password|secret|api_key|apikey):\s*([^\s"'`]+)/gi, '$1: [REDACTED]');
}

function safeSignalPath(filePath) {
  const rel = path.relative(root, filePath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel;
  }
  return path.basename(filePath);
}

const bashEnvDenylist = new Set([
  'BASH_ENV',
  'CDPATH',
  'ENV',
  'GIT_ASKPASS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NPM_CONFIG_USERCONFIG',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'PYTHONPATH',
  'PROMPT_COMMAND',
  'RUBYOPT',
  'RUSTC_WRAPPER',
  'SSH_ASKPASS',
  'TERMINFO',
  'TERMINFO_DIRS',
  'VISUAL',
  'EDITOR',
]);

function estimateTokens(text) {
  return Math.max(0, Math.ceil(String(text || '').length / 4));
}

function sanitizeBashEnvironment(source = process.env) {
  if (!sanitizeBashEnv) {
    return { ...source };
  }

  const env = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (bashEnvDenylist.has(key)) continue;
    env[key] = value;
  }
  return env;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (value == null || value === '') return [];
  return [String(value).trim()].filter(Boolean);
}

async function readTextIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function readJsonIfExists(filePath) {
  const raw = await readTextIfExists(filePath);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readPatternList(value) {
  return normalizeList(value);
}

function textMatchesPattern(text, pattern) {
  const candidate = String(text || '');
  const raw = String(pattern || '').trim();
  if (!raw) return false;
  try {
    return new RegExp(raw, 'i').test(candidate);
  } catch {
    return candidate.toLowerCase().includes(raw.toLowerCase());
  }
}

function textMatchesAnyPattern(text, patterns = []) {
  return normalizeList(patterns).some((pattern) => textMatchesPattern(text, pattern));
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function buildSignalSummaryText(signal) {
  const parts = [];
  if (signal?.headline) parts.push(`headline: ${signal.headline}`);
  if (signal?.nextAction) parts.push(`nextAction: ${signal.nextAction}`);
  if (Array.isArray(signal?.keyLines) && signal.keyLines.length) {
    parts.push(`keyLines:\n${signal.keyLines.join('\n')}`);
  }
  if (Array.isArray(signal?.errors) && signal.errors.length) {
    parts.push(`errors:\n${signal.errors.join('\n')}`);
  }
  if (Array.isArray(signal?.warnings) && signal.warnings.length) {
    parts.push(`warnings:\n${signal.warnings.join('\n')}`);
  }
  return parts.join('\n\n');
}

async function readFileWindow(filePath, maxBytes = 50000, mode = 'tail') {
  const buffer = await fsp.readFile(filePath);
  const bytes = buffer.byteLength;
  const truncated = bytes > maxBytes;
  const slice = truncated
    ? mode === 'head'
      ? buffer.subarray(0, maxBytes)
      : buffer.subarray(Math.max(0, bytes - maxBytes))
    : buffer;
  return {
    text: slice.toString('utf8'),
    bytes,
    truncated,
  };
}

async function readTrustedWorkspaceRegistry() {
  return readJsonIfExists(trustedSignalRegistryPath);
}

async function writeTrustedWorkspaceRegistry(registry) {
  await ensureDir(path.dirname(trustedSignalRegistryPath));
  await fsp.writeFile(trustedSignalRegistryPath, JSON.stringify(registry, null, 2), 'utf8');
}

async function listSignalFilterFiles(dir) {
  if (!(await fileExists(dir))) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(ya?ml|json)$/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function normalizeSignalFilter(definition, sourcePath, scope) {
  const parsed = isPlainObject(definition) ? definition : {};
  const match = isPlainObject(parsed.match) ? parsed.match : {};
  const rules = isPlainObject(parsed.rules) ? parsed.rules : {};
  return {
    name: String(parsed.name || path.basename(sourcePath, path.extname(sourcePath)) || 'signal-filter'),
    description: parsed.description ? String(parsed.description) : '',
    sourcePath,
    scope,
    trusted: scope === 'builtin',
    active: scope === 'builtin',
    match: {
      command: readPatternList(match.command),
      tool: readPatternList(match.tool),
    },
    rules: {
      keep: readPatternList(rules.keep),
      warn: readPatternList(rules.warn),
      drop: readPatternList(rules.drop),
      highlight: readPatternList(rules.highlight),
    },
  };
}

async function loadSignalFilterFile(filePath, scope) {
  const raw = await fsp.readFile(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  const parsed = ext === '.json' ? JSON.parse(raw) : parsePresetYaml(raw);
  if (!isPlainObject(parsed)) {
    throw new Error(`signal filter must be an object: ${path.basename(filePath)}`);
  }
  return normalizeSignalFilter(parsed, filePath, scope);
}

async function loadSignalFilterCatalog() {
  const builtins = [];
  const workspaceFilters = [];
  const registry = await readTrustedWorkspaceRegistry();
  const workspaceEntry = isPlainObject(registry[realRoot]) ? registry[realRoot] : { filters: {} };
  const trustedFiles = isPlainObject(workspaceEntry.filters) ? workspaceEntry.filters : {};

  for (const filePath of await listSignalFilterFiles(builtinSignalFiltersRoot)) {
    try {
      builtins.push(await loadSignalFilterFile(filePath, 'builtin'));
    } catch (error) {
      builtins.push({
        name: path.basename(filePath, path.extname(filePath)),
        description: '',
        sourcePath: filePath,
        scope: 'builtin',
        trusted: true,
        active: true,
        error: String(error?.message || error),
        match: { command: [], tool: [] },
        rules: { keep: [], warn: [], drop: [], highlight: [] },
      });
    }
  }

  for (const filePath of await listSignalFilterFiles(workspaceSignalFiltersRoot)) {
    const rel = path.relative(root, filePath);
    const trustedHash = String(trustedFiles[rel] || '').trim();
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const filter = await loadSignalFilterFile(filePath, 'workspace');
      const fingerprint = sha256(raw);
      const trusted = !!trustedHash && trustedHash === fingerprint;
      workspaceFilters.push({
        ...filter,
        trusted,
        active: trusted,
        fingerprint,
        trustKey: rel,
      });
    } catch (error) {
      workspaceFilters.push({
        name: path.basename(filePath, path.extname(filePath)),
        description: '',
        sourcePath: filePath,
        scope: 'workspace',
        trusted: !!trustedHash,
        active: false,
        error: String(error?.message || error),
        match: { command: [], tool: [] },
        rules: { keep: [], warn: [], drop: [], highlight: [] },
        trustKey: rel,
      });
    }
  }

  return {
    builtins,
    workspace: workspaceFilters,
  };
}

function selectSignalDistiller(commandText, filters = []) {
  const command = String(commandText || '').trim();
  const builtins = filters.filter((filter) => filter.scope === 'builtin' && filter.active);
  const generic = builtins.find((filter) => filter.name === 'generic') || null;
  const matched = builtins.find((filter) => filter.name !== 'generic' && textMatchesAnyPattern(command, filter.match.command)) || null;
  const activeWorkspaceFilters = filters.filter((filter) => filter.scope === 'workspace' && filter.active && textMatchesAnyPattern(command, filter.match.command));
  const selected = matched || generic || { name: 'generic', scope: 'builtin', rules: { keep: [], warn: [], drop: [], highlight: [] }, match: { command: [], tool: [] } };
  const activeFilters = uniqueBy(
    [generic, matched, ...activeWorkspaceFilters].filter(Boolean),
    (filter) => `${filter.scope}:${filter.name}:${filter.sourcePath}`,
  );
  return {
    name: selected.name || 'generic',
    filters: activeFilters,
    matchedFilters: activeFilters.map((filter) => ({
      name: filter.name,
      scope: filter.scope,
      sourcePath: safeSignalPath(filter.sourcePath),
    })),
  };
}

function matchSignalFilterLine(line, filter) {
  const rules = filter?.rules || {};
  const keep = normalizeList(rules.keep).filter((pattern) => textMatchesPattern(line, pattern));
  const warn = normalizeList(rules.warn).filter((pattern) => textMatchesPattern(line, pattern));
  const drop = normalizeList(rules.drop).filter((pattern) => textMatchesPattern(line, pattern));
  const highlight = normalizeList(rules.highlight).filter((pattern) => textMatchesPattern(line, pattern));
  return {
    keep,
    warn,
    drop,
    highlight,
  };
}

function summarizeFilterMatches(matches = []) {
  const summary = [];
  for (const match of matches) {
    const filter = match.filter || match;
    if (match.drop?.length) {
      summary.push(`${filter.name}:drop:${match.drop.slice(0, 3).join('|')}`);
    }
    if (match.warn?.length) {
      summary.push(`${filter.name}:warn:${match.warn.slice(0, 3).join('|')}`);
    }
    if (match.highlight?.length) {
      summary.push(`${filter.name}:highlight:${match.highlight.slice(0, 3).join('|')}`);
    }
  }
  return uniqueLines(summary).slice(0, 24);
}

async function trustWorkspaceSignalFilters() {
  const files = await listSignalFilterFiles(workspaceSignalFiltersRoot);
  const registry = await readTrustedWorkspaceRegistry();
  const trustedFiles = {};
  for (const filePath of files) {
    const rel = path.relative(root, filePath);
    const raw = await fsp.readFile(filePath, 'utf8');
    trustedFiles[rel] = sha256(raw);
  }
  registry[realRoot] = {
    trustedAt: nowIso(),
    filters: trustedFiles,
  };
  await writeTrustedWorkspaceRegistry(registry);
  return {
    trustedAt: registry[realRoot].trustedAt,
    workspace: realRoot,
    files: Object.keys(trustedFiles).sort(),
  };
}

function uniqueLines(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

function distillSignalText(text, options = {}, filters = [], commandText = '') {
  const normalized = normalizeSignalText(text);
  const rawLines = normalized.split('\n').map((line) => line.replace(/\s+$/, ''));
  const compactLines = [];
  let previous = null;
  const removedPatterns = new Set();

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (previous !== '') {
        compactLines.push('');
      } else {
        removedPatterns.add('duplicate blank lines');
      }
      previous = '';
      continue;
    }

    if (trimmed === previous) {
      removedPatterns.add('duplicate lines');
      continue;
    }
    previous = trimmed;
    compactLines.push(line);
  }

  const nonEmpty = compactLines.filter((line) => String(line).trim());
  const signalLines = [];
  const errors = [];
  const warnings = [];
  const highlights = [];
  const matchedFilters = [];

  for (const line of nonEmpty) {
    const lineMatches = [];
    for (const filter of Array.isArray(filters) ? filters : []) {
      if (!filter || filter.active === false) continue;
      const matches = matchSignalFilterLine(line, filter);
      if (matches.keep.length || matches.warn.length || matches.drop.length || matches.highlight.length) {
        lineMatches.push({ filter, ...matches });
      }
    }

    const dropHits = lineMatches.flatMap((match) => match.drop.map((pattern) => `${match.filter.name}:drop:${pattern}`));
    const keepHits = lineMatches.flatMap((match) => match.keep.map((pattern) => `${match.filter.name}:keep:${pattern}`));
    const warnHits = lineMatches.flatMap((match) => match.warn.map((pattern) => `${match.filter.name}:warn:${pattern}`));
    const highlightHits = lineMatches.flatMap((match) => match.highlight.map((pattern) => `${match.filter.name}:highlight:${pattern}`));
    const keepOverride = keepHits.length > 0;

    if (dropHits.length && !keepOverride) {
      for (const hit of dropHits.slice(0, 4)) removedPatterns.add(hit);
      continue;
    }

    signalLines.push(line);

    if (lineMatches.length) {
      matchedFilters.push(
        ...lineMatches.map((match) => ({
          name: match.filter.name,
          scope: match.filter.scope,
          sourcePath: safeSignalPath(match.filter.sourcePath),
        })),
      );
    }

    if (/(error|failed|fail|exception|traceback|panic|fatal|segfault|permission denied|not found|timed out|timeout)/i.test(line)) {
      errors.push(line);
      continue;
    }
    if (warnHits.length || /(warn|warning|deprecated)/i.test(line)) {
      warnings.push(line);
      continue;
    }
    if (highlightHits.length || keepOverride || /(success|succeeded|passed|built|compiled|installed|applied|completed|done|exit code)/i.test(line)) {
      highlights.push(line);
    }
  }

  const headCount = Math.max(4, Math.min(Number(options.headCount || 8), 20));
  const tailCount = Math.max(4, Math.min(Number(options.tailCount || 8), 20));
  const excerpt = signalLines.slice(0, headCount);
  const tail = signalLines.slice(-tailCount);
  const keyLines = uniqueLines([...errors, ...warnings, ...highlights]).slice(0, 24);

  for (const line of keyLines) {
    if (!excerpt.includes(line)) excerpt.push(line);
  }

  if (signalLines.length > excerpt.length + tail.length) {
    excerpt.push('...');
  }
  for (const line of tail) {
    if (!excerpt.includes(line)) excerpt.push(line);
  }

  const sourceLineCount = compactLines.length;
  const keptLineCount = signalLines.filter((line) => String(line).trim()).length;
  const headline = errors.length
    ? 'signal contains errors'
    : warnings.length
      ? 'signal contains warnings'
      : 'signal extracted';

  return {
    headline,
    keyLines,
    errors: uniqueLines(errors).slice(0, 12),
    warnings: uniqueLines(warnings).slice(0, 12),
    excerpt: excerpt.join('\n'),
    removedPatterns: uniqueLines([...removedPatterns, ...summarizeFilterMatches(matchedFilters)]).slice(0, 24),
    matchedFilters: uniqueBy(matchedFilters, (item) => `${item.scope}:${item.name}:${item.sourcePath}`),
    stats: {
      sourceLineCount,
      keptLineCount,
      omittedLineCount: Math.max(0, sourceLineCount - keptLineCount),
    },
  };
}

async function walkFiles(startDir, options = {}) {
  const includeHidden = !!options.includeHidden;
  const ignoreDirs = new Set(options.ignoreDirs || ['.git', 'node_modules', 'dist', 'build', 'logs', '.mcp-workbench']);
  const rootDir = resolveWorkspacePath(startDir || '.');
  const results = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        results.push(path.relative(rootDir, path.join(dir, entry.name)));
      }
    }
  }

  await walk(rootDir);
  return results;
}

function parsePresetScalar(raw) {
  const value = String(raw).trim();
  if (value === '') return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if ((value.startsWith('[') && value.endsWith(']')) || (value.startsWith('{') && value.endsWith('}'))) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function parsePresetInlineMapping(text) {
  const match = String(text).match(/^([^:]+):(.*)$/);
  if (!match) return null;
  const key = match[1].trim();
  const rawValue = match[2].trim();
  if (!key) return null;
  return {
    key,
    value: rawValue === '' ? undefined : parsePresetScalar(rawValue),
  };
}

function mergePresetObject(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) return source;
  return Object.assign(target, source);
}

function parsePresetYaml(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  let index = 0;

  function skipBlankAndComments() {
    while (index < lines.length) {
      const trimmed = lines[index].trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        index += 1;
        continue;
      }
      break;
    }
  }

  function peekIndent() {
    let cursor = index;
    while (cursor < lines.length) {
      const trimmed = lines[cursor].trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        cursor += 1;
        continue;
      }
      return lines[cursor].match(/^ */)?.[0].length || 0;
    }
    return null;
  }

  function parseBlock(expectedIndent) {
    let mode = null;
    const obj = {};
    const arr = [];

    while (index < lines.length) {
      skipBlankAndComments();
      if (index >= lines.length) break;

      const raw = lines[index];
      const indent = raw.match(/^ */)?.[0].length || 0;
      if (indent < expectedIndent) break;
      if (indent > expectedIndent) break;

      const trimmed = raw.slice(expectedIndent);
      if (trimmed.startsWith('- ')) {
        if (mode === null) mode = 'array';
        if (mode !== 'array') {
          throw new Error(`mixed mapping and sequence at line ${index + 1}`);
        }

        index += 1;
        const payload = trimmed.slice(2).trim();
        let item;

        if (!payload) {
          const childIndent = peekIndent();
          item = childIndent !== null && childIndent > expectedIndent ? parseBlock(expectedIndent + 2) : {};
        } else {
          const inline = /^['"\[{]/.test(payload) ? null : parsePresetInlineMapping(payload);
          if (inline) {
            item = { [inline.key]: inline.value };
            const childIndent = peekIndent();
            if (childIndent !== null && childIndent > expectedIndent) {
              const child = parseBlock(expectedIndent + 2);
              item = mergePresetObject(item, child);
            }
          } else {
            item = parsePresetScalar(payload);
            const childIndent = peekIndent();
            if (childIndent !== null && childIndent > expectedIndent) {
              const child = parseBlock(expectedIndent + 2);
              if (isPlainObject(item)) {
                item = mergePresetObject(item, child);
              } else if (isPlainObject(child)) {
                item = { value: item, ...child };
              } else if (Array.isArray(child)) {
                item = [item, ...child];
              }
            }
          }
        }

        arr.push(item);
        continue;
      }

      if (mode === null) mode = 'object';
      if (mode !== 'object') {
        throw new Error(`mixed sequence and mapping at line ${index + 1}`);
      }

      const kv = parsePresetInlineMapping(trimmed);
      if (!kv) {
        throw new Error(`invalid preset line at ${index + 1}: ${raw}`);
      }

      index += 1;
      if (kv.value === undefined) {
        const childIndent = peekIndent();
        obj[kv.key] = childIndent !== null && childIndent > expectedIndent ? parseBlock(expectedIndent + 2) : {};
      } else {
        obj[kv.key] = kv.value;
      }
    }

    return mode === 'array' ? arr : obj;
  }

  return parseBlock(0);
}

function normalizeWorkflowPermissions(rawPermissions) {
  const permissions = isPlainObject(rawPermissions) ? rawPermissions : {};
  const filesystem = isPlainObject(permissions.filesystem) ? permissions.filesystem : {};
  const shell = isPlainObject(permissions.shell) ? permissions.shell : {};
  const network = isPlainObject(permissions.network) ? permissions.network : {};

  return {
    filesystem: {
      read: filesystem.read !== false,
      write: filesystem.write === true,
    },
    shell: {
      enabled: shell.enabled === true,
    },
    network: {
      enabled: network.enabled === true,
    },
  };
}

function normalizeWorkflowStep(step) {
  if (!isPlainObject(step)) {
    throw new Error('each workflow step must be an object');
  }
  const tool = String(step.tool || step.name || '').trim();
  if (!tool) {
    throw new Error('workflow step requires tool');
  }
  return {
    tool,
    arguments: isPlainObject(step.arguments) ? step.arguments : isPlainObject(step.args) ? step.args : {},
    wait: step.wait !== false,
    description: step.description ? String(step.description) : '',
  };
}

function normalizeWorkflowSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.map(normalizeWorkflowStep);
}

function workflowToolCategory(name) {
  if (['read', 'glob', 'grep', 'codesearch', 'lsp'].includes(name)) return 'filesystem-read';
  if (['write', 'edit', 'apply_patch'].includes(name)) return 'filesystem-write';
  if (['bash', 'bash_status', 'bash_tail', 'bash_result', 'bash_kill'].includes(name)) return 'shell';
  if (name === 'webfetch') return 'network';
  if (['job_retrieve', 'signal_diff', 'signal_filters'].includes(name)) return 'workflow-read';
  if (name === 'trust_workspace_filters') return 'workflow-control';
  if (['workflow', 'workflow_cancel'].includes(name)) return 'workflow-control';
  if (['workflow_presets', 'workflow_status', 'workflow_result', 'signal'].includes(name)) return 'workflow-read';
  return 'other';
}

function workflowStepAllowed(step, permissions) {
  const category = workflowToolCategory(step.tool);
  if (category === 'workflow-control') {
    return false;
  }
  if (category === 'filesystem-read') {
    return permissions.filesystem.read;
  }
  if (category === 'filesystem-write') {
    return permissions.filesystem.write;
  }
  if (category === 'shell') {
    return permissions.shell.enabled;
  }
  if (category === 'network') {
    return permissions.network.enabled;
  }
  return true;
}

function isToolEnabled(name) {
  if (['read', 'glob', 'grep', 'codesearch', 'lsp', 'workflow_presets', 'signal', 'workflow_status', 'workflow_result', 'job_retrieve', 'signal_diff', 'signal_filters', 'trust_workspace_filters'].includes(name)) {
    return true;
  }
  if (['write', 'edit', 'apply_patch'].includes(name)) return enableWriteTools;
  if (['bash', 'bash_status', 'bash_tail', 'bash_result', 'bash_kill'].includes(name)) return enableBash;
  if (name === 'webfetch') return enableWebfetch;
  if (name === 'workflow' || name === 'workflow_cancel') return enableWorkflow;
  return true;
}

async function listWorkflowPresetFiles() {
  if (!(await fileExists(realWorkflowPresetsRoot))) return [];
  const entries = await fsp.readdir(realWorkflowPresetsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(ya?ml|json)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function resolveWorkflowPresetPath(name) {
  const base = String(name || '').trim();
  if (!base) throw new Error('preset name is required');
  const safeBase = path.basename(base);
  const candidateNames = path.extname(safeBase)
    ? [safeBase]
    : [`${safeBase}.yaml`, `${safeBase}.yml`, `${safeBase}.json`, safeBase];

  for (const candidate of candidateNames) {
    const filePath = path.resolve(realWorkflowPresetsRoot, candidate);
    if (path.relative(realWorkflowPresetsRoot, filePath).startsWith('..')) continue;
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const realPath = fs.realpathSync(filePath);
      if (path.relative(realWorkflowPresetsRoot, realPath).startsWith('..')) {
        continue;
      }
      return realPath;
    }
  }

  throw new Error(`workflow preset not found: ${base}`);
}

async function loadWorkflowPreset(name) {
  const filePath = resolveWorkflowPresetPath(name);
  const raw = await fsp.readFile(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  const parsed = ext === '.json' ? JSON.parse(raw) : parsePresetYaml(raw);
  if (!isPlainObject(parsed)) {
    throw new Error(`workflow preset must be an object: ${path.basename(filePath)}`);
  }
  const steps = Array.isArray(parsed.steps) ? parsed.steps.map(normalizeWorkflowStep) : [];
  const permissions = normalizeWorkflowPermissions(parsed.permissions);
  return {
    name: String(parsed.name || path.basename(filePath, ext)),
    description: parsed.description ? String(parsed.description) : '',
    sourcePath: filePath,
    permissions,
    steps,
    raw: parsed,
  };
}

async function summarizeWorkflowPresets() {
  const files = await listWorkflowPresetFiles();
  const presets = [];
  for (const file of files) {
    try {
      const preset = await loadWorkflowPreset(file);
      presets.push({
        name: preset.name,
        file: path.basename(preset.sourcePath),
        description: preset.description,
        stepCount: preset.steps.length,
        permissions: preset.permissions,
      });
    } catch (error) {
      presets.push({
        name: path.basename(file, path.extname(file)),
        file,
        error: String(error?.message || error),
      });
    }
  }
  return presets;
}

async function describeWorkflowPreset(name) {
  const preset = await loadWorkflowPreset(name);
  return {
    name: preset.name,
    file: path.basename(preset.sourcePath),
    description: preset.description,
    stepCount: preset.steps.length,
    permissions: preset.permissions,
    steps: preset.steps,
  };
}

async function resolveWorkflowPlan(args) {
  const presetName = String(args.preset || args.workflowPreset || '').trim();
  const inlineSteps = normalizeWorkflowSteps(args.steps);
  const explicitName = String(args.name || '').trim();
  let preset = null;
  let steps = inlineSteps;
  let permissions = normalizeWorkflowPermissions(null);
  let name = explicitName;
  let description = '';

  if (presetName) {
    preset = await loadWorkflowPreset(presetName);
    steps = [...preset.steps, ...inlineSteps];
    permissions = preset.permissions;
    if (!name) name = preset.name;
    description = preset.description;
  }

  if (!steps.length) {
    throw new Error('workflow requires steps or preset');
  }

  return {
    name: name || 'workflow',
    description,
    steps,
    permissions,
    preset,
  };
}

function validateWorkflowPlan(plan) {
  const errors = [];
  for (const step of plan.steps) {
    if (!TOOL_NAMES.has(step.tool)) {
      errors.push(`unknown workflow tool: ${step.tool}`);
      continue;
    }
    if (!isToolEnabled(step.tool)) {
      errors.push(`workflow tool disabled: ${step.tool}`);
      continue;
    }
    if (!workflowStepAllowed(step, plan.permissions)) {
      errors.push(`workflow step not allowed by permissions: ${step.tool}`);
    }
  }
  return uniqueLines(errors);
}

function globToRegExp(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\.^$+{}()|[]'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += '$';
  return new RegExp(out);
}

function getToolAnnotations(name) {
  const readOnly = ['read', 'glob', 'grep', 'webfetch', 'workflow_presets', 'signal', 'workflow_status', 'workflow_result', 'job_retrieve', 'signal_diff', 'signal_filters'];
  const writeTools = ['write', 'edit', 'apply_patch', 'bash', 'bash_status', 'bash_tail', 'bash_result', 'bash_kill', 'workflow', 'workflow_cancel'];
  const configTools = ['trust_workspace_filters'];

  if (readOnly.includes(name)) {
    return {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
  }

  if (writeTools.includes(name)) {
    return {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    };
  }

  if (configTools.includes(name)) {
    return {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
  }

  return undefined;
}

function baseTool(name, description, inputSchema) {
  const tool = { name, description, inputSchema };
  const annotations = getToolAnnotations(name);
  if (annotations) tool.annotations = annotations;
  return tool;
}

const TOOLS = [
  baseTool('read', 'Read a text file from the workspace.', {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root.' },
    },
    required: ['path'],
    additionalProperties: false,
  }),
  baseTool('write', 'Write a text file to the workspace.', {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
      mkdirp: { type: 'boolean', default: true },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  }),
  baseTool('edit', 'Edit a text file by replacing text or overwriting the whole file.', {
    type: 'object',
    properties: {
      path: { type: 'string' },
      oldString: { type: 'string' },
      newString: { type: 'string' },
      replaceAll: { type: 'boolean', default: false },
      content: { type: 'string', description: 'Optional full replacement content.' },
    },
    required: ['path'],
    additionalProperties: false,
  }),
  baseTool('glob', 'Find files in the workspace by glob pattern.', {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      cwd: { type: 'string' },
      includeHidden: { type: 'boolean', default: false },
      limit: { type: 'number', default: 200 },
    },
    required: ['pattern'],
    additionalProperties: false,
  }),
  baseTool('grep', 'Search file contents in the workspace.', {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      glob: { type: 'string' },
      ignoreCase: { type: 'boolean', default: false },
      literal: { type: 'boolean', default: false },
      maxResults: { type: 'number', default: 200 },
    },
    required: ['pattern'],
    additionalProperties: false,
  }),
  baseTool('codesearch', 'Search code across the workspace using grep-like matching.', {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      glob: { type: 'string' },
      ignoreCase: { type: 'boolean', default: false },
      literal: { type: 'boolean', default: false },
      maxResults: { type: 'number', default: 200 },
    },
    required: ['pattern'],
    additionalProperties: false,
  }),
  baseTool('lsp', 'Best-effort workspace symbol search based on text matching.', {
    type: 'object',
    properties: {
      query: { type: 'string' },
      pattern: { type: 'string' },
      path: { type: 'string' },
      glob: { type: 'string' },
      ignoreCase: { type: 'boolean', default: true },
      literal: { type: 'boolean', default: true },
      maxResults: { type: 'number', default: 200 },
    },
    required: ['query'],
    additionalProperties: false,
  }),
  baseTool('webfetch', 'Fetch a URL and return the response body.', {
    type: 'object',
    properties: {
      url: { type: 'string' },
      timeoutMs: { type: 'number', default: 15000 },
      maxChars: { type: 'number', default: 20000 },
    },
    required: ['url'],
    additionalProperties: false,
  }),
  baseTool('apply_patch', 'Apply a unified diff patch to the workspace.', {
    type: 'object',
    properties: {
      patch: { type: 'string' },
      cwd: { type: 'string' },
    },
    required: ['patch'],
    additionalProperties: false,
  }),
  baseTool('bash', 'Run a shell command asynchronously and return a job id immediately.', {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string' },
      timeoutMs: { type: 'number', default: 0 },
      description: { type: 'string' },
    },
    required: ['command'],
    additionalProperties: false,
  }),
  baseTool('bash_status', 'Check the current status of a bash job.', {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
    },
    required: ['jobId'],
    additionalProperties: false,
  }),
  baseTool('bash_tail', 'Read the latest stdout/stderr from a bash job.', {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
      lines: { type: 'number', default: 200 },
    },
    required: ['jobId'],
    additionalProperties: false,
  }),
  baseTool('bash_result', 'Get the final result of a bash job.', {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
    },
    required: ['jobId'],
    additionalProperties: false,
  }),
  baseTool('bash_kill', 'Terminate a running bash job.', {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
    },
    required: ['jobId'],
    additionalProperties: false,
  }),
  baseTool('workflow_presets', 'List workflow presets in the preset directory or inspect one preset.', {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Optional preset name to inspect.' },
    },
    additionalProperties: false,
  }),
  baseTool('signal', 'Return a distilled signal view for a job or workflow.', {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
      lines: { type: 'number', default: 300 },
      includeRaw: { type: 'boolean', default: false },
    },
    required: ['jobId'],
    additionalProperties: false,
  }),
  baseTool('job_retrieve', 'Retrieve raw log content for a job by rewind ref or job id.', {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'Rewind reference such as rewind:job_xxx:stdout.' },
      jobId: { type: 'string' },
      stream: { type: 'string', enum: ['stdout', 'stderr', 'combined', 'trace'] },
      maxBytes: { type: 'number', default: 50000 },
      mode: { type: 'string', enum: ['tail', 'head'], default: 'tail' },
    },
    additionalProperties: false,
  }),
  baseTool('signal_diff', 'Compare raw job output with distilled signal output.', {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
      lines: { type: 'number', default: 300 },
      includeRaw: { type: 'boolean', default: false },
    },
    required: ['jobId'],
    additionalProperties: false,
  }),
  baseTool('signal_filters', 'Inspect signal filters and matching distillers.', {
    type: 'object',
    properties: {
      name: { type: 'string' },
      command: { type: 'string', description: 'Optional command string to inspect matching filters.' },
      includeInactive: { type: 'boolean', default: true },
      workspaceOnly: { type: 'boolean', default: false },
    },
    additionalProperties: false,
  }),
  baseTool('trust_workspace_filters', 'Trust local workspace signal filters for the current workspace.', {
    type: 'object',
    properties: {},
    additionalProperties: false,
  }),
  baseTool('workflow', 'Run a batch of tool steps or a named workflow preset as one background job.', {
    type: 'object',
    properties: {
      name: { type: 'string' },
      preset: { type: 'string', description: 'Preset name from the workflow preset directory.' },
      stopOnError: { type: 'boolean', default: true },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string' },
            arguments: { type: 'object' },
            wait: { type: 'boolean', default: true },
            description: { type: 'string' },
          },
          required: ['tool'],
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  }),
  baseTool('workflow_status', 'Inspect a workflow job.', {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
    },
    required: ['jobId'],
    additionalProperties: false,
  }),
  baseTool('workflow_result', 'Fetch the final result of a workflow job.', {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
    },
    required: ['jobId'],
    additionalProperties: false,
  }),
  baseTool('workflow_cancel', 'Cancel a workflow job.', {
    type: 'object',
    properties: {
      jobId: { type: 'string' },
    },
    required: ['jobId'],
    additionalProperties: false,
  }),
];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

function createJob(kind, title, extra = {}) {
  const jobId = crypto.randomUUID();
  const dir = path.join(realJobsRoot, jobId);
  const job = {
    jobId,
    kind,
    title: title || kind,
    status: 'queued',
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    message: '',
    error: null,
    result: null,
    exitCode: null,
    signal: null,
    pid: null,
    childJobId: null,
    command: null,
    presetName: null,
    presetPath: null,
    permissions: null,
    stdoutPath: path.join(dir, 'stdout.log'),
    stderrPath: path.join(dir, 'stderr.log'),
    metaPath: path.join(dir, 'meta.json'),
    ...extra,
  };
  jobs.set(jobId, job);
  void persistJob(job).catch((err) => {
    console.error('[mcp-workbench] failed to persist job:', jobId, err);
  });
  return job;
}

async function persistJob(job) {
  await ensureDir(path.dirname(job.metaPath));
  const snapshot = {
    jobId: job.jobId,
    kind: job.kind,
    title: job.title,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    message: job.message,
    error: job.error,
    result: job.result,
    exitCode: job.exitCode,
    signal: job.signal,
    pid: job.pid,
    childJobId: job.childJobId,
    command: job.command,
    cwd: job.cwd,
    presetName: job.presetName,
    presetPath: job.presetPath,
    permissions: job.permissions,
  };
  await fsp.writeFile(job.metaPath, JSON.stringify(snapshot, null, 2));
}

function getJob(jobId) {
  if (!jobs.has(jobId)) {
    const found = loadJobFromDiskSync(jobId);
    if (found) jobs.set(jobId, found);
  }
  return jobs.get(jobId) || null;
}

function loadJobFromDiskSync(jobId) {
  const metaPath = path.join(realJobsRoot, jobId, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    const raw = fs.readFileSync(metaPath, 'utf8');
    const meta = JSON.parse(raw);
    return {
      jobId: meta.jobId,
      kind: meta.kind,
      title: meta.title,
      status: meta.status,
      createdAt: meta.createdAt,
      startedAt: meta.startedAt,
      finishedAt: meta.finishedAt,
      message: meta.message || '',
      error: meta.error || null,
      result: meta.result || null,
      exitCode: meta.exitCode ?? null,
      signal: meta.signal ?? null,
      pid: meta.pid ?? null,
      childJobId: meta.childJobId ?? null,
      command: meta.command ?? null,
      cwd: meta.cwd ?? null,
      presetName: meta.presetName ?? null,
      presetPath: meta.presetPath ?? null,
      permissions: meta.permissions ?? null,
      stdoutPath: path.join(path.dirname(metaPath), 'stdout.log'),
      stderrPath: path.join(path.dirname(metaPath), 'stderr.log'),
      metaPath,
    };
  } catch {
    return null;
  }
}

async function restoreJobs() {
  if (!(await fileExists(realJobsRoot))) return;
  const entries = await fsp.readdir(realJobsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const job = loadJobFromDiskSync(entry.name);
    if (job) jobs.set(job.jobId, job);
  }
}

function jobIsTerminal(job) {
  return ['completed', 'failed', 'cancelled', 'timed_out', 'rejected'].includes(job?.status);
}

async function cleanupJobsOnce() {
  if (jobRetentionHours === 0 && jobMaxCount === 0) return;
  if (!(await fileExists(realJobsRoot))) return;

  const entries = await fsp.readdir(realJobsRoot, { withFileTypes: true });
  const loaded = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const job = loadJobFromDiskSync(entry.name);
    if (job) loaded.push(job);
  }

  const now = Date.now();
  const retentionMs = jobRetentionHours > 0 ? jobRetentionHours * 60 * 60 * 1000 : 0;
  const terminal = loaded
    .filter((job) => jobIsTerminal(job))
    .sort((a, b) => {
      const aTime = Date.parse(a.finishedAt || a.createdAt || '') || 0;
      const bTime = Date.parse(b.finishedAt || b.createdAt || '') || 0;
      return aTime - bTime;
    });

  const deleteCandidates = new Map();

  for (const job of terminal) {
    if (retentionMs > 0) {
      const finished = Date.parse(job.finishedAt || job.createdAt || '') || 0;
      if (finished > 0 && now - finished > retentionMs) {
        deleteCandidates.set(job.jobId, job);
      }
    }
  }

  if (jobMaxCount > 0 && terminal.length > jobMaxCount) {
    for (const job of terminal.slice(0, terminal.length - jobMaxCount)) {
      deleteCandidates.set(job.jobId, job);
    }
  }

  const deleteList = [...deleteCandidates.values()];

  for (const job of deleteList) {
    try {
      await fsp.rm(path.dirname(job.metaPath), { recursive: true, force: true });
      jobs.delete(job.jobId);
    } catch (error) {
      console.error('[mcp-workbench] cleanup job failed:', job.jobId, error);
    }
  }
}

function scheduleJobCleanup() {
  cleanupJobsOnce().catch((err) => {
    console.error('[mcp-workbench] cleanup failed:', err);
  });
  setInterval(() => {
    cleanupJobsOnce().catch((err) => {
      console.error('[mcp-workbench] cleanup failed:', err);
    });
  }, jobCleanupIntervalMs).unref?.();
}

async function markJob(job, patch) {
  Object.assign(job, patch);
  await persistJob(job);
  return job;
}

async function appendJobLog(filePath, chunk) {
  await fsp.appendFile(filePath, chunk);
}

async function spawnBashJob(command, cwd, timeoutMs, description) {
  const job = createJob('bash', description || command.slice(0, 80), { command, cwd });
  await markJob(job, {
    status: 'running',
    startedAt: nowIso(),
    message: 'running',
  });

  const shell = '/bin/bash';
  const child = spawn(shell, ['-lc', command], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sanitizeBashEnvironment(process.env),
  });

  job.pid = child.pid;
  await persistJob(job);

  if (timeoutMs && timeoutMs > 0) {
    setTimeout(() => {
      const current = getJob(job.jobId);
      if (current && current.status === 'running') {
        void markJob(job, {
          status: 'timed_out',
          finishedAt: nowIso(),
          message: `timed out after ${timeoutMs}ms`,
        }).catch((err) => {
          console.error('[mcp-workbench] failed to mark timed out job:', err);
        });
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // ignore
        }
      }
    }, timeoutMs).unref?.();
  }

  child.stdout.on('data', async (chunk) => {
    void appendJobLog(job.stdoutPath, chunk).catch((err) => {
      console.error('[mcp-workbench] stdout log error:', err);
    });
  });
  child.stderr.on('data', async (chunk) => {
    void appendJobLog(job.stderrPath, chunk).catch((err) => {
      console.error('[mcp-workbench] stderr log error:', err);
    });
  });

  child.on('error', async (err) => {
    await markJob(job, {
      status: 'failed',
      finishedAt: nowIso(),
      error: String(err?.message || err),
      message: String(err?.message || err),
    });
  });

  child.on('close', async (code, signal) => {
    const current = getJob(job.jobId);
    if (!current || current.status === 'cancelled' || current.status === 'timed_out') return;
    await markJob(job, {
      status: code === 0 ? 'completed' : 'failed',
      finishedAt: nowIso(),
      exitCode: code,
      signal: signal || null,
      message: code === 0 ? 'completed' : `exit code ${code}`,
    });
  });

  child.unref();
  return job;
}

async function killJob(jobId) {
  const job = getJob(jobId);
  if (!job) throw new Error(`job not found: ${jobId}`);
  if (job.status !== 'running' && job.status !== 'queued') {
    return job;
  }
  if (job.pid) {
    try {
      process.kill(-job.pid, 'SIGTERM');
    } catch {
      try {
        process.kill(job.pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
  }
  await markJob(job, {
    status: 'cancelled',
    finishedAt: nowIso(),
    message: 'cancelled',
  });
  return job;
}

async function runTool(name, args, ctx = {}) {
  if (!isToolEnabled(name)) {
    throw new Error(`tool disabled: ${name}`);
  }
  switch (name) {
    case 'read':
      return handleRead(args);
    case 'write':
      return handleWrite(args);
    case 'edit':
      return handleEdit(args);
    case 'glob':
      return handleGlob(args);
    case 'grep':
      return handleGrep(args);
    case 'codesearch':
      return handleCodeSearch(args);
    case 'lsp':
      return handleLspSearch(args);
    case 'webfetch':
      return handleWebFetch(args);
    case 'apply_patch':
      return handleApplyPatch(args);
    case 'bash':
      return handleBash(args);
    case 'bash_status':
      return handleBashStatus(args);
    case 'bash_tail':
      return handleBashTail(args);
    case 'bash_result':
      return handleBashResult(args);
    case 'bash_kill':
      return handleBashKill(args);
    case 'workflow_presets':
      return handleWorkflowPresets(args);
    case 'signal':
      return handleSignal(args);
    case 'job_retrieve':
      return handleJobRetrieve(args);
    case 'signal_diff':
      return handleSignalDiff(args);
    case 'signal_filters':
      return handleSignalFilters(args);
    case 'trust_workspace_filters':
      return handleTrustWorkspaceFilters(args);
    case 'workflow':
      return handleWorkflow(args, ctx);
    case 'workflow_status':
      return handleWorkflowStatus(args);
    case 'workflow_result':
      return handleWorkflowResult(args);
    case 'workflow_cancel':
      return handleWorkflowCancel(args);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function handleRead(args) {
  const filePath = await resolveExistingWorkspacePath(args.path || args.filePath);
  const content = await fsp.readFile(filePath, 'utf8');
  return { content: okContent(content) };
}

async function handleWrite(args) {
  const filePath = await resolveWritableWorkspacePath(args.path || args.filePath);
  const dir = path.dirname(filePath);
  if (args.mkdirp !== false) await ensureDir(dir);
  await fsp.writeFile(filePath, String(args.content ?? ''), 'utf8');
  return { content: okContent(`wrote ${path.relative(root, filePath)}`) };
}

async function handleEdit(args) {
  const filePath = args.content !== undefined
    ? await resolveWritableWorkspacePath(args.path || args.filePath)
    : await resolveExistingWorkspacePath(args.path || args.filePath);
  const dir = path.dirname(filePath);
  if (args.content !== undefined) {
    if (args.mkdirp !== false) await ensureDir(dir);
    await fsp.writeFile(filePath, String(args.content), 'utf8');
    return { content: okContent(`rewrote ${path.relative(root, filePath)}`) };
  }

  const oldString = args.oldString;
  const newString = args.newString ?? '';
  if (typeof oldString !== 'string' || oldString.length === 0) {
    throw new Error('edit requires oldString or content');
  }
  const current = await fsp.readFile(filePath, 'utf8');
  const count = current.split(oldString).length - 1;
  if (count === 0) throw new Error('oldString not found');
  const updated = args.replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString);
  await fsp.writeFile(filePath, updated, 'utf8');
  return { content: okContent(`edited ${path.relative(root, filePath)} (${count} match${count === 1 ? '' : 'es'})`) };
}

async function handleGlob(args) {
  const cwd = args.cwd ? await resolveWorkspaceDirectoryPath(args.cwd) : root;
  const includeHidden = !!args.includeHidden;
  const limit = Math.max(1, Number(args.limit || 200));
  const pattern = String(args.pattern);
  const regex = globToRegExp(pattern);
  const files = await walkFiles(cwd, { includeHidden });
  const matches = files.filter((file) => regex.test(file)).slice(0, limit);
  return { content: okContent(matches.join('\n') || '(no matches)') };
}

async function handleGrep(args) {
  const pattern = String(args.pattern);
  const literal = !!args.literal;
  const ignoreCase = !!args.ignoreCase;
  const maxResults = Math.max(1, Number(args.maxResults || 200));
  const rootPath = args.path ? await resolveExistingWorkspacePath(args.path) : root;
  const globPattern = args.glob ? String(args.glob) : null;
  const searchRegex = literal ? null : new RegExp(pattern, ignoreCase ? 'i' : '');
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  const stat = await fsp.stat(rootPath);
  const files = stat.isDirectory() ? await walkFiles(rootPath, { includeHidden: false }) : [path.basename(rootPath)];
  const filtered = globPattern ? files.filter((file) => globToRegExp(globPattern).test(file)) : files;
  const results = [];

  for (const rel of filtered) {
    if (results.length >= maxResults) break;
    const abs = stat.isDirectory() ? path.join(rootPath, rel) : rootPath;
    let text;
    try {
      text = await fsp.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const matched = literal
        ? (ignoreCase ? line.toLowerCase().includes(needle) : line.includes(needle))
        : searchRegex.test(line);
      if (matched) {
        results.push(`${path.relative(root, abs)}:${i + 1}: ${line}`);
        if (results.length >= maxResults) break;
      }
    }
  }

  return { content: okContent(results.join('\n') || '(no matches)') };
}

async function handleCodeSearch(args) {
  return handleGrep(args);
}

async function handleLspSearch(args) {
  const normalized = {
    ...args,
    pattern: String(args.pattern || args.query || ''),
    literal: args.literal !== undefined ? !!args.literal : true,
    ignoreCase: args.ignoreCase !== undefined ? !!args.ignoreCase : true,
  };
  if (!normalized.pattern) throw new Error('query is required');
  return handleGrep(normalized);
}

async function handleWebFetch(args) {
  const url = String(args.url);
  const timeoutMs = Math.max(1000, Number(args.timeoutMs || 15000));
  const maxChars = Math.max(1024, Number(args.maxChars || 20000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('fetch timeout')), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': `${serverName}/${serverVersion}` },
    });
    const text = await response.text();
    const clipped = text.slice(0, maxChars);
    return {
      content: okContent(
        [
          `status: ${response.status} ${response.statusText}`,
          `content-type: ${response.headers.get('content-type') || 'unknown'}`,
          '',
          clipped,
        ].join('\n'),
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractPatchPaths(patchText) {
  const paths = [];
  for (const line of String(patchText || '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const parts = line.split(/\s+/);
      for (const raw of parts.slice(2)) {
        const cleaned = raw.replace(/^a\//, '').replace(/^b\//, '');
        if (cleaned && cleaned !== '/dev/null') paths.push(cleaned);
      }
      continue;
    }

    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const raw = line.slice(4).trim().split(/\s+/)[0];
      const cleaned = raw.replace(/^a\//, '').replace(/^b\//, '');
      if (cleaned && cleaned !== '/dev/null') paths.push(cleaned);
      continue;
    }

    if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      paths.push(line.replace(/^rename (from|to)\s+/, '').trim());
    }
  }
  return paths;
}

function assertSafePatchPath(patchPath) {
  if (!patchPath || patchPath === '/dev/null') return;
  if (path.isAbsolute(patchPath)) {
    throw new Error(`patch path must be relative: ${patchPath}`);
  }
  const normalized = path.normalize(patchPath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error(`patch path escapes workspace: ${patchPath}`);
  }
}

function validatePatchPaths(patchText) {
  for (const patchPath of extractPatchPaths(patchText)) {
    assertSafePatchPath(patchPath);
  }
}

async function runPatchCommand(command, cwd) {
  const attempts = [
    { cmd: 'git', args: ['apply', '--whitespace=nowarn', '-'] },
    { cmd: 'patch', args: ['-p0', '--forward', '--batch', '--silent'] },
  ];

  for (const attempt of attempts) {
    const result = await new Promise((resolve) => {
      const child = spawn(attempt.cmd, attempt.args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
      child.on('error', (err) => resolve({ ok: false, error: String(err?.message || err), stdout, stderr }));
      child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
      child.stdin.end(command, 'utf8');
    });
    if (result.ok) return result;
  }
  throw new Error('failed to apply patch with git apply or patch');
}

async function handleApplyPatch(args) {
  const cwd = args.cwd ? await resolveWorkspaceDirectoryPath(args.cwd) : root;
  validatePatchPaths(String(args.patch));
  await runPatchCommand(String(args.patch), cwd);
  return { content: okContent(`applied patch in ${path.relative(root, cwd) || '.'}`) };
}

async function handleBash(args) {
  const command = String(args.command || '');
  if (!command.trim()) throw new Error('command is required');
  const cwd = args.cwd ? await resolveWorkspaceDirectoryPath(args.cwd) : root;
  const timeoutMs = Number(args.timeoutMs || 0);
  const description = args.description || command.slice(0, 120);
  const job = await spawnBashJob(command, cwd, timeoutMs, description);
  return {
    content: okContent(JSON.stringify({
      jobId: job.jobId,
      status: job.status,
      description: job.title,
      message: 'job started; use bash_status, bash_tail, bash_result, or signal to follow progress',
    }, null, 2)),
  };
}

async function handleBashStatus(args) {
  const job = getJob(args.jobId);
  if (!job) throw new Error(`job not found: ${args.jobId}`);
  return {
    content: okContent(JSON.stringify({
      jobId: job.jobId,
      kind: job.kind,
      title: job.title,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      message: job.message,
      exitCode: job.exitCode,
      signal: job.signal,
      pid: job.pid,
    }, null, 2)),
  };
}

async function handleBashTail(args) {
  const job = getJob(args.jobId);
  if (!job) throw new Error(`job not found: ${args.jobId}`);
  const lineCount = normalizeLineCount(args.lines, 200);
  const stdout = await readTail(job.stdoutPath, lineCount);
  const stderr = await readTail(job.stderrPath, lineCount);
  return {
    content: okContent(
      [
        `stdout:`,
        stdout || '(empty)',
        '',
        `stderr:`,
        stderr || '(empty)',
      ].join('\n'),
    ),
  };
}

async function handleBashResult(args) {
  const job = getJob(args.jobId);
  if (!job) throw new Error(`job not found: ${args.jobId}`);
  if (job.status === 'running' || job.status === 'queued') {
    return { content: okContent(`job ${job.jobId} is still ${job.status}`) };
  }
  const stdout = await readTail(job.stdoutPath, 5000);
  const stderr = await readTail(job.stderrPath, 5000);
  return {
    content: okContent(
      JSON.stringify({
        jobId: job.jobId,
        status: job.status,
        exitCode: job.exitCode,
        signal: job.signal,
        stdout,
        stderr,
      }, null, 2),
    ),
  };
}

async function handleBashKill(args) {
  const job = await killJob(args.jobId);
  return {
    content: okContent(JSON.stringify({
      jobId: job.jobId,
      status: job.status,
      message: 'job cancelled',
    }, null, 2)),
  };
}

async function handleWorkflowPresets(args) {
  const name = String(args.name || '').trim();
  if (name) {
    return {
      content: okContent(JSON.stringify({ preset: await describeWorkflowPreset(name) }, null, 2)),
    };
  }

  return {
    content: okContent(JSON.stringify({ presets: await summarizeWorkflowPresets() }, null, 2)),
  };
}

function summarizeWorkflowTrace(trace = []) {
  const lines = [];
  for (let i = 0; i < trace.length; i += 1) {
    const entry = trace[i] || {};
    const tool = String(entry.tool || `step ${i + 1}`);
    const result = redactSecrets(asText(entry.result));
    if (result) {
      lines.push(`[${i + 1}] ${tool}: ${result.slice(0, 4000)}`);
    } else if (entry.error) {
      lines.push(`[${i + 1}] ${tool}: error: ${redactSecrets(asText(entry.error)).slice(0, 4000)}`);
    }
  }
  return lines.join('\n');
}

function collectTraceArtifacts(trace = []) {
  const commandsRun = [];
  const filesTouched = [];
  for (const entry of trace) {
    const tool = String(entry?.tool || '');
    const input = isPlainObject(entry?.input) ? entry.input : {};
    if (tool === 'bash' && typeof input.command === 'string' && input.command.trim()) {
      commandsRun.push(redactSecrets(input.command.trim()));
    }
    if (['write', 'edit'].includes(tool) && typeof (input.path || input.filePath) === 'string' && String(input.path || input.filePath).trim()) {
      filesTouched.push(String(input.path || input.filePath).trim());
    }
    if (tool === 'apply_patch' && typeof input.patch === 'string') {
      filesTouched.push(...extractPatchPaths(input.patch));
    }
  }
  return {
    commandsRun: uniqueLines(commandsRun),
    filesTouched: uniqueLines(filesTouched),
  };
}

async function buildJobSignal(job, options = {}) {
  const lineCount = normalizeLineCount(options.lines, 300);
  const stdoutRaw = await readTail(job.stdoutPath, lineCount);
  const stderrRaw = await readTail(job.stderrPath, lineCount);
  const workflowArtifacts = job.kind === 'workflow' && job.result?.trace
    ? collectTraceArtifacts(job.result.trace)
    : { commandsRun: job.command ? [job.command] : [], filesTouched: [] };
  const commandText = String(workflowArtifacts.commandsRun[0] || job.command || '').trim();
  const traceText = job.kind === 'workflow' && job.result?.trace ? redactSecrets(summarizeWorkflowTrace(job.result.trace)) : '';
  const stdout = redactSecrets(stdoutRaw);
  const stderr = redactSecrets(stderrRaw);
  const logText = [traceText, stdout ? `stdout:\n${stdout}` : '', stderr ? `stderr:\n${stderr}` : '']
    .filter(Boolean)
    .join('\n\n');
  const filterCatalog = await loadSignalFilterCatalog();
  const signalProfile = selectSignalDistiller(commandText, [...filterCatalog.builtins, ...filterCatalog.workspace]);
  const distilled = distillSignalText(logText, options, signalProfile.filters, commandText);
  const commandsRun = uniqueLines(workflowArtifacts.commandsRun).map((command) => redactSecrets(command));
  const filesTouched = uniqueLines(workflowArtifacts.filesTouched);
  const errors = uniqueLines([
    ...(job.status === 'rejected' && job.error ? [redactSecrets(job.error)] : []),
    ...distilled.errors,
  ]).filter(Boolean);
  const warnings = uniqueLines(distilled.warnings).filter(Boolean);
  const headline = job.status === 'rejected'
    ? 'workflow rejected by permissions'
    : job.status === 'timed_out'
      ? 'job timed out'
      : job.status === 'failed'
        ? 'job failed'
        : errors.length > 0
          ? 'signal contains errors'
          : warnings.length > 0
            ? 'signal contains warnings'
            : 'signal extracted';
  const combinedFeedback = `${errors.join('\n')}\n${warnings.join('\n')}\n${stdout}\n${stderr}`.trim();
  const nextAction = job.status === 'rejected'
    ? 'enable the missing permission in the preset or remove the blocked step'
    : job.status === 'timed_out'
      ? 'increase timeoutMs, split the job into smaller steps, or inspect partial output'
      : /permission denied/i.test(combinedFeedback)
        ? 'check workspace permissions or tool gating'
        : /not found/i.test(combinedFeedback)
          ? 'check command availability, path, or preset references'
          : job.status === 'failed'
            ? 'read stderr and fix the failing command'
            : warnings.length > 0
              ? 'review warnings before continuing'
              : 'continue with the next step';
  const summaryText = buildSignalSummaryText({
    headline,
    nextAction,
    keyLines: distilled.keyLines,
    errors,
    warnings,
  });
  const signalPayload = {
    jobId: job.jobId,
    kind: job.kind,
    title: job.title,
    status: job.status,
    childJobId: job.childJobId || null,
    presetName: job.presetName || null,
    presetPath: job.presetPath || null,
    distiller: signalProfile.name || 'generic',
    headline,
    keyLines: distilled.keyLines,
    errors,
    warnings,
    excerpt: distilled.excerpt,
    stats: {
      ...distilled.stats,
      rawChars: logText.length,
      signalChars: summaryText.length,
      estimatedRawTokens: estimateTokens(logText),
      estimatedSignalTokens: estimateTokens(summaryText),
      estimatedReductionPct: logText.length > 0
        ? Math.max(0, Math.round((1 - (summaryText.length / logText.length)) * 1000) / 10)
        : 0,
    },
    nextAction,
    commandsRun,
    filesTouched,
    removedPatterns: distilled.removedPatterns || [],
    matchedFilters: distilled.matchedFilters || signalProfile.matchedFilters || [],
    rewind: {
      available: true,
      stdoutRef: `rewind:${job.jobId}:stdout`,
      stderrRef: `rewind:${job.jobId}:stderr`,
      combinedRef: `rewind:${job.jobId}:combined`,
      traceRef: `rewind:${job.jobId}:trace`,
    },
    rawPaths: {
      stdout: safeSignalPath(job.stdoutPath),
      stderr: safeSignalPath(job.stderrPath),
    },
    includeRaw: !!options.includeRaw,
    rawWarning: options.includeRaw ? 'raw output may contain secrets; use carefully' : undefined,
    raw: options.includeRaw ? { stdout, stderr } : undefined,
  };
  return signalPayload;
}

async function handleSignal(args) {
  const job = getJob(args.jobId);
  if (!job) throw new Error(`job not found: ${args.jobId}`);
  const signal = await buildJobSignal(job, args);
  return {
    content: okContent(JSON.stringify(signal, null, 2)),
  };
}

function parseJobRewindRef(args) {
  const ref = String(args.ref || '').trim();
  const jobId = String(args.jobId || '').trim();
  const stream = String(args.stream || '').trim() || 'combined';

  if (ref) {
    if (ref.startsWith('rewind:')) {
      const parts = ref.split(':');
      if (parts.length < 3 || !parts[1] || !parts[2]) {
        throw new Error(`invalid rewind ref: ${ref}`);
      }
      return {
        ref,
        jobId: parts[1],
        stream: parts[2],
      };
    }
    return {
      ref: `rewind:${ref}:${stream}`,
      jobId: ref,
      stream,
    };
  }

  if (!jobId) {
    throw new Error('jobId or ref is required');
  }

  return {
    ref: `rewind:${jobId}:${stream}`,
    jobId,
    stream,
  };
}

async function readJobStream(job, stream, maxBytes = 50000, mode = 'tail') {
  const normalizedStream = String(stream || 'combined').trim() || 'combined';
  const limit = Math.max(1024, Number(maxBytes || 50000));

  if (normalizedStream === 'trace') {
    const trace = Array.isArray(job.result?.trace) ? JSON.stringify(job.result.trace, null, 2) : '';
    const clipped = trace.length > limit
      ? mode === 'head'
        ? trace.slice(0, limit)
        : trace.slice(Math.max(0, trace.length - limit))
      : trace;
    return {
      text: clipped,
      bytes: Buffer.byteLength(trace, 'utf8'),
      truncated: trace.length > limit,
    };
  }

  if (normalizedStream === 'stdout') {
    return readFileWindow(job.stdoutPath, limit, mode);
  }

  if (normalizedStream === 'stderr') {
    return readFileWindow(job.stderrPath, limit, mode);
  }

  const stdout = await readTextIfExists(job.stdoutPath);
  const stderr = await readTextIfExists(job.stderrPath);
  const combined = [
    stdout ? `stdout:\n${stdout}` : '',
    stderr ? `stderr:\n${stderr}` : '',
  ].filter(Boolean).join('\n\n');
  const bytes = Buffer.byteLength(combined, 'utf8');
  const text = bytes > limit
    ? mode === 'head'
      ? combined.slice(0, limit)
      : combined.slice(Math.max(0, combined.length - limit))
    : combined;
  return {
    text,
    bytes,
    truncated: bytes > limit,
  };
}

async function handleJobRetrieve(args) {
  const refInfo = parseJobRewindRef(args);
  const job = getJob(refInfo.jobId);
  if (!job) throw new Error(`job not found: ${refInfo.jobId}`);
  const stream = refInfo.stream === 'combined' || refInfo.stream === 'stdout' || refInfo.stream === 'stderr' || refInfo.stream === 'trace'
    ? refInfo.stream
    : 'combined';
  const mode = String(args.mode || 'tail').trim() === 'head' ? 'head' : 'tail';
  const payload = await readJobStream(job, stream, args.maxBytes, mode);
  return {
    content: okContent(JSON.stringify({
      ref: refInfo.ref,
      jobId: job.jobId,
      kind: job.kind,
      title: job.title,
      stream,
      mode,
      bytes: payload.bytes,
      truncated: payload.truncated,
      content: payload.text,
    }, null, 2)),
  };
}

function buildSignalPreviewText(signal) {
  const preview = {
    jobId: signal.jobId,
    kind: signal.kind,
    status: signal.status,
    headline: signal.headline,
    nextAction: signal.nextAction,
    keyLines: signal.keyLines,
    errors: signal.errors,
    warnings: signal.warnings,
    distiller: signal.distiller,
  };
  return JSON.stringify(preview, null, 2);
}

async function handleSignalDiff(args) {
  const job = getJob(args.jobId);
  if (!job) throw new Error(`job not found: ${args.jobId}`);
  const signal = await buildJobSignal(job, args);
  const lineCount = normalizeLineCount(args.lines, 300);
  const rawPreviewParts = [];
  if (job.kind === 'workflow' && Array.isArray(job.result?.trace) && job.result.trace.length) {
    rawPreviewParts.push(redactSecrets(summarizeWorkflowTrace(job.result.trace)).slice(0, 12000));
  }
  const stdout = redactSecrets(await readTail(job.stdoutPath, lineCount));
  const stderr = redactSecrets(await readTail(job.stderrPath, lineCount));
  if (stdout) rawPreviewParts.push(`stdout:\n${stdout}`);
  if (stderr) rawPreviewParts.push(`stderr:\n${stderr}`);
  const rawPreview = rawPreviewParts.filter(Boolean).join('\n\n');
  return {
    content: okContent(JSON.stringify({
      jobId: job.jobId,
      kind: job.kind,
      status: job.status,
      distiller: signal.distiller,
      rawPreview,
      signalPreview: buildSignalPreviewText(signal),
      removedPatterns: signal.removedPatterns || [],
      reductionPct: signal.stats?.estimatedReductionPct ?? null,
      metrics: signal.stats,
      rewind: signal.rewind,
    }, null, 2)),
  };
}

async function handleSignalFilters(args) {
  const catalog = await loadSignalFilterCatalog();
  const name = String(args.name || '').trim();
  const command = String(args.command || '').trim();
  const includeInactive = args.includeInactive !== false;
  const workspaceOnly = args.workspaceOnly === true;
  const filters = workspaceOnly
    ? [...catalog.workspace]
    : [...catalog.builtins, ...catalog.workspace];
  const filtered = includeInactive ? filters : filters.filter((filter) => filter.active);
  const selected = command ? selectSignalDistiller(command, filtered) : null;
  const matchFilters = command
    ? filtered.filter((filter) => {
        if (!filter.active) return false;
        if (!filter.match?.command?.length) return true;
        return textMatchesAnyPattern(command, filter.match.command);
      })
    : [];

  if (name) {
    const found = filtered.find((filter) => filter.name === name);
    if (!found) throw new Error(`signal filter not found: ${name}`);
    return {
      content: okContent(JSON.stringify({
        filter: {
          name: found.name,
          description: found.description,
          sourcePath: safeSignalPath(found.sourcePath),
          scope: found.scope,
          trusted: !!found.trusted,
          active: !!found.active,
          match: found.match,
          rules: found.rules,
          error: found.error || null,
        },
        distiller: selected?.name || null,
        matchingFilters: selected?.matchedFilters || [],
      }, null, 2)),
    };
  }

  return {
    content: okContent(JSON.stringify({
      workspace: realRoot,
      trustRegistry: trustedSignalRegistryPath,
      distiller: selected?.name || null,
      activeFilters: selected?.matchedFilters || matchFilters.map((filter) => ({
        name: filter.name,
        scope: filter.scope,
        sourcePath: safeSignalPath(filter.sourcePath),
      })),
      filters: filtered.map((filter) => ({
        name: filter.name,
        description: filter.description,
        sourcePath: safeSignalPath(filter.sourcePath),
        scope: filter.scope,
        trusted: !!filter.trusted,
        active: !!filter.active,
        match: filter.match,
        rules: filter.rules,
        error: filter.error || null,
      })),
    }, null, 2)),
  };
}

async function handleTrustWorkspaceFilters() {
  const result = await trustWorkspaceSignalFilters();
  return {
    content: okContent(JSON.stringify({
      workspace: result.workspace,
      trustedAt: result.trustedAt,
      files: result.files,
      registry: trustedSignalRegistryPath,
    }, null, 2)),
  };
}

async function waitForBashJob(jobId, timeoutMs = 0) {
  const started = Date.now();
  for (;;) {
    const job = getJob(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    if (job.status !== 'running' && job.status !== 'queued') return job;
    if (timeoutMs > 0 && Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for bash job ${jobId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

async function executeWorkflowStep(step, workflowJob, permissions) {
  const tool = step.tool || step.name;
  const input = step.arguments || step.input || {};
  const wait = step.wait !== false;
  if (!workflowStepAllowed(step, permissions)) {
    throw new Error(`workflow step not allowed by preset permissions: ${tool}`);
  }
  const result = await runTool(tool, input, { workflowJobId: workflowJob.jobId });

  if (tool === 'bash' && wait) {
    const parsed = safeJsonFromContent(result);
    if (parsed && parsed.jobId) {
      workflowJob.childJobId = parsed.jobId;
      await persistJob(workflowJob);
      await waitForBashJob(parsed.jobId, Number(step.timeoutMs || 0));
      const finalResult = await handleBashResult({ jobId: parsed.jobId });
      return {
        tool,
        input,
        awaited: true,
        result: finalResult.content[0].text,
      };
    }
  }

  return {
    tool,
    input,
    awaited: false,
    result: result.content?.[0]?.text || asText(result),
  };
}

function safeJsonFromContent(result) {
  try {
    const text = result?.content?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildWorkflowPreflightErrors(plan) {
  const errors = [];
  for (const step of plan.steps) {
    if (!TOOL_NAMES.has(step.tool)) {
      errors.push(`unknown workflow tool: ${step.tool}`);
      continue;
    }
    if (!isToolEnabled(step.tool)) {
      errors.push(`workflow tool disabled: ${step.tool}`);
      continue;
    }
    if (!workflowStepAllowed(step, plan.permissions)) {
      errors.push(`workflow step not allowed by permissions: ${step.tool}`);
    }
  }
  return uniqueLines(errors);
}

function buildWorkflowPreflightPayload(job, errors, plan, extra = {}) {
  const headline = 'workflow rejected by permissions';
  const nextAction = errors.some((error) => /bash|shell/i.test(error))
    ? 'enable shell permissions in the preset or remove the blocked shell step'
    : errors.some((error) => /write|edit|apply_patch/i.test(error))
      ? 'enable write permissions in the preset or remove the blocked write step'
      : errors.some((error) => /network|webfetch/i.test(error))
        ? 'enable network permissions or remove the blocked network step'
        : 'adjust the preset permissions or remove the blocked step';
  return {
    kind: 'workflow_preflight_error',
    status: 'rejected',
    jobId: job.jobId,
    headline,
    errors,
    nextAction,
    presetName: plan?.preset?.name || null,
    presetPath: plan?.preset?.sourcePath || null,
    permissions: plan?.permissions || null,
    ...extra,
  };
}

async function handleWorkflow(args) {
  const stopOnError = args.stopOnError !== false;
  let plan;
  try {
    plan = await resolveWorkflowPlan(args);
  } catch (error) {
    const rejectedJob = createJob('workflow', String(args.name || args.preset || 'workflow'), {});
    await markJob(rejectedJob, {
      status: 'rejected',
      startedAt: nowIso(),
      finishedAt: nowIso(),
      message: String(error?.message || error),
      error: String(error?.stack || error),
      result: {
        kind: 'workflow_preflight_error',
        status: 'rejected',
        headline: 'workflow rejected',
        errors: [String(error?.message || error)],
        nextAction: 'fix the preset or step list and try again',
      },
    });
    return {
      content: okContent(JSON.stringify(buildWorkflowPreflightPayload(rejectedJob, [String(error?.message || error)], null, {
        message: String(error?.message || error),
      }), null, 2)),
      isError: true,
    };
  }

  const preflightErrors = buildWorkflowPreflightErrors(plan);
  const job = createJob('workflow', plan.name || 'workflow', {
    totalSteps: plan.steps.length,
    currentStep: 0,
    presetName: plan.preset?.name || null,
    presetPath: plan.preset?.sourcePath || null,
    permissions: plan.permissions,
  });

  if (preflightErrors.length) {
    await markJob(job, {
      status: 'rejected',
      startedAt: nowIso(),
      finishedAt: nowIso(),
      message: 'workflow rejected by permissions',
      error: preflightErrors.join('\n'),
      result: {
        kind: 'workflow_preflight_error',
        status: 'rejected',
        headline: 'workflow rejected by permissions',
        errors: preflightErrors,
        nextAction: preflightErrors.some((error) => /bash|shell/i.test(error))
          ? 'enable shell permissions in the preset or remove the blocked shell step'
          : preflightErrors.some((error) => /write|edit|apply_patch/i.test(error))
            ? 'enable write permissions in the preset or remove the blocked write step'
            : preflightErrors.some((error) => /network|webfetch/i.test(error))
              ? 'enable network permissions or remove the blocked network step'
              : 'adjust the preset permissions or remove the blocked step',
        presetName: plan.preset?.name || null,
        presetPath: plan.preset?.sourcePath || null,
        permissions: plan.permissions,
      },
    });
    return {
      content: okContent(JSON.stringify(buildWorkflowPreflightPayload(job, preflightErrors, plan), null, 2)),
      isError: true,
    };
  }

  await markJob(job, {
    status: 'running',
    startedAt: nowIso(),
    message: 'workflow started',
  });

  setImmediate(async () => {
    const trace = [];
    let hadErrors = false;
    try {
      for (let i = 0; i < plan.steps.length; i += 1) {
        const step = plan.steps[i];
        await markJob(job, {
          currentStep: i + 1,
          totalSteps: plan.steps.length,
          message: step.description || `step ${i + 1}: ${step.tool}`,
        });
        try {
          const entry = await executeWorkflowStep(step, job, plan.permissions);
          trace.push(entry);
        } catch (error) {
          hadErrors = true;
          trace.push({
            tool: step.tool,
            input: step.arguments || step.input || {},
            awaited: false,
            error: String(error?.message || error),
          });
          if (stopOnError) throw error;
        }
        if (job.status === 'cancelled') return;
      }
      await markJob(job, {
        status: 'completed',
        finishedAt: nowIso(),
        message: hadErrors ? 'workflow completed with errors' : 'workflow completed',
        result: { trace },
      });
    } catch (error) {
      await markJob(job, {
        status: 'failed',
        finishedAt: nowIso(),
        error: String(error?.stack || error),
        message: String(error?.message || error),
      });
    }
  });

  return {
    content: okContent(JSON.stringify({
      jobId: job.jobId,
      status: job.status,
      message: 'workflow queued; use workflow_status, workflow_result, or signal to follow progress',
    }, null, 2)),
  };
}

async function handleWorkflowStatus(args) {
  const job = getJob(args.jobId);
  if (!job || job.kind !== 'workflow') throw new Error(`workflow job not found: ${args.jobId}`);
  return {
    content: okContent(JSON.stringify({
      jobId: job.jobId,
      status: job.status,
      currentStep: job.currentStep || 0,
      totalSteps: job.totalSteps || 0,
      message: job.message,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      childJobId: job.childJobId || null,
      presetName: job.presetName || null,
      presetPath: job.presetPath || null,
      permissions: job.permissions || null,
    }, null, 2)),
  };
}

async function handleWorkflowResult(args) {
  const job = getJob(args.jobId);
  if (!job || job.kind !== 'workflow') throw new Error(`workflow job not found: ${args.jobId}`);
  if (job.status === 'running' || job.status === 'queued') {
    return { content: okContent(`workflow ${job.jobId} is still ${job.status}`) };
  }
  return {
    content: okContent(JSON.stringify({
      jobId: job.jobId,
      status: job.status,
      result: job.result,
      error: job.error,
      presetName: job.presetName || null,
      presetPath: job.presetPath || null,
      permissions: job.permissions || null,
    }, null, 2)),
  };
}

async function handleWorkflowCancel(args) {
  const job = getJob(args.jobId);
  if (!job || job.kind !== 'workflow') throw new Error(`workflow job not found: ${args.jobId}`);
  if (job.childJobId) {
    try {
      await killJob(job.childJobId);
    } catch {
      // ignore
    }
  }
  await markJob(job, {
    status: 'cancelled',
    finishedAt: nowIso(),
    message: 'workflow cancelled',
  });
  return {
    content: okContent(JSON.stringify({
      jobId: job.jobId,
      status: job.status,
      message: 'workflow cancelled',
    }, null, 2)),
  };
}

function buildHealthPayload() {
  return {
    ok: true,
    name: serverName,
    version: serverVersion,
  };
}

function buildDebugHealthPayload() {
  return {
    ...buildHealthPayload(),
    workspace: root,
    realWorkspace: realRoot,
    jobsDir: realJobsRoot,
    workflowPresetsDir: realWorkflowPresetsRoot,
    signalFiltersDir: workspaceSignalFiltersRoot,
    builtinSignalFiltersDir: builtinSignalFiltersRoot,
    trustedSignalRegistryPath,
    authRequired: !!authToken || !allowNoAuth,
    allowNoAuth,
    allowQueryToken,
    allowOutside,
    responseMode,
    sanitizeBashEnv,
    toolGating: {
      write: enableWriteTools,
      bash: enableBash,
      webfetch: enableWebfetch,
      workflow: enableWorkflow,
    },
    enabledTools: TOOLS.filter((tool) => isToolEnabled(tool.name)).map((tool) => tool.name),
    jobCount: jobs.size,
  };
}

function getSession(req, method) {
  const header = String(req.headers['mcp-session-id'] || '').trim();
  if (header && sessions.has(header)) return sessions.get(header);
  if (method === 'initialize') return null;
  if (sessions.size === 1) return sessions.values().next().value;
  if (header) {
    const session = { sessionId: header, createdAt: nowIso() };
    sessions.set(header, session);
    return session;
  }
  return null;
}

function authorize(req, urlObj) {
  if (!authToken) return allowNoAuth;
  const queryToken = allowQueryToken ? String(urlObj.searchParams.get('auth_token') || '').trim() : '';
  const authHeader = String(req.headers.authorization || '');
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  return bearer === authToken || (allowQueryToken && queryToken === authToken);
}

function buildToolsList() {
  return { tools: TOOLS.filter((tool) => isToolEnabled(tool.name)) };
}

async function handleRpc(req, res, urlObj) {
  if (!authorize(req, urlObj)) {
    sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    sendJson(res, error?.statusCode === 413 ? 413 : 400, rpcError(null, error?.statusCode === 413 ? -32000 : -32700, error?.statusCode === 413 ? 'request body too large' : 'parse error', String(error?.message || error)));
    return;
  }

  const method = body?.method;
  const hasId = Object.prototype.hasOwnProperty.call(body, 'id');
  const id = hasId ? body.id : null;
  const isNotification = !hasId;
  const params = isPlainObject(body?.params) ? body.params : {};

  const session = getSession(req, method);

  if (method === 'initialize') {
    const sessionId = session?.sessionId || crypto.randomUUID();
    sessions.set(sessionId, { sessionId, createdAt: nowIso() });
    const payload = rpcResult(id, {
      protocolVersion: params.protocolVersion || '2024-11-05',
      serverInfo: { name: serverName, version: serverVersion },
      capabilities: { tools: {}, logging: {} },
    });
    sendRpcResponse(req, res, 200, payload, { 'mcp-session-id': sessionId });
    return;
  }

  if (isNotification) {
    res.writeHead(204, { 'mcp-session-id': session?.sessionId || '' });
    res.end();
    return;
  }

  if (!session) {
    sendRpcResponse(req, res, 400, rpcError(id, -32000, 'session not initialized'));
    return;
  }

  try {
    if (method === 'tools/list') {
      sendRpcResponse(req, res, 200, rpcResult(id, buildToolsList()), { 'mcp-session-id': session.sessionId });
      return;
    }

    if (method === 'tools/call') {
      const toolName = String(params.name || '');
      if (!toolName) throw new Error('tool name is required');
      const toolArgs = isPlainObject(params.arguments) ? params.arguments : {};
      const result = await runTool(toolName, toolArgs, { sessionId: session.sessionId });
      sendRpcResponse(req, res, 200, rpcResult(id, {
        content: result.content || okContent('(no content)'),
        isError: !!result.isError,
      }), { 'mcp-session-id': session.sessionId });
      return;
    }

    if (method === 'ping') {
      sendRpcResponse(req, res, 200, rpcResult(id, {}), { 'mcp-session-id': session.sessionId });
      return;
    }

    sendRpcResponse(req, res, 400, rpcError(id, -32601, `method not found: ${method}`), { 'mcp-session-id': session.sessionId });
  } catch (error) {
    sendRpcResponse(req, res, 200, rpcResult(id, {
      content: okContent(`error: ${String(error?.message || error)}`),
      isError: true,
    }), { 'mcp-session-id': session.sessionId });
  }
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

  applyCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && (urlObj.pathname === '/' || urlObj.pathname === '/health')) {
    sendJson(res, 200, buildHealthPayload());
    return;
  }

  if (req.method === 'GET' && urlObj.pathname === '/debug/health') {
    if (!authorize(req, urlObj)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    sendJson(res, 200, buildDebugHealthPayload());
    return;
  }

  if (req.method === 'POST') {
    handleRpc(req, res, urlObj);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.on('error', (err) => {
  console.error('[mcp-workbench] server error:', err);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`[mcp-workbench] listening on http://${host}:${port}`);
  console.log(`[mcp-workbench] workspace: ${root}`);
  console.log(`[mcp-workbench] jobs: ${realJobsRoot}`);
});

process.on('SIGINT', async () => {
  server.close(() => process.exit(0));
});

process.on('SIGTERM', async () => {
  server.close(() => process.exit(0));
});
