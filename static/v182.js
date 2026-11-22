/* TimeSave Social V18.2 — mobile workspace navigation and compact status. */
'use strict';
(() => {
  const mediaQuery = window.matchMedia('(max-width: 860px)');
  const sidebar = document.querySelector('#appShell .sidebar');
  const navigation = $('v182Navigation');
  const toggle = $('v182MenuToggle');
  const backdrop = $('v182MenuBackdrop');
  if (!sidebar || !navigation || !toggle || !backdrop) return;
  const setOpen = (open, restoreFocus = false) => {
    open = Boolean(open && mediaQuery.matches);
    sidebar.classList.toggle('v182-menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.innerHTML = open ? '<span aria-hidden="true">✕</span> Menü' : '<span aria-hidden="true">☰</span> Menü';
    backdrop.hidden = !open;
    if (restoreFocus && mediaQuery.matches) toggle.focus();
  };
  toggle.addEventListener('click', () => setOpen(!sidebar.classList.contains('v182-menu-open')));
  backdrop.addEventListener('click', () => setOpen(false, true));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && sidebar.classList.contains('v182-menu-open')) setOpen(false, true);
  });
  mediaQuery.addEventListener('change', () => setOpen(false));
  let mobileAccountsVisited = false;
  const previousNav = nav;
  nav = function(id) {
    const wasOpen = sidebar.classList.contains('v182-menu-open');
    const result = previousNav(id);
    if (id === 'accounts' && mediaQuery.matches && !mobileAccountsVisited) {
      mobileAccountsVisited = true;
      if (typeof v1725AccountTab === 'function') v1725AccountTab('overview');
    }
    setOpen(false);
    const activeId = ['studio','videoStudio','v17Montage'].includes(id) ? 'studio' : id;
    navigation.querySelectorAll('.nav').forEach(b => {
      if (b.dataset.pane === activeId) b.setAttribute('aria-current','page');
      else b.removeAttribute('aria-current');
    });
    if (wasOpen) $('pageTitle')?.focus({preventScroll:true});
    return result;
  };
  for (const [buttonId, containerId] of [['v182NoticeToggle','v1714FreeNotice'], ['v182PublishNoticeToggle',null]]) {
    const warningToggle = $(buttonId);
    warningToggle?.addEventListener('click', () => {
      const container = containerId ? $(containerId) : warningToggle.parentElement;
      const open = container.classList.toggle('v182-notice-open');
      warningToggle.setAttribute('aria-expanded', String(open));
    });
  }
  const previousLogout = v1725Logout;
  v1725Logout = function() { setOpen(false); return previousLogout(); };
  setOpen(false);
})();

function v182OpenTelegramManual() {
  if (typeof v1725AccountTab === 'function') v1725AccountTab('telegram');
  const input = $('telegramToken');
  const details = input?.closest('details');
  if (details) details.open = true;
  input?.focus({preventScroll:true});
  input?.scrollIntoView({behavior:'smooth',block:'center'});
}
