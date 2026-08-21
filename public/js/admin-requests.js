const providerLabels = { railway: 'Railway', vercel: 'Vercel', heroku: 'Heroku', render: 'Render' };
const statusLabels = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', deployed: 'Deployed' };

function requestRow(request) {
  const statusOptions = Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${request.status === value ? 'selected' : ''}>${label}</option>`).join('');
  return `<article class="card admin-request-card">
    <div class="admin-request-head"><div><div class="request-project-name">${escapeHtml(request.projectName)}</div><div class="request-requester">${escapeHtml(request.requesterName)} · <a href="mailto:${escapeHtml(request.requesterEmail)}">${escapeHtml(request.requesterEmail)}</a></div></div><span class="request-provider-badge">${escapeHtml(providerLabels[request.provider] || request.provider)}</span></div>
    <div class="admin-request-meta"><span>Repository <a href="${escapeHtml(request.repoUrl)}" target="_blank" rel="noopener">${escapeHtml(request.repoUrl)}</a></span><span>Branch <b>${escapeHtml(request.branch || 'main')}</b></span><span>Submitted <b>${timeAgo(request.createdAt)}</b></span></div>
    ${request.notes ? `<p class="admin-request-notes">${escapeHtml(request.notes)}</p>` : ''}
    <div class="admin-request-actions"><select class="request-status" data-id="${request._id}">${statusOptions}</select><input class="request-admin-notes" data-id="${request._id}" value="${escapeHtml(request.adminNotes || '')}" placeholder="Admin note for this request" maxlength="2000" /><button class="btn btn-primary btn-sm save-request" data-id="${request._id}">Save</button></div>
  </article>`;
}

async function loadRequests() {
  const list = document.getElementById('adminRequestList');
  const empty = document.getElementById('adminRequestEmpty');
  try {
    const { requests } = await apiFetch('/api/deployment-requests');
    document.getElementById('requestCount').textContent = `${requests.length} request${requests.length === 1 ? '' : 's'}`;
    list.innerHTML = requests.map(requestRow).join('');
    empty.style.display = requests.length ? 'none' : 'block';
    list.querySelectorAll('.save-request').forEach((button) => button.addEventListener('click', () => saveRequest(button.dataset.id)));
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function saveRequest(id) {
  const status = document.querySelector(`.request-status[data-id="${CSS.escape(id)}"]`).value;
  const adminNotes = document.querySelector(`.request-admin-notes[data-id="${CSS.escape(id)}"]`).value;
  try {
    await apiFetch(`/api/deployment-requests/${id}`, { method: 'PATCH', body: JSON.stringify({ status, adminNotes }) });
    showToast('Request updated');
    await loadRequests();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('refreshRequests').addEventListener('click', loadRequests);
loadRequests();
