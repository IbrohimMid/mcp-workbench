#!/usr/bin/env node

import { spawn } from 'node:child_process';
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
  const jobDir = path.join(workspaceDir, '.mcp-workbench', 'jobs');
  const presetDir = path.join(workspaceDir, 'workflow-presets');
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(jobDir, { recursive: true });
  await fs.mkdir(presetDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, 'hello.txt'), 'hello from smoke test\n', 'utf8');
  await fs.writeFile(path.join(tmp, 'outside.txt'), 'outside world\n', 'utf8');
  await fs.symlink(path.join(tmp, 'outside.txt'), path.join(workspaceDir, 'link-out'));

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
    for (const required of ['read', 'write', 'edit', 'apply_patch', 'bash', 'workflow', 'workflow_presets', 'signal']) {
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

    const debugHealth = await fetch(`${baseUrl}/debug/health`, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    assert(debugHealth.status === 200, `debug health failed with ${debugHealth.status}`);
    const debugHealthJson = await debugHealth.json();
    assert(debugHealthJson.workspace === workspaceDir, 'debug health workspace mismatch');
    assert(Array.isArray(debugHealthJson.enabledTools), 'debug health missing enabledTools');

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
