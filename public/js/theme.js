(() => {
  const storageKey = 'firebox-theme';
  const root = document.documentElement;

  function getTheme() {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    const toggle = document.getElementById('themeToggle');
    if (!toggle) return;
    const isLight = theme === 'light';
    toggle.setAttribute('aria-pressed', String(isLight));
    toggle.setAttribute('aria-label', isLight ? 'Switch to dark mode' : 'Switch to light mode');
    toggle.innerHTML = `<span class="theme-toggle-icon" aria-hidden="true">${isLight ? '☾' : '☀'}</span><span>${isLight ? 'Dark mode' : 'Light mode'}</span>`;
  }

  applyTheme(getTheme());

  document.addEventListener('DOMContentLoaded', () => {
    let toggle = document.getElementById('themeToggle');
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.id = 'themeToggle';
      toggle.className = 'theme-toggle';
      toggle.type = 'button';
      document.body.appendChild(toggle);
    }
    applyTheme(root.dataset.theme || getTheme());
    toggle.addEventListener('click', () => {
      const nextTheme = root.dataset.theme === 'light' ? 'dark' : 'light';
      localStorage.setItem(storageKey, nextTheme);
      applyTheme(nextTheme);
    });
  });
})();
