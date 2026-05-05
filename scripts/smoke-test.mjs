#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
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

  const validateConfig = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'validate-config.mjs'),
    '--root', root,
  ], { encoding: 'utf8' });
  assert(validateConfig.status === 0, `config validator failed: ${validateConfig.stderr || validateConfig.stdout}`);

  const workerDoctor = spawnSync('bash', ['-lc', 'WORKBENCH_ENV_FILE="$WORKBENCH_ENV_FILE" ./scripts/worker-doctor.sh chatgpt'], {
    cwd: root,
    env: {
      ...process.env,
      WORKBENCH_ENV_FILE: chatgptEnvPath,
    },
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
    ...process.env,
    WORKSPACE_DIR: workspaceDir,
    MCP_TOKEN: token,
    MCP_HOST: '127.0.0.1',
    MCP_PORT: String(port),
    MCP_ALLOW_OUTSIDE_WORKSPACE: '0',
    MCP_ENABLE_WRITE_TOOLS: '1',
    MCP_ENABLE_BASH: '1',
    MCP_WORKFLOW_JOB_DIR: jobDir,
    MCP_WORKFLOW_PRESET_DIR: presetDir,
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
    child.kill('SIGTERM');
    await exited;
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
    for (const required of ['read', 'write', 'edit', 'apply_patch', 'bash', 'workflow', 'workflow_presets', 'signal', 'job_retrieve', 'signal_diff', 'signal_filters', 'trust_workspace_filters']) {
      assert(toolNames.includes(required), `missing tool: ${required}`);
    }

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
          'printf "secret job done\\n"',
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
      const statusRes = await rpc(baseUrl, sessionId, 'tools/call', {
        name: 'signal',
        arguments: { jobId: secretJobId, includeRaw: true },
      }, { id: `secret-signal-${i}` });
      assert(statusRes.status === 200, `secret signal failed with ${statusRes.status}`);
      secretSignal = JSON.parse(statusRes.body?.result?.content?.[0]?.text || '{}');
      if (secretSignal.status && secretSignal.status !== 'running' && secretSignal.status !== 'queued') {
        break;
      }
      await sleep(150);
    }
    assert(secretSignal && secretSignal.status === 'completed', `secret job did not complete: ${JSON.stringify(secretSignal)}`);
    const secretBlob = JSON.stringify(secretSignal);
    assert(!secretBlob.includes(secretValue), 'secret leaked into signal JSON');
    assert(secretSignal.rawWarning, 'includeRaw should surface a warning');
    assert(secretSignal.rawPaths && !path.isAbsolute(secretSignal.rawPaths.stdout), 'raw stdout path should not be absolute');
    assert(secretSignal.raw && !JSON.stringify(secretSignal.raw).includes(secretValue), 'secret leaked into raw signal output');

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

    const dashboard = await fetch(`${baseUrl}/dashboard`);
    assert(dashboard.status === 200, `dashboard failed with ${dashboard.status}`);
    const dashboardHtml = await dashboard.text();
    assert(dashboardHtml.includes('mcp-workbench dashboard'), 'dashboard html missing title');

    const dashboardState = await fetch(`${baseUrl}/api/dashboard`);
    assert(dashboardState.status === 200, `dashboard state failed with ${dashboardState.status}`);
    const dashboardStateJson = await dashboardState.json();
    assert(dashboardStateJson.ok === true, 'dashboard state missing ok flag');
    assert(dashboardStateJson.connection && dashboardStateJson.connection.mcpUrl, 'dashboard state missing mcpUrl');
    assert(dashboardStateJson.current && dashboardStateJson.current.permissionLabel, 'dashboard state missing current worker summary');
    const dashboardJobs = await fetch(`${baseUrl}/api/jobs`);
    assert(dashboardJobs.status === 200, `dashboard jobs failed with ${dashboardJobs.status}`);
    const dashboardJobsJson = await dashboardJobs.json();
    assert(Array.isArray(dashboardJobsJson.jobs), 'dashboard jobs missing jobs array');

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

    const workflowRejected = await rpc(baseUrl, sessionId, 'tools/call', {
      name: 'workflow',
      arguments: {
        steps: [
          {
            tool: 'bash',
            arguments: {
              command: 'printf should-not-run',
              cwd: '.',
              description: 'blocked bash step',
            },
          },
        ],
      },
    }, { id: 'workflow-reject' });
    assert(workflowRejected.status === 200, `workflow rejection call failed with ${workflowRejected.status}`);
    const workflowRejectedJson = JSON.parse(workflowRejected.body?.result?.content?.[0]?.text || '{}');
    assert(workflowRejectedJson.kind === 'workflow_preflight_error', `workflow rejection kind mismatch: ${workflowRejectedJson.kind}`);
    assert(workflowRejectedJson.status === 'rejected', `workflow rejection status mismatch: ${workflowRejectedJson.status}`);
    assert(Array.isArray(workflowRejectedJson.errors) && workflowRejectedJson.errors.some((entry) => String(entry).includes('bash')), 'workflow rejection errors missing bash');

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
    await cleanup();
  }
}

await main();
