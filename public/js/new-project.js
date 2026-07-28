let selectedType = 'node-app';

// ── Type picker ───────────────────────────────────────────────────────────
document.querySelectorAll('.type-option').forEach((el) => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.type-option').forEach((o) => o.classList.remove('selected'));
    el.classList.add('selected');
    selectedType = el.dataset.type;
  });
});

// ── Command field helpers ─────────────────────────────────────────────────
function setDetectedBadge(fieldId, value, detected) {
  const field  = document.getElementById(fieldId);
  const wrap   = field.closest('.field');
  const badge  = wrap.querySelector('.detect-badge');

  field.value = value;

  if (detected && value) {
    badge.textContent  = '✦ auto-detected';
    badge.style.display = 'inline';
    field.classList.add('field-detected');
  } else {
    badge.style.display = 'none';
    field.classList.remove('field-detected');
  }
}

function setDetecting(on) {
  ['buildCommand', 'startCommand'].forEach((id) => {
    const field = document.getElementById(id);
    const wrap  = field.closest('.field');
    const badge = wrap.querySelector('.detect-badge');
    if (on) {
      badge.textContent  = '⟳ detecting…';
      badge.style.display = 'inline';
      field.disabled = true;
    } else {
      field.disabled = false;
    }
  });
}

// Clear badges when user manually edits a command field
['buildCommand', 'startCommand'].forEach((id) => {
  document.getElementById(id).addEventListener('input', () => {
    const wrap  = document.getElementById(id).closest('.field');
    const badge = wrap.querySelector('.detect-badge');
    badge.style.display = 'none';
    document.getElementById(id).classList.remove('field-detected');
  });
});

// ── Detect commands for the selected repo ─────────────────────────────────
async function detectRepoCommands(fullName, branch) {
  setDetecting(true);
  try {
    const result = await apiFetch(
      `/api/github/detect?repo=${encodeURIComponent(fullName)}&branch=${encodeURIComponent(branch || 'main')}`
    );
    setDetectedBadge('buildCommand', result.buildCommand || '', result.detected);
    setDetectedBadge('startCommand',  result.startCommand  || '', result.detected);

    const fwEl = document.getElementById('frameworkBadge');
    if (fwEl && result.framework && result.framework !== 'unknown') {
      fwEl.textContent  = FRAMEWORK_LABELS[result.framework] || result.framework;
      fwEl.style.display = 'inline';
    } else if (fwEl) {
      fwEl.style.display = 'none';
    }
  } catch {
    setDetectedBadge('buildCommand', '', false);
    setDetectedBadge('startCommand',  '', false);
  } finally {
    setDetecting(false);
  }
}

const FRAMEWORK_LABELS = {
  nextjs:    'Next.js',
  cra:       'Create React App',
  vite:      'Vite',
  nuxt:      'Nuxt',
  astro:     'Astro',
  gatsby:    'Gatsby',
  nestjs:    'NestJS',
  remix:     'Remix',
  sveltekit: 'SvelteKit',
  express:   'Express',
  fastify:   'Fastify',
  hono:      'Hono',
  koa:       'Koa',
  'ts-node': 'TypeScript',
};

// ── Repo loader ───────────────────────────────────────────────────────────
document.getElementById('loadReposBtn').addEventListener('click', async () => {
  const btn = document.getElementById('loadReposBtn');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const { repos } = await apiFetch('/api/github/repos');
    const select = document.getElementById('repoSelect');
    if (!repos.length) {
      select.innerHTML = '<option value="">No repositories found</option>';
      return;
    }
    select.innerHTML = repos.map((r) =>
      `<option value="${escapeHtml(r.fullName)}"
               data-branch="${escapeHtml(r.defaultBranch)}"
               data-url="${escapeHtml(r.cloneUrl)}">${escapeHtml(r.fullName)}${r.private ? ' 🔒' : ''}</option>`
    ).join('');

    const first = repos[0];
    if (!document.getElementById('name').value) {
      document.getElementById('name').value = first.name;
    }
    document.getElementById('branch').value = first.defaultBranch;
    detectRepoCommands(first.fullName, first.defaultBranch);

    select.addEventListener('change', () => {
      const opt = select.selectedOptions[0];
      if (!opt) return;
      const nameEl = document.getElementById('name');
      if (!nameEl.value || nameEl.value === nameEl.dataset.auto) {
        nameEl.value = opt.value.split('/')[1] || opt.value;
        nameEl.dataset.auto = nameEl.value;
      }
      const branch = opt.dataset.branch || 'main';
      document.getElementById('branch').value = branch;
      detectRepoCommands(opt.value, branch);
    });
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '↻ Load repos';
  }
});

// Re-detect when branch is changed manually
document.getElementById('branch').addEventListener('change', () => {
  const select = document.getElementById('repoSelect');
  const repo   = select.value;
  if (!repo) return;
  detectRepoCommands(repo, document.getElementById('branch').value);
});

// ── Env var rows ──────────────────────────────────────────────────────────
document.getElementById('addEnvRow').addEventListener('click', () => addEnvRow());

function addEnvRow(key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'env-row';
  row.innerHTML = `
    <input placeholder="KEY"   class="env-key"   value="${escapeHtml(key)}" />
    <input placeholder="value" class="env-value" value="${escapeHtml(value)}" />
    <button type="button" class="btn btn-icon btn-ghost remove-env">✕</button>
  `;
  row.querySelector('.remove-env').addEventListener('click', () => row.remove());
  document.getElementById('envRows').appendChild(row);
}
addEnvRow('NODE_ENV', 'production');

// ── Form submit ───────────────────────────────────────────────────────────
document.getElementById('newProjectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('formError');
  errEl.style.display = 'none';

  const select             = document.getElementById('repoSelect');
  const githubRepoFullName = select.value;

  if (!githubRepoFullName) {
    errEl.textContent  = 'Please load and select a GitHub repository.';
    errEl.style.display = 'block';
    return;
  }

  const envVars = Array.from(document.querySelectorAll('.env-row')).map((row) => ({
    key:   row.querySelector('.env-key').value.trim(),
    value: row.querySelector('.env-value').value,
  })).filter((e) => e.key);

  const payload = {
    name:                document.getElementById('name').value.trim(),
    type:                selectedType,
    githubRepoFullName,
    repoUrl:             `https://github.com/${githubRepoFullName}`,
    githubBranch:        document.getElementById('branch').value.trim() || 'main',
    rootDirectory:       document.getElementById('rootDirectory').value.trim() || '.',
    buildCommand:        document.getElementById('buildCommand').value.trim(),
    startCommand:        document.getElementById('startCommand').value.trim(),
    deployPath:          document.getElementById('deployPath').value.trim(),
    vpsUrl:              document.getElementById('vpsUrl').value.trim(),
    envVars,
  };

  const submitBtn = document.getElementById('submitBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating…';

  try {
    const { project } = await apiFetch('/api/projects', {
      method: 'POST',
      body:   JSON.stringify(payload),
    });
    showToast('Project created! Click ⚡ Deploy to run the first deployment.');
    window.location.href = `/projects/${project._id}`;
  } catch (err) {
    errEl.textContent  = err.message;
    errEl.style.display = 'block';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Project';
  }
});
