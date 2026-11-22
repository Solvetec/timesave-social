/* TimeSave Social V17.23 · Storage Diagnostics, Backup/Restore & Drafts */
'use strict';
let v1723ActiveDraftId = '';

async function v1723LoadStorage() {
  if (!auth) return;
  try {
    const st = await api('/api/storage/status');
    if ($('v1723StorageStatus')) $('v1723StorageStatus').textContent = st.message || '';
    if ($('v1723StorageNumbers')) {
      $('v1723StorageNumbers').innerHTML =
        `<span class="pill ${st.persisted ? 'green' : 'amber'}">${st.persisted ? 'Dauerhafter Speicher' : 'Flüchtig (Render Free)'}</span>` +
        `<span class="pill">Medien: ${st.media_present} / ${st.media_count} (${v176FmtSize(st.media_bytes)})</span>` +
        `<span class="pill">Entwürfe: ${st.draft_count}</span>` +
        `<span class="pill">Aufträge: ${st.job_count}</span>` +
        (st.missing_count ? `<span class="pill red">Fehlende Dateien: ${st.missing_count}</span>` : '');
    }
  } catch (e) {
    if ($('v1723StorageStatus')) $('v1723StorageStatus').textContent = '⚠ ' + e.message;
  }
}

let v1723BackupBusy = false;

async function v1723Backup() {
  if (v1723BackupBusy) return;
  const btn = document.querySelector('button[onclick="v1723Backup()"]');
  const statusEl = $('v1723StorageStatus');
  const prevLabel = btn ? btn.textContent : '';
  v1723BackupBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Backup wird erstellt …'; }
  if (statusEl) statusEl.textContent = '⏳ Erstelle vollständiges Backup-Archiv (Datenbank, Schlüssel & Medien) …';
  try {
    toast('Erstelle vollständiges Backup …');
    const resp = await fetch('/api/storage/backup', { headers: { 'X-Admin-Token': auth } });
    if (!resp.ok) {
      let msg = 'Backup fehlgeschlagen (HTTP ' + resp.status + ').';
      try { const b = await resp.json(); if (b.detail) msg = b.detail; } catch {}
      throw new Error(msg);
    }
    const missingCount = Number(resp.headers.get('x-backup-missing-count') || 0);
    const blob = await resp.blob();
    const disp = resp.headers.get('content-disposition') || '';
    const match = disp.match(/filename="?([^";]+)"?/i);
    const filename = match ? match[1] : 'TimeSave_Social_Backup.zip';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    const note = missingCount > 0
      ? '✓ Backup geladen: ' + filename + ' (' + missingCount + ' ältere fehlende Datei(en) wurden übersprungen – siehe BACKUP_HINWEIS.txt).'
      : '✓ Vollständiges Backup heruntergeladen: ' + filename;
    if (statusEl) statusEl.textContent = note;
    toast(note);
  } catch (e) {
    if (statusEl) statusEl.textContent = '⚠ ' + e.message;
    toast(e.message, true);
  } finally {
    v1723BackupBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = prevLabel || '⬇ Komplettes Backup herunterladen'; }
  }
}

async function v1723ImportBackup() {
  const file = $('v1723ImportFile')?.files?.[0];
  if (!file) { toast('Bitte zuerst eine Backup-ZIP-Datei auswählen.', true); return; }
  if (!confirm('Backup jetzt in diese leere Cloud-Installation importieren? Die Automatik bleibt danach aus Sicherheitsgründen pausiert.')) return;
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api('/api/cloud/migrate', { method: 'POST', body: fd });
    if ($('v1723ImportFile')) $('v1723ImportFile').value = '';
    await refresh();
    await v1723LoadStorage();
    toast(res.message || 'Backup wiederhergestellt.');
  } catch (e) {
    toast(e.message, true);
  }
}

function v1723CollectDraftPayload() {
  const mode = document.querySelector('input[name="v17SendMode"]:checked')?.value || 'schedule';
  const validMedia = id => (id && media.some(m => m.id === id)) ? id : '';
  return {
    caption: $('v17Caption')?.value || '',
    due_at: $('v17Due')?.value || '',
    send_now: mode === 'now',
    default_image: validMedia(v17State.defaultImage),
    default_video: validMedia(v17State.defaultVideo),
    tiktok_privacy: $('v17TikTokPrivacy')?.value || 'SELF_ONLY',
    youtube_privacy: $('v17YoutubePrivacy')?.value || 'private',
    tiktok_aigc: !!$('v17TikTokAigc')?.checked,
    targets: v17State.targets.map(t => ({
      provider: t.provider,
      format: t.format,
      kind: t.kind,
      connectionId: t.connectionId || '',
      mediaId: validMedia(t.mediaId),
      mediaIds: (t.mediaIds || []).filter(id => media.some(m => m.id === id)),
      coverIndex: Number(t.coverIndex || 0),
      tiktokTitle: t.tiktokTitle || '',
      autoMusic: !!t.autoMusic,
      brandOrganic: !!t.brandOrganic,
      brandContent: !!t.brandContent,
      disableComment: !!t.disableComment,
      captionOverride: t.captionOverride ?? null,
      manual: !!t.manual,
    })),
  };
}

async function v1723SaveDraft(asNew = false) {
  const titleInput = $('v1723DraftTitle');
  const title = (titleInput?.value || '').trim() || ('Entwurf ' + new Date().toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
  const payload = v1723CollectDraftPayload();
  try {
    const isUpdate = !asNew && !!v1723ActiveDraftId;
    const res = isUpdate
      ? await json('/api/drafts/' + encodeURIComponent(v1723ActiveDraftId), { title, payload }, 'PUT')
      : await json('/api/drafts', { title, payload }, 'POST');
    v1723ActiveDraftId = res.id;
    if (titleInput) titleInput.value = res.title;
    if ($('v1723DraftSaved')) $('v1723DraftSaved').textContent = '✓ Entwurf „' + res.title + '“ gespeichert (' + new Date(res.updated_at).toLocaleTimeString('de-DE') + ').';
    toast('Entwurf gespeichert.');
    v1723LoadDrafts();
  } catch (e) {
    toast(e.message, true);
  }
}

async function v1723LoadDrafts() {
  if (!auth) return;
  const list = $('v1723DraftList');
  if (!list) return;
  try {
    const items = await api('/api/drafts');
    list.innerHTML = items.map(d =>
      `<div class="v1723-draft-card"><div><strong>${esc(d.title)}</strong><small>Aktualisiert: ${new Date(d.updated_at).toLocaleString('de-DE')} · ${d.media_count} Mediendatei(en)</small></div>` +
      `<div class="row"><button type="button" class="tiny" data-draft-open="${esc(d.id)}">✎ Öffnen</button>` +
      `<button type="button" class="danger tiny" data-draft-del="${esc(d.id)}">Löschen</button></div></div>`
    ).join('') || '<p class="v17-empty">Noch keine Entwürfe gespeichert.</p>';
    list.querySelectorAll('[data-draft-open]').forEach(b => b.addEventListener('click', () => v1723OpenDraft(b.dataset.draftOpen)));
    list.querySelectorAll('[data-draft-del]').forEach(b => b.addEventListener('click', () => v1723DeleteDraft(b.dataset.draftDel)));
  } catch (e) {
    list.innerHTML = '<p class="hint">⚠ ' + esc(e.message) + '</p>';
  }
}

async function v1723OpenDraft(id) {
  try {
    const draft = await api('/api/drafts/' + encodeURIComponent(id));
    const p = draft.payload || {};
    v1723ActiveDraftId = draft.id;
    if ($('v1723DraftTitle')) $('v1723DraftTitle').value = draft.title || '';
    if ($('v17Caption')) $('v17Caption').value = p.caption || '';
    if ($('v17Due') && p.due_at) $('v17Due').value = p.due_at;
    const radio = document.querySelector('input[name="v17SendMode"][value="' + (p.send_now ? 'now' : 'schedule') + '"]');
    if (radio) radio.checked = true;
    v17ToggleSchedule();
    if (p.default_image) v17State.defaultImage = p.default_image;
    if (p.default_video) v17State.defaultVideo = p.default_video;
    if ($('v17YoutubePrivacy') && p.youtube_privacy) $('v17YoutubePrivacy').value = p.youtube_privacy;
    if ($('v17TikTokAigc')) $('v17TikTokAigc').checked = !!p.tiktok_aigc;
    if ($('v17TikTokConsent')) $('v17TikTokConsent').checked = false;
    v17State.targets = Array.isArray(p.targets) ? p.targets.map(t => ({ ...t })) : [];
    if ($('v1723DraftSaved')) $('v1723DraftSaved').textContent = '✎ Entwurf „' + draft.title + '“ geladen.';
    nav('publish');
    toast('Entwurf geladen.');
  } catch (e) {
    toast(e.message, true);
  }
}

async function v1723DeleteDraft(id) {
  if (!confirm('Diesen Entwurf löschen? Die Mediendateien bleiben in der Mediathek erhalten.')) return;
  try {
    await api('/api/drafts/' + encodeURIComponent(id), { method: 'DELETE' });
    if (v1723ActiveDraftId === id) v1723ActiveDraftId = '';
    v1723LoadDrafts();
    toast('Entwurf gelöscht.');
  } catch (e) {
    toast(e.message, true);
  }
}

function v1723New() {
  v1723ActiveDraftId = '';
  if ($('v1723DraftTitle')) $('v1723DraftTitle').value = '';
  if ($('v17Caption')) $('v17Caption').value = '';
  if ($('v17Due')) $('v17Due').value = v17DefaultDueValue();
  v17State.targets = [];
  if ($('v1723DraftSaved')) $('v1723DraftSaved').textContent = 'Neuer leerer Entwurf gestartet.';
  nav('publish');
}
