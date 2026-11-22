/* TimeSave Social V17 · Primary Publisher, MediaHub, Multi-Photo Montage & Weekly Calendar */
'use strict';

function v176FmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function v17TransmitMedia(file, onProgress, optimizeVideo = true) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/media', true);
    xhr.setRequestHeader('X-Admin-Token', auth);
    xhr.upload.onprogress = ev => {
      if (!ev.lengthComputable) return;
      const pct = Math.min(99, Math.round((ev.loaded / ev.total) * 100));
      const bar = $('v176Progress');
      if (bar) { bar.hidden = false; bar.value = pct; }
      if (onProgress) onProgress(pct < 99 ? pct + ' % übertragen …' : 'Wird auf dem Server geprüft / optimiert …');
    };
    xhr.onload = () => {
      const bar = $('v176Progress');
      if (bar) { bar.value = 100; setTimeout(() => { bar.hidden = true; bar.value = 0; }, 1200); }
      let body = {};
      try { body = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(typeof body.detail === 'string' ? body.detail : 'Upload fehlgeschlagen (HTTP ' + xhr.status + ')'));
    };
    xhr.onerror = () => {
      const bar = $('v176Progress');
      if (bar) bar.hidden = true;
      reject(new Error('Netzwerkfehler beim Hochladen.'));
    };
    const fd = new FormData();
    fd.append('file', file);
    fd.append('optimize_video', optimizeVideo ? 'true' : 'false');
    xhr.send(fd);
  });
}

const v17State = window.v17State = {
  kind: 'image',
  hubKind: 'image',
  filter: 'all',
  defaultImage: '',
  defaultVideo: '',
  targets: [],
  weekOffset: 0,
  montageScenes: [],
  tiktokLoadedAccount: '',
  pendingReview: null,
  busy: false,
  lastOptimizedVideoId: '',
};

const v17ProviderDefs = [
  { provider: 'instagram', name: 'Instagram', icon: '📸', formats: [
    { format: 'story', kind: 'image', label: '◌ Foto-Story', group: 'story' },
    { format: 'post', kind: 'image', label: '▧ Foto-Beitrag', group: 'post' },
    { format: 'reel', kind: 'video', label: '▶ Video-Reel', group: 'video' },
    { format: 'story', kind: 'video', label: '▶ Video-Story', group: 'story' },
  ]},
  { provider: 'facebook', name: 'Facebook-Seite', icon: '🔵', formats: [
    { format: 'story', kind: 'image', label: '◌ Foto-Story', group: 'story' },
    { format: 'post', kind: 'image', label: '▧ Foto-Beitrag', group: 'post' },
    { format: 'reel', kind: 'video', label: '▶ Video-Reel', group: 'video' },
    { format: 'post', kind: 'video', label: '▶ Feed-Video', group: 'video' },
    { format: 'story', kind: 'video', label: '▶ Video-Story', group: 'story' },
  ]},
  { provider: 'telegram', name: 'Telegram-Kanal', icon: '✈️', formats: [
    { format: 'post', kind: 'image', label: '▧ Bild-Beitrag', group: 'post' },
    { format: 'post', kind: 'video', label: '▶ Video-Beitrag', group: 'video' },
  ]},
  { provider: 'telegram_story', name: 'Telegram-Profil-Story', icon: '🌟', formats: [
    { format: 'story', kind: 'image', label: '◌ Bild-Story', group: 'story' },
    { format: 'story', kind: 'video', label: '▶ Video-Story', group: 'story' },
  ]},
  { provider: 'youtube', name: 'YouTube', icon: '▶️', formats: [
    { format: 'video', kind: 'video', label: '▶ Video / Short (MP4)', group: 'video' },
  ]},
  { provider: 'tiktok', name: 'TikTok', icon: '🎵', formats: [
    { format: 'video', kind: 'video', label: '▶ Video (MP4 / Entwurf)', group: 'video' },
    { format: 'post', kind: 'image', label: '▧ Foto / Karussell (1–35 JPG)', group: 'post' },
  ]},
];

function v17DefaultDueValue() {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  d.setHours(9, 0, 0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function v17Creative(mode) {
  const pane = mode === 'video' ? 'videoStudio' : mode === 'montage' ? 'v17Montage' : 'studio';
  nav(pane);
  document.querySelectorAll('.v17-creative-nav button').forEach(b => {
    const active = b.dataset.creative === mode;
    b.classList.toggle('selected', active);
    b.classList.toggle('active', active);
  });
  document.querySelectorAll('.nav[data-creative-nav="1"]').forEach(b => b.classList.add('active'));
  if (mode === 'montage') {
    $('pageTitle').textContent = 'Kreativstudio · Bilder → Video';
    v17MontagePictures();
    v17RenderMontageTimeline();
  }
}

function v17SetKind(kind) {
  v17State.kind = kind === 'video' ? 'video' : 'image';
  $('v17KindImage')?.classList.toggle('selected', v17State.kind === 'image');
  $('v17KindVideo')?.classList.toggle('selected', v17State.kind === 'video');
  v17RenderAssets();
}

function v17HubKind(kind) {
  v17State.hubKind = kind === 'video' ? 'video' : 'image';
  $('v17HubImg')?.classList.toggle('selected', v17State.hubKind === 'image');
  $('v17HubVid')?.classList.toggle('selected', v17State.hubKind === 'video');
  v17RenderHub();
}

function v17SortMedia(kind, search, sort) {
  const q = (search || '').toLowerCase().trim();
  const list = media.filter(m => (kind === 'video' ? m.mime === 'video/mp4' : m.mime?.startsWith('image/')))
    .filter(m => !q || (m.original_name || '').toLowerCase().includes(q));
  if (sort === 'old') list.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  else if (sort === 'az') list.sort((a, b) => (a.original_name || '').localeCompare(b.original_name || '', 'de'));
  else if (sort === 'za') list.sort((a, b) => (b.original_name || '').localeCompare(a.original_name || '', 'de'));
  else list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return list;
}

function v17UpdateDefaultsUI() {
  const img = media.find(m => m.id === v17State.defaultImage);
  const vid = media.find(m => m.id === v17State.defaultVideo);
  if ($('v17DefaultImage')) $('v17DefaultImage').textContent = img ? img.original_name : 'Noch kein Bild';
  if ($('v17DefaultVideo')) $('v17DefaultVideo').textContent = vid ? vid.original_name : 'Noch kein Video';
}

function v17SelectDefault(id) {
  const item = media.find(m => m.id === id);
  if (!item) return;
  const kind = item.mime === 'video/mp4' ? 'video' : 'image';
  if (kind === 'video') v17State.defaultVideo = id;
  else v17State.defaultImage = id;
  chosen = id;
  for (const t of v17State.targets) {
    if (t.kind === kind && !t.mediaId) t.mediaId = id;
  }
  v17UpdateDefaultsUI();
  v17RenderAssets();
  v17RenderSelectedTargets();
}

function v17RenderAssets() {
  const root = $('v17Assets');
  if (!root) return;
  const items = v17SortMedia(v17State.kind, $('v17MediaSearch')?.value, $('v17MediaSort')?.value);
  const activeId = v17State.kind === 'video' ? v17State.defaultVideo : v17State.defaultImage;
  root.innerHTML = items.map(m => {
    const sel = m.id === activeId;
    return `<div class="v17-asset-card ${sel ? 'selected' : ''}" data-id="${esc(m.id)}">` +
      `<div class="v17-asset-thumb"><img data-v17-thumb="${esc(m.id)}" alt="Vorschau">` +
      `<span class="v17-asset-badge">${m.mime === 'video/mp4' ? 'MP4' : 'BILD'}${m.missing ? ' · fehlt' : ''}</span></div>` +
      `<div class="v17-asset-name" title="${esc(m.original_name)}">${esc(m.original_name)}</div>` +
      `<div class="v17-asset-meta">${v176FmtSize(m.bytes)}</div></div>`;
  }).join('') || '<p class="v17-empty">Noch keine ' + (v17State.kind === 'video' ? 'Videos' : 'Bilder') + ' vorhanden.</p>';
  root.querySelectorAll('.v17-asset-card').forEach(el => {
    el.addEventListener('click', () => v17SelectDefault(el.dataset.id));
  });
  root.querySelectorAll('[data-v17-thumb]').forEach(img => loadImageInto(img, img.dataset.v17Thumb));
  v17UpdateDefaultsUI();
}

async function v17UploadFiles() {
  const files = [
    ...Array.from($('v17ImageFiles')?.files || []),
    ...Array.from($('v17VideoFiles')?.files || []),
  ];
  if (!files.length) { toast('Bitte zuerst Bilder oder Videos auswählen.', true); return; }
  const btn = $('v17Upload'), status = $('v17FileStatus');
  if (btn) btn.disabled = true;
  if (status) status.textContent = '⏳ Übertrage ' + files.length + ' Datei(en) …';
  const uploaded = [], errors = [];
  let lastOptId = '';
  try {
    for (const f of files) {
      try {
        const res = await v17TransmitMedia(f, msg => { if (status) status.textContent = '⏳ ' + f.name + ' · ' + msg; });
        uploaded.push({ id: res.id, kind: f.type === 'video/mp4' ? 'video' : 'image', optimized: !!res.optimized, orig: res.original_bytes, stored: res.stored_bytes });
        if (res.optimized) lastOptId = res.id;
      } catch (e) {
        errors.push(f.name + ': ' + e.message);
      }
    }
    if (uploaded.length) {
      await refresh();
      for (const u of uploaded) {
        if (u.kind === 'video') v17State.defaultVideo = u.id;
        else v17State.defaultImage = u.id;
        chosen = u.id;
      }
      const last = uploaded[uploaded.length - 1];
      v17SetKind(last.kind);
      v17RenderSelectedTargets();
      if (lastOptId) {
        v17State.lastOptimizedVideoId = lastOptId;
        const dlBtn = $('v176LastDownload');
        if (dlBtn) { dlBtn.hidden = false; dlBtn.onclick = () => downloadMedia(v17State.lastOptimizedVideoId); }
      }
      const msg = '✓ ' + uploaded.length + ' Datei(en) gespeichert.' + (lastOptId ? ' Video automatisch unter 100 MB optimiert.' : '') + (errors.length ? ' ⚠ ' + errors.join(' | ') : '');
      if (status) status.textContent = msg;
      toast(msg, errors.length > 0 && !uploaded.length);
    } else if (errors.length) {
      if (status) status.textContent = '⚠ ' + errors.join(' | ');
      toast(errors.join(' | '), true);
    }
    if ($('v17ImageFiles')) $('v17ImageFiles').value = '';
    if ($('v17VideoFiles')) $('v17VideoFiles').value = '';
  } finally {
    if (btn) btn.disabled = false;
  }
}

function v17SetFilter(filter) {
  v17State.filter = filter || 'all';
  document.querySelectorAll('.v17-filterbar button').forEach(b => b.classList.toggle('selected', b.dataset.filter === v17State.filter));
  v17RenderProviders();
}

function v17RenderProviders() {
  const root = $('v17ProviderGrid');
  if (!root) return;
  root.innerHTML = v17ProviderDefs.map(def => {
    const accs = accounts.filter(a => a.provider === def.provider);
    const fmts = def.formats.filter(f => v17State.filter === 'all' || f.group === v17State.filter);
    if (!fmts.length) return '';
    const statusPill = accs.length
      ? `<span class="pill ${accs.some(a => a.status === 'error') ? 'red' : 'green'}">${accs.length} verbunden</span>`
      : '<span class="pill gray">Nicht verbunden</span>';
    const btns = fmts.map(f =>
      `<button type="button" class="outline" data-add-provider="${esc(def.provider)}" data-add-format="${esc(f.format)}" data-add-kind="${esc(f.kind)}">+ ${esc(f.label)}</button>`
    ).join('');
    return `<div class="v17-provider-card"><div class="v17-provider-head"><strong>${def.icon} ${esc(def.name)}</strong>${statusPill}</div><div class="v17-provider-btns">${btns}</div></div>`;
  }).join('') || '<p class="v17-empty">Keine Plattformen für diesen Filter.</p>';
  root.querySelectorAll('[data-add-provider]').forEach(btn => {
    btn.addEventListener('click', () => v17AddTarget(btn.dataset.addProvider, btn.dataset.addFormat, btn.dataset.addKind));
  });
}

function v17AddTarget(provider, format, kind) {
  const accs = accounts.filter(a => a.provider === provider);
  const defaultMedia = kind === 'video'
    ? (v17State.defaultVideo || media.find(m => m.mime === 'video/mp4')?.id || '')
    : (v17State.defaultImage || media.find(m => m.mime?.startsWith('image/'))?.id || '');
  const connId = accs[0]?.id || '';
  if (v17State.targets.some(t => t.provider === provider && t.format === format && (t.connectionId || '') === connId)) {
    toast('Dieses Ziel ist bereits ausgewählt. Du kannst unten ein anderes Konto wählen, falls mehrere verbunden sind.', true);
    return;
  }
  v17State.targets.push({
    provider,
    format,
    kind,
    connectionId: connId,
    mediaId: defaultMedia,
    mediaIds: [],
    coverIndex: 0,
    tiktokTitle: '',
    autoMusic: false,
    brandOrganic: false,
    brandContent: false,
    disableComment: false,
    captionOverride: null,
    manual: ['whatsapp', 'whatsapp_channel'].includes(provider),
  });
  if (provider === 'tiktok' && $('v17TikTokConsent')) $('v17TikTokConsent').checked = false;
  v17RenderSelectedTargets();
}

function v17RemoveTarget(idx) {
  v17State.targets.splice(idx, 1);
  v17RenderSelectedTargets();
}

function v17RenderSelectedTargets() {
  const root = $('v17SelectedTargets');
  if (!root) return;
  if ($('v17SelectedCount')) $('v17SelectedCount').textContent = v17State.targets.length + ' ausgewählt';
  const hasTikTok = v17State.targets.some(t => t.provider === 'tiktok');
  const hasYouTube = v17State.targets.some(t => t.provider === 'youtube');
  if ($('v17TikTokBox')) $('v17TikTokBox').hidden = !hasTikTok;
  if ($('v17YoutubeBox')) $('v17YoutubeBox').hidden = !hasYouTube;
  if (!v17State.targets.length) {
    root.innerHTML = '<p class="v17-empty">Noch keine Ziele ausgewählt. Wähle oben eine Plattform und ein Format.</p>';
    return;
  }
  root.innerHTML = v17State.targets.map((t, idx) => {
    const def = v17ProviderDefs.find(d => d.provider === t.provider) || { icon: icon[t.provider] || '✦', name: t.provider };
    const accs = accounts.filter(a => a.provider === t.provider);
    const matchingMedia = media.filter(m => t.kind === 'video' ? m.mime === 'video/mp4' : m.mime?.startsWith('image/'));
    if (t.mediaId && !matchingMedia.some(m => m.id === t.mediaId)) t.mediaId = '';
    if (!t.mediaId) t.mediaId = t.kind === 'video' ? v17State.defaultVideo : v17State.defaultImage;
    if (t.connectionId && !accs.some(a => a.id === t.connectionId)) t.connectionId = accs[0]?.id || '';
    const accOpts = accs.length
      ? accs.map(a => `<option value="${esc(a.id)}" ${a.id === t.connectionId ? 'selected' : ''}>${esc(a.label)}</option>`).join('')
      : '<option value="">– Konto erst unter Konten verbinden –</option>';
    const mediaOpts = '<option value="">– ' + (t.kind === 'video' ? 'MP4-Video' : 'Bild') + ' wählen –</option>' +
      matchingMedia.map(m => `<option value="${esc(m.id)}" ${m.id === t.mediaId ? 'selected' : ''}>${esc(m.original_name)}</option>`).join('');
    let ttPhotoExtra = '';
    if (t.provider === 'tiktok' && t.format === 'post') {
      const jpgs = media.filter(m => m.mime === 'image/jpeg' && !m.missing);
      const pngs = media.filter(m => m.mime === 'image/png' && !m.missing);
      if (!Array.isArray(t.mediaIds)) t.mediaIds = [];
      t.mediaIds = t.mediaIds.filter(id => jpgs.some(m => m.id === id));
      if (!t.mediaIds.length && t.mediaId && jpgs.some(m => m.id === t.mediaId)) {
        t.mediaIds = [t.mediaId];
      }
      if (t.mediaIds.length) {
        t.mediaId = t.mediaIds[0];
        if (t.coverIndex >= t.mediaIds.length) t.coverIndex = 0;
      }
      const selectedRows = t.mediaIds.map((id, pos) => {
        const pic = jpgs.find(m => m.id === id);
        return `<div class="v19-carousel-item">` +
          `<span><b>${pos + 1}.</b> ${esc(pic?.original_name || id)}</span>` +
          `<div class="v19-carousel-actions">` +
          `<label class="v19-cover-radio"><input type="radio" name="v19Cover_${idx}" data-tt-cover="${pos}" data-idx="${idx}" ${t.coverIndex === pos ? 'checked' : ''}/> Cover</label>` +
          `<button type="button" class="outline tiny" data-tt-move="up" data-pos="${pos}" data-idx="${idx}" ${pos === 0 ? 'disabled' : ''}>↑</button>` +
          `<button type="button" class="outline tiny" data-tt-move="down" data-pos="${pos}" data-idx="${idx}" ${pos === t.mediaIds.length - 1 ? 'disabled' : ''}>↓</button>` +
          `<button type="button" class="danger tiny" data-tt-del="${pos}" data-idx="${idx}">✕</button>` +
          `</div></div>`;
      }).join('');
      const addableOpts = '<option value="">+ Weiteres JPG zum Karussell hinzufügen …</option>' +
        jpgs.filter(m => !t.mediaIds.includes(m.id)).map(m => `<option value="${esc(m.id)}">${esc(m.original_name)}</option>`).join('');
      const pngHint = pngs.length
        ? `<div class="v19-png-bar"><small>TikTok-Fotos benötigen JPG (${pngs.length} PNG in Mediathek):</small> ` +
          pngs.slice(0, 4).map(p => `<button type="button" class="outline tiny" data-tt-prep-png="${esc(p.id)}" data-idx="${idx}">⚡ „${esc(p.original_name.slice(0, 22))}“ → JPG</button>`).join(' ') +
          `</div>`
        : '';
      ttPhotoExtra = `<div class="v19-carousel-box">` +
        `<div class="v19-carousel-head"><strong>🖼 TikTok Foto- &amp; Karussell-Auswahl (${t.mediaIds.length}/35 JPGs)</strong><small>Reihenfolge &amp; Cover-Bild frei wählbar</small></div>` +
        `<div class="v19-carousel-list">${selectedRows || '<small style="opacity:.75;">Noch kein JPG ausgewählt – wähle oben eine JPG-Datei oder füge unten Bilder hinzu.</small>'}</div>` +
        `<div class="v19-row" style="margin-top:8px;"><select data-tt-add="${idx}" style="flex:1;min-width:180px;">${addableOpts}</select></div>` +
        pngHint +
        `<div class="v19-grid" style="margin-top:10px;margin-bottom:4px;">` +
        `<label>Fototitel (optional, max. 90 Zeichen)<input type="text" maxlength="90" data-field="tiktokTitle" data-idx="${idx}" value="${esc(t.tiktokTitle || '')}" placeholder="Kurzer Titel über dem Fotobeitrag"/></label>` +
        `<label class="v17-check" style="align-self:end;"><input type="checkbox" data-field="autoMusic" data-idx="${idx}" ${t.autoMusic ? 'checked' : ''}/> Musik automatisch hinzufügen (auto_add_music)</label>` +
        `</div></div>`;
    }
    return `<div class="v17-target-card" data-idx="${idx}">` +
      `<div class="v17-flex"><strong>${def.icon} ${esc(def.name)} · ${esc(fmtNames[t.format] || t.format)} (${t.kind === 'video' ? 'Video' : 'Bild'})</strong>` +
      `<button type="button" class="danger tiny" data-remove-idx="${idx}">Entfernen</button></div>` +
      `<div class="v17-target-grid"><div><label style="margin:0 0 4px">Zielkonto</label><select data-field="connectionId" data-idx="${idx}">${accOpts}</select></div>` +
      `<div><label style="margin:0 0 4px">${t.provider === 'tiktok' && t.format === 'post' ? 'Hauptbild (JPG, Position 1)' : 'Datei'}</label><select data-field="mediaId" data-idx="${idx}">${mediaOpts}</select></div></div>` +
      ttPhotoExtra +
      `<input type="text" maxlength="2200" data-field="captionOverride" data-idx="${idx}" value="${esc(t.captionOverride || '')}" placeholder="Optional: eigener Begleittext nur für dieses Ziel (leer = gemeinsamer Text)">` +
      `</div>`;
  }).join('');
  root.querySelectorAll('[data-remove-idx]').forEach(btn => btn.addEventListener('click', () => v17RemoveTarget(Number(btn.dataset.removeIdx))));
  root.querySelectorAll('[data-field]').forEach(el => {
    const evName = el.tagName === 'INPUT' ? 'input' : 'change';
    el.addEventListener(evName, () => {
      const idx = Number(el.dataset.idx);
      const t = v17State.targets[idx];
      if (!t) return;
      if (el.dataset.field === 'captionOverride') t.captionOverride = el.value ? el.value : null;
      else if (el.type === 'checkbox') t[el.dataset.field] = !!el.checked;
      else t[el.dataset.field] = el.value;
      if (t.provider === 'tiktok' && t.format === 'post' && el.dataset.field === 'mediaId' && el.value) {
        const picked = media.find(m => m.id === el.value);
        if (picked && picked.mime === 'image/jpeg') {
          t.mediaIds = [el.value, ...(t.mediaIds || []).filter(id => id !== el.value)].slice(0, 35);
          t.coverIndex = 0;
          v17RenderSelectedTargets();
          return;
        }
      }
      if (t.provider === 'tiktok' && el.dataset.field === 'connectionId') {
        v17State.tiktokLoadedAccount = '';
        if ($('v17TikTokPrivacy')) $('v17TikTokPrivacy').disabled = true;
        if ($('v17TikTokCreator')) $('v17TikTokCreator').textContent = 'Bitte Sichtbarkeit für dieses Konto abfragen.';
        if ($('v17TikTokConsent')) $('v17TikTokConsent').checked = false;
      }
    });
  });
  root.querySelectorAll('[data-tt-add]').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = Number(sel.dataset.ttAdd);
      const t = v17State.targets[idx];
      if (!t || !sel.value) return;
      if (!Array.isArray(t.mediaIds)) t.mediaIds = [];
      if (t.mediaIds.length >= 35) { toast('TikTok erlaubt maximal 35 Bilder pro Karussell.', true); return; }
      if (!t.mediaIds.includes(sel.value)) {
        t.mediaIds.push(sel.value);
        t.mediaId = t.mediaIds[0];
      }
      v17RenderSelectedTargets();
    });
  });
  root.querySelectorAll('[data-tt-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      const pos = Number(btn.dataset.ttDel);
      const t = v17State.targets[idx];
      if (!t || !Array.isArray(t.mediaIds)) return;
      t.mediaIds.splice(pos, 1);
      t.mediaId = t.mediaIds[0] || '';
      if (t.coverIndex >= t.mediaIds.length) t.coverIndex = 0;
      v17RenderSelectedTargets();
    });
  });
  root.querySelectorAll('[data-tt-move]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      const pos = Number(btn.dataset.pos);
      const dir = btn.dataset.ttMove === 'up' ? -1 : 1;
      const t = v17State.targets[idx];
      if (!t || !Array.isArray(t.mediaIds)) return;
      const next = pos + dir;
      if (next < 0 || next >= t.mediaIds.length) return;
      const tmp = t.mediaIds[pos];
      t.mediaIds[pos] = t.mediaIds[next];
      t.mediaIds[next] = tmp;
      if (t.coverIndex === pos) t.coverIndex = next;
      else if (t.coverIndex === next) t.coverIndex = pos;
      t.mediaId = t.mediaIds[0];
      v17RenderSelectedTargets();
    });
  });
  root.querySelectorAll('[data-tt-cover]').forEach(rad => {
    rad.addEventListener('change', () => {
      const idx = Number(rad.dataset.idx);
      const t = v17State.targets[idx];
      if (t) t.coverIndex = Number(rad.dataset.ttCover) || 0;
    });
  });
  root.querySelectorAll('[data-tt-prep-png]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mid = btn.dataset.ttPrepPng;
      const idx = Number(btn.dataset.idx);
      btn.disabled = true;
      try {
        const created = await api('/api/tiktok/photos/prepare/' + encodeURIComponent(mid), { method: 'POST' });
        await refresh();
        const t = v17State.targets[idx];
        if (t && created?.id) {
          if (!Array.isArray(t.mediaIds)) t.mediaIds = [];
          if (!t.mediaIds.includes(created.id)) t.mediaIds.push(created.id);
          t.mediaId = t.mediaIds[0];
          v17RenderSelectedTargets();
        }
        toast('TikTok-JPG vorbereitet und zum Karussell hinzugefügt.');
      } catch (e) {
        toast(e.message || 'JPG-Vorbereitung fehlgeschlagen.', true);
      } finally {
        btn.disabled = false;
      }
    });
  });
  if (typeof window.v19SyncTikTokUi === 'function') window.v19SyncTikTokUi();
}

async function v17QueryTikTok() {
  const tt = v17State.targets.find(t => t.provider === 'tiktok');
  const accId = tt?.connectionId;
  if (!accId) { toast('Bitte zuerst ein verbundenes TikTok-Konto auswählen.', true); return; }
  const btn = $('v17TikTokQuery');
  if (btn) btn.disabled = true;
  try {
    const data = await api('/api/tiktok/creator/' + encodeURIComponent(accId));
    const opts = data.privacy_level_options || [];
    if (!opts.length) throw new Error('TikTok liefert keine Sichtbarkeitsoptionen.');
    const labels = { SELF_ONLY: 'Nur ich (privat/Test)', PUBLIC_TO_EVERYONE: 'Öffentlich', MUTUAL_FOLLOW_FRIENDS: 'Freunde', FOLLOWER_OF_CREATOR: 'Follower' };
    const sel = $('v17TikTokPrivacy');
    if (sel) {
      sel.innerHTML = '<option value="">– Bitte Sichtbarkeit aktiv auswählen –</option>' +
        opts.map(v => `<option value="${esc(v)}">${esc(labels[v] || v)}</option>`).join('');
      sel.disabled = false;
      sel.value = '';
    }
    v17State.tiktokLoadedAccount = accId;
    v17State.tiktokCreator = data;
    if (typeof window.v19ApplyCreatorLimits === 'function') window.v19ApplyCreatorLimits(data);
    if ($('v17TikTokCreator')) $('v17TikTokCreator').textContent = (data.creator_nickname || data.creator_username || 'TikTok-Konto') + ' · bereit';
    if ($('v17TikTokConsent')) $('v17TikTokConsent').checked = false;
    toast('TikTok-Konto geladen. Bitte Sichtbarkeit & Optionen aktiv auswählen.');
  } catch (e) {
    v17State.tiktokLoadedAccount = '';
    if ($('v17TikTokPrivacy')) $('v17TikTokPrivacy').disabled = true;
    if ($('v17TikTokCreator')) $('v17TikTokCreator').textContent = '⚠ ' + e.message;
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function v17ToggleSchedule() {
  const mode = document.querySelector('input[name="v17SendMode"]:checked')?.value || 'schedule';
  if ($('v17ScheduleArea')) $('v17ScheduleArea').hidden = mode === 'now';
}

function v17BuildPlanPayload() {
  if (!v17State.targets.length) throw new Error('Bitte mindestens ein Veröffentlichungsziel auswählen.');
  const mode = document.querySelector('input[name="v17SendMode"]:checked')?.value || 'schedule';
  const due = $('v17Due')?.value || '';
  if (mode === 'schedule' && (!due || !Number.isFinite(new Date(due).getTime()) || new Date(due) <= new Date())) {
    throw new Error('Bitte ein gültiges Datum und eine Uhrzeit in der Zukunft wählen.');
  }
  const seen = new Set();
  const targets = v17State.targets.map(t => {
    const file = media.find(m => m.id === t.mediaId);
    if (!file) throw new Error((providers[t.provider]?.name || t.provider) + ': Bitte eine passende Datei auswählen.');
    if (file.missing) throw new Error(file.original_name + ': Die Datei fehlt auf dem Server. Bitte erneut hochladen.');
    if (!['whatsapp', 'whatsapp_channel'].includes(t.provider) && !t.connectionId) {
      throw new Error((providers[t.provider]?.name || t.provider) + ': Bitte zuerst unter Konten & Plattformen verbinden.');
    }
    const key = t.provider + '|' + (t.connectionId || '') + '|' + t.format;
    if (seen.has(key)) throw new Error('Doppeltes Ziel: ' + t.provider + ' (' + t.format + ') bitte nur einmal pro Konto wählen.');
    seen.add(key);
    const entry = {
      provider: t.provider,
      connection_id: t.connectionId || null,
      format: t.format,
      media_id: file.id,
    };
    if (t.provider === 'tiktok') {
      const commercialOn = !!$('v19TikTokCommercialToggle')?.checked;
      const brandOrg = commercialOn && !!$('v19TikTokBrandOrganic')?.checked;
      const brandCont = commercialOn && !!$('v19TikTokBrandContent')?.checked;
      entry.tiktok_disable_comment = !$('v19TikTokAllowComment')?.checked;
      entry.tiktok_disable_duet = !$('v19TikTokAllowDuet')?.checked;
      entry.tiktok_disable_stitch = !$('v19TikTokAllowStitch')?.checked;
      entry.tiktok_brand_organic = brandOrg;
      entry.tiktok_brand_content = brandCont;
      if (t.format === 'post') {
        const ids = Array.isArray(t.mediaIds) && t.mediaIds.length ? t.mediaIds.slice(0, 35) : [file.id];
        for (const mid of ids) {
          const pic = media.find(m => m.id === mid);
          if (!pic || pic.mime !== 'image/jpeg') {
            throw new Error('TikTok Foto/Karussell: Alle ausgewählten Bilder müssen JPG sein. Nutze den Button „→ JPG“ direkt in der Karte.');
          }
        }
        entry.media_id = ids[0];
        entry.media_ids = ids;
        entry.photo_cover_index = Math.min(Math.max(0, Number(t.coverIndex) || 0), ids.length - 1);
        entry.tiktok_photo_title = (t.tiktokTitle || '').slice(0, 90);
        entry.tiktok_auto_add_music = !!t.autoMusic;
      }
    }
    if (t.captionOverride !== null && t.captionOverride !== '') entry.caption = t.captionOverride;
    return entry;
  });
  const tt = targets.find(t => t.provider === 'tiktok');
  const ttMode = tt ? ($('v19TikTokPostMode')?.value || 'direct') : 'direct';
  if (tt) {
    if (tt.connection_id !== v17State.tiktokLoadedAccount || $('v17TikTokPrivacy')?.disabled) {
      throw new Error('TikTok: Bitte zuerst „TikTok-Konto & Sichtbarkeit abfragen“ ausführen.');
    }
    const chosenPrivacy = $('v17TikTokPrivacy')?.value || '';
    if (ttMode === 'direct' && !chosenPrivacy) {
      throw new Error('TikTok: Bitte eine Sichtbarkeit aktiv auswählen (laut TikTok-Richtlinie gibt es keine Vorauswahl).');
    }
    if ($('v19TikTokCommercialToggle')?.checked && !$('v19TikTokBrandOrganic')?.checked && !$('v19TikTokBrandContent')?.checked) {
      throw new Error('TikTok Werbung: Bitte mindestens „Eigene Marke“ oder „Bezahlte Partnerschaft“ ankreuzen.');
    }
    if (ttMode === 'direct' && $('v19TikTokCommercialToggle')?.checked && $('v19TikTokBrandContent')?.checked && chosenPrivacy === 'SELF_ONLY') {
      throw new Error('TikTok: Bezahlte Partnerschaft (Branded Content) kann nicht als „Nur ich“ gepostet werden.');
    }
    if (!$('v17TikTokConsent')?.checked) {
      throw new Error('TikTok: Bitte die TikTok-Freigabe ausdrücklich ankreuzen.');
    }
  }
  return {
    mode,
    payload: {
      media_id: targets[0].media_id,
      caption: $('v17Caption')?.value || '',
      due_at: mode === 'now' ? v17DefaultDueValue() : due,
      targets,
      tiktok_privacy: tt ? ($('v17TikTokPrivacy').value || 'SELF_ONLY') : 'SELF_ONLY',
      tiktok_post_mode: ttMode,
      tiktok_consent: !!tt,
      tiktok_aigc: !!tt && !!$('v17TikTokAigc')?.checked,
      youtube_privacy: $('v17YoutubePrivacy')?.value || 'private',
    },
  };
}

function v17Review() {
  try {
    const built = v17BuildPlanPayload();
    v17State.pendingReview = built;
    const list = $('v17ReviewList');
    if (list) {
      list.innerHTML = built.payload.targets.map(t => {
        const file = media.find(m => m.id === t.media_id);
        const acc = accounts.find(a => a.id === t.connection_id);
        return `<div class="v17-review-row"><div><strong>${icon[t.provider] || ''} ${esc(providers[t.provider]?.name || t.provider)} · ${esc(fmtNames[t.format] || t.format)}</strong><br>` +
          `<small>${esc(file?.original_name || t.media_id)}${acc ? ' · ' + esc(acc.label) : ''}</small></div>` +
          `<span class="pill green">${file?.mime === 'video/mp4' ? 'MP4' : 'Bild'}</span></div>`;
      }).join('');
    }
    if ($('v17ReviewWhen')) {
      $('v17ReviewWhen').textContent = built.mode === 'now'
        ? '🚀 Möglichst sofort (nächster Scheduler-Durchlauf)'
        : '🗓 Geplant für: ' + new Date(built.payload.due_at).toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short' });
    }
    if ($('v17FinalConsent')) $('v17FinalConsent').checked = false;
    if ($('v17FinalPublish')) $('v17FinalPublish').disabled = true;
    $('v17ReviewDialog')?.showModal();
  } catch (e) {
    toast(e.message, true);
  }
}

function v17CloseReview() {
  if ($('v17ReviewDialog')?.open) $('v17ReviewDialog').close();
  v17State.pendingReview = null;
}

function v17ConsentChanged() {
  if ($('v17FinalPublish')) $('v17FinalPublish').disabled = !$('v17FinalConsent')?.checked;
}

async function v17ConfirmPublish() {
  if (v17State.busy || !$('v17FinalConsent')?.checked || !v17State.pendingReview) return;
  v17State.busy = true;
  if ($('v17FinalPublish')) $('v17FinalPublish').disabled = true;
  try {
    const { mode, payload } = v17State.pendingReview;
    const endpoint = mode === 'now' ? '/api/plan/now' : '/api/plan';
    const res = await json(endpoint, payload);
    if ($('v17TikTokConsent')) $('v17TikTokConsent').checked = false;
    v17CloseReview();
    await refresh();
    toast('✓ ' + res.count + ' Veröffentlichung(en) ' + (mode === 'now' ? 'zum sofortigen Versand eingereiht.' : 'erfolgreich geplant.'));
    nav('queue');
  } catch (e) {
    toast(e.message, true);
  } finally {
    v17State.busy = false;
    if ($('v17FinalPublish')) $('v17FinalPublish').disabled = !$('v17FinalConsent')?.checked;
  }
}

function v17RenderHub() {
  const root = $('v17HubAssets');
  if (!root) return;
  const items = v17SortMedia(v17State.hubKind, $('v17HubSearch')?.value, $('v17HubSort')?.value);
  if ($('v17HubCount')) $('v17HubCount').textContent = items.length + ' ' + (v17State.hubKind === 'video' ? 'Video(s)' : 'Bild(er)') + ' angezeigt';
  root.innerHTML = items.map(m => {
    const isVid = m.mime === 'video/mp4';
    return `<div class="v17-asset-card">` +
      `<div class="v17-asset-thumb"><img data-hub-thumb="${esc(m.id)}" alt="Vorschau">` +
      `<span class="v17-asset-badge">${isVid ? 'MP4' : 'BILD'}${m.missing ? ' · fehlt' : ''}</span></div>` +
      `<div class="v17-asset-name" title="${esc(m.original_name)}">${esc(m.original_name)}</div>` +
      `<div class="v17-asset-meta">${v176FmtSize(m.bytes)} · ${new Date(m.created_at).toLocaleDateString('de-DE')}</div>` +
      `<div class="v17-asset-actions">` +
      `<button type="button" class="tiny" data-hub-use="${esc(m.id)}">✦ Nutzen</button>` +
      `<button type="button" class="outline tiny" data-hub-edit="${esc(m.id)}" data-hub-vid="${isVid ? '1' : '0'}">${isVid ? '▶ Edit' : '◈ Edit'}</button>` +
      `<button type="button" class="outline tiny" data-hub-qr="${esc(m.id)}">📱 QR</button>` +
      `<button type="button" class="outline tiny" data-hub-dl="${esc(m.id)}">⬇</button>` +
      `<button type="button" class="outline tiny" data-hub-rename="${esc(m.id)}">✎</button>` +
      `<button type="button" class="danger tiny" data-hub-del="${esc(m.id)}">✕</button>` +
      `</div></div>`;
  }).join('') || '<p class="v17-empty">Keine Dateien gefunden.</p>';
  root.querySelectorAll('[data-hub-thumb]').forEach(img => loadImageInto(img, img.dataset.hubThumb));
  root.querySelectorAll('[data-hub-use]').forEach(b => b.addEventListener('click', () => { v17SelectDefault(b.dataset.hubUse); nav('publish'); }));
  root.querySelectorAll('[data-hub-edit]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.hubVid === '1') openVideoStudio(b.dataset.hubEdit); else openStudio(b.dataset.hubEdit);
  }));
  root.querySelectorAll('[data-hub-qr]').forEach(b => b.addEventListener('click', () => v14OpenMobileQr(b.dataset.hubQr)));
  root.querySelectorAll('[data-hub-dl]').forEach(b => b.addEventListener('click', () => downloadMedia(b.dataset.hubDl)));
  root.querySelectorAll('[data-hub-rename]').forEach(b => b.addEventListener('click', async () => {
    const item = media.find(x => x.id === b.dataset.hubRename);
    const next = prompt('Neuer Dateiname:', item?.original_name || '');
    if (!next || !next.trim()) return;
    try { await json('/api/media/' + encodeURIComponent(b.dataset.hubRename), { name: next.trim() }, 'PATCH'); await refresh(); toast('Dateiname geändert.'); }
    catch (e) { toast(e.message, true); }
  }));
  root.querySelectorAll('[data-hub-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Diese ungenutzte Datei dauerhaft aus der Mediathek löschen?')) return;
    try { await api('/api/media/' + encodeURIComponent(b.dataset.hubDel), { method: 'DELETE' }); await refresh(); toast('Datei gelöscht.'); }
    catch (e) { toast(e.message, true); }
  }));
}

function v17WeekChange(delta) {
  v17State.weekOffset = delta === 0 ? 0 : v17State.weekOffset + delta;
  v17RenderWeek();
}

function v17RenderWeek() {
  const root = $('v17Week');
  if (!root) return;
  const nowDate = new Date();
  const dayIdx = (nowDate.getDay() + 6) % 7;
  const monday = new Date(nowDate);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - dayIdx + v17State.weekOffset * 7);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  if ($('v17WeekLabel')) {
    $('v17WeekLabel').textContent = monday.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' – ' +
      sunday.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  const todayStr = nowDate.toLocaleDateString('sv-SE');
  const daysHtml = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const key = d.toLocaleDateString('sv-SE');
    const dayJobs = jobs.filter(j => j.status !== 'cancelled' && new Date(j.due_at).toLocaleDateString('sv-SE') === key)
      .sort((a, b) => a.due_at.localeCompare(b.due_at));
    const chips = dayJobs.slice(0, 6).map(j =>
      `<div class="v17-week-chip ${esc(j.status)}" title="${esc(j.original_name)}">${new Date(j.due_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} ${icon[j.platform] || ''} ${esc(j.original_name)}</div>`
    ).join('') + (dayJobs.length > 6 ? `<small>+ ${dayJobs.length - 6} weitere</small>` : '');
    daysHtml.push(`<div class="v17-week-day ${key === todayStr ? 'is-today' : ''}"><div class="v17-week-head"><span>${d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}</span><span>${dayJobs.length}</span></div>${chips || '<small class="muted">Frei</small>'}</div>`);
  }
  root.innerHTML = daysHtml.join('');
  if ($('v17JobSummary')) {
    const counts = {
      scheduled: jobs.filter(j => j.status === 'scheduled').length,
      published: jobs.filter(j => ['published', 'published_manual'].includes(j.status)).length,
      review: jobs.filter(j => j.status === 'needs_review').length,
      awaiting: jobs.filter(j => j.status === 'awaiting_confirmation').length,
    };
    $('v17JobSummary').innerHTML = `<span class="pill amber">Geplant: ${counts.scheduled}</span>` +
      `<span class="pill green">Veröffentlicht: ${counts.published}</span>` +
      (counts.awaiting ? `<span class="pill">In Verarbeitung: ${counts.awaiting}</span>` : '') +
      (counts.review ? `<span class="pill red">Prüfen: ${counts.review}</span>` : '');
  }
}

function v17MontagePictures() {
  const root = $('v17MontageImageList');
  if (!root) return;
  const items = v17SortMedia('image', $('v17MontageSearch')?.value, 'new');
  root.innerHTML = items.map(m =>
    `<div class="v17-asset-card" data-montage-add="${esc(m.id)}"><div class="v17-asset-thumb"><img data-m-thumb="${esc(m.id)}" alt="Bild"><span class="v17-asset-badge">+ Szene</span></div><div class="v17-asset-name" title="${esc(m.original_name)}">${esc(m.original_name)}</div></div>`
  ).join('') || '<p class="v17-empty">Lade zuerst Bilder hoch, um ein Video aus mehreren Szenen zu erstellen.</p>';
  root.querySelectorAll('[data-m-thumb]').forEach(img => loadImageInto(img, img.dataset.mThumb));
  root.querySelectorAll('[data-montage-add]').forEach(card => {
    card.addEventListener('click', () => {
      if (v17State.montageScenes.length >= 12) { toast('Maximal 12 Szenen pro Montage.', true); return; }
      v17State.montageScenes.push({ media_id: card.dataset.montageAdd, seconds: 4, text: '' });
      v17RenderMontageTimeline();
    });
  });
}

function v17RenderMontageTimeline() {
  const root = $('v17Timeline');
  if (!root) return;
  if (!v17State.montageScenes.length) {
    root.innerHTML = '<p class="v17-empty">Noch keine Bilder in der Timeline. Klicke links auf mindestens zwei Bilder.</p>';
    return;
  }
  root.innerHTML = v17State.montageScenes.map((sc, idx) => {
    const m = media.find(x => x.id === sc.media_id);
    return `<div class="v17-scene-row"><img data-tl-thumb="${esc(sc.media_id)}" alt="Szene ${idx + 1}">` +
      `<div class="v17-scene-fields"><strong>Szene ${idx + 1}: ${esc(m?.original_name || sc.media_id)}</strong>` +
      `<input type="text" maxlength="180" data-sc-text="${idx}" value="${esc(sc.text)}" placeholder="Optionaler Text auf dieser Szene">` +
      `<label style="margin:0;font-size:11.5px">Dauer (Sek.): <input type="number" min="2" max="12" step="0.5" style="width:84px;display:inline-block" data-sc-sec="${idx}" value="${sc.seconds}"></label></div>` +
      `<div class="v17-scene-controls">` +
      `<button type="button" class="outline" data-sc-up="${idx}" ${idx === 0 ? 'disabled' : ''}>↑</button>` +
      `<button type="button" class="outline" data-sc-dn="${idx}" ${idx === v17State.montageScenes.length - 1 ? 'disabled' : ''}>↓</button>` +
      `<button type="button" class="danger" data-sc-rm="${idx}">✕</button></div></div>`;
  }).join('');
  root.querySelectorAll('[data-tl-thumb]').forEach(img => loadImageInto(img, img.dataset.tlThumb));
  root.querySelectorAll('[data-sc-text]').forEach(el => el.addEventListener('input', () => { v17State.montageScenes[Number(el.dataset.scText)].text = el.value; }));
  root.querySelectorAll('[data-sc-sec]').forEach(el => el.addEventListener('change', () => { v17State.montageScenes[Number(el.dataset.scSec)].seconds = Math.max(2, Math.min(12, Number(el.value) || 4)); }));
  root.querySelectorAll('[data-sc-up]').forEach(b => b.addEventListener('click', () => { const i = Number(b.dataset.scUp); if (i > 0) { [v17State.montageScenes[i - 1], v17State.montageScenes[i]] = [v17State.montageScenes[i], v17State.montageScenes[i - 1]]; v17RenderMontageTimeline(); } }));
  root.querySelectorAll('[data-sc-dn]').forEach(b => b.addEventListener('click', () => { const i = Number(b.dataset.scDn); if (i < v17State.montageScenes.length - 1) { [v17State.montageScenes[i + 1], v17State.montageScenes[i]] = [v17State.montageScenes[i], v17State.montageScenes[i + 1]]; v17RenderMontageTimeline(); } }));
  root.querySelectorAll('[data-sc-rm]').forEach(b => b.addEventListener('click', () => { v17State.montageScenes.splice(Number(b.dataset.scRm), 1); v17RenderMontageTimeline(); }));
}

async function v17RenderMontage() {
  if (v17State.montageScenes.length < 2) { toast('Bitte mindestens zwei Bilder in die Timeline legen.', true); return; }
  const btn = $('v17MontageRender'), info = $('v17MontageInfo');
  if (btn) btn.disabled = true;
  if ($('v183MontageProgress')) { $('v183MontageProgress').hidden=false; $('v183MontageProgress').value=0; }
  if (info) info.textContent = '⏳ MP4 wird aus ' + v17State.montageScenes.length + ' Szenen gerendert …';
  try {
    const started = await json('/api/studio/slideshow', {
      scenes: v17State.montageScenes,
      aspect: $('v17MontageFormat')?.value || 'story',
      transition: $('v17MontageTransition')?.value || 'fade',
      color: $('v17MontageColor')?.value || 'natural',
    });
    const bar = $('v183MontageProgress');
    let res, failures=0;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      try { res = await api('/api/studio/slideshow/' + encodeURIComponent(started.job_id)); failures=0; }
      catch (err) {
        if (++failures >= 8 || !/^HTTP (502|503|504)$|Failed to fetch|Load failed|NetworkError/i.test(err.message)) throw err;
        if (info) info.textContent = 'Verbindung wird wiederhergestellt …';
        continue;
      }
      if (bar) bar.value = res.progress;
      if (info) info.textContent = res.progress + '% · ' + res.message;
      if (res.status === 'error') throw new Error(res.message);
      if (res.status === 'done') break;
    }
    await refresh();
    v17State.defaultVideo = res.id;
    chosen = res.id;
    if (info) info.textContent = '✓ ' + res.message + ' (' + res.duration + ' s)';
    toast(res.message);
  } catch (e) {
    if (info) info.textContent = '⚠ ' + e.message;
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

if ($('v17Due') && !$('v17Due').value) $('v17Due').value = v17DefaultDueValue();

const v17PrevNav = nav;
nav = function(id) {
  v17PrevNav(id);
  const titles = {
    dashboard: 'Übersicht',
    publish: 'Veröffentlichen',
    mediaHub: 'Mediathek',
    drafts: 'Entwürfe',
    queue: 'Planung & Archiv',
    storykit: 'Storys zum Teilen',
    accounts: 'Konten & Plattformen',
    settings: 'Einstellungen',
    v17Montage: 'Kreativstudio · Bilder → Video',
  };
  if (titles[id]) $('pageTitle').textContent = titles[id];
  if (id === 'publish') { v17RenderAssets(); v17RenderProviders(); v17RenderSelectedTargets(); }
  if (id === 'mediaHub') { v17RenderHub(); if (typeof v1723LoadStorage === 'function') v1723LoadStorage(); }
  if (id === 'drafts' && typeof v1723LoadDrafts === 'function') v1723LoadDrafts();
  if (id === 'queue') v17RenderWeek();
  if (id === 'storykit' && typeof v175Load === 'function') v175Load();
  if (id === 'v17Montage') { v17MontagePictures(); v17RenderMontageTimeline(); }
};

const v17PrevRefresh = refresh;
refresh = async function() {
  const res = await v17PrevRefresh();
  if (!v17State.defaultImage) v17State.defaultImage = media.find(m => m.mime?.startsWith('image/') && !m.missing)?.id || '';
  if (!v17State.defaultVideo) v17State.defaultVideo = media.find(m => m.mime === 'video/mp4' && !m.missing)?.id || '';
  v17RenderAssets();
  v17RenderProviders();
  v17RenderSelectedTargets();
  v17RenderHub();
  v17RenderWeek();
  return res;
};
