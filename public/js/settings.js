async function loadSettings() {
  try {
    const { user } = await apiFetch('/api/auth/me');
    document.getElementById('userName').textContent  = user.name;
    document.getElementById('userEmail').textContent = user.email;

    // SSH badge
    renderBadge('sshBadge', 'removeSshBtn', user.hasSshCredentials);

    // Pre-fill SSH fields with non-secret values
    if (user.sshHost)       document.getElementById('sshHost').value       = user.sshHost;
    if (user.sshPort)       document.getElementById('sshPort').value       = user.sshPort;
    if (user.sshUsername)   document.getElementById('sshUsername').value   = user.sshUsername;
    if (user.sshDeployRoot) document.getElementById('sshDeployRoot').value = user.sshDeployRoot;

    // Show correct auth type radio
    if (user.sshAuthType === 'password') {
      document.querySelector('input[name="sshAuthType"][value="password"]').checked = true;
      toggleAuthType('password');
    }

    // GitHub badge
    renderBadge('githubBadge', 'removeGithubBtn', user.hasGithubToken);
  } catch {
    window.location.href = '/login';
  }
}

function renderBadge(badgeId, removeBtnId, connected) {
  const badge = document.getElementById(badgeId);
  const btn   = document.getElementById(removeBtnId);
  if (connected) {
    badge.textContent  = '✓ Connected';
    badge.className    = 'token-badge connected';
    btn.style.display  = 'inline-flex';
  } else {
    badge.textContent  = '✗ Not connected';
    badge.className    = 'token-badge';
    btn.style.display  = 'none';
  }
}

function toggleAuthType(type) {
  document.getElementById('keyField').style.display      = type === 'key'      ? '' : 'none';
  document.getElementById('passwordField').style.display = type === 'password' ? '' : 'none';
}

// Auth type radio toggle
document.querySelectorAll('input[name="sshAuthType"]').forEach((radio) => {
  radio.addEventListener('change', (e) => toggleAuthType(e.target.value));
});

// ── SSH credentials ───────────────────────────────────────────────────────

document.getElementById('saveSshBtn').addEventListener('click', async () => {
  const authType   = document.querySelector('input[name="sshAuthType"]:checked').value;
  const privateKey = authType === 'key'      ? document.getElementById('sshPrivateKey').value.trim() : '';
  const password   = authType === 'password' ? document.getElementById('sshPassword').value.trim()   : '';

  const host       = document.getElementById('sshHost').value.trim();
  const port       = document.getElementById('sshPort').value.trim();
  const username   = document.getElementById('sshUsername').value.trim();
  const deployRoot = document.getElementById('sshDeployRoot').value.trim();

  if (!host)     { showToast('SSH host is required', 'error'); return; }
  if (!username) { showToast('SSH username is required', 'error'); return; }
  // Blank secret fields intentionally preserve the encrypted credential already saved on the server.
  try {
    await apiFetch('/api/settings/ssh-credentials', {
      method: 'POST',
      body: JSON.stringify({ host, port, username, privateKey, password, deployRoot }),
    });
    // Clear the sensitive fields after save
    document.getElementById('sshPrivateKey').value = '';
    document.getElementById('sshPassword').value   = '';
    showToast(privateKey || password ? 'SSH connection saved securely.' : 'VPS settings saved; existing SSH credentials were preserved.');
    loadSettings();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('testSshBtn').addEventListener('click', async () => {
  const button = document.getElementById('testSshBtn');
  button.disabled = true;
  button.textContent = 'Testing…';
  try {
    const result = await apiFetch('/api/settings/ssh-credentials/test', { method: 'POST', body: '{}' });
    showToast(result.message || 'SSH connection established.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Test connection';
  }
});

document.getElementById('testTcpBtn').addEventListener('click', async () => {
  const button = document.getElementById('testTcpBtn');
  button.disabled = true;
  button.textContent = 'Testing Railway…';
  try {
    const result = await apiFetch('/api/settings/ssh-credentials/test-tcp', { method: 'POST', body: '{}' });
    showToast(`${result.message} (${result.elapsedMs} ms)`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Test Railway TCP';
  }
});

document.getElementById('removeSshBtn').addEventListener('click', async () => {
  if (!confirm('Remove SSH credentials? You will not be able to deploy until you re-add them.')) return;
  try {
    await apiFetch('/api/settings/ssh-credentials', { method: 'DELETE' });
    document.getElementById('sshHost').value       = '';
    document.getElementById('sshUsername').value   = '';
    document.getElementById('sshDeployRoot').value = '/opt/apps';
    showToast('SSH credentials removed.');
    loadSettings();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── GitHub token ──────────────────────────────────────────────────────────

document.getElementById('saveGithubBtn').addEventListener('click', async () => {
  const token = document.getElementById('githubToken').value.trim();
  if (!token) { showToast('Enter your GitHub personal access token', 'error'); return; }
  try {
    await apiFetch('/api/settings/github-token', { method: 'POST', body: JSON.stringify({ token }) });
    document.getElementById('githubToken').value = '';
    showToast('GitHub token saved.');
    loadSettings();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('removeGithubBtn').addEventListener('click', async () => {
  if (!confirm('Remove GitHub token?')) return;
  try {
    await apiFetch('/api/settings/github-token', { method: 'DELETE' });
    showToast('GitHub token removed.');
    loadSettings();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Logout ────────────────────────────────────────────────────────────────

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await apiFetch('/api/auth/logout', { method: 'POST' });
  localStorage.removeItem('firebox_token');
  window.location.href = '/login';
});

loadSettings();
