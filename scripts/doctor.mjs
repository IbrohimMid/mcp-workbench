#!/usr/bin/env node

import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const envFile = process.env.WORKBENCH_ENV_FILE || path.join(root, '.env');

function info(message) {
  console.log(message);
}

function warn(message) {
  console.log(`WARN ${message}`);
}

function ok(message) {
  console.log(`OK ${message}`);
}

function fail(message) {
  console.error(`ERROR ${message}`);
  process.exitCode = 1;
}

function loadEnvFile(filePath) {
  const result = {};
  return fs.readFile(filePath, 'utf8')
    .then((raw) => {
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        result[key] = value.replace(/^['"]|['"]$/g, '');
      }
      return result;
    })
    .catch(() => result);
}

function envBool(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

async function portAvailable(host, port) {
  const server = net.createServer();
  return await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function main() {
  info('mcp-workbench doctor');

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 20) {
    ok(`node ${process.version}`);
  } else {
    fail(`node 20+ is required. Current version: ${process.version}`);
  }

  let env = {};
  env = await loadEnvFile(envFile);
  const workspaceDir = String(process.env.WORKSPACE_DIR || env.WORKSPACE_DIR || '').trim();
  const token = String(process.env.MCP_TOKEN || env.MCP_TOKEN || '').trim();
  const allowNoAuth = envBool(process.env.MCP_ALLOW_NO_AUTH || env.MCP_ALLOW_NO_AUTH);
  const host = String(process.env.MCP_HOST || env.MCP_HOST || '127.0.0.1');
  const port = Number(process.env.MCP_PORT || env.MCP_PORT || 3333);

  if (workspaceDir) {
    try {
      const stat = await fs.stat(workspaceDir);
      if (stat.isDirectory()) {
        ok(`workspace ${workspaceDir}`);
      } else {
        fail(`WORKSPACE_DIR is not a directory: ${workspaceDir}`);
      }
    } catch {
      fail(`WORKSPACE_DIR does not exist: ${workspaceDir}`);
    }
  } else {
    fail('WORKSPACE_DIR is missing');
  }

  if (token && token !== 'change-me') {
    ok('MCP_TOKEN set');
  } else if (allowNoAuth) {
    warn('MCP_ALLOW_NO_AUTH=1 (local development only)');
  } else {
    fail('MCP_TOKEN is missing. Set a token or enable MCP_ALLOW_NO_AUTH=1 for local dev.');
  }

  const cloudflared = await new Promise((resolve) => {
    execFile('cloudflared', ['--version'], (error, stdout) => {
      if (!error) {
        resolve(String(stdout || 'cloudflared'));
        return;
      }
      resolve('');
    });
  });
  if (cloudflared) {
    ok(`cloudflared ${String(cloudflared).trim()}`);
  } else {
    const docker = await new Promise((resolve) => {
      execFile('docker', ['--version'], (error, stdout) => {
        if (!error) {
          resolve(String(stdout || 'docker'));
          return;
        }
        resolve('');
      });
    });
    if (docker) {
      ok(`docker ${String(docker).trim()}`);
    } else {
      warn('cloudflared or docker not found on PATH');
    }
  }

  if (await portAvailable(host, port)) {
    ok(`port ${host}:${port} is available`);
  } else {
    warn(`port ${host}:${port} is already in use`);
  }

  const presetDir = String(process.env.MCP_WORKFLOW_PRESET_DIR || env.MCP_WORKFLOW_PRESET_DIR || path.join(root, 'workflow-presets')).trim();
  try {
    const stat = await fs.stat(presetDir);
    if (stat.isDirectory()) {
      ok(`workflow presets ${presetDir}`);
    } else {
      warn(`workflow preset path is not a directory: ${presetDir}`);
    }
  } catch {
    warn(`workflow preset directory not found: ${presetDir}`);
  }

  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }

  info('doctor complete');
}

await main();
