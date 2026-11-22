/* TimeSave Social V17.15 + V17.16 · Meta Unified Login Diagnostics & Temporary Save */
'use strict';

async function v1715RefreshSetup() {
  if (!auth) return;
  try {
    const info = await api('/api/instagram/unified/setup');
    if ($('v1715Callback')) $('v1715Callback').textContent = info.callback || 'Noch keine öffentliche HTTPS-URL erkannt.';
    if ($('v1715SettingsHint') && info.message) $('v1715SettingsHint').textContent = info.message;
    const sourceLabels = { render_env: 'Render ENV', local_database: 'lokal gespeichert', environment: 'Umgebung', render_url: 'Render HTTPS', missing: 'fehlt' };
    if ($('v1715Diagnostics')) {
      $('v1715Diagnostics').innerHTML = Object.entries(info.checks || {}).map(([name, c]) =>
        `<div>${c.configured ? '✅' : '❌'} <code>${esc(name)}</code> · <small>${esc(sourceLabels[c.source] || c.source)}</small></div>`
      ).join('');
    }
    if ($('v1715UnifiedStatus')) {
      $('v1715UnifiedStatus').textContent = info.configured
        ? '✅ Meta Unified Login ist vollständig konfiguriert und bereit.'
        : '❌ Noch unvollständig: Es fehlen ' + (info.missing || []).join(', ') + '.';
    }
  } catch (e) {
    if ($('v1715Diagnostics')) $('v1715Diagnostics').textContent = '⚠ ' + e.message;
  }
}

async function v1716SaveUnifiedTemporary() {
  const values = {};
  for (const id of ['meta_app_id', 'meta_app_secret', 'instagram_unified_config_id']) {
    const el = $(id);
    if (!el) continue;
    const val = el.value.trim();
    if (el.type === 'password') {
      if (val) values[id] = val;
    } else if (val && val !== (el.dataset.originalValue || '')) {
      values[id] = val;
    }
  }
  if (!Object.keys(values).length) {
    toast('Keine neuen Werte eingegeben. Bestehende Render-ENV-Werte bleiben aktiv.');
    return;
  }
  try {
    await json('/api/config', { values });
    await loadConfig();
    toast('Vorübergehend gespeichert. Auf Render Free für Dauerhaftigkeit in Render → Environment hinterlegen.');
  } catch (e) {
    toast(e.message, true);
  }
}

const v1715PrevRefresh = refresh;
refresh = async function() {
  const res = await v1715PrevRefresh();
  v1715RefreshSetup();
  return res;
};
