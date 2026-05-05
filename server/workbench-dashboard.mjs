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

export function renderDashboardPage(state) {
  const serializedState = serializeDashboardState(state);
  const workers = renderWorkerList(state.workers || []);
  const jobs = renderJobList(state.jobs || []);
  const current = state.current || {};
  const connection = state.connection || {};
  const tunnel = state.tunnel || {};
  const signal = state.selectedSignal || null;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>mcp-workbench dashboard</title>
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
    .list { display: grid; gap: 10px; }
    .worker-row, .job-row {
      width: 100%; display: flex; justify-content: space-between; gap: 14px; align-items: center;
      padding: 12px 14px; border: 1px solid var(--line); border-radius: 14px; background: rgba(255,255,255,.03);
      color: var(--text); cursor: pointer; text-align: left;
    }
    .worker-row.selected, .job-row.selected { border-color: rgba(124,167,255,.6); box-shadow: inset 0 0 0 1px rgba(124,167,255,.22); }
    .worker-title, .job-main { display: grid; gap: 3px; }
    .worker-title span, .job-main span { color: var(--muted); font-size: 12px; }
    .worker-meta, .job-meta { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .empty { color: var(--muted); padding: 8px 0; }
    .signal-headline { font-size: 16px; margin: 0 0 6px; }
    .signal-next { margin: 0 0 14px; color: var(--soft); }
    h4 { margin: 16px 0 8px; font-size: 13px; letter-spacing: .02em; color: var(--soft); }
    .timeline { max-height: 620px; overflow: auto; }
    .signal pre { max-height: 220px; }
    .footer {
      margin-top: 16px; color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap;
    }
    @media (max-width: 980px) {
      .grid { grid-template-columns: 1fr; }
      .hero { flex-direction: column; align-items: flex-start; }
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
      </div>
      <div class="copy-row">
        <button class="btn" data-copy="${escapeHtml(connection.mcpUrl || '')}">Copy MCP URL</button>
        <button class="btn" data-copy="${escapeHtml(connection.authHeader || '')}">Copy auth</button>
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
              <div class="kv-row"><strong>Permission</strong><span>${badge(current.permissionLabel || 'readonly', current.permissionLabel || '')}</span></div>
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
              <div class="kv-row"><strong>MCP URL</strong><span>${escapeHtml(connection.mcpUrl || '')}</span></div>
              <div class="kv-row"><strong>Dashboard URL</strong><span>${escapeHtml(connection.dashboardUrl || '')}</span></div>
              <div class="kv-row"><strong>Tunnel URL</strong><span>${escapeHtml(tunnel.tunnelUrl || 'not configured')}</span></div>
              <div class="kv-row"><strong>Auth hint</strong><span>${escapeHtml(connection.authHint || '')}</span></div>
            </div>
            <div class="footer">
              <span>${escapeHtml(tunnel.modeLabel || 'quick tunnel ready')}</span>
              <span>${escapeHtml(tunnel.hint || 'Use the browser to copy the final URL or auth header into ChatGPT / Notion.')}</span>
            </div>
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

    async function fetchJson(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(path + ' -> ' + response.status);
      return response.json();
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
          if (selectedJob) params.set('job', selectedJob);
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
  </script>
</body>
</html>`;
}
