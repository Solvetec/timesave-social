/* TimeSave Social V20.4 – Mobile Schnell-Leiste & aktuelle Handy-Menüführung */
(function () {
  'use strict';

  const DOCK_ITEMS = [
    { id: 'dashboard', pane: 'dashboard', ico: '⌂', label: 'Start' },
    { id: 'mediaHub',  pane: 'mediaHub',  ico: '📸', label: 'Kamera', action: 'cam' },
    { id: 'publish',   pane: 'publish',   ico: '✦', label: 'Posten', cta: true },
    { id: 'storykit',  pane: 'storykit',  ico: '◷', label: 'Storys' },
    { id: 'queue',     pane: 'queue',     ico: '▤', label: 'Planung' },
  ];

  function syncDockActive(paneId) {
    const mapped = ['studio', 'videoStudio', 'v17Montage'].includes(paneId) ? 'mediaHub' : paneId;
    document.querySelectorAll('.v204-dock-btn').forEach((btn) => {
      const target = btn.dataset.dockPane;
      btn.classList.toggle('is-active', target === mapped && !btn.classList.contains('v204-dock-cta'));
    });
  }

  function enhanceMobileDashboard() {
    const dash = document.getElementById('dashboard');
    if (!dash || document.getElementById('v204MobileQuickCard')) return;
    const hero = dash.querySelector('.v17-dash-hero');
    if (!hero) return;

    const card = document.createElement('div');
    card.id = 'v204MobileQuickCard';
    card.className = 'v17-surface';
    card.style.marginBottom = '14px';
    card.innerHTML =
      '<div class="v17-flex" style="margin-bottom:8px;"><div><span class="v17-kicker">HANDY-DIREKTSTART</span><h3 style="margin:2px 0 0;">Sofort aufnehmen &amp; posten</h3></div></div>' +
      '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;">' +
      '<button type="button" id="v204MobPhotoBtn">📸 Foto aufnehmen</button>' +
      '<button type="button" class="outline" id="v204MobVideoBtn">🎬 Video aufnehmen</button>' +
      '<button type="button" class="outline" onclick="nav(\'publish\')">✦ Direkt posten</button>' +
      '<button type="button" class="outline" onclick="nav(\'accounts\')">↗ Konten prüfen</button>' +
      '</div>';

    hero.insertAdjacentElement('afterend', card);
    document.getElementById('v204MobPhotoBtn')?.addEventListener('click', () => {
      if (typeof window.v197OpenCamera === 'function') window.v197OpenCamera('photo');
      else if (typeof nav === 'function') nav('mediaHub');
    });
    document.getElementById('v204MobVideoBtn')?.addEventListener('click', () => {
      if (typeof window.v197OpenCamera === 'function') window.v197OpenCamera('video');
      else if (typeof nav === 'function') nav('mediaHub');
    });
  }

  function mountDock() {
    if (!document.getElementById('v204MobileDock')) {
      const dock = document.createElement('nav');
      dock.id = 'v204MobileDock';
      dock.className = 'v204-mobile-dock';
      dock.setAttribute('aria-label', 'Handy Schnellnavigation');

      DOCK_ITEMS.forEach((item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'v204-dock-btn' + (item.cta ? ' v204-dock-cta' : '');
        btn.dataset.dockPane = item.pane;
        btn.innerHTML = '<span class="v204-dock-ico" aria-hidden="true">' + item.ico + '</span><span>' + item.label + '</span>';
        btn.addEventListener('click', () => {
          if (item.action === 'cam' && typeof window.v197OpenCamera === 'function') {
            window.v197OpenCamera('photo');
          } else if (typeof nav === 'function') {
            nav(item.pane);
          }
          syncDockActive(item.pane);
        });
        dock.appendChild(btn);
      });

      document.body.appendChild(dock);
    }

    enhanceMobileDashboard();

    if (typeof window.nav === 'function' && !window.nav.__v204Wrapped) {
      const origNav = window.nav;
      const wrappedNav = function (id) {
        const res = origNav.apply(this, arguments);
        syncDockActive(id);
        return res;
      };
      wrappedNav.__v204Wrapped = true;
      window.nav = wrappedNav;
    }

    const activeNav = document.querySelector('#v182Navigation .nav.active');
    syncDockActive((activeNav && activeNav.dataset.pane) || 'dashboard');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountDock);
  } else {
    mountDock();
  }
})();
