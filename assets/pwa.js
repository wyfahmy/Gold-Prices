(() => {
  const install = document.getElementById('installApp');
  const help = document.getElementById('installHelp');
  const update = document.getElementById('updateApp');
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let promptEvent;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && !standalone()) install.hidden = false;
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    promptEvent = event;
    install.hidden = standalone();
  });
  install.addEventListener('click', async () => {
    if (promptEvent) {
      const event = promptEvent;
      promptEvent = null;
      install.hidden = true;
      await event.prompt();
      await event.userChoice;
    } else if (ios) {
      help.textContent = 'On iPhone or iPad, open this page in Safari, tap Share, then Add to Home Screen and Add.';
      help.hidden = false;
    }
  });
  window.addEventListener('appinstalled', () => {
    promptEvent = null;
    install.hidden = true;
    help.hidden = true;
  });
  if ('serviceWorker' in navigator && window.isSecureContext) {
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) location.reload();
    });
    navigator.serviceWorker.register('./service-worker.js', {updateViaCache: 'none'}).then(reg => {
      const offerUpdate = () => {
        if (!reg.waiting || !navigator.serviceWorker.controller) return;
        update.hidden = false;
        update.onclick = () => {
          reloading = true;
          reg.waiting.postMessage({type: 'SKIP_WAITING'});
        };
      };
      offerUpdate();
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', offerUpdate);
      });
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(console.warn);
      });
    }).catch(error => {
      console.warn('Offline support unavailable', error);
    });
  }
})();
