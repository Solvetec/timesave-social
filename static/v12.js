/* TimeSave Social V12 · Legacy composer gallery, preview and send-mode helpers */
'use strict';
let v12MediaKind = 'image';
let v12GalleryLimit = 18;
let v12PreviewUrls = [];

function v12SetMediaKind(kind) {
  v12MediaKind = kind === 'video' ? 'video' : 'image';
  v12GalleryLimit = 18;
  $('v12ImageTab')?.setAttribute('aria-selected', String(v12MediaKind === 'image'));
  $('v12VideoTab')?.setAttribute('aria-selected', String(v12MediaKind === 'video'));
  v12RenderGallery();
}

function v12FilteredMedia(kind, search, sort) {
  const q = (search || '').toLowerCase().trim();
  const list = media.filter(m => (kind === 'video' ? m.mime === 'video/mp4' : m.mime?.startsWith('image/')))
    .filter(m => !q || (m.original_name || '').toLowerCase().includes(q));
  if (sort === 'old') list.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  else if (sort === 'az') list.sort((a, b) => (a.original_name || '').localeCompare(b.original_name || '', 'de'));
  else if (sort === 'za') list.sort((a, b) => (b.original_name || '').localeCompare(a.original_name || '', 'de'));
  else list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return list;
}

function v12UpdatePickedLabels() {
  const img = media.find(m => m.id === v11SourceDefaults.image);
  const vid = media.find(m => m.id === v11SourceDefaults.video);
  const imgBox = $('v12ImagePicked')?.querySelector('strong');
  const vidBox = $('v12VideoPicked')?.querySelector('strong');
  if (imgBox) imgBox.textContent = img ? img.original_name : 'Noch keines ausgewählt';
  if (vidBox) vidBox.textContent = vid ? vid.original_name : 'Noch keines ausgewählt';
}

function v12RenderGallery() {
  const root = $('v12MediaGallery');
  if (!root) return;
  const imgCount = media.filter(m => m.mime?.startsWith('image/')).length;
  const vidCount = media.filter(m => m.mime === 'video/mp4').length;
  if ($('v12ImageCount')) $('v12ImageCount').textContent = String(imgCount);
  if ($('v12VideoCount')) $('v12VideoCount').textContent = String(vidCount);
  if ($('v12LibraryCounts')) $('v12LibraryCounts').textContent = imgCount + ' Bilder · ' + vidCount + ' Videos';
  const items = v12FilteredMedia(v12MediaKind, $('v12MediaSearch')?.value, $('v12MediaSort')?.value);
  const visible = items.slice(0, v12GalleryLimit);
  const activeId = v11SourceDefaults[v12MediaKind] || $('composerMedia')?.value || '';
  root.innerHTML = visible.map(m =>
    `<button type="button" class="v12-media-item ${m.id === activeId ? 'is-selected' : ''}" data-id="${esc(m.id)}">` +
    `<img data-v12-thumb="${esc(m.id)}" alt="Vorschau">` +
    `<span title="${esc(m.original_name)}">${esc(m.original_name)}</span></button>`
  ).join('') || '<p class="hint">Keine passenden Dateien in der Mediathek.</p>';
  root.querySelectorAll('.v12-media-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      chosen = id;
      $('composerMedia').value = id;
      showComposerPreview();
      v11SyncSourceMedia();
      v12UpdatePickedLabels();
      v12RenderGallery();
    });
  });
  root.querySelectorAll('[data-v12-thumb]').forEach(img => loadImageInto(img, img.dataset.v12Thumb));
  const moreBtn = $('v12ShowMore');
  if (moreBtn) moreBtn.hidden = items.length <= v12GalleryLimit;
  v12UpdatePickedLabels();
}

function v12ShowMore() {
  v12GalleryLimit += 18;
  v12RenderGallery();
}

async function v12UploadMedia() {
  const files = [
    ...Array.from($('v12ImageFiles')?.files || []),
    ...Array.from($('v12VideoFiles')?.files || []),
  ];
  if (!files.length) { toast('Bitte zuerst Bilder oder Videos auswählen.', true); return; }
  const btn = $('v10UploadButton'), notice = $('v10UploadStatus');
  if (btn) btn.disabled = true;
  if (notice) { notice.className = 'v10-upload-status v10-upload-busy'; notice.textContent = '⏳ Lade ' + files.length + ' Datei(en) hoch …'; }
  const ok = [], errs = [];
  try {
    for (const f of files) {
      try {
        const r = await v17TransmitMedia(f, msg => { if (notice) notice.textContent = '⏳ ' + f.name + ' · ' + msg; });
        ok.push({ id: r.id, name: f.name, kind: f.type === 'video/mp4' ? 'video' : 'image' });
      } catch (e) {
        errs.push(f.name + ': ' + e.message);
      }
    }
    if (ok.length) {
      await refresh();
      for (const item of ok) {
        v11SourceDefaults[item.kind] = item.id;
        for (const p of Object.keys(v10MediaFormats)) {
          if (v10State[p] && v10State[p].kind === item.kind) v10State[p].mediaId = item.id;
        }
      }
      const last = ok[ok.length - 1];
      chosen = last.id;
      $('composerMedia').value = last.id;
      showComposerPreview();
      renderTargetGroup('composerTargets', 'post');
      v12RenderGallery();
      if (notice) {
        notice.className = 'v10-upload-status v10-upload-ok';
        notice.textContent = '✓ ' + ok.length + ' Datei(en) gespeichert.' + (errs.length ? ' ⚠ ' + errs.join(' | ') : '');
      }
      toast(ok.length + ' Datei(en) hochgeladen.');
    } else if (errs.length) {
      if (notice) { notice.className = 'v10-upload-status v10-warning'; notice.textContent = '⚠ ' + errs.join(' | '); }
      toast(errs.join(' | '), true);
    }
    if ($('v12ImageFiles')) $('v12ImageFiles').value = '';
    if ($('v12VideoFiles')) $('v12VideoFiles').value = '';
    if ($('v12PickedFiles')) $('v12PickedFiles').textContent = 'Noch keine neuen Dateien ausgewählt.';
  } finally {
    if (btn) btn.disabled = false;
  }
}

function v12OpenEditor(kind) {
  if (kind === 'video') openVideoStudio(v11SourceDefaults.video || chosen || $('composerMedia').value);
  else openStudio(v11SourceDefaults.image || chosen || $('composerMedia').value);
}

function v12ToggleSendMode() {
  const isNow = !!$('v12ModeNow')?.checked;
  if ($('v12ScheduledTime')) $('v12ScheduledTime').hidden = isNow;
  if ($('v12NowHelp')) $('v12NowHelp').hidden = !isNow;
}

async function v12OpenPreview() {
  const dialog = $('v12PreviewDialog'), grid = $('v12PreviewContents');
  if (!dialog || !grid) return;
  v12PreviewUrls.forEach(u => URL.revokeObjectURL(u));
  v12PreviewUrls = [];
  const rows = Array.from($('composerTargets')?.querySelectorAll('.target') || []).filter(r => r.querySelector('.want')?.checked);
  if (!rows.length) { toast('Bitte zuerst mindestens eine Plattform auswählen.', true); return; }
  grid.replaceChildren();
  const cap = $('postCaption')?.value.trim() || '';
  for (const row of rows) {
    const p = row.dataset.provider, st = v10State[p] || {};
    const m = media.find(x => x.id === st.mediaId);
    const card = document.createElement('div'); card.className = 'v12-preview-card';
    const title = document.createElement('strong'); title.textContent = (icon[p] || '') + ' ' + (v10Labels[p] || p) + ' · ' + (fmtNames[st.format] || st.format || '');
    card.appendChild(title);
    if (m) {
      if (m.mime === 'video/mp4') {
        const vid = document.createElement('video'); vid.controls = true; vid.muted = true; vid.playsInline = true;
        card.appendChild(vid);
        fetch('/api/media/' + encodeURIComponent(m.id), { headers: { 'X-Admin-Token': auth } })
          .then(r => r.ok ? r.blob() : null).then(b => { if (b) { const u = URL.createObjectURL(b); v12PreviewUrls.push(u); vid.src = u; } }).catch(() => {});
      } else {
        const img = document.createElement('img'); img.alt = m.original_name;
        card.appendChild(img);
        loadImageInto(img, m.id);
      }
    }
    if (cap) { const txt = document.createElement('small'); txt.textContent = cap.slice(0, 180); card.appendChild(txt); }
    grid.appendChild(card);
  }
  dialog.showModal();
}

function v12ClosePreview() {
  if ($('v12PreviewDialog')?.open) $('v12PreviewDialog').close();
  v12PreviewUrls.forEach(u => URL.revokeObjectURL(u));
  v12PreviewUrls = [];
}

['v12ImageFiles', 'v12VideoFiles'].forEach(id => {
  $(id)?.addEventListener('change', () => {
    const count = ($('v12ImageFiles')?.files?.length || 0) + ($('v12VideoFiles')?.files?.length || 0);
    if ($('v12PickedFiles')) $('v12PickedFiles').textContent = count ? count + ' Datei(en) zum Hochladen ausgewählt.' : 'Noch keine neuen Dateien ausgewählt.';
  });
});

const v12PrevRefresh = refresh;
refresh = async function() {
  const res = await v12PrevRefresh();
  v12RenderGallery();
  return res;
};
