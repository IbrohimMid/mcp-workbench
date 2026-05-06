export function serializeDashboardState(state) {
  return JSON.stringify(state)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function badgeClass(kind) {
  switch (kind) {
    case 'yolo':
      return 'badge badge-danger';
    case 'standard':
      return 'badge badge-warn';
    case 'readonly':
      return 'badge badge-soft';
    case 'running':
    case 'online':
    case 'connected':
      return 'badge badge-success';
    case 'failed':
    case 'cancelled':
    case 'timed_out':
    case 'rejected':
      return 'badge badge-danger';
    default:
      return 'badge';
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function badge(label, kind = '') {
  return `<span class="${badgeClass(kind)}">${escapeHtml(label)}</span>`;
}

function renderWorkerList(workers = []) {
  if (!workers.length) {
    return '<div class="empty">No worker profiles found yet.</div>';
  }

  return workers.map((worker) => {
    const selected = worker.isSelected ? ' selected' : '';
    return `
      <button class="worker-row${selected}" data-worker="${escapeHtml(worker.name)}">
        <span class="worker-title">
          <strong>${escapeHtml(worker.name)}</strong>
          <span>${escapeHtml(worker.client || 'unknown client')}</span>
          <span class="worker-url">${escapeHtml(worker.publicConnectorUrl || worker.mcpUrl || 'waiting for URL')}</span>
        </span>
        <span class="worker-meta">
          ${badge(worker.permission || 'readonly', worker.permission || '')}
          ${badge(worker.status || 'offline', worker.status || '')}
        </span>
      </button>
    `;
  }).join('');
}

function renderJobList(jobs = []) {
  if (!jobs.length) {
    return '<div class="empty">No jobs have been created yet.</div>';
  }

  return jobs.map((job) => {
    const selected = job.isSelected ? ' selected' : '';
    const meta = [job.kind, job.currentStep && job.totalSteps ? `${job.currentStep}/${job.totalSteps}` : null].filter(Boolean).join(' · ');
    return `
      <button class="job-row${selected}" data-job="${escapeHtml(job.jobId)}">
        <span class="job-main">
          <strong>${escapeHtml(job.title || job.kind || 'job')}</strong>
          <span>${escapeHtml(meta)}</span>
        </span>
        <span class="job-meta">
          ${badge(job.status || 'unknown', job.status || '')}
          <time datetime="${escapeHtml(job.createdAt || '')}">${escapeHtml(job.createdAtLabel || '')}</time>
        </span>
      </button>
    `;
  }).join('');
}

function renderSignal(signal) {
  if (!signal) {
    return '<div class="empty">Select a job to view its signal summary.</div>';
  }

  const lines = [];
  if (signal.headline) lines.push(`<p class="signal-headline">${escapeHtml(signal.headline)}</p>`);
  if (signal.nextAction) lines.push(`<p class="signal-next">${escapeHtml(signal.nextAction)}</p>`);
  if (Array.isArray(signal.keyLines) && signal.keyLines.length) {
    lines.push(`<h4>Key lines</h4><pre>${escapeHtml(signal.keyLines.join('\n'))}</pre>`);
  }
  if (Array.isArray(signal.errors) && signal.errors.length) {
    lines.push(`<h4>Errors</h4><pre>${escapeHtml(signal.errors.join('\n'))}</pre>`);
  }
  if (Array.isArray(signal.warnings) && signal.warnings.length) {
    lines.push(`<h4>Warnings</h4><pre>${escapeHtml(signal.warnings.join('\n'))}</pre>`);
  }
  if (signal.rewind) {
    lines.push(`<h4>Rewind</h4><pre>${escapeHtml(JSON.stringify(signal.rewind, null, 2))}</pre>`);
  }
  if (signal.rawWarning) {
    lines.push(`<p class="muted">${escapeHtml(signal.rawWarning)}</p>`);
  }
  return lines.join('');
}

export function renderDashboardPage(state, options = {}) {
  const serializedState = serializeDashboardState(state);
  const workers = renderWorkerList(state.workers || []);
  const jobs = renderJobList(state.jobs || []);
  const current = state.current || {};
  const connection = state.connection || {};
  const tunnel = state.tunnel || {};
  const signal = state.selectedSignal || null;
  const workspaceInfo = state.workspaceInfo || {};
  const actionToken = String(options.actionToken || '');
  const localOnly = !!actionToken && options.localOnly !== false;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>mcp-workbench dashboard</title>
  <meta name="mcp-dashboard-action-token" content="${escapeHtml(actionToken)}" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f1115;
      --panel: #151923;
      --panel-2: #10141c;
      --line: #273042;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --soft: #cbd5e1;
      --green: #30c98d;
      --yellow: #f4b860;
      --red: #ff7373;
      --blue: #7ca7ff;
      --shadow: 0 24px 80px rgba(0, 0, 0, .32);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at top, rgba(43, 84, 153, .22), transparent 35%), var(--bg);
      color: var(--text);
      font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
    }
    .wrap { max-width: 1400px; margin: 0 auto; padding: 28px 22px 42px; }
    .hero {
      display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 22px;
      padding: 20px 22px; border: 1px solid var(--line); border-radius: 18px; background: rgba(16, 20, 28, .84); box-shadow: var(--shadow);
    }
    .hero h1 { margin: 0 0 6px; font-size: 28px; line-height: 1.05; }
    .hero p { margin: 0; color: var(--muted); max-width: 720px; }
    .hero .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .quickstart {
      margin-top: 14px;
      padding: 14px 16px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255,255,255,.03);
      max-width: 860px;
    }
    .quickstart strong { display: block; margin-bottom: 8px; color: var(--text); }
    .quickstart ol { margin: 0; padding-left: 18px; color: var(--soft); }
    .quickstart li { margin: 6px 0; }
    .quickstart code { padding: 2px 6px; border-radius: 8px; border: 1px solid var(--line); background: rgba(255,255,255,.04); }
    .guide {
      margin-top: 12px;
      padding: 14px 16px;
      border: 1px solid rgba(124, 167, 255, .28);
      border-radius: 14px;
      background: rgba(124, 167, 255, .06);
      max-width: 860px;
    }
    .guide strong { display: block; margin-bottom: 8px; color: var(--text); }
    .guide ul { margin: 0; padding-left: 18px; color: var(--soft); }
    .guide li { margin: 6px 0; }
    .guide code {
      padding: 2px 6px;
      border-radius: 8px;
      border: 1px solid rgba(124, 167, 255, .24);
      background: rgba(255,255,255,.04);
    }
    .guide .muted { margin-top: 10px; }
    .chip, .badge {
      display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px;
      border: 1px solid var(--line); color: var(--soft); background: rgba(255,255,255,.03); font-size: 12px;
    }
    .badge-success { color: #8ef2c6; border-color: rgba(48,201,141,.35); background: rgba(48,201,141,.10); }
    .badge-warn { color: #ffd48a; border-color: rgba(244,184,96,.35); background: rgba(244,184,96,.10); }
    .badge-danger { color: #ffadad; border-color: rgba(255,115,115,.35); background: rgba(255,115,115,.10); }
    .badge-soft { color: #d3d9e6; border-color: rgba(148,163,184,.35); background: rgba(148,163,184,.10); }
    .grid {
      display: grid;
      grid-template-columns: 1.15fr .85fr;
      gap: 18px;
      align-items: start;
    }
    .stack { display: grid; gap: 18px; }
    .card {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(17, 21, 30, .9);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .card .head {
      display: flex; align-items: center; justify-content: space-between; gap: 14px;
      padding: 16px 18px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,.02);
    }
    .card .head h2 { margin: 0; font-size: 16px; }
    .card .body { padding: 18px; }
    .muted { color: var(--muted); }
    .kv { display: grid; gap: 10px; }
    .kv-row { display: flex; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid rgba(39,48,66,.55); }
    .kv-row:last-child { border-bottom: 0; }
    .kv-row strong { font-weight: 600; }
    .copy-row, .url-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .copy-row code, .url-row code, pre {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel-2);
      color: #dbe4f0;
      padding: 12px 14px;
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .btn {
      appearance: none; border: 1px solid var(--line); background: rgba(255,255,255,.04); color: var(--text);
      border-radius: 12px; padding: 9px 12px; cursor: pointer; font: inherit;
    }
    .btn:hover { border-color: #3a4760; background: rgba(255,255,255,.07); }
    .btn:disabled {
      opacity: .55;
      cursor: not-allowed;
    }
    .list { display: grid; gap: 10px; }
    .worker-row, .job-row {
      width: 100%; display: flex; justify-content: space-between; gap: 14px; align-items: center;
      padding: 12px 14px; border: 1px solid var(--line); border-radius: 14px; background: rgba(255,255,255,.03);
      color: var(--text); cursor: pointer; text-align: left;
    }
    .worker-row.selected, .job-row.selected { border-color: rgba(124,167,255,.6); box-shadow: inset 0 0 0 1px rgba(124,167,255,.22); }
    .worker-title, .job-main { display: grid; gap: 3px; }
    .worker-title span, .job-main span { color: var(--muted); font-size: 12px; }
    .worker-url { color: var(--soft); font-size: 11px; line-height: 1.35; }
    .worker-meta, .job-meta { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .empty { color: var(--muted); padding: 8px 0; }
    .signal-headline { font-size: 16px; margin: 0 0 6px; }
    .signal-next { margin: 0 0 14px; color: var(--soft); }
    h4 { margin: 16px 0 8px; font-size: 13px; letter-spacing: .02em; color: var(--soft); }
    .timeline { max-height: 620px; overflow: auto; }
    .signal pre { max-height: 220px; }
    .tunnel-log pre { max-height: 220px; }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-top: 8px;
    }
    .form-grid label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
    }
    .form-grid small {
      display: block;
      line-height: 1.35;
      color: var(--muted);
    }
    .form-grid label.wide { grid-column: 1 / -1; }
    .form-grid input,
    .form-grid select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255,255,255,.04);
      color: var(--text);
      padding: 9px 10px;
      font: inherit;
    }
    .action-row { margin-top: 14px; }
    .footer {
      margin-top: 16px; color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap;
    }
    @media (max-width: 980px) {
      .grid { grid-template-columns: 1fr; }
      .hero { flex-direction: column; align-items: flex-start; }
      .form-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <div>
        <h1>mcp-workbench dashboard</h1>
        <p>Local control surface for worker configs, connector URLs, permission badges, and job signal summaries.</p>
        <div class="chips">
          <span class="chip">${escapeHtml(current.permissionLabel || 'readonly')}</span>
          <span class="chip">${escapeHtml(current.status || 'offline')}</span>
          <span class="chip">${escapeHtml(current.authMode || 'bearer')}</span>
          <span class="chip">${escapeHtml(state.server?.name || 'mcp-workbench')}</span>
        </div>
        <div class="guide">
          <strong>Which URL should you paste?</strong>
          <ul>
            <li><code>Public connector URL</code> goes into ChatGPT or Notion.</li>
            <li><code>Local MCP URL</code> is only for localhost debugging on this machine.</li>
            <li>If auth is <code>bearer</code>, click <code>Copy auth</code> and paste that in the client too.</li>
            <li>To create a worker: fill the form below, click <code>Create &amp; start worker</code>, then copy the public connector URL once it appears.</li>
          </ul>
          <div class="muted">For quick tunnels, the public URL can change after restart. Use a named tunnel if you want a stable connector URL.</div>
        </div>
        <div class="quickstart">
          <strong>Quick start</strong>
          <ol>
            <li>Create a worker profile if you do not already have one.</li>
            <li>Create the worker, then the dashboard starts server and tunnel for you.</li>
            <li>Copy <strong>Public connector URL</strong> for ChatGPT or Notion. Use <strong>Local MCP URL</strong> only for localhost debugging.</li>
          </ol>
        </div>
      </div>
      <div class="copy-row">
        <button class="btn" id="copy-public-connector-url" data-copy="${escapeHtml(connection.publicConnectorUrl || '')}" ${connection.publicConnectorUrl ? '' : 'disabled'}>Copy URL for ChatGPT / Notion</button>
        <button class="btn" id="copy-local-mcp-url" data-copy="${escapeHtml(connection.mcpUrl || '')}" ${connection.mcpUrl ? '' : 'disabled'}>Copy localhost URL</button>
        <button class="btn" id="copy-auth" ${localOnly && current.authMode !== 'no-auth' ? '' : 'disabled'}>Copy auth</button>
        <button class="btn" data-copy="${escapeHtml(connection.dashboardUrl || '')}">Copy dashboard URL</button>
      </div>
    </section>

    <section class="grid">
      <div class="stack">
        <article class="card">
          <div class="head">
            <h2>Current worker</h2>
            <span class="badge">${escapeHtml(current.status || 'offline')}</span>
          </div>
          <div class="body">
            <div class="kv">
              <div class="kv-row"><strong>Name</strong><span>${escapeHtml(current.name || 'unknown')}</span></div>
              <div class="kv-row"><strong>Client</strong><span>${escapeHtml(current.client || 'unknown')}</span></div>
              <div class="kv-row"><strong>Workspace</strong><span>${escapeHtml(current.workspace || '')}</span></div>
              <div class="kv-row"><strong>Repo root</strong><span>${escapeHtml(workspaceInfo.workspace?.root || '')}</span></div>
              <div class="kv-row"><strong>Env file</strong><span>${escapeHtml(current.filePath || workspaceInfo.worker?.filePath || '')}</span></div>
              <div class="kv-row"><strong>Runtime</strong><span>${escapeHtml(workspaceInfo.workspace?.runtimeRoot || '')}</span></div>
              <div class="kv-row"><strong>Permission</strong><span>${badge(current.permissionLabel || 'readonly', current.permissionLabel || '')}</span></div>
              <div class="kv-row"><strong>Auth</strong><span>${badge(current.authMode || 'bearer', current.authMode || '')}</span></div>
              <div class="kv-row"><strong>Boundary</strong><span>${escapeHtml(workspaceInfo.boundary?.allowOutside ? 'outside workspace allowed' : 'workspace-bound')}</span></div>
              <div class="kv-row"><strong>Port</strong><span>${escapeHtml(String(current.port || ''))}</span></div>
            </div>
          </div>
        </article>

        <article class="card">
          <div class="head">
            <h2>Connector and tunnel</h2>
            <span class="badge">${escapeHtml(connection.authMode || 'bearer')}</span>
          </div>
          <div class="body">
            <div class="kv">
              <div class="kv-row"><strong>Local MCP URL</strong><span>${escapeHtml(connection.mcpUrl || '')}</span></div>
              <div class="kv-row"><strong>Public connector URL</strong><span>${escapeHtml(connection.publicConnectorUrl || 'waiting for tunnel URL')}</span></div>
              <div class="kv-row"><strong>Dashboard URL</strong><span>${escapeHtml(connection.dashboardUrl || '')}</span></div>
              <div class="kv-row"><strong>Tunnel URL</strong><span>${escapeHtml(tunnel.tunnelUrl || 'not configured')}</span></div>
              <div class="kv-row"><strong>Tunnel public URL</strong><span>${escapeHtml(tunnel.publicUrl || 'waiting for tunnel URL')}</span></div>
              <div class="kv-row"><strong>Auth hint</strong><span>${escapeHtml(connection.authHint || '')}</span></div>
            </div>
            <div class="footer">
              <span>${escapeHtml(tunnel.modeLabel || 'quick tunnel ready')}</span>
              <span>${escapeHtml(tunnel.hint || 'Use the public connector URL in ChatGPT / Notion. The local MCP URL is only for localhost debugging.')}</span>
            </div>
            <div class="tunnel-log">
              <h4>Tunnel log tail</h4>
              <pre id="tunnel-log-tail">${escapeHtml(tunnel.logTail || 'waiting for tunnel log...')}</pre>
            </div>
          </div>
        </article>

        <article class="card">
          <div class="head">
            <h2>Control panel</h2>
            <span class="badge">${escapeHtml(localOnly ? 'local-only' : 'view-only')}</span>
          </div>
          <div class="body">
            <p class="muted">Mutating actions stay local and require the dashboard action token.</p>
            <p class="muted">Fill <strong>Worker name</strong>, <strong>Client</strong>, <strong>Workspace</strong>, <strong>Permission</strong>, <strong>Boundary</strong>, and <strong>Port</strong>, then click <strong>Create &amp; start worker</strong>.</p>
            <div class="form-grid">
              <label>
                <span>Worker name</span>
                <input id="worker-name" value="${escapeHtml(state.suggestedWorkerName || current.name || 'chatgpt')}" />
                <small class="muted">The dashboard suggests a new unique name so create does not overwrite the selected worker.</small>
              </label>
              <label>
                <span>Client</span>
                <input id="worker-client" value="${escapeHtml(current.client || 'chatgpt')}" />
                <small class="muted">Use <code>chatgpt</code>, <code>notion</code>, or a custom label.</small>
              </label>
              <label class="wide">
                <span>Workspace</span>
                <input id="worker-workspace" value="${escapeHtml(current.workspace || workspaceInfo.worker?.workspace || '')}" />
                <small class="muted">This is the folder the worker may access. Keep it narrow unless you explicitly want a wider boundary.</small>
              </label>
              <label>
                <span>Permission</span>
                <select id="worker-permission">
                  ${['readonly', 'standard', 'yolo'].map((value) => `<option value="${value}"${value === (current.permissionLabel || 'readonly') ? ' selected' : ''}>${value}</option>`).join('')}
                </select>
                <small class="muted"><code>yolo</code> enables write, shell, and webfetch.</small>
              </label>
              <label>
                <span>Boundary</span>
                <select id="worker-boundary">
                  <option value="workspace-bound"${workspaceInfo.boundary?.allowOutside ? '' : ' selected'}>workspace-bound</option>
                  <option value="outside-workspace"${workspaceInfo.boundary?.allowOutside ? ' selected' : ''}>outside workspace allowed</option>
                </select>
                <small class="muted">Choose <code>outside workspace allowed</code> only when the worker should access paths beyond <code>WORKSPACE_DIR</code>.</small>
              </label>
              <label>
                <span>Port</span>
                <input id="worker-port" type="number" min="1" step="1" value="${escapeHtml(String(state.suggestedPort || current.port || 3333))}" />
                <small class="muted">The dashboard suggests the next free port so each worker gets its own URL.</small>
              </label>
              <label>
                <span>Tunnel</span>
                <select id="worker-tunnel">
                  ${['quick', 'named'].map((value) => `<option value="${value}"${value === (current.tunnelMode || 'quick') ? ' selected' : ''}>${value}</option>`).join('')}
                </select>
                <small class="muted"><code>quick</code> is easiest. <code>named</code> is stable.</small>
              </label>
            </div>
            <div class="copy-row action-row">
              <button class="btn" id="create-worker" ${localOnly ? '' : 'disabled'}>Create &amp; start worker</button>
              <button class="btn" data-worker-action="server/start" ${localOnly ? '' : 'disabled'}>Start server</button>
              <button class="btn" data-worker-action="server/stop" ${localOnly ? '' : 'disabled'}>Stop server</button>
              <button class="btn" data-worker-action="server/restart" ${localOnly ? '' : 'disabled'}>Restart server</button>
              <button class="btn" data-worker-action="tunnel/start" ${localOnly ? '' : 'disabled'}>Start tunnel</button>
              <button class="btn" data-worker-action="tunnel/stop" ${localOnly ? '' : 'disabled'}>Stop tunnel</button>
              <button class="btn" data-worker-action="tunnel/restart" ${localOnly ? '' : 'disabled'}>Restart tunnel</button>
              <button class="btn" data-worker-action="doctor" ${localOnly ? '' : 'disabled'}>Run doctor</button>
              <button class="btn" data-worker-action="validate" ${localOnly ? '' : 'disabled'}>Validate config</button>
            </div>
            <p class="muted" id="action-status">${escapeHtml(localOnly ? 'Ready.' : 'Actions are disabled for non-local dashboard access.')}</p>
            <p class="muted">Target worker: <strong>${escapeHtml(current.name || 'unknown')}</strong>. Actions affect the selected worker profile.</p>
          </div>
        </article>

        <article class="card">
          <div class="head">
            <h2>Job timeline</h2>
            <span class="badge">${escapeHtml(String((state.jobs || []).length))} jobs</span>
          </div>
          <div class="body timeline">
            <div id="jobs" class="list">${jobs}</div>
          </div>
        </article>
      </div>

      <div class="stack">
        <article class="card">
          <div class="head">
            <h2>Workers</h2>
            <span class="badge">${escapeHtml(String((state.workers || []).length))} profiles</span>
          </div>
          <div class="body">
            <div id="workers" class="list">${workers}</div>
          </div>
        </article>

        <article class="card signal">
          <div class="head">
            <h2>Selected job signal</h2>
            <span class="badge">${escapeHtml(state.selectedSignal?.status || 'idle')}</span>
          </div>
          <div class="body" id="signal">${renderSignal(signal)}</div>
        </article>
      </div>
    </section>
  </div>

  <script id="mcp-dashboard-state" type="application/json">${serializedState}</script>
  <script>
    const initialState = JSON.parse(document.getElementById('mcp-dashboard-state').textContent);
    let currentState = initialState;
    let selectedWorker = (initialState.current && initialState.current.name) || null;
    let selectedJob = initialState.selectedJobId || (initialState.jobs && initialState.jobs[0] && initialState.jobs[0].jobId) || null;
    const dashboardActionToken = (document.querySelector('meta[name="mcp-dashboard-action-token"]') || {}).content || '';
    const localActionsEnabled = !!dashboardActionToken;

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    async function copyText(text) {
      if (!text) return;
      await navigator.clipboard.writeText(text);
    }

    async function fetchJson(path, init = {}) {
      const response = await fetch(path, {
        ...init,
        headers: {
          accept: 'application/json',
          ...(init.headers || {}),
        },
      });
      if (!response.ok) throw new Error(path + ' -> ' + response.status);
      return response.json();
    }

    async function postJson(path, body = {}) {
      const response = await fetch(path, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(dashboardActionToken ? { 'x-mcp-dashboard-token': dashboardActionToken } : {}),
        },
        body: JSON.stringify(body || {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || (path + ' -> ' + response.status));
      }
      return payload;
    }

    function setActionStatus(message) {
      const el = document.getElementById('action-status');
      if (el) el.textContent = message || '';
    }

    function selectedWorkerName() {
      return (currentState.current && currentState.current.name) || selectedWorker || '';
    }

    function syncAuthButtonState() {
      const button = document.getElementById('copy-auth');
      if (!button) return;
      button.disabled = !localActionsEnabled || !selectedWorkerName() || (currentState.current && currentState.current.authMode === 'no-auth');
    }

    function syncConnectionButtons() {
      const publicButton = document.getElementById('copy-public-connector-url');
      if (publicButton) {
        const publicUrl = currentState.connection && currentState.connection.publicConnectorUrl ? String(currentState.connection.publicConnectorUrl) : '';
        publicButton.disabled = !publicUrl;
        publicButton.dataset.copy = publicUrl;
      }
      const localButton = document.getElementById('copy-local-mcp-url');
      if (localButton) {
        const localUrl = currentState.connection && currentState.connection.mcpUrl ? String(currentState.connection.mcpUrl) : '';
        localButton.disabled = !localUrl;
        localButton.dataset.copy = localUrl;
      }
      const dashboardButton = document.querySelector('button[data-copy="' + escapeHtml(currentState.connection && currentState.connection.dashboardUrl ? String(currentState.connection.dashboardUrl) : '') + '"]');
      if (dashboardButton && currentState.connection && currentState.connection.dashboardUrl) {
        dashboardButton.dataset.copy = String(currentState.connection.dashboardUrl);
      }
    }

    function syncTunnelPanel() {
      const tunnelLog = document.getElementById('tunnel-log-tail');
      if (tunnelLog) {
        const tail = currentState.tunnel && currentState.tunnel.logTail ? String(currentState.tunnel.logTail) : 'waiting for tunnel log...';
        tunnelLog.textContent = tail;
      }
    }

    async function copySelectedAuth() {
      const name = selectedWorkerName();
      if (!name) throw new Error('no worker selected');
      const payload = await fetchJson('/api/workers/' + encodeURIComponent(name) + '/auth-header', {
        headers: {
          ...(dashboardActionToken ? { 'x-mcp-dashboard-token': dashboardActionToken } : {}),
        },
      });
      if (payload.authMode === 'no-auth') {
        throw new Error('no auth required for selected worker');
      }
      await copyText(payload.authHeader || '');
      return payload;
    }

    async function runWorkerAction(action) {
      const name = selectedWorkerName();
      if (!name) throw new Error('no worker selected');
      const response = await postJson('/api/workers/' + encodeURIComponent(name) + '/' + action);
      await refresh();
      return response;
    }

    async function refreshUntilConnectorReady(timeoutMs = 15000, intervalMs = 1000) {
      const startedAt = Date.now();
      while (Date.now() - startedAt <= timeoutMs) {
        await refresh();
        if (currentState.connection && currentState.connection.publicConnectorUrl) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      return false;
    }

    async function createWorkerFromForm() {
      const payload = {
        name: document.getElementById('worker-name').value.trim(),
        client: document.getElementById('worker-client').value.trim(),
        workspace: document.getElementById('worker-workspace').value.trim(),
        permission: document.getElementById('worker-permission').value,
        allowOutsideWorkspace: document.getElementById('worker-boundary').value === 'outside-workspace',
        port: Number(document.getElementById('worker-port').value),
        tunnelMode: document.getElementById('worker-tunnel').value,
      };
      const response = await postJson('/api/workers/create', payload);
      await refresh();
      return response;
    }

    if (localActionsEnabled) {
      const createButton = document.getElementById('create-worker');
      if (createButton) {
        createButton.addEventListener('click', async () => {
          try {
            setActionStatus('Creating worker and starting server/tunnel...');
            const response = await createWorkerFromForm();
            const workerLabel = response && response.worker ? String(response.worker) : 'worker';
            const renamedNote = response && response.renamedFrom ? ' (requested ' + response.renamedFrom + ')' : '';
            setActionStatus('Worker created as ' + workerLabel + renamedNote + '.' + (response && response.port ? ' Port ' + response.port + '.' : ''));
            if (response && response.worker) {
              selectedWorker = String(response.worker);
              selectedJob = null;
              const params = new URLSearchParams(window.location.search);
              params.set('worker', selectedWorker);
              params.delete('job');
              window.history.replaceState({}, '', window.location.pathname + '?' + params.toString());
            }
            setActionStatus('Waiting for public connector URL...');
            const ready = await refreshUntilConnectorReady();
            setActionStatus(ready ? 'Public connector URL ready.' : 'Tunnel started, waiting for Cloudflare URL...');
            await refresh();
          } catch (error) {
            setActionStatus(String(error && error.message ? error.message : error));
          }
        });
      }

      document.querySelectorAll('[data-worker-action]').forEach((button) => {
        button.addEventListener('click', async () => {
          const action = button.getAttribute('data-worker-action');
          try {
            setActionStatus(action.replace('/', ' ') + '...');
            await runWorkerAction(action);
            if (action === 'tunnel/start' || action === 'tunnel/restart') {
              setActionStatus('Waiting for public connector URL...');
              const ready = await refreshUntilConnectorReady();
              setActionStatus(ready ? 'Public connector URL ready.' : 'Tunnel started, waiting for Cloudflare URL...');
            }
            setActionStatus(action.replace('/', ' ') + ' complete.');
          } catch (error) {
            setActionStatus(String(error && error.message ? error.message : error));
          }
        });
      });

      const copyAuthButton = document.getElementById('copy-auth');
      if (copyAuthButton) {
        copyAuthButton.addEventListener('click', async () => {
          try {
            setActionStatus('Copying auth...');
            await copySelectedAuth();
            copyAuthButton.textContent = 'Copied';
            setTimeout(() => {
              copyAuthButton.textContent = 'Copy auth';
            }, 1000);
            setActionStatus('Auth copied.');
          } catch (error) {
            setActionStatus(String(error && error.message ? error.message : error));
          }
        });
      }
    }

    function renderWorkers(workers) {
      const el = document.getElementById('workers');
      el.innerHTML = (workers || []).map((worker) => [
        '<button class="worker-row' + (worker.name === selectedWorker ? ' selected' : '') + '" data-worker="' + escapeHtml(worker.name) + '">',
        '  <span class="worker-title">',
        '    <strong>' + escapeHtml(worker.name) + '</strong>',
        '    <span>' + escapeHtml(worker.client || 'unknown client') + '</span>',
        '  </span>',
        '  <span class="worker-meta">',
        '    <span class="badge">' + escapeHtml(worker.permissionLabel || 'readonly') + '</span>',
        '    <span class="badge ' + (worker.status === 'running' ? 'badge-success' : '') + '">' + escapeHtml(worker.status || 'offline') + '</span>',
        '  </span>',
        '</button>',
      ].join('\\n')).join('') || '<div class="empty">No worker profiles found yet.</div>';
      el.querySelectorAll('[data-worker]').forEach((button) => {
        button.addEventListener('click', () => {
          selectedWorker = button.getAttribute('data-worker');
          const params = new URLSearchParams(window.location.search);
          params.set('worker', selectedWorker || '');
          params.delete('job');
          window.location.search = params.toString();
        });
      });
    }

    function renderJobs(jobs) {
      const el = document.getElementById('jobs');
      el.innerHTML = (jobs || []).map((job) => [
        '<button class="job-row' + (job.jobId === selectedJob ? ' selected' : '') + '" data-job="' + escapeHtml(job.jobId) + '">',
        '  <span class="job-main">',
        '    <strong>' + escapeHtml(job.title || job.kind || 'job') + '</strong>',
        '    <span>' + escapeHtml([job.kind, job.currentStep && job.totalSteps ? job.currentStep + '/' + job.totalSteps : null].filter(Boolean).join(' · ')) + '</span>',
        '  </span>',
        '  <span class="job-meta">',
        '    <span class="badge ' + (job.status === 'completed' ? 'badge-success' : job.status === 'failed' || job.status === 'cancelled' || job.status === 'timed_out' ? 'badge-danger' : '') + '">' + escapeHtml(job.status || 'unknown') + '</span>',
        '    <time datetime="' + escapeHtml(job.createdAt || '') + '">' + escapeHtml(job.createdAtLabel || '') + '</time>',
        '  </span>',
        '</button>',
      ].join('\\n')).join('') || '<div class="empty">No jobs have been created yet.</div>';
      el.querySelectorAll('[data-job]').forEach((button) => {
        button.addEventListener('click', () => {
          selectedJob = button.getAttribute('data-job');
          const params = new URLSearchParams(window.location.search);
          if (selectedWorker) params.set('worker', selectedWorker);
          params.set('job', selectedJob || '');
          window.location.search = params.toString();
        });
      });
    }

    function renderSignal(signal) {
      const el = document.getElementById('signal');
      if (!signal) {
        el.innerHTML = '<div class="empty">Select a job to view its signal summary.</div>';
        return;
      }
      const parts = [];
      if (signal.headline) parts.push('<p class="signal-headline">' + escapeHtml(signal.headline) + '</p>');
      if (signal.nextAction) parts.push('<p class="signal-next">' + escapeHtml(signal.nextAction) + '</p>');
      if (signal.keyLines && signal.keyLines.length) parts.push('<h4>Key lines</h4><pre>' + escapeHtml(signal.keyLines.join('\\n')) + '</pre>');
      if (signal.errors && signal.errors.length) parts.push('<h4>Errors</h4><pre>' + escapeHtml(signal.errors.join('\\n')) + '</pre>');
      if (signal.warnings && signal.warnings.length) parts.push('<h4>Warnings</h4><pre>' + escapeHtml(signal.warnings.join('\\n')) + '</pre>');
      if (signal.rewind) parts.push('<h4>Rewind</h4><pre>' + escapeHtml(JSON.stringify(signal.rewind, null, 2)) + '</pre>');
      if (signal.rawWarning) parts.push('<p class="muted">' + escapeHtml(signal.rawWarning) + '</p>');
      el.innerHTML = parts.join('') || '<div class="empty">No signal available.</div>';
    }

    async function refreshJob(jobId) {
      if (!jobId) return;
      const payload = await fetchJson('/api/jobs/' + encodeURIComponent(jobId));
      renderSignal(payload.signal);
    }

    async function refresh() {
      const state = await fetchJson('/api/dashboard' + (selectedWorker ? '?worker=' + encodeURIComponent(selectedWorker) : ''));
      currentState = state;
      selectedWorker = state.current && state.current.name ? state.current.name : selectedWorker;
      const jobs = state.jobs || [];
      const hasSelectedJob = selectedJob && jobs.some((job) => job.jobId === selectedJob);
      selectedJob = hasSelectedJob ? selectedJob : (jobs[0] && jobs[0].jobId) || null;
      renderWorkers(state.workers || []);
      renderJobs(state.jobs || []);
      renderSignal(state.selectedSignal || null);
      document.querySelector('.hero .chips').innerHTML = [
        '<span class="chip">' + escapeHtml(state.current.permissionLabel || 'readonly') + '</span>',
        '<span class="chip">' + escapeHtml(state.current.status || 'offline') + '</span>',
        '<span class="chip">' + escapeHtml(state.current.authMode || 'bearer') + '</span>',
        '<span class="chip">' + escapeHtml(state.server.name || 'mcp-workbench') + '</span>'
      ].join('');
      syncConnectionButtons();
      syncTunnelPanel();
      syncAuthButtonState();
    }

    document.querySelectorAll('[data-copy]').forEach((button) => {
      button.addEventListener('click', async () => {
        await copyText(button.getAttribute('data-copy'));
        button.textContent = 'Copied';
        setTimeout(() => {
          button.textContent = button.dataset.original || button.textContent;
        }, 1000);
      });
      button.dataset.original = button.textContent;
    });

    setInterval(() => {
      refresh().catch(() => {});
    }, 10000);

    renderWorkers(currentState.workers || []);
    renderJobs(currentState.jobs || []);
    renderSignal(currentState.selectedSignal || null);
    syncConnectionButtons();
    syncTunnelPanel();
    syncAuthButtonState();
  </script>
</body>
</html>`;
}
