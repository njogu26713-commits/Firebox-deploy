async function loadHome() {
  try {
    const { user } = await apiFetch('/api/auth/me');
    document.getElementById('userName').textContent = user.name;
    document.getElementById('userEmail').textContent = user.email;
    const { projects } = await apiFetch('/api/projects');
    document.getElementById('homeProjectCount').textContent = projects.length;
  } catch (err) {
    window.location.href = '/login';
  }
}
document.getElementById('logoutBtn').addEventListener('click', async () => { await apiFetch('/api/auth/logout', { method: 'POST' }); localStorage.removeItem('firebox_token'); window.location.href = '/login'; });
loadHome();
