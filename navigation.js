// Notify the isolated content script as soon as ChatGPT changes routes.
(() => {
  if (window.__gptReadingNavigation) return;
  window.__gptReadingNavigation = true;
  const changed = () => window.dispatchEvent(new Event('gpt-reading-route'));
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name];
    history[name] = function(...args) { const result = Reflect.apply(original, this, args); changed(); return result; };
  }
  addEventListener('popstate', changed); addEventListener('pageshow', changed);
  window.navigation?.addEventListener('currententrychange', changed);
})();
