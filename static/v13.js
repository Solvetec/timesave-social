/* TimeSave Social V13 · WhatsApp manual reminders & display phone preferences */
'use strict';

async function v13LoadWaPrefs() {
  if (!auth) return;
  try {
    const prefs = await api('/api/whatsapp/preferences');
    if ($('v13WaPhone') && prefs.phone !== undefined) $('v13WaPhone').value = prefs.phone || '';
  } catch {}
}

async function v13SaveWaPrefs() {
  try {
    const res = await json('/api/whatsapp/preferences', { phone: $('v13WaPhone')?.value || '' });
    if ($('v13WaPhone')) $('v13WaPhone').value = res.phone || '';
    toast(res.message || 'Nummer gespeichert.');
  } catch (e) {
    toast(e.message, true);
  }
}

function v13RenderWaQueue() {
  const waJobs = jobs.filter(j => ['whatsapp', 'whatsapp_channel'].includes(j.platform));
  const open = waJobs.filter(j => ['scheduled', 'manual'].includes(j.status));
  if ($('v13WaBadge')) $('v13WaBadge').textContent = open.length + ' offen';
  const list = $('v13WaRows');
  if (!list) return;
  if (!waJobs.length) {
    list.innerHTML = '<p class="hint">Keine offenen WhatsApp-Erinnerungen.</p>';
    return;
  }
  list.innerHTML = waJobs.slice(0, 30).map(j => {
    const done = j.status === 'published_manual';
    return `<div class="v13-wa-row"><div><strong>${esc(j.original_name)}</strong><br><small>${new Date(j.due_at).toLocaleString('de-DE')} · ${esc(j.platform === 'whatsapp' ? 'WhatsApp-Status' : 'WhatsApp-Kanal')}</small></div>` +
      `<div class="row"><button type="button" class="outline tiny" onclick="downloadMedia('${esc(j.media_id)}')">⬇ Datei</button>` +
      (done ? '<span class="pill green">Erledigt ✓</span>' : `<button type="button" class="tiny" onclick="jobAction('${esc(j.id)}','mark-published')">Als erledigt abhaken ✓</button>`) +
      `</div></div>`;
  }).join('');
}

$('v13WaSave')?.addEventListener('click', v13SaveWaPrefs);

const v13PrevRefresh = refresh;
refresh = async function() {
  const res = await v13PrevRefresh();
  v13RenderWaQueue();
  v13LoadWaPrefs();
  return res;
};
