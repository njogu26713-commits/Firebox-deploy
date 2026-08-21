const historyStatus = { success: 'Success', failed: 'Failed', building: 'Building', queued: 'Queued', stopped: 'Stopped' };
async function loadHistory() {
  const list = document.getElementById('historyList');
  try {
    const { projects } = await apiFetch('/api/projects');
    const records = [];
    for (const project of projects) {
      try {
        const { deployments } = await apiFetch(`/api/projects/${project._id}/deployments`);
        (deployments || []).forEach((deployment) => records.push({ ...deployment, projectName: project.name, projectId: project._id }));
      } catch (_) { /* keep history resilient when an individual project has no records */ }
    }
    records.sort((a, b) => new Date(b.createdAt || b.startedAt || 0) - new Date(a.createdAt || a.startedAt || 0));
    list.innerHTML = records.slice(0, 50).map((record) => `<div class="card history-row"><div class="history-row-icon ${record.status === 'success' ? 'success' : record.status === 'failed' ? 'failed' : ''}">${record.status === 'success' ? '✓' : record.status === 'failed' ? '×' : '↗'}</div><div class="history-row-main"><strong>${escapeHtml(record.projectName)}</strong><span>${escapeHtml(record.trigger || 'Manual deploy')} · ${escapeHtml(record.branch || 'main')}</span></div><div class="history-row-status"><b>${escapeHtml(historyStatus[record.status] || record.status || 'Unknown')}</b><small>${timeAgo(record.createdAt || record.startedAt)}</small></div></div>`).join('');
    document.getElementById('historyEmpty').style.display = records.length ? 'none' : 'block';
  } catch (err) { showToast(err.message, 'error'); }
}
document.getElementById('refreshHistory').addEventListener('click', loadHistory);
document.getElementById('logoutBtn').addEventListener('click', async () => { await apiFetch('/api/auth/logout', { method: 'POST' }); localStorage.removeItem('firebox_token'); window.location.href = '/login'; });
loadHistory();
