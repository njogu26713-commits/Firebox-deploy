(() => {
  const providers = [...document.querySelectorAll('.request-provider')];
  const form = document.getElementById('requestForm');
  const submit = document.getElementById('submitRequest');
  const error = document.getElementById('requestError');
  let selectedProvider = '';

  function chooseProvider(provider) {
    selectedProvider = provider;
    providers.forEach((button) => {
      const selected = button.dataset.provider === provider;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    submit.disabled = false;
    submit.innerHTML = `Send ${provider[0].toUpperCase() + provider.slice(1)} request <span>→</span>`;
  }

  providers.forEach((button) => button.addEventListener('click', () => chooseProvider(button.dataset.provider)));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.style.display = 'none';
    if (!selectedProvider) return;
    submit.disabled = true;
    submit.textContent = 'Sending…';
    try {
      const response = await fetch('/api/deployment-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requesterName: document.getElementById('requesterName').value,
          requesterEmail: document.getElementById('requesterEmail').value,
          projectName: document.getElementById('projectName').value,
          provider: selectedProvider,
          repoUrl: document.getElementById('repoUrl').value,
          branch: document.getElementById('branch').value || 'main',
          notes: document.getElementById('notes').value,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      form.style.display = 'none';
      document.getElementById('requestSuccess').style.display = 'block';
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
      submit.disabled = false;
      submit.innerHTML = `Send ${selectedProvider[0].toUpperCase() + selectedProvider.slice(1)} request <span>→</span>`;
    }
  });
})();
