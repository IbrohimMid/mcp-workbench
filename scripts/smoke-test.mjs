#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server', 'workbench-server.mjs');
const token = 'smoke-token';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseEnv(extra = {}) {
  return {
    HOME: process.env.HOME,
    USER: process.env.USER,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
    ...extra,
  };
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('failed to allocate a port');
  return port;
}

function parseSseJson(text) {
  const lines = String(text || '').split(/\r?\n/);
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  const raw = dataLines.join('\n').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

async function rpc(baseUrl, sessionId, method, params = {}, options = {}) {
  const body = options.notification
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: options.id || `${method}-${Date.now()}`, method, params };

  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: `Bearer ${token}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: response.status === 204 ? null : parseSseJson(text),
  };
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-workbench-smoke-'));
  const workspaceDir = path.join(tmp, 'workspace');
  const generatedRoot = path.join(tmp, 'generated-repo');
  const profilePath = path.join(tmp, 'dual-worker.yaml');
  const jobDir = path.join(workspaceDir, '.mcp-workbench', 'jobs');
  const presetDir = path.join(workspaceDir, 'workflow-presets');
  const workspaceSignalFiltersDir = path.join(workspaceDir, '.mcp-workbench', 'signal-filters');
  const secretValue = 'super-secret-123';
  let createdWorkerName = 'panel-chatgpt';
  let createdWorkerPort = null;
  let createdWorkerEnvFile = null;
  let dashboardActionToken = '';
  let createdWorkerStarted = false;
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(generatedRoot, { recursive: true });
  await fs.mkdir(jobDir, { recursive: true });
  await fs.mkdir(presetDir, { recursive: true });
  await fs.mkdir(workspaceSignalFiltersDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, 'hello.txt'), 'hello from smoke test\n', 'utf8');
  await fs.writeFile(path.join(tmp, 'outside.txt'), 'outside world\n', 'utf8');
  await fs.symlink(path.join(tmp, 'outside.txt'), path.join(workspaceDir, 'link-out'));

  await fs.writeFile(
    profilePath,
    [
      'name: smoke-dual-worker',
      'description: Smoke profile for two YOLO workers',
      'defaults:',
      `  workspace: ${workspaceDir}`,
      '  permission: yolo',
      '  portBase: 3333',
      '  tunnelMode: quick',
      '  workflowMode: sync',
      'workers:',
      '  - name: chatgpt',
      '    client: chatgpt',
      '  - name: notion',
      '    client: notion',
      '',
    ].join('\n'),
    'utf8',
  );

  const generatedProfile = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'generate-worker.mjs'),
    '--root', generatedRoot,
    '--profile', profilePath,
  ], { encoding: 'utf8' });
  assert(generatedProfile.status === 0, `worker profile generator failed: ${generatedProfile.stderr || generatedProfile.stdout}`);

  const chatgptEnvPath = path.join(generatedRoot, '.mcp-workbench', 'workers', 'chatgpt.env');
  const notionEnvPath = path.join(generatedRoot, '.mcp-workbench', 'workers', 'notion.env');
  const chatgptEnv = await fs.readFile(chatgptEnvPath, 'utf8');
  const notionEnv = await fs.readFile(notionEnvPath, 'utf8');
  assert(chatgptEnv.includes("MCP_SERVER_NAME='mcp-workbench-chatgpt'"), 'chatgpt env missing server name');
  assert(chatgptEnv.includes("MCP_ENABLE_BASH='1'"), 'chatgpt env should enable bash for yolo');
  assert(chatgptEnv.includes("MCP_ALLOW_OUTSIDE_WORKSPACE='0'"), 'chatgpt env should keep workspace boundary');
  assert(chatgptEnv.includes("MCP_ENABLE_WRITE_TOOLS='1'"), 'chatgpt env should enable write tools for yolo');
  assert(chatgptEnv.includes(`MCP_PORT='3333'`), 'chatgpt env port mismatch');
  assert(notionEnv.includes("MCP_SERVER_NAME='mcp-workbench-notion'"), 'notion env missing server name');
  assert(notionEnv.includes(`MCP_PORT='3334'`), 'notion env port mismatch');
  assert(notionEnv.includes("MCP_ENABLE_WRITE_TOOLS='1'"), 'notion env should enable write tools for yolo');
  assert(notionEnv.includes("MCP_ENABLE_BASH='1'"), 'notion env should enable bash for yolo');
  assert(notionEnv.includes("MCP_ALLOW_OUTSIDE_WORKSPACE='0'"), 'notion env should keep workspace boundary');
  assert(chatgptEnv !== notionEnv, 'worker env files should differ');

  const openWorkerEnvName = 'notion-open';
  const openWorker = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'generate-worker.mjs'),
    '--root', generatedRoot,
    '--name', openWorkerEnvName,
    '--client', 'notion',
    '--workspace', workspaceDir,
    '--permission', 'yolo',
    '--port', '3335',
    '--allow-outside-workspace',
  ], { encoding: 'utf8' });
  assert(openWorker.status === 0, `open worker generator failed: ${openWorker.stderr || openWorker.stdout}`);
  const openWorkerEnvPath = path.join(generatedRoot, '.mcp-workbench', 'workers', `${openWorkerEnvName}.env`);
  const openWorkerEnv = await fs.readFile(openWorkerEnvPath, 'utf8');
  assert(openWorkerEnv.includes("MCP_ALLOW_OUTSIDE_WORKSPACE='1'"), 'open worker should allow outside workspace');

  const validateConfig = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'validate-config.mjs'),
    '--root', root,
  ], { encoding: 'utf8' });
  assert(validateConfig.status === 0, `config validator failed: ${validateConfig.stderr || validateConfig.stdout}`);

  const workerDoctor = spawnSync('bash', ['-lc', 'WORKBENCH_ENV_FILE="$WORKBENCH_ENV_FILE" ./scripts/worker-doctor.sh chatgpt'], {
    cwd: root,
    env: baseEnv({
      WORKBENCH_ENV_FILE: chatgptEnvPath,
    }),
    encoding: 'utf8',
  });
  assert(workerDoctor.status === 0, `worker-doctor wrapper failed: ${workerDoctor.stderr || workerDoctor.stdout}`);

  await fs.writeFile(
    path.join(presetDir, 'smoke-preset.yaml'),
    [
      'name: smoke-preset',
      'description: Smoke preset for workflow loading',
      'permissions:',
      '  filesystem:',
      '    read: true',
      '    write: true',
      '  shell:',
      '    enabled: true',
      '  network:',
      '    enabled: false',
      'steps:',
      '  - tool: bash',
      '    description: Print a smoke marker',
      '    wait: true',
      '    arguments:',
      '      command: printf smoke-preset-ok',
      '      timeoutMs: 0',
      '      cwd: .',
      '',
    ].join('\n'),
    'utf8',
  );

  await fs.writeFile(
    path.join(presetDir, 'smoke-apply-preset.yaml'),
    [
      'name: smoke-apply-preset',
      'description: Smoke preset for apply_patch files touched',
      'permissions:',
      '  filesystem:',
      '    read: true',
      '    write: true',
      '  shell:',
      '    enabled: false',
      '  network:',
      '    enabled: false',
      'steps:',
      '  - tool: apply_patch',
      '    description: Patch hello.txt',
      '    wait: true',
      '    arguments:',
      '      cwd: .',
      '      patch: "diff --git a/hello.txt b/hello.txt\\n--- a/hello.txt\\n+++ b/hello.txt\\n@@ -1 +1 @@\\n-hello from smoke test\\n+hello from smoke test patched\\n"',
      '',
    ].join('\n'),
    'utf8',
  );

  await fs.writeFile(
    path.join(workspaceSignalFiltersDir, 'local-signal-demo.yaml'),
    [
      'name: local-signal-demo',
      'description: Trust-gated demo filter',
      'match:',
      '  command:',
      '    - signal-filter-demo',
      'rules:',
      '  drop:',
      '    - DROP-ME',
      '  highlight:',
      '    - KEEP-ME',
      '',
    ].join('\n'),
    'utf8',
  );

  const port = await getFreePort();
  const env = {
    ...baseEnv(),
    WORKSPACE_DIR: workspaceDir,
    MCP_TOKEN: token,
    MCP_HOST: '127.0.0.1',
    MCP_PORT: String(port),
    MCP_ALLOW_OUTSIDE_WORKSPACE: '0',
    MCP_ENABLE_WRITE_TOOLS: '1',
    MCP_ENABLE_BASH: '1',
    MCP_WORKFLOW_JOB_DIR: jobDir,
    MCP_WORKFLOW_PRESET_DIR: presetDir,
    MCP_SIGNAL_FILTER_DIR: workspaceSignalFiltersDir,
    MCP_SIGNAL_TRUST_REGISTRY: path.join(tmp, 'trusted-workspaces.json'),
  };

  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  const cleanup = async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    await Promise.race([exited, sleep(2000)]);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      await Promise.race([exited, sleep(500)]);
    }
  };

  try {
    for (let i = 0; i < 60; i += 1) {
      try {
        const res = await fetch(`${baseUrl}/health`);
        if (res.ok) break;
      } catch {
        // retry
      }
      await sleep(250);
      if (i === 59) throw new Error('server did not become ready');
    }

    const health = await fetch(`${baseUrl}/health`);
    assert(health.status === 200, `health failed with ${health.status}`);
    const healthJson = await health.json();
    assert(healthJson.ok === true, 'health missing ok flag');
    assert(!Object.prototype.hasOwnProperty.call(healthJson, 'workspace'), 'health leaked workspace path');

    const unauthorized = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'unauth-init',
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      }),
    });
    assert(unauthorized.status === 401, `expected 401 without auth, got ${unauthorized.status}`);

    const debugUnauthorized = await fetch(`${baseUrl}/debug/health`);
    assert(debugUnauthorized.status === 401, `expected 401 for debug health without auth, got ${debugUnauthorized.status}`);

    const init = await rpc(baseUrl, null, 'initialize', { protocolVersion: '2024-11-05' }, { id: 'init' });
    assert(init.status === 200, `initialize failed with ${init.status}`);
    const sessionId = init.headers.get('mcp-session-id');
    assert(sessionId, 'missing mcp-session-id header');

    const notification = await rpc(baseUrl, sessionId, 'notifications/initialized', {}, { notification: true });
    assert(notification.status === 204, `expected 204 for notification, got ${notification.status}`);

    const tools = await rpc(baseUrl, sessionId, 'tools/list', {}, { id: 'tools' });
    assert(tools.status === 200, `tools/list failed with ${tools.status}`);
    const toolNames = (tools.body?.result?.tools || []).map((tool) => tool.name);
    for (const required of ['read', 'write', 'edit', 'apply_patch', 'bash', 'workflow', 'workflow_presets', 'signal', 'job_retrieve', 'signal_diff', 'signal_filters', 'trust_workspace_filters', 'workspace_info']) {
      assert(toolNames.includes(required), `missing tool: ${required}`);
    }

    const workspaceInfo = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'workspace_info',
      arguments: {},
    }, { id: 'workspace-info' });
    assert(workspaceInfo.status === 200, `workspace_info failed with ${workspaceInfo.status}`);
    const workspaceInfoJson = JSON.parse(workspaceInfo.body?.result?.content?.[0]?.text || '{}');
    assert(workspaceInfoJson.workspace?.root === workspaceDir, 'workspace_info root mismatch');
    assert(workspaceInfoJson.worker?.workspace === workspaceDir, 'workspace_info worker workspace mismatch');
    assert(!JSON.stringify(workspaceInfoJson).includes(token), 'workspace_info leaked MCP_TOKEN');
    assert(JSON.stringify(workspaceInfoJson).includes('[REDACTED]'), 'workspace_info should redact auth');

    const read = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'read',
      arguments: { path: 'hello.txt' },
    }, { id: 'read' });
    assert(read.status === 200, `read failed with ${read.status}`);
    assert(String(read.body?.result?.content?.[0]?.text || '').includes('hello from smoke test'), 'read output mismatch');

    const symlinkRead = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'read',
      arguments: { path: 'link-out' },
    }, { id: 'symlink-read' });
    assert(symlinkRead.status === 200, `symlink read failed with ${symlinkRead.status}`);
    assert(symlinkRead.body?.result?.isError === true, 'symlink read should fail');
    assert(String(symlinkRead.body?.result?.content?.[0]?.text || '').includes('path escapes workspace'), 'symlink read missing boundary error');

    const patchTraversal = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'apply_patch',
      arguments: {
        patch: [
          'diff --git a/../outside.txt b/../outside.txt',
          '--- a/../outside.txt',
          '+++ b/../outside.txt',
          '@@ -1 +1 @@',
          '-outside',
          '+inside',
          '',
        ].join('\n'),
      },
    }, { id: 'patch-traversal' });
    assert(patchTraversal.status === 200, `patch traversal request failed with ${patchTraversal.status}`);
    assert(patchTraversal.body?.result?.isError === true, 'patch traversal should fail');

    const noisy = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'bash',
      arguments: {
        command: [
          'for i in 1 1 1 2 2 3; do echo "noise $i"; done',
          'echo "WARNING: ignore this noise"',
          'echo "FINAL: ok"',
        ].join('; '),
        cwd: '.',
        description: 'signal smoke test',
      },
    }, { id: 'noisy' });
    assert(noisy.status === 200, `noisy bash failed with ${noisy.status}`);
    const noisyJson = JSON.parse(noisy.body?.result?.content?.[0]?.text || '{}');
    const noisyJobId = noisyJson.jobId;
    assert(noisyJobId, 'noisy bash job id missing');

    let noisyStatus = null;
    for (let i = 0; i < 40; i += 1) {
      const statusRes = await rpc(baseUrl, sessionId, 'tools/call', {
        name: 'bash_status',
        arguments: { jobId: noisyJobId },
      }, { id: `noisy-status-${i}` });
      assert(statusRes.status === 200, `bash_status failed with ${statusRes.status}`);
      noisyStatus = JSON.parse(statusRes.body?.result?.content?.[0]?.text || '{}');
      if (noisyStatus.status && noisyStatus.status !== 'running' && noisyStatus.status !== 'queued') {
        break;
      }
      await sleep(150);
    }
    assert(noisyStatus && noisyStatus.status === 'completed', `noisy bash did not complete: ${JSON.stringify(noisyStatus)}`);

    const signal = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'signal',
      arguments: { jobId: noisyJobId },
    }, { id: 'signal' });
    assert(signal.status === 200, `signal failed with ${signal.status}`);
    const signalJson = JSON.parse(signal.body?.result?.content?.[0]?.text || '{}');
    assert((signalJson.keyLines || []).some((line) => String(line).includes('WARNING: ignore this noise')), 'signal missing warning line');
    assert(String(signalJson.excerpt || '').includes('FINAL: ok'), 'signal missing final line');
    assert(signalJson.rewind && signalJson.rewind.stdoutRef, 'signal missing rewind refs');

    const cleanMetadata = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'bash',
      arguments: {
        command: 'printf "clean output\\n"',
        cwd: '.',
        description: 'warning title but clean output',
      },
    }, { id: 'clean-metadata' });
    assert(cleanMetadata.status === 200, `clean metadata bash failed with ${cleanMetadata.status}`);
    const cleanMetadataJson = JSON.parse(cleanMetadata.body?.result?.content?.[0]?.text || '{}');
    const cleanMetadataJobId = cleanMetadataJson.jobId;
    assert(cleanMetadataJobId, 'clean metadata job id missing');

    let cleanMetadataSignal = null;
    for (let i = 0; i < 40; i += 1) {
      const statusRes = await rpc(baseUrl, sessionId, 'tools/call', {
        name: 'signal',
        arguments: { jobId: cleanMetadataJobId },
      }, { id: `clean-metadata-signal-${i}` });
      assert(statusRes.status === 200, `clean metadata signal failed with ${statusRes.status}`);
      cleanMetadataSignal = JSON.parse(statusRes.body?.result?.content?.[0]?.text || '{}');
      if (cleanMetadataSignal.status && cleanMetadataSignal.status !== 'running' && cleanMetadataSignal.status !== 'queued') {
        break;
      }
      await sleep(150);
    }
    assert(cleanMetadataSignal && cleanMetadataSignal.status === 'completed', `clean metadata job did not complete: ${JSON.stringify(cleanMetadataSignal)}`);
    assert(cleanMetadataSignal.headline === 'signal extracted', `metadata false positive leaked into headline: ${cleanMetadataSignal.headline}`);
    assert((cleanMetadataSignal.warnings || []).length === 0, 'metadata false positive leaked into warnings');
    assert((cleanMetadataSignal.errors || []).length === 0, 'metadata false positive leaked into errors');

    const secretJob = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'bash',
      arguments: {
        command: [
          `printf 'token=${secretValue}\\n'`,
          `printf 'Authorization: Bearer ${secretValue}\\n'`,
          'sleep 1',
        ].join('; '),
        cwd: '.',
        description: 'secret redaction smoke test',
      },
    }, { id: 'secret-job' });
    assert(secretJob.status === 200, `secret bash failed with ${secretJob.status}`);
    const secretJobJson = JSON.parse(secretJob.body?.result?.content?.[0]?.text || '{}');
    const secretJobId = secretJobJson.jobId;
    assert(secretJobId, 'secret job id missing');

    let secretSignal = null;
    for (let i = 0; i < 40; i += 1) {
      const signalRes = await rpc(baseUrl, sessionId, 'tools/call', {
        name: 'signal',
        arguments: { jobId: secretJobId, includeRaw: true },
      }, { id: `secret-full-signal-${i}` });
      assert(signalRes.status === 200, `secret signal failed with ${signalRes.status}`);
      secretSignal = JSON.parse(signalRes.body?.result?.content?.[0]?.text || '{}');
      if (secretSignal.raw && (secretSignal.raw.stdout || secretSignal.raw.stderr)) {
        break;
      }
      await sleep(150);
    }

    const secretBlob = JSON.stringify(secretSignal);
    assert(!secretBlob.includes(secretValue), 'secret leaked into signal JSON');
    assert(secretSignal.rawWarning, 'includeRaw should surface a warning');
    assert(secretSignal.raw && typeof secretSignal.raw.stdout === 'string' && typeof secretSignal.raw.stderr === 'string', 'includeRaw should expose raw stdout/stderr');
    assert(secretSignal.rawPaths && !path.isAbsolute(secretSignal.rawPaths.stdout), 'raw stdout path should not be absolute');
    assert(!JSON.stringify(secretSignal.raw).includes(secretValue), 'secret leaked into raw signal output');

    const filtersBeforeTrust = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'signal_filters',
      arguments: {},
    }, { id: 'filters-before-trust' });
    assert(filtersBeforeTrust.status === 200, `signal_filters failed with ${filtersBeforeTrust.status}`);
    const filtersBeforeTrustJson = JSON.parse(filtersBeforeTrust.body?.result?.content?.[0]?.text || '{}');
    const localFilterBefore = (filtersBeforeTrustJson.filters || []).find((filter) => filter.name === 'local-signal-demo');
    assert(localFilterBefore, 'local filter not listed');
    assert(localFilterBefore.trusted === false, 'local filter should start untrusted');
    assert(localFilterBefore.active === false, 'local filter should start inactive');

    const untrustedLocalJob = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'bash',
      arguments: {
        command: 'echo signal-filter-demo; printf "KEEP-ME\\nDROP-ME\\nDONE\\n"',
        cwd: '.',
        description: 'signal-filter-demo untrusted',
      },
    }, { id: 'untrusted-local-job' });
    assert(untrustedLocalJob.status === 200, `untrusted local bash failed with ${untrustedLocalJob.status}`);
    const untrustedLocalJobJson = JSON.parse(untrustedLocalJob.body?.result?.content?.[0]?.text || '{}');
    const untrustedLocalJobId = untrustedLocalJobJson.jobId;
    assert(untrustedLocalJobId, 'untrusted local job id missing');
    let untrustedLocalSignal = null;
    for (let i = 0; i < 40; i += 1) {
      const statusRes = await rpc(baseUrl, sessionId, 'tools/call', {
        name: 'signal',
        arguments: { jobId: untrustedLocalJobId },
      }, { id: `untrusted-local-signal-${i}` });
      assert(statusRes.status === 200, `untrusted local signal failed with ${statusRes.status}`);
      untrustedLocalSignal = JSON.parse(statusRes.body?.result?.content?.[0]?.text || '{}');
      if (untrustedLocalSignal.status && untrustedLocalSignal.status !== 'running' && untrustedLocalSignal.status !== 'queued') {
        break;
      }
      await sleep(150);
    }
    assert(String(untrustedLocalSignal.excerpt || '').includes('DROP-ME'), 'untrusted filter should not apply yet');

    const trustFilters = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'trust_workspace_filters',
      arguments: {},
    }, { id: 'trust-filters' });
    assert(trustFilters.status === 200, `trust_workspace_filters failed with ${trustFilters.status}`);

    const filtersAfterTrust = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'signal_filters',
      arguments: {},
    }, { id: 'filters-after-trust' });
    assert(filtersAfterTrust.status === 200, `signal_filters after trust failed with ${filtersAfterTrust.status}`);
    const filtersAfterTrustJson = JSON.parse(filtersAfterTrust.body?.result?.content?.[0]?.text || '{}');
    const localFilterAfter = (filtersAfterTrustJson.filters || []).find((filter) => filter.name === 'local-signal-demo');
    assert(localFilterAfter && localFilterAfter.trusted === true, 'local filter should be trusted after trust_workspace_filters');
    assert(localFilterAfter && localFilterAfter.active === true, 'local filter should be active after trust_workspace_filters');

    const trustedLocalJob = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'bash',
      arguments: {
        command: 'echo signal-filter-demo; printf "KEEP-ME\\nDROP-ME\\nDONE\\n"',
        cwd: '.',
        description: 'signal-filter-demo trusted',
      },
    }, { id: 'trusted-local-job' });
    assert(trustedLocalJob.status === 200, `trusted local bash failed with ${trustedLocalJob.status}`);
    const trustedLocalJobJson = JSON.parse(trustedLocalJob.body?.result?.content?.[0]?.text || '{}');
    const trustedLocalJobId = trustedLocalJobJson.jobId;
    assert(trustedLocalJobId, 'trusted local job id missing');
    let trustedLocalSignal = null;
    for (let i = 0; i < 40; i += 1) {
      const statusRes = await rpc(baseUrl, sessionId, 'tools/call', {
        name: 'signal',
        arguments: { jobId: trustedLocalJobId },
      }, { id: `trusted-local-signal-${i}` });
      assert(statusRes.status === 200, `trusted local signal failed with ${statusRes.status}`);
      trustedLocalSignal = JSON.parse(statusRes.body?.result?.content?.[0]?.text || '{}');
      if (trustedLocalSignal.status && trustedLocalSignal.status !== 'running' && trustedLocalSignal.status !== 'queued') {
        break;
      }
      await sleep(150);
    }
    assert(!String(trustedLocalSignal.excerpt || '').includes('DROP-ME'), 'trusted local filter should drop DROP-ME');

    const debugHealth = await fetch(`${baseUrl}/debug/health`, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    assert(debugHealth.status === 200, `debug health failed with ${debugHealth.status}`);
    const debugHealthJson = await debugHealth.json();
    assert(debugHealthJson.workspace === workspaceDir, 'debug health workspace mismatch');
    assert(Array.isArray(debugHealthJson.enabledTools), 'debug health missing enabledTools');

    const apiWorkspaceInfo = await fetch(`${baseUrl}/api/workspace-info`, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    assert(apiWorkspaceInfo.status === 200, `api workspace info failed with ${apiWorkspaceInfo.status}`);
    const apiWorkspaceInfoJson = await apiWorkspaceInfo.json();
    assert(apiWorkspaceInfoJson.workspace && apiWorkspaceInfoJson.workspace.root === workspaceDir, 'api workspace info root mismatch');
    assert(!JSON.stringify(apiWorkspaceInfoJson).includes(token), 'api workspace info leaked MCP_TOKEN');
    assert(JSON.stringify(apiWorkspaceInfoJson).includes('[REDACTED]'), 'api workspace info should redact auth');

    const dashboard = await fetch(`${baseUrl}/dashboard`);
    assert(dashboard.status === 200, `dashboard failed with ${dashboard.status}`);
    const dashboardHtml = await dashboard.text();
    assert(dashboardHtml.includes('mcp-workbench dashboard'), 'dashboard html missing title');
    const dashboardActionTokenMatch = dashboardHtml.match(/name="mcp-dashboard-action-token" content="([^"]*)"/);
    assert(dashboardActionTokenMatch && dashboardActionTokenMatch[1], 'dashboard missing action token');
    dashboardActionToken = dashboardActionTokenMatch[1];

    const dashboardState = await fetch(`${baseUrl}/api/dashboard`);
    assert(dashboardState.status === 200, `dashboard state failed with ${dashboardState.status}`);
    const dashboardStateJson = await dashboardState.json();
    assert(dashboardStateJson.ok === true, 'dashboard state missing ok flag');
    assert(dashboardStateJson.connection && dashboardStateJson.connection.mcpUrl, 'dashboard state missing mcpUrl');
    assert(dashboardStateJson.current && dashboardStateJson.current.permissionLabel, 'dashboard state missing current worker summary');
    assert(dashboardStateJson.workspaceInfo && dashboardStateJson.workspaceInfo.worker, 'dashboard state missing workspaceInfo');
    assert(dashboardStateJson.workspaceInfo.workspace && dashboardStateJson.workspaceInfo.workspace.root === workspaceDir, 'dashboard state workspaceInfo root mismatch');
    assert(dashboardStateJson.suggestedWorkerName, 'dashboard state missing suggestedWorkerName');
    assert(typeof dashboardStateJson.suggestedPort === 'number', 'dashboard state missing suggestedPort');
    assert(!JSON.stringify(dashboardStateJson).includes(token), 'dashboard state leaked MCP_TOKEN');
    const dashboardJobs = await fetch(`${baseUrl}/api/jobs`);
    assert(dashboardJobs.status === 200, `dashboard jobs failed with ${dashboardJobs.status}`);
    const dashboardJobsJson = await dashboardJobs.json();
    assert(Array.isArray(dashboardJobsJson.jobs), 'dashboard jobs missing jobs array');
    assert(String(dashboard.headers.get('access-control-allow-origin') || '') !== '*', 'dashboard should not allow wildcard CORS');

    const actionHeaders = {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-mcp-dashboard-token': dashboardActionToken,
    };

    const spoofedCreate = await fetch(`${baseUrl}/api/workers/create`, {
      method: 'POST',
      headers: {
        ...actionHeaders,
        'x-forwarded-host': 'public.example.com',
      },
      body: JSON.stringify({
        name: 'spoofed-worker',
        client: 'chatgpt',
        workspace: workspaceDir,
        permission: 'yolo',
        port: 39999,
        tunnelMode: 'quick',
      }),
    });
    assert(spoofedCreate.status === 403, `spoofed dashboard action should fail with 403, got ${spoofedCreate.status}`);

    createdWorkerPort = await getFreePort();
    const createdWorker = await fetch(`${baseUrl}/api/workers/create`, {
      method: 'POST',
      headers: actionHeaders,
      body: JSON.stringify({
        name: createdWorkerName,
        client: 'chatgpt',
        workspace: workspaceDir,
        permission: 'yolo',
        port: createdWorkerPort,
        tunnelMode: 'quick',
        allowOutsideWorkspace: false,
      }),
    });
    assert(createdWorker.status === 200, `worker create failed with ${createdWorker.status}`);
    const createdWorkerJson = await createdWorker.json();
    assert(createdWorkerJson.ok === true, 'worker create missing ok flag');
    assert(createdWorkerJson.envFile, 'worker create missing envFile');
    assert(createdWorkerJson.port === createdWorkerPort, 'worker create port mismatch');
    assert(createdWorkerJson.allowOutsideWorkspace === false, 'worker create boundary mismatch');
    createdWorkerName = String(createdWorkerJson.worker || createdWorkerName).trim();
    assert(createdWorkerName, 'worker create missing resolved worker name');
    assert(createdWorkerJson.envFile && String(createdWorkerJson.envFile).endsWith(`${createdWorkerName}.env`), 'worker create resolved envFile mismatch');
    createdWorkerStarted = true;

    createdWorkerEnvFile = path.join(root, '.mcp-workbench', 'workers', `${createdWorkerName}.env`);
    assert(await fs.access(createdWorkerEnvFile).then(() => true).catch(() => false), 'created worker env file missing');

    const authHeaderUnauthorized = await fetch(`${baseUrl}/api/workers/${encodeURIComponent(createdWorkerName)}/auth-header`);
    assert(authHeaderUnauthorized.status === 401, `auth-header without token should fail with 401, got ${authHeaderUnauthorized.status}`);

    const authHeaderResponse = await fetch(`${baseUrl}/api/workers/${encodeURIComponent(createdWorkerName)}/auth-header`, {
      headers: {
        'x-mcp-dashboard-token': dashboardActionToken,
      },
    });
    assert(authHeaderResponse.status === 200, `auth-header failed with ${authHeaderResponse.status}`);
    const authHeaderJson = await authHeaderResponse.json();
    assert(authHeaderJson.authMode === 'bearer', 'auth-header mode mismatch');
    assert(String(authHeaderJson.authHeader || '').startsWith('Authorization: Bearer '), 'auth-header did not return bearer token');

    for (let i = 0; i < 40; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${createdWorkerPort}/health`);
        if (res.ok) break;
      } catch {
        // retry
      }
      await sleep(250);
      if (i === 39) throw new Error('created worker server did not become ready');
    }

    const createdWorkerHealth = await fetch(`http://127.0.0.1:${createdWorkerPort}/health`);
    assert(createdWorkerHealth.status === 200, `created worker health failed with ${createdWorkerHealth.status}`);

    const createdWorkerRuntimeDir = path.join(workspaceDir, '.mcp-workbench', 'runtime', 'workers', createdWorkerName);
    const createdWorkerRuntimeStatePath = path.join(createdWorkerRuntimeDir, 'state.json');
    const createdWorkerTunnelLogPath = path.join(createdWorkerRuntimeDir, 'tunnel.log');
    for (let i = 0; i < 20; i += 1) {
      if (await fs.access(createdWorkerRuntimeStatePath).then(() => true).catch(() => false)) break;
      await sleep(100);
      if (i === 19) throw new Error(`created worker runtime state missing: ${createdWorkerRuntimeStatePath}`);
    }
    const createdWorkerRuntimeState = JSON.parse(await fs.readFile(createdWorkerRuntimeStatePath, 'utf8'));
    assert(createdWorkerRuntimeState.server && Number(createdWorkerRuntimeState.server.pid || 0) > 0, 'created worker server pid missing');
    assert(createdWorkerRuntimeState.tunnel && Number(createdWorkerRuntimeState.tunnel.pid || 0) > 0, 'created worker tunnel pid missing');
    const stopTunnel = await fetch(`${baseUrl}/api/workers/${encodeURIComponent(createdWorkerName)}/tunnel/stop`, {
      method: 'POST',
      headers: actionHeaders,
      body: '{}',
    });
    assert(stopTunnel.status === 200, `worker tunnel stop failed with ${stopTunnel.status}`);
    const stopTunnelJson = await stopTunnel.json();
    assert(stopTunnelJson.ok === true, 'worker tunnel stop missing ok flag');
    const fakeTunnelUrl = 'https://smoke-tunnel-example.trycloudflare.com';
    await fs.writeFile(createdWorkerTunnelLogPath, `2026-01-01T00:00:00Z INF Your quick Tunnel is ready at ${fakeTunnelUrl}\n`, 'utf8');
    await fs.writeFile(createdWorkerRuntimeStatePath, JSON.stringify({
      ...createdWorkerRuntimeState,
      tunnel: {
        ...(createdWorkerRuntimeState.tunnel || {}),
        pid: createdWorkerRuntimeState.tunnel?.pid || 424242,
        status: createdWorkerRuntimeState.tunnel?.status || 'running',
        publicUrl: fakeTunnelUrl,
        publicConnectorUrl: `${fakeTunnelUrl}/mcp`,
      },
    }, null, 2), 'utf8');

    const dashboardWithTunnel = await fetch(`${baseUrl}/api/dashboard?worker=${encodeURIComponent(createdWorkerName)}`);
    assert(dashboardWithTunnel.status === 200, `dashboard with tunnel failed with ${dashboardWithTunnel.status}`);
    const dashboardWithTunnelJson = await dashboardWithTunnel.json();
    assert(dashboardWithTunnelJson.connection && dashboardWithTunnelJson.connection.publicConnectorUrl === `${fakeTunnelUrl}/mcp`, 'dashboard did not surface public connector URL');
    assert(dashboardWithTunnelJson.tunnel && dashboardWithTunnelJson.tunnel.publicUrl === fakeTunnelUrl, 'dashboard did not surface tunnel public URL');
    assert(String(dashboardWithTunnelJson.tunnel?.logTail || '').includes(fakeTunnelUrl), 'dashboard did not surface tunnel log tail');

    const presetList = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'workflow_presets',
      arguments: {},
    }, { id: 'preset-list' });
    assert(presetList.status === 200, `workflow_presets failed with ${presetList.status}`);
    const presetListJson = JSON.parse(presetList.body?.result?.content?.[0]?.text || '{}');
    assert(Array.isArray(presetListJson.presets), 'workflow_presets result missing presets');
    assert(presetListJson.presets.some((preset) => preset.name === 'smoke-preset'), 'smoke preset not listed');

    const workflowStart = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'workflow',
      arguments: { preset: 'smoke-preset' },
    }, { id: 'workflow-start' });
    assert(workflowStart.status === 200, `workflow start failed with ${workflowStart.status}`);
    const workflowStartJson = JSON.parse(workflowStart.body?.result?.content?.[0]?.text || '{}');
    const jobId = workflowStartJson.jobId;
    assert(jobId, 'workflow job id missing');

    let workflowStatus = null;
    for (let i = 0; i < 40; i += 1) {
      const statusRes = await rpc(baseUrl, sessionId, 'tools/call', {
        name: 'workflow_status',
        arguments: { jobId },
      }, { id: `workflow-status-${i}` });
      assert(statusRes.status === 200, `workflow_status failed with ${statusRes.status}`);
      workflowStatus = JSON.parse(statusRes.body?.result?.content?.[0]?.text || '{}');
      if (workflowStatus.status && workflowStatus.status !== 'running' && workflowStatus.status !== 'queued') {
        break;
      }
      await sleep(250);
    }
    assert(workflowStatus && workflowStatus.status === 'completed', `workflow did not complete: ${JSON.stringify(workflowStatus)}`);

    const workflowResult = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'workflow_result',
      arguments: { jobId },
    }, { id: 'workflow-result' });
    assert(workflowResult.status === 200, `workflow_result failed with ${workflowResult.status}`);
    const workflowResultJson = JSON.parse(workflowResult.body?.result?.content?.[0]?.text || '{}');
    const trace = workflowResultJson.result?.trace || [];
    assert(trace.length > 0, 'workflow trace is empty');
    assert(String(trace[0]?.result || '').includes('smoke-preset-ok'), 'workflow preset result mismatch');

    const dashboardJobDetail = await fetch(`${baseUrl}/api/jobs/${jobId}`);
    assert(dashboardJobDetail.status === 200, `dashboard job detail failed with ${dashboardJobDetail.status}`);
    const dashboardJobDetailJson = await dashboardJobDetail.json();
    assert(dashboardJobDetailJson.job && dashboardJobDetailJson.job.jobId === jobId, 'dashboard job detail job mismatch');
    assert(dashboardJobDetailJson.signal && dashboardJobDetailJson.signal.rewind, 'dashboard job detail missing signal summary');

    const applyWorkflowStart = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'workflow',
      arguments: { preset: 'smoke-apply-preset' },
    }, { id: 'workflow-apply-start' });
    assert(applyWorkflowStart.status === 200, `apply workflow start failed with ${applyWorkflowStart.status}`);
    const applyWorkflowStartJson = JSON.parse(applyWorkflowStart.body?.result?.content?.[0]?.text || '{}');
    const applyJobId = applyWorkflowStartJson.jobId;
    assert(applyJobId, 'apply workflow job id missing');

    let applyWorkflowStatus = null;
    for (let i = 0; i < 40; i += 1) {
      const statusRes = await rpc(baseUrl, sessionId, 'tools/call', {
        name: 'workflow_status',
        arguments: { jobId: applyJobId },
      }, { id: `workflow-apply-status-${i}` });
      assert(statusRes.status === 200, `workflow_status for apply job failed with ${statusRes.status}`);
      applyWorkflowStatus = JSON.parse(statusRes.body?.result?.content?.[0]?.text || '{}');
      if (applyWorkflowStatus.status && applyWorkflowStatus.status !== 'running' && applyWorkflowStatus.status !== 'queued') {
        break;
      }
      await sleep(250);
    }
    assert(applyWorkflowStatus && applyWorkflowStatus.status === 'completed', `apply workflow did not complete: ${JSON.stringify(applyWorkflowStatus)}`);

    const applySignal = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'signal',
      arguments: { jobId: applyJobId },
    }, { id: 'workflow-apply-signal' });
    assert(applySignal.status === 200, `apply workflow signal failed with ${applySignal.status}`);
    const applySignalJson = JSON.parse(applySignal.body?.result?.content?.[0]?.text || '{}');
    assert((applySignalJson.filesTouched || []).some((entry) => String(entry).includes('hello.txt')), 'apply_patch filesTouched missing hello.txt');
    assert(applySignalJson.rewind && applySignalJson.rewind.traceRef, 'workflow signal missing rewind refs');
    assert(typeof applySignalJson.stats?.estimatedReductionPct === 'number', 'workflow signal missing reduction metrics');

    const cargoJob = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'bash',
      arguments: {
        command: [
          'echo cargo test smoke',
          'printf "warning: simulated\\n"',
          'printf "test result: ok\\n"',
        ].join('; '),
        cwd: '.',
        description: 'cargo test smoke',
      },
    }, { id: 'cargo-job' });
    assert(cargoJob.status === 200, `cargo bash failed with ${cargoJob.status}`);
    const cargoJobJson = JSON.parse(cargoJob.body?.result?.content?.[0]?.text || '{}');
    const cargoJobId = cargoJobJson.jobId;
    assert(cargoJobId, 'cargo job id missing');

    let cargoSignal = null;
    for (let i = 0; i < 40; i += 1) {
      const statusRes = await rpc(baseUrl, sessionId, 'tools/call', {
        name: 'signal',
        arguments: { jobId: cargoJobId },
      }, { id: `cargo-signal-${i}` });
      assert(statusRes.status === 200, `cargo signal failed with ${statusRes.status}`);
      cargoSignal = JSON.parse(statusRes.body?.result?.content?.[0]?.text || '{}');
      if (cargoSignal.status && cargoSignal.status !== 'running' && cargoSignal.status !== 'queued') {
        break;
      }
      await sleep(150);
    }
    assert(cargoSignal && cargoSignal.distiller === 'cargo', `cargo distiller mismatch: ${cargoSignal?.distiller}`);
    assert(cargoSignal.rewind && cargoSignal.rewind.stdoutRef, 'cargo signal missing rewind refs');
    assert(typeof cargoSignal.stats?.estimatedReductionPct === 'number', 'cargo signal missing reduction metrics');

    const cargoRetrieve = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'job_retrieve',
      arguments: {
        ref: cargoSignal.rewind.stdoutRef,
        maxBytes: 20000,
      },
    }, { id: 'cargo-retrieve' });
    assert(cargoRetrieve.status === 200, `job_retrieve failed with ${cargoRetrieve.status}`);
    const cargoRetrieveJson = JSON.parse(cargoRetrieve.body?.result?.content?.[0]?.text || '{}');
    assert(String(cargoRetrieveJson.content || '').includes('warning: simulated'), 'job_retrieve missing raw stdout');

    const cargoDiff = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'signal_diff',
      arguments: { jobId: cargoJobId },
    }, { id: 'cargo-diff' });
    assert(cargoDiff.status === 200, `signal_diff failed with ${cargoDiff.status}`);
    const cargoDiffJson = JSON.parse(cargoDiff.body?.result?.content?.[0]?.text || '{}');
    assert(String(cargoDiffJson.rawPreview || '').includes('cargo test smoke'), 'signal_diff missing raw preview');
    assert(String(cargoDiffJson.signalPreview || '').includes('headline'), 'signal_diff missing signal preview');
    assert(Array.isArray(cargoDiffJson.removedPatterns), 'signal_diff missing removedPatterns');
    assert(typeof cargoDiffJson.reductionPct === 'number', 'signal_diff missing reductionPct');

    const workflowInline = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'workflow',
      arguments: {
        steps: [
          {
            tool: 'read',
            arguments: {
              path: 'hello.txt',
            },
            description: 'Read workspace context',
          },
          {
            tool: 'bash',
            arguments: {
              command: 'printf inline-workflow-ok',
              cwd: '.',
              description: 'Inline bash step',
            },
          },
        ],
      },
    }, { id: 'workflow-inline' });
    assert(workflowInline.status === 200, `workflow inline call failed with ${workflowInline.status}`);
    const workflowInlineJson = JSON.parse(workflowInline.body?.result?.content?.[0]?.text || '{}');
    const inlineJobId = workflowInlineJson.jobId;
    assert(inlineJobId, 'workflow inline job id missing');

    let workflowInlineStatus = null;
    for (let i = 0; i < 40; i += 1) {
      const statusRes = await rpc(baseUrl, sessionId, 'tools/call', {
        name: 'workflow_status',
        arguments: { jobId: inlineJobId },
      }, { id: `workflow-inline-status-${i}` });
      assert(statusRes.status === 200, `workflow_status for inline job failed with ${statusRes.status}`);
      workflowInlineStatus = JSON.parse(statusRes.body?.result?.content?.[0]?.text || '{}');
      if (workflowInlineStatus.status && workflowInlineStatus.status !== 'running' && workflowInlineStatus.status !== 'queued') {
        break;
      }
      await sleep(250);
    }
    assert(workflowInlineStatus && workflowInlineStatus.status === 'completed', `inline workflow did not complete: ${JSON.stringify(workflowInlineStatus)}`);

    const workflowInlineResult = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'workflow_result',
      arguments: { jobId: inlineJobId },
    }, { id: 'workflow-inline-result' });
    assert(workflowInlineResult.status === 200, `workflow_result for inline job failed with ${workflowInlineResult.status}`);
    const workflowInlineResultJson = JSON.parse(workflowInlineResult.body?.result?.content?.[0]?.text || '{}');
    const inlineTrace = workflowInlineResultJson.result?.trace || [];
    assert(inlineTrace.length === 2, `inline workflow trace length mismatch: ${inlineTrace.length}`);
    assert(String(inlineTrace[0]?.result || '').includes('hello from smoke test'), 'inline workflow read step mismatch');
    assert(String(inlineTrace[1]?.result || '').includes('inline-workflow-ok'), 'inline workflow bash step mismatch');

    const oversizedBody = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'oversized',
        method: 'tools/list',
        params: { blob: 'x'.repeat(1_200_000) },
      }),
    });
    assert(oversizedBody.status === 413, `expected 413 for oversized body, got ${oversizedBody.status}`);

    console.log('smoke test passed');
  } catch (error) {
    console.error(String(error?.stack || error));
    console.error('\n--- server stdout ---');
    console.error(stdout || '(empty)');
    console.error('\n--- server stderr ---');
    console.error(stderr || '(empty)');
    process.exitCode = 1;
  } finally {
    if (createdWorkerStarted && dashboardActionToken) {
      try {
        const stopHeaders = {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-mcp-dashboard-token': dashboardActionToken,
        };
        const stopWithTimeout = async (url) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error('cleanup timeout')), 2000);
          timer.unref?.();
          try {
            await fetch(url, {
              method: 'POST',
              headers: stopHeaders,
              body: '{}',
              signal: controller.signal,
            });
          } catch {
            // ignore cleanup failures
          } finally {
            clearTimeout(timer);
          }
        };
        await stopWithTimeout(`${baseUrl}/api/workers/${encodeURIComponent(createdWorkerName)}/tunnel/stop`);
        await stopWithTimeout(`${baseUrl}/api/workers/${encodeURIComponent(createdWorkerName)}/server/stop`);
      } catch {
        // ignore cleanup failure
      }
    }
    if (createdWorkerEnvFile) {
      await fs.rm(createdWorkerEnvFile, { force: true }).catch(() => {});
      await fs.rm(path.join(root, '.mcp-workbench', 'runtime', 'workers', createdWorkerName), { recursive: true, force: true }).catch(() => {});
    }
    await cleanup();
  }
}

await main();
