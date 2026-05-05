#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const checks = [
  {
    file: 'server/workbench-server.mjs',
    forbidden: ['--unsafe-paths', 'Omni', 'omni'],
  },
  {
    file: 'README.md',
    forbidden: ['--unsafe-paths', 'Omni', 'omni'],
    required: ['Agent-first setup', 'scripts/generate-worker.mjs', 'worker-install-systemd.sh', 'worker-profiles/dual-chatgpt-notion.yaml'],
  },
  {
    file: 'AGENTS.md',
    required: ['scripts/generate-worker.mjs', 'MCP_ALLOW_OUTSIDE_WORKSPACE=0', 'worker-profiles/dual-chatgpt-notion.yaml'],
  },
  {
    file: 'docs/agent-bootstrap.md',
    required: ['MCP_ALLOW_OUTSIDE_WORKSPACE=0', 'scripts/generate-worker.mjs', 'worker-up.sh', 'worker-profiles/dual-chatgpt-notion.yaml'],
  },
  {
    file: 'worker-profiles/dual-chatgpt-notion.yaml',
    required: ['chatgpt', 'notion', 'permission: yolo'],
  },
  {
    file: '.env.example',
    required: [
      'MCP_ALLOW_NO_AUTH=0',
      'MCP_ALLOW_QUERY_TOKEN=0',
      'MCP_ENABLE_WRITE_TOOLS=0',
      'MCP_ENABLE_BASH=0',
      'MCP_SANITIZE_BASH_ENV=1',
      'MCP_ENABLE_WEBFETCH=0',
      'MCP_ENABLE_WORKFLOW=1',
      'MCP_RESPONSE_MODE=auto',
      'MCP_MAX_BODY_BYTES=1048576',
    ],
  },
];

let failed = false;

for (const check of checks) {
  const filePath = path.join(root, check.file);
  const text = await fs.readFile(filePath, 'utf8');
  for (const pattern of check.forbidden || []) {
    if (text.includes(pattern)) {
      console.error(`ERROR ${check.file} contains forbidden pattern: ${pattern}`);
      failed = true;
    }
  }
  for (const pattern of check.required || []) {
    if (!text.includes(pattern)) {
      console.error(`ERROR ${check.file} is missing required pattern: ${pattern}`);
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log('security check passed');
