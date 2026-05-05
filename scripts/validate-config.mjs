#!/usr/bin/env node

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      result[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      i += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function parseScalar(raw) {
  const value = String(raw).trim();
  if (value === '') return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
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

function parseInlineMapping(text) {
  const match = String(text).match(/^([^:]+):(.*)$/);
  if (!match) return null;
  const key = match[1].trim();
  const rawValue = match[2].trim();
  if (!key) return null;
  return {
    key,
    value: rawValue === '' ? undefined : parseScalar(rawValue),
  };
}

function mergeObject(target, source) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
  return Object.assign(target, source);
}

function parseYaml(text) {
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
          const inline = /^['"\[{]/.test(payload) ? null : parseInlineMapping(payload);
          if (inline) {
            item = { [inline.key]: inline.value };
            const childIndent = peekIndent();
            if (childIndent !== null && childIndent > expectedIndent) {
              item = mergeObject(item, parseBlock(expectedIndent + 2));
            }
          } else {
            item = parseScalar(payload);
            const childIndent = peekIndent();
            if (childIndent !== null && childIndent > expectedIndent) {
              const child = parseBlock(expectedIndent + 2);
              if (item && typeof item === 'object' && !Array.isArray(item)) {
                item = mergeObject(item, child);
              } else if (child && typeof child === 'object' && !Array.isArray(child)) {
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

      const kv = parseInlineMapping(trimmed);
      if (!kv) {
        throw new Error(`invalid YAML line at ${index + 1}: ${raw}`);
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

async function readStructuredFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return JSON.parse(raw);
  return parseYaml(raw);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function validatePermission(name, permission) {
  if (!['readonly', 'standard', 'yolo'].includes(permission)) {
    throw new Error(`${name}: invalid permission preset "${permission}"`);
  }
}

function validateWorkerProfile(filePath, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('profile must be an object');
  }
  const workers = asArray(data.workers);
  if (!workers.length) {
    throw new Error('profile must contain at least one worker');
  }

  const defaults = data.defaults && typeof data.defaults === 'object' && !Array.isArray(data.defaults) ? data.defaults : {};
  const names = new Set();
  const ports = new Set();

  for (let i = 0; i < workers.length; i += 1) {
    const worker = workers[i];
    if (!worker || typeof worker !== 'object' || Array.isArray(worker)) {
      throw new Error(`worker ${i + 1} must be an object`);
    }
    const name = String(worker.name || '').trim();
    if (!name) throw new Error(`worker ${i + 1} is missing name`);
    if (names.has(name)) throw new Error(`duplicate worker name: ${name}`);
    names.add(name);

    const permission = String(worker.permission ?? defaults.permission ?? 'yolo').trim().toLowerCase();
    validatePermission(name, permission);

    const workspace = String(worker.workspace ?? defaults.workspace ?? '').trim();
    if (!workspace) {
      throw new Error(`worker ${name} is missing workspace`);
    }

    const port = worker.port ?? null;
    const portBase = Number(worker.portBase ?? worker.port_base ?? defaults.portBase ?? defaults.port_base ?? NaN);
    const resolvedPort = Number(port) > 0 ? Number(port) : (Number.isFinite(portBase) ? portBase + i : NaN);
    if (!Number.isFinite(resolvedPort) || resolvedPort <= 0) {
      throw new Error(`worker ${name} is missing port`);
    }
    if (ports.has(resolvedPort)) {
      throw new Error(`duplicate worker port: ${resolvedPort}`);
    }
    ports.add(resolvedPort);
  }

  return {
    type: 'worker-profile',
    filePath,
    workerCount: workers.length,
  };
}

function validateWorkflowPreset(filePath, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('workflow preset must be an object');
  }
  const name = String(data.name || '').trim();
  if (!name) throw new Error('workflow preset is missing name');
  const steps = asArray(data.steps);
  if (!steps.length) throw new Error('workflow preset must contain at least one step');
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(`workflow step ${i + 1} must be an object`);
    }
    const tool = String(step.tool || step.name || '').trim();
    if (!tool) throw new Error(`workflow step ${i + 1} is missing tool`);
  }
  return {
    type: 'workflow-preset',
    filePath,
    name,
    stepCount: steps.length,
  };
}

function validateSignalFilter(filePath, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('signal filter must be an object');
  }
  const name = String(data.name || '').trim();
  if (!name) throw new Error('signal filter is missing name');
  const rules = data.rules && typeof data.rules === 'object' && !Array.isArray(data.rules) ? data.rules : data;
  const ruleKeys = ['drop', 'warn', 'highlight'];
  const hasAnyRules = ruleKeys.some((key) => Array.isArray(rules[key]) && rules[key].length > 0);
  if (!hasAnyRules) {
    throw new Error('signal filter must define drop, warn, or highlight patterns');
  }
  return {
    type: 'signal-filter',
    filePath,
    name,
    ruleKeys: ruleKeys.filter((key) => Array.isArray(rules[key]) && rules[key].length > 0),
  };
}

function normalizeGlobs(values) {
  const patterns = values.filter(Boolean);
  return patterns.length ? patterns : ['worker-profiles', 'workflow-presets', 'signal-filters'];
}

async function walkFiles(startDir, collected = []) {
  let entries = [];
  try {
    entries = await fs.readdir(startDir, { withFileTypes: true });
  } catch {
    return collected;
  }

  for (const entry of entries) {
    const abs = path.join(startDir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(abs, collected);
    } else if (/\.(ya?ml|json)$/i.test(entry.name)) {
      collected.push(abs);
    }
  }
  return collected;
}

async function validateFile(filePath) {
  const data = await readStructuredFile(filePath);
  const rel = path.relative(root, filePath).replace(/\\/g, '/');
  if (rel.startsWith('worker-profiles/')) return validateWorkerProfile(filePath, data);
  if (rel.startsWith('workflow-presets/')) return validateWorkflowPreset(filePath, data);
  if (rel.startsWith('signal-filters/')) return validateSignalFilter(filePath, data);
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log([
      'Usage:',
      '  node scripts/validate-config.mjs',
      '  node scripts/validate-config.mjs --root <path>',
      '  node scripts/validate-config.mjs worker-profiles workflow-presets signal-filters',
      '',
      'Options:',
      '  --root <path>   Repo root to validate (default: current repo)',
    ].join('\n'));
    return;
  }

  const validateRoot = args.root ? path.resolve(String(args.root)) : root;
  const globs = normalizeGlobs(args._.map(String));
  const files = [];
  for (const pattern of globs) {
    const target = path.isAbsolute(pattern) ? pattern : path.join(validateRoot, pattern);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) continue;
    if (stat.isFile()) {
      files.push(target);
      continue;
    }
    await walkFiles(target, files);
  }

  if (!files.length) {
    die('no config files found to validate');
  }

  const summaries = [];
  for (const filePath of files) {
    const summary = await validateFile(filePath);
    if (summary) summaries.push(summary);
  }

  const workerCount = summaries.filter((entry) => entry.type === 'worker-profile').length;
  const presetCount = summaries.filter((entry) => entry.type === 'workflow-preset').length;
  const filterCount = summaries.filter((entry) => entry.type === 'signal-filter').length;
  console.log([
    'config validation passed',
    `worker profiles: ${workerCount}`,
    `workflow presets: ${presetCount}`,
    `signal filters: ${filterCount}`,
  ].join('\n'));
}

await main();
