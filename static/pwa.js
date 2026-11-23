/* TimeSave Social V20.1 – PWA Registration & Install-Hinweis */
(function () {
  'use strict';

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  if (isStandalone) {
    document.documentElement.classList.add('pwa-standalone');
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    });
  }

  let deferredPrompt = null;

  function showInstallBanner() {
    if (isStandalone || !deferredPrompt || document.getElementById('tsPwaBanner')) return;
    if (sessionStorage.getItem('ts_pwa_dismissed') === '1') return;

    const bar = document.createElement('div');
    bar.id = 'tsPwaBanner';
    bar.style.cssText =
      'position:fixed;left:12px;right:12px;bottom:14px;z-index:9999;max-width:460px;margin:0 auto;' +
      'background:#231942;color:#fff;border:1px solid #493680;border-radius:14px;padding:11px 14px;' +
      'display:flex;align-items:center;justify-content:space-between;gap:10px;box-shadow:0 10px 28px rgba(20,12,48,.32);font-size:13px;';
    bar.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;min-width:0;">' +
      '<img src="/static/icons/icon-192.png" alt="TimeSave Social" style="width:34px;height:34px;border-radius:8px;flex:0 0 auto;"/>' +
      '<div style="line-height:1.3;"><b>TimeSave Social als App</b><div style="opacity:.82;font-size:12px;">Vollbild &amp; App-Icon auf dem Startbildschirm</div></div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;flex:0 0 auto;">' +
      '<button type="button" id="tsPwaInstallBtn" style="padding:7px 11px;font-size:12px;background:#7a52d4;color:#fff;border-radius:9px;">Installieren</button>' +
      '<button type="button" id="tsPwaCloseBtn" aria-label="Schließen" style="padding:7px 9px;font-size:12px;background:rgba(255,255,255,.14);color:#fff;border-radius:9px;">✕</button>' +
      '</div>';

    document.body.appendChild(bar);

    document.getElementById('tsPwaInstallBtn')?.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => {});
      deferredPrompt = null;
      bar.remove();
    });

    document.getElementById('tsPwaCloseBtn')?.addEventListener('click', () => {
      sessionStorage.setItem('ts_pwa_dismissed', '1');
      bar.remove();
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBanner();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    document.getElementById('tsPwaBanner')?.remove();
  });
})();
