const TYPE_LABELS = {
  api: 'API', website: 'Website',
  'bot-whatsapp': 'WhatsApp Bot', 'bot-telegram': 'Telegram Bot',
  'bot-discord': 'Discord Bot', 'node-app': 'Node.js App',
};

async function loadUser() {
  try {
    const { user } = await apiFetch('/api/auth/me');
    document.getElementById('userName').textContent  = user.name;
    document.getElementById('userEmail').textContent = user.email;
    if (!user.hasSshCredentials) {
      document.getElementById('sshWarning').style.display = 'block';
    }
  } catch {
    window.location.href = '/login';
  }
}

function domainDisplay(p) {
  if (p.vpsUrl)       return p.vpsUrl.replace(/^https?:\/\//, '');
  if (p.customDomain) return p.customDomain;
  return '—';
}

function projectCard(p) {
  const domain  = domainDisplay(p);
  const href    = p.vpsUrl || (p.customDomain ? `https://${p.customDomain}` : '#');

  return `
    <div class="card project-card" onclick="location.href='/projects/${p._id}'">
      <div class="project-card-head">
        <div>
          <div class="project-name">${escapeHtml(p.name)}</div>
          <div class="project-type">${TYPE_LABELS[p.type] || p.type}</div>
        </div>
        <div class="beacon" data-status="${p.status}">
          <span class="beacon-dot"></span>${p.status}
        </div>
      </div>
      <div class="project-domain">
        <a href="${href !== '#' ? escapeHtml(href) : '#'}" target="_blank" rel="noopener"
           onclick="event.stopPropagation()" style="color:var(--muted);">${escapeHtml(domain)}</a>
      </div>
      <div class="project-meta">
        <span>Branch <b>${escapeHtml(p.githubBranch || 'main')}</b></span>
        <span>Deployed <b>${timeAgo(p.lastDeployedAt)}</b></span>
        <span class="badge" style="font-size:10px;">VPS / PM2</span>
      </div>
    </div>
  `;
}

async function loadProjects() {
  try {
    const { projects } = await apiFetch('/api/projects');
    const grid  = document.getElementById('projectsGrid');
    const empty = document.getElementById('emptyState');
    const count = document.getElementById('projectCount');

    count.textContent = `${projects.length} project${projects.length === 1 ? '' : 's'}`;

    if (!projects.length) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    grid.innerHTML = projects.map(projectCard).join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('refreshBtn').addEventListener('click', loadProjects);

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await apiFetch('/api/auth/logout', { method: 'POST' });
  localStorage.removeItem('firebox_token');
  window.location.href = '/login';
});

// Live status updates
fireboxSocket.emit('subscribe:dashboard');
fireboxSocket.on('project:status', () => loadProjects());

loadUser();
loadProjects();
