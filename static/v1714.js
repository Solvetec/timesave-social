/* TimeSave Social V17.14 + V17.18 · Render Cloud Runtime Status & Scheduler Toggle */
'use strict';
let v1714Runtime = null;

async function v1714CloudRefresh() {
  if (!auth) return;
  try {
    const rt = await api('/api/cloud/runtime');
    v1714Runtime = rt;
    const notice = $('v1714FreeNotice');
    if (notice) notice.hidden = !rt.free_preview;
    const pill = $('appStatus');
    if (pill) {
      if (!rt.cloud_mode) {
        pill.className = 'pill green';
        pill.textContent = '● Lokal aktiv';
      } else if (rt.free_preview) {
        pill.className = rt.publishing_enabled ? 'pill green' : 'pill amber';
        pill.textContent = rt.publishing_enabled ? '● Render Free · Test' : '⏸ Render Free · Pausiert';
      } else {
        pill.className = rt.publishing_enabled ? 'pill green' : 'pill amber';
        pill.textContent = rt.publishing_enabled ? '● Cloud · Aktiv' : '⏸ Cloud · Pausiert';
      }
    }
    const statusBox = $('v1714CloudStatus');
    if (statusBox) {
      statusBox.innerHTML = `<strong>Modus:</strong> ${rt.cloud_mode ? (rt.free_preview ? 'Render Free (flüchtig)' : 'Cloud mit dauerhaftem Speicher') : 'Lokaler Betrieb'}<br>` +
        `<strong>Scheduler / Automatik:</strong> ${rt.publishing_enabled ? '✅ Aktiv' : '⏸ Pausiert'}<br>` +
        `<strong>Öffentliche URL:</strong> <code>${esc(rt.url || 'nicht gesetzt')}</code><br>` +
        `<strong>Bestand:</strong> ${rt.counts?.media ?? 0} Medien · ${rt.counts?.connections ?? 0} Konten · ${rt.counts?.jobs ?? 0} Aufträge` +
        (rt.runtime_warning ? `<br><small>${esc(rt.runtime_warning)}</small>` : '');
    }
    const toggle = $('v1718PublishingToggle');
    if (toggle) {
      toggle.disabled = !rt.cloud_mode;
      toggle.textContent = !rt.cloud_mode
        ? 'Lokal immer aktiv'
        : rt.publishing_enabled ? '⏸ Automatik pausieren' : '▶ Automatik aktivieren';
    }
  } catch (e) {
    if ($('v1714CloudStatus')) $('v1714CloudStatus').textContent = '⚠ ' + e.message;
  }
}

async function v1718TogglePublishing() {
  if (!v1714Runtime) await v1714CloudRefresh();
  if (!v1714Runtime?.cloud_mode) return;
  const wantEnable = !v1714Runtime.publishing_enabled;
  let confirmation = '';
  if (wantEnable) {
    if (v1714Runtime.free_preview) {
      if (!confirm('Automatik auf Render Free aktivieren? Fällige Beiträge werden echt veröffentlicht, solange der Server wach ist.')) return;
      confirmation = 'TESTAUTOMATIK_BESTAETIGT';
    } else {
      if (!confirm('Cloud-Automatik aktivieren? Bitte sicherstellen, dass keine lokale Windows-Instanz parallel veröffentlicht.')) return;
      confirmation = 'LOKALE APP GESTOPPT';
    }
  }
  try {
    await json('/api/cloud/publishing', { enabled: wantEnable, confirmation });
    await v1714CloudRefresh();
    toast(wantEnable ? 'Automatik aktiviert.' : 'Automatik pausiert.');
  } catch (e) {
    toast(e.message, true);
  }
}

const v1714PrevRefresh = refresh;
refresh = async function() {
  const res = await v1714PrevRefresh();
  v1714CloudRefresh();
  return res;
};
