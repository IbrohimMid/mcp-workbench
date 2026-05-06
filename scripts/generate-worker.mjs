#!/usr/bin/env node

import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRoot = path.resolve(__dirname, '..');

const PRESETS = {
  readonly: {
    MCP_ENABLE_WRITE_TOOLS: '0',
    MCP_ENABLE_BASH: '0',
    MCP_ENABLE_WEBFETCH: '0',
    MCP_ENABLE_WORKFLOW: '1',
    MCP_SANITIZE_BASH_ENV: '1',
  },
  standard: {
    MCP_ENABLE_WRITE_TOOLS: '1',
    MCP_ENABLE_BASH: '0',
    MCP_ENABLE_WEBFETCH: '1',
    MCP_ENABLE_WORKFLOW: '1',
    MCP_SANITIZE_BASH_ENV: '1',
  },
  yolo: {
    MCP_ENABLE_WRITE_TOOLS: '1',
    MCP_ENABLE_BASH: '1',
    MCP_ENABLE_WEBFETCH: '1',
    MCP_ENABLE_WORKFLOW: '1',
    MCP_SANITIZE_BASH_ENV: '1',
  },
};

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
      const key = token.slice(2, eq);
      const value = token.slice(eq + 1);
      result[key] = value;
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

function expandHome(input) {
  const value = String(input || '').trim();
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveAbsolute(input) {
  return path.resolve(expandHome(input));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function formatEnvLine(key, value) {
  return `${key}=${shellQuote(value)}`;
}

function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function permissionPreset(permission) {
  const preset = PRESETS[String(permission || 'yolo').trim().toLowerCase()];
  if (!preset) {
    const names = Object.keys(PRESETS).join(', ');
    die(`unknown permission preset "${permission}". Use one of: ${names}`);
  }
  return preset;
}

function parseProfileScalar(raw) {
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

function parseProfileInlineMapping(text) {
  const match = String(text).match(/^([^:]+):(.*)$/);
  if (!match) return null;
  const key = match[1].trim();
  const rawValue = match[2].trim();
  if (!key) return null;
  return {
    key,
    value: rawValue === '' ? undefined : parseProfileScalar(rawValue),
  };
}

function mergeProfileObject(target, source) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
  return Object.assign(target, source);
}

function parseProfileYaml(text) {
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
          const inline = /^['"\[{]/.test(payload) ? null : parseProfileInlineMapping(payload);
          if (inline) {
            item = { [inline.key]: inline.value };
            const childIndent = peekIndent();
            if (childIndent !== null && childIndent > expectedIndent) {
              const child = parseBlock(expectedIndent + 2);
              item = mergeProfileObject(item, child);
            }
          } else {
            item = parseProfileScalar(payload);
            const childIndent = peekIndent();
            if (childIndent !== null && childIndent > expectedIndent) {
              const child = parseBlock(expectedIndent + 2);
              if (item && typeof item === 'object' && !Array.isArray(item)) {
                item = mergeProfileObject(item, child);
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

      const kv = parseProfileInlineMapping(trimmed);
      if (!kv) {
        throw new Error(`invalid profile line at ${index + 1}: ${raw}`);
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

function resolveProfilePath(profileInput, root) {
  const value = String(profileInput || '').trim();
  if (!value) {
    die('--profile is required');
  }

  const candidates = [];
  const absolute = path.isAbsolute(value) ? value : null;
  if (absolute) {
    candidates.push(absolute);
  } else {
    candidates.push(path.resolve(process.cwd(), value));
    if (root) candidates.push(path.resolve(root, value));
  }

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate) && fsSync.statSync(candidate).isFile()) {
      return fsSync.realpathSync(candidate);
    }
  }

  die(`profile not found: ${value}`);
}

function normalizeWorkerName(value, fallback) {
  return String(value || fallback || '').trim();
}

function normalizeWorkerClient(value, fallback) {
  return String(value || fallback || '').trim().toLowerCase();
}

function normalizeTunnelMode(value, fallback) {
  return String(value || fallback || 'quick').trim().toLowerCase();
}

function normalizeWorkflowMode(value, fallback) {
  return String(value || fallback || 'sync').trim();
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isFinite(port) && port > 0 ? port : null;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return !!fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return !!fallback;
}

function normalizeWorkerSpec(raw, defaults, index, root) {
  const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const name = normalizeWorkerName(entry.name, defaults.name);
  if (!name) die(`worker profile entry ${index + 1} is missing name`);
  const client = normalizeWorkerClient(entry.client, name);
  if (!client) die(`worker profile entry ${name} is missing client`);

  const workspaceValue = entry.workspace ?? defaults.workspace;
  if (!workspaceValue) {
    die(`worker profile entry ${name} is missing workspace`);
  }
  const workspace = resolveAbsolute(workspaceValue);
  const workspaceStat = fsSync.statSync(workspace, { throwIfNoEntry: false });
  if (!workspaceStat) {
    die(`worker profile workspace does not exist: ${workspace}`);
  }
  if (!workspaceStat.isDirectory()) {
    die(`worker profile workspace is not a directory: ${workspace}`);
  }

  const permission = String(entry.permission ?? defaults.permission ?? 'yolo').trim().toLowerCase();
  const preset = permissionPreset(permission);
  const allowOutsideWorkspace = normalizeBoolean(
    entry.allowOutsideWorkspace
    ?? entry.allow_outside_workspace
    ?? defaults.allowOutsideWorkspace
    ?? defaults.allow_outside_workspace
    ?? false,
  );
  const portBase = normalizePort(defaults.portBase ?? defaults.port_base ?? defaults.portbase);
  const port = normalizePort(entry.port) ?? (portBase !== null ? portBase + index : null);
  if (!port) {
    die(`worker profile entry ${name} is missing port`);
  }

  const tunnelMode = normalizeTunnelMode(entry.tunnelMode ?? entry.tunnel_mode ?? entry['tunnel-mode'], defaults.tunnelMode ?? defaults.tunnel_mode ?? defaults['tunnel-mode']);
  const workflowMode = normalizeWorkflowMode(entry.workflowMode ?? entry.workflow_mode ?? entry['workflow-mode'], defaults.workflowMode ?? defaults.workflow_mode ?? defaults['workflow-mode']);
  const serverCmd = String(entry.serverCmd ?? entry.server_cmd ?? entry['server-cmd'] ?? defaults.serverCmd ?? defaults.server_cmd ?? defaults['server-cmd'] ?? '').trim();
  const tunnelUrl = String(entry.tunnelUrl ?? entry.tunnel_url ?? entry['tunnel-url'] ?? defaults.tunnelUrl ?? defaults.tunnel_url ?? defaults['tunnel-url'] ?? `http://127.0.0.1:${port}`).trim();
  const token = String(entry.token || '').trim() || randomToken();
  const home = os.homedir();
  const serverName = `mcp-workbench-${name}`;
  const workerDir = path.join(root, '.mcp-workbench', 'workers', name);
  const logDir = path.join(workerDir, 'logs');

  return {
    name,
    client,
    workspace,
    permission,
    allowOutsideWorkspace,
    preset,
    port,
    tunnelMode,
    workflowMode,
    serverCmd,
    tunnelUrl,
    token,
    serverName,
    home,
    workerDir,
    logDir,
  };
}

async function loadWorkerProfile(profilePath) {
  const raw = await fs.readFile(profilePath, 'utf8');
  const ext = path.extname(profilePath).toLowerCase();
  const parsed = ext === '.json' ? JSON.parse(raw) : parseProfileYaml(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    die(`worker profile must be an object: ${profilePath}`);
  }
  const workers = Array.isArray(parsed.workers) ? parsed.workers : [];
  if (!workers.length) {
    die(`worker profile must contain at least one worker: ${profilePath}`);
  }
  const defaults = parsed.defaults && typeof parsed.defaults === 'object' && !Array.isArray(parsed.defaults) ? parsed.defaults : {};
  return {
    name: String(parsed.name || path.basename(profilePath, ext) || 'worker-profile'),
    description: String(parsed.description || ''),
    defaults: {
      ...defaults,
      workspace: parsed.workspace ?? defaults.workspace,
      permission: parsed.permission ?? defaults.permission ?? 'yolo',
      allowOutsideWorkspace: parsed.allowOutsideWorkspace ?? defaults.allowOutsideWorkspace ?? false,
      portBase: parsed.portBase ?? parsed.port_base ?? defaults.portBase ?? defaults.port_base ?? null,
      tunnelMode: parsed.tunnelMode ?? parsed.tunnel_mode ?? defaults.tunnelMode ?? defaults.tunnel_mode ?? 'quick',
      workflowMode: parsed.workflowMode ?? parsed.workflow_mode ?? defaults.workflowMode ?? defaults.workflow_mode ?? 'sync',
      serverCmd: parsed.serverCmd ?? parsed.server_cmd ?? defaults.serverCmd ?? defaults.server_cmd ?? '',
      tunnelUrl: parsed.tunnelUrl ?? parsed.tunnel_url ?? defaults.tunnelUrl ?? defaults.tunnel_url ?? '',
    },
    workers,
    sourcePath: profilePath,
  };
}

async function writeWorkerEnv(root, spec, options = {}) {
  const workerDir = spec.workerDir || path.join(root, '.mcp-workbench', 'workers', spec.name);
  const envFile = path.join(root, '.mcp-workbench', 'workers', `${spec.name}.env`);
  const existing = await pathExists(envFile);
  if (existing && !options.overwrite) {
    die(`worker env already exists: ${envFile} (use --overwrite to replace it)`);
  }

  const serverLog = path.join(spec.logDir, 'server.log');
  const tunnelLog = path.join(spec.logDir, 'tunnel.log');
  const jobDir = path.join(spec.workspace, '.mcp-workbench', 'jobs', spec.name);
  const signalFilterDir = path.join(spec.workspace, '.mcp-workbench', 'signal-filters');
  const workflowPresetDir = path.join(spec.workspace, 'workflow-presets');
  const trustRegistry = path.join(spec.home || os.homedir(), '.config', 'mcp-workbench', 'trusted-workspaces.json');

  await ensureDir(path.dirname(envFile));
  await ensureDir(spec.logDir);

  const env = {
    MCP_SERVER_NAME: spec.serverName,
    MCP_HOST: '127.0.0.1',
    MCP_PORT: String(spec.port),
    WORKSPACE_DIR: spec.workspace,
    MCP_AGENT: spec.serverName,
    MCP_TOKEN: spec.token,
    MCP_ALLOW_NO_AUTH: '0',
    MCP_ALLOW_QUERY_TOKEN: '0',
    MCP_ALLOW_OUTSIDE_WORKSPACE: spec.allowOutsideWorkspace ? '1' : '0',
    MCP_SERVER_CMD: spec.serverCmd,
    MCP_WORKFLOW_MODE: spec.workflowMode,
    MCP_WORKFLOW_JOB_DIR: jobDir,
    MCP_WORKFLOW_PRESET_DIR: workflowPresetDir,
    MCP_SIGNAL_FILTER_DIR: signalFilterDir,
    MCP_SIGNAL_TRUST_REGISTRY: trustRegistry,
    MCP_WORKFLOW_POLL_INTERVAL_MS: '1000',
    MCP_JOB_RETENTION_HOURS: '24',
    MCP_JOB_MAX_COUNT: '200',
    MCP_JOB_CLEANUP_INTERVAL_MS: '3600000',
    MCP_RESPONSE_MODE: 'auto',
    MCP_MAX_BODY_BYTES: '1048576',
    MCP_ALLOWED_ORIGINS: '*',
    TUNNEL_MODE: spec.tunnelMode,
    TUNNEL_URL: spec.tunnelUrl,
    CLOUDFLARED_EDGE_IP_VERSION: 'auto',
    CLOUDFLARED_IMAGE: 'cloudflare/cloudflared:latest',
    CLOUDFLARED_CONFIG: path.join(root, 'cloudflared', 'config.yml'),
    MCP_STARTUP_TIMEOUT: '60',
    MCP_SERVER_LOG: serverLog,
    MCP_TUNNEL_LOG: tunnelLog,
    WORKBENCH_WORKER_NAME: spec.name,
    WORKBENCH_WORKER_CLIENT: spec.client,
    WORKBENCH_WORKER_PERMISSION: spec.permission,
  };

  Object.assign(env, spec.preset || {});

  const lines = [
    '# Generated by scripts/generate-worker.mjs',
    `# Worker: ${spec.name}`,
    `# Client: ${spec.client}`,
    `# Permission preset: ${spec.permission}`,
    `# Workspace: ${spec.workspace}`,
    '',
  ];
  for (const [key, value] of Object.entries(env)) {
    lines.push(formatEnvLine(key, value));
  }
  lines.push('');
  const text = lines.join('\n');

  if (!options.dryRun) {
    await fs.writeFile(envFile, text, 'utf8');
  }

  return {
    envFile,
    text,
  };
}

async function generateFromProfile(root, profilePath, options = {}) {
  const profile = await loadWorkerProfile(profilePath);
  const results = [];
  const seenPorts = new Set();
  const seenNames = new Set();

  for (let i = 0; i < profile.workers.length; i += 1) {
    const rawWorker = profile.workers[i];
    const merged = {
      ...profile.defaults,
      ...rawWorker,
    };
    const spec = normalizeWorkerSpec(merged, profile.defaults, i, root);
    if (seenNames.has(spec.name)) {
      die(`duplicate worker name in profile: ${spec.name}`);
    }
    if (seenPorts.has(spec.port)) {
      die(`duplicate worker port in profile: ${spec.port}`);
    }
    seenNames.add(spec.name);
    seenPorts.add(spec.port);
    const result = await writeWorkerEnv(root, spec, options);
    results.push({ spec, ...result });
  }

  return {
    profile,
    results,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log([
      'Usage:',
      '  node scripts/generate-worker.mjs --name chatgpt --client chatgpt --workspace ~/Documents/project --permission yolo --port 3333',
      '  node scripts/generate-worker.mjs --profile worker-profiles/dual-chatgpt-notion.yaml',
      '',
      'Options:',
      '  --root <path>         Repo root to generate into (default: current repo)',
      '  --profile <path>      Declarative worker profile file (YAML or JSON)',
      '  --name <name>         Worker name, used for env filenames',
      '  --client <name>       Client name such as chatgpt or notion',
      '  --workspace <path>    Workspace directory exposed to the worker',
      '  --permission <name>   readonly, standard, or yolo',
      '  --port <n>            Local MCP port',
      '  --token <value>       Use a fixed token instead of generating one',
      '  --allow-outside-workspace  Set MCP_ALLOW_OUTSIDE_WORKSPACE=1',
      '  --tunnel-mode <name>  quick or named',
      '  --dry-run             Print the generated env and stop',
      '  --overwrite           Replace an existing worker env file',
    ].join('\n'));
    return;
  }

  const root = resolveAbsolute(args.root || defaultRoot);
  const profileArg = String(args.profile || '').trim();
  const overwrite = !!args.overwrite;
  const dryRun = !!args['dry-run'];

  if (profileArg) {
    const profilePath = resolveProfilePath(profileArg, root);
    const generated = await generateFromProfile(root, profilePath, { overwrite, dryRun });
    console.log([
      dryRun ? '[dry-run] profile would write:' : 'profile wrote:',
      ...generated.results.flatMap(({ envFile, spec }) => [
        `  ${envFile}`,
        `  client: ${spec.client}`,
        `  permission: ${spec.permission}`,
        `  port: ${spec.port}`,
        `  workspace: ${spec.workspace}`,
        `  boundary: ${spec.allowOutsideWorkspace ? 'outside workspace allowed' : 'workspace-bound'}`,
        `  auth: bearer token`,
        `  tunnel: ${spec.tunnelMode}`,
      ]),
      '',
      `profile: ${generated.profile.name}`,
      `source: ${generated.profile.sourcePath}`,
      `next: ./scripts/worker-list.sh`,
      ...generated.results.map(({ spec }) => `next: ./scripts/worker-up.sh ${spec.name}`),
    ].join('\n'));
    return;
  }

  const name = String(args.name || '').trim();
  const client = String(args.client || name || '').trim().toLowerCase();
  const workspaceArg = String(args.workspace || '').trim();
  const permission = String(args.permission || 'yolo').trim().toLowerCase();
  const port = Number(args.port || 0);
  const tunnelMode = String(args['tunnel-mode'] || args.tunnelMode || 'quick').trim().toLowerCase();
  const token = String(args.token || '').trim() || randomToken();
  const allowOutsideWorkspace = normalizeBoolean(args['allow-outside-workspace'] ?? args.allowOutsideWorkspace ?? args.allow_outside_workspace, false);

  if (!name) die('--name is required');
  if (!client) die('--client is required');
  if (!workspaceArg) die('--workspace is required');
  if (!Number.isFinite(port) || port <= 0) die('--port must be a positive integer');
  const workspace = resolveAbsolute(workspaceArg);

  const workspaceStat = await fs.stat(workspace).catch(() => null);
  if (!workspaceStat) die(`workspace does not exist: ${workspace}`);
  if (!workspaceStat.isDirectory()) die(`workspace is not a directory: ${workspace}`);

  const workerDir = path.join(root, '.mcp-workbench', 'workers', name);
  const envFile = path.join(root, '.mcp-workbench', 'workers', `${name}.env`);
  const existing = await pathExists(envFile);
  if (existing && !overwrite) {
    die(`worker env already exists: ${envFile} (use --overwrite to replace it)`);
  }

  const preset = permissionPreset(permission);
  const home = os.homedir();
  const serverName = `mcp-workbench-${name}`;
  const logDir = path.join(workerDir, 'logs');
  const serverLog = path.join(logDir, 'server.log');
  const tunnelLog = path.join(logDir, 'tunnel.log');
  const jobDir = path.join(workspace, '.mcp-workbench', 'jobs', name);
  const signalFilterDir = path.join(workspace, '.mcp-workbench', 'signal-filters');
  const workflowPresetDir = path.join(workspace, 'workflow-presets');
  const trustRegistry = path.join(home, '.config', 'mcp-workbench', 'trusted-workspaces.json');
  const tunnelUrl = args['tunnel-url'] ? String(args['tunnel-url']) : `http://127.0.0.1:${port}`;
  const serverCmd = String(args['server-cmd'] || '').trim();

  const env = {
    MCP_SERVER_NAME: serverName,
    MCP_HOST: '127.0.0.1',
    MCP_PORT: String(port),
    WORKSPACE_DIR: workspace,
    MCP_AGENT: serverName,
    MCP_TOKEN: token,
    MCP_ALLOW_NO_AUTH: '0',
    MCP_ALLOW_QUERY_TOKEN: '0',
    MCP_ALLOW_OUTSIDE_WORKSPACE: allowOutsideWorkspace ? '1' : '0',
    MCP_SERVER_CMD: serverCmd,
    MCP_WORKFLOW_MODE: String(args['workflow-mode'] || 'sync'),
    MCP_WORKFLOW_JOB_DIR: jobDir,
    MCP_WORKFLOW_PRESET_DIR: workflowPresetDir,
    MCP_SIGNAL_FILTER_DIR: signalFilterDir,
    MCP_SIGNAL_TRUST_REGISTRY: trustRegistry,
    MCP_WORKFLOW_POLL_INTERVAL_MS: '1000',
    MCP_JOB_RETENTION_HOURS: '24',
    MCP_JOB_MAX_COUNT: '200',
    MCP_JOB_CLEANUP_INTERVAL_MS: '3600000',
    MCP_RESPONSE_MODE: 'auto',
    MCP_MAX_BODY_BYTES: '1048576',
    MCP_ALLOWED_ORIGINS: '*',
    TUNNEL_MODE: tunnelMode,
    TUNNEL_URL: tunnelUrl,
    CLOUDFLARED_EDGE_IP_VERSION: 'auto',
    CLOUDFLARED_IMAGE: 'cloudflare/cloudflared:latest',
    CLOUDFLARED_CONFIG: path.join(root, 'cloudflared', 'config.yml'),
    MCP_STARTUP_TIMEOUT: '60',
    MCP_SERVER_LOG: serverLog,
    MCP_TUNNEL_LOG: tunnelLog,
    WORKBENCH_WORKER_NAME: name,
    WORKBENCH_WORKER_CLIENT: client,
    WORKBENCH_WORKER_PERMISSION: permission,
  };

  Object.assign(env, preset);

  await ensureDir(path.dirname(envFile));
  await ensureDir(logDir);

  const lines = [
    '# Generated by scripts/generate-worker.mjs',
    `# Worker: ${name}`,
    `# Client: ${client}`,
    `# Permission preset: ${permission}`,
    `# Workspace: ${workspace}`,
    '',
  ];
  for (const [key, value] of Object.entries(env)) {
    lines.push(formatEnvLine(key, value));
  }
  lines.push('');
  const text = lines.join('\n');

  if (!dryRun) {
    await fs.writeFile(envFile, text, 'utf8');
  }

  console.log([
    dryRun ? '[dry-run] would write:' : 'wrote:',
    `  ${envFile}`,
    `  client: ${client}`,
    `  permission: ${permission}`,
    `  port: ${port}`,
    `  workspace: ${workspace}`,
    `  boundary: ${allowOutsideWorkspace ? 'outside workspace allowed' : 'workspace-bound'}`,
    `  auth: bearer token`,
    `  tunnel: ${tunnelMode}`,
    `  next: ./scripts/worker-up.sh ${name}`,
    `  next (systemd): ./scripts/worker-install-systemd.sh ${name}`,
    '',
    'worker env preview:',
    text,
  ].join('\n'));
}

await main();
