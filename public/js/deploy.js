(() => {
  const providers = {
    railway: {
      name: 'Railway',
      description: 'Deploy Node.js services and containers with a simple Git-based workflow.',
    },
    vercel: {
      name: 'Vercel',
      description: 'Deploy frontend applications, Next.js projects, serverless functions, and edge workloads.',
    },
    heroku: {
      name: 'Heroku',
      description: 'Deploy apps through buildpacks with dynos, add-ons, and pipeline support.',
    },
    render: {
      name: 'Render',
      description: 'Deploy web services, static sites, background workers, and scheduled jobs.',
    },
  };

  const cards = [...document.querySelectorAll('.provider-card')];
  const selectedName = document.getElementById('selectedProvider');
  const selectedDescription = document.getElementById('providerDescription');
  const continueButton = document.getElementById('continueDeploy');
  let selectedProvider = null;

  function selectProvider(providerId) {
    const provider = providers[providerId];
    if (!provider) return;
    selectedProvider = providerId;
    cards.forEach((card) => {
      const isSelected = card.dataset.provider === providerId;
      card.classList.toggle('selected', isSelected);
      card.setAttribute('aria-pressed', String(isSelected));
    });
    selectedName.textContent = provider.name;
    selectedDescription.textContent = provider.description;
    continueButton.disabled = false;
    continueButton.innerHTML = `Continue with ${provider.name} <span>→</span>`;
  }

  cards.forEach((card) => {
    card.addEventListener('click', () => selectProvider(card.dataset.provider));
  });

  continueButton.addEventListener('click', () => {
    if (!selectedProvider) return;
    const provider = providers[selectedProvider];
    window.alert(`${provider.name} selected. Provider configuration will be available in the next step.`);
  });
})();
