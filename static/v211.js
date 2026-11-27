/* TimeSave Social V21.1 · Setup course and honest subscription preview */
(function () {
  'use strict';
  const $o = (id) => document.getElementById(id);
  const dialog = () => $o('v211WelcomeDialog');
  let cachedStatus = null;
  let requestSeq = 0;
  let dismissedInSession = false;

  function stopVideo() {
    const v = $o('v211Video');
    if (v) v.pause();
  }
  function closeGuide() {
    stopVideo();
    const d = dialog();
    if (!d) return;
    if (d.open) d.close();
  }
  function renderGuide(status) {
    cachedStatus = status;
    const url = status.video_url;
    const video = $o('v211Video');
    const placeholder = $o('v211VideoPlaceholder');
    const download = $o('v211Download');
    const downloadWrap = $o('v211DownloadWrap');
    if (video && placeholder && download && downloadWrap) {
      // A URL supplied by this endpoint is a server-controlled, same-origin asset.
      video.hidden = !url;
      placeholder.hidden = !!url;
      if (url && video.getAttribute('src') !== url) video.setAttribute('src', url);
      if (!url) video.removeAttribute('src');
      downloadWrap.hidden = !url;
      if (url) download.href = url;
      else download.removeAttribute('href');
    }
    const badge = $o('v211GuideStatus');
    if (badge) badge.textContent = status.completed ? '✓ Eingerichtet' : '◷ Noch offen';
  }
  async function fetchGuide() {
    const status = await api('/api/onboarding/status');
    renderGuide(status);
    return status;
  }
  function showGuide() {
    const d = dialog();
    if (!d || d.open || !$o('appShell') || $o('appShell').hidden) return;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open','');
  }
  async function afterLogin() {
    const thisReq = ++requestSeq;
    const signedInToken = auth;
    if (!signedInToken || $o('appShell')?.hidden) return;
    try {
      const status = await fetchGuide();
      if (requestSeq !== thisReq || signedInToken !== auth || $o('appShell')?.hidden) return;
      if (!status.completed && !dismissedInSession) showGuide();
    } catch (e) {
      // Do not block login or publishing when tutorial data is unavailable.
      console.warn('Einrichtungsstatus nicht verfügbar:', e);
    }
    try { await loadBilling(); } catch {}
  }
  async function loadBilling() {
    if (!auth) return;
    const root = $o('v211Plans');
    if (!root) return;
    const data = await api('/api/billing/overview');
    root.replaceChildren();
    for (const plan of (data.draft_plans || [])) {
      const box = document.createElement('div');
      box.className = 'v211-plan';
      const name = document.createElement('strong');
      name.textContent = plan.name;
      const price = document.createElement('b');
      price.textContent = new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(plan.monthly_eur);
      const unit = document.createElement('small');
      unit.textContent = ' / Monat (Idee)';
      const p = document.createElement('p');
      p.textContent = plan.description;
      box.append(name,price,unit,p);
      root.appendChild(box);
    }
  }
  window.v211OpenOnboarding = async function () {
    if (!auth) return;
    try { await fetchGuide(); } catch (e) { toast('Anleitung kann gerade nicht geladen werden: ' + e.message,true); return; }
    showGuide();
  };
  window.v211ResetOnboarding = async function () {
    if (!auth) return;
    try {
      await json('/api/onboarding/status', { completed: false }, 'PUT');
      dismissedInSession = false;
      await fetchGuide();
      showGuide();
      toast('Begrüßung für dein Konto wieder aktiviert.');
    } catch (e) { toast(e.message,true); }
  };
  function postpone() {
    dismissedInSession = true;
    closeGuide();
  }
  async function finish() {
    const error = $o('v211Error');
    const btn = $o('v211Complete');
    if (error) error.hidden = true;
    if (btn) btn.disabled = true;
    try {
      await json('/api/onboarding/status', { completed: true }, 'PUT');
      dismissedInSession = true;
      renderGuide({ ...(cachedStatus || {}), completed: true });
      closeGuide();
      toast('Dein Schnellstart ist abgeschlossen. Du findest die Anleitung jederzeit in Einstellungen.');
    } catch (e) {
      if (error) { error.textContent = 'Speichern fehlgeschlagen: ' + e.message; error.hidden = false; }
    } finally { if (btn) btn.disabled = false; }
  }
  function init() {
    $o('v211Close')?.addEventListener('click', postpone);
    $o('v211Later')?.addEventListener('click', postpone);
    $o('v211Complete')?.addEventListener('click', finish);
    dialog()?.addEventListener('cancel', (e) => { e.preventDefault(); postpone(); });
    dialog()?.addEventListener('close', stopVideo);
    dialog()?.querySelectorAll('[data-v211-go]').forEach(btn => {
      btn.addEventListener('click', () => { closeGuide(); nav(btn.dataset.v211Go); });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // All three authentication paths are supported: email, admin-key and tab resume.
  const oldFinish = window.v18FinishSession;
  if (typeof oldFinish === 'function') {
    window.v18FinishSession = async function (...args) {
      const result = await oldFinish.apply(this, args);
      await afterLogin();
      return result;
    };
  }
  const oldLogin = window.login;
  if (typeof oldLogin === 'function') {
    window.login = async function (...args) {
      const result = await oldLogin.apply(this, args);
      if (auth && !$o('appShell')?.hidden) await afterLogin();
      return result;
    };
  }
  const oldLogout = window.v1725Logout;
  if (typeof oldLogout === 'function') {
    window.v1725Logout = async function (...args) {
      requestSeq++;
      dismissedInSession = false;
      closeGuide();
      return oldLogout.apply(this, args);
    };
  }
})();
