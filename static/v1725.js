/* TimeSave Social V17.25 · UX Polish, Sorting, Onboarding, Tab Session & Pro Video Workspace */
'use strict';

const V1725_SESSION_KEY = 'timesave_tab_token';
let v1725ActiveVideoTab = 'basis';
let v1725ActiveAccountTab = 'all';

// 1. Optional branding (makes giving a dedicated instance to another person effortless)
async function v1725LoadBranding() {
  try {
    const r = await fetch('/api/branding');
    if (!r.ok) return;
    const b = await r.json();
    if (!b.brand_name) return;
    if ($('v1725BrandName')) $('v1725BrandName').textContent = b.brand_name;
    if ($('v1725BrandSub') && b.brand_subtitle) $('v1725BrandSub').textContent = b.brand_subtitle;
    if ($('v1725LoginEyebrow')) $('v1725LoginEyebrow').textContent = 'BY SOLVETEC · WILLKOMMEN';
    if ($('v1725TopEyebrow')) $('v1725TopEyebrow').textContent = b.brand_name.toUpperCase() + ' · ' + (b.brand_subtitle || 'BY SOLVETEC');
    document.title = b.brand_name + ' · by Solvetec';
  } catch {}
}

// 2. Password reveal + tab-scoped sessionStorage persistence (survives F5, cleared when tab closes)
function v1725TogglePassword() {
  const input = $('admin'), btn = $('v1725TogglePw');
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  if (btn) btn.textContent = show ? '🙈' : '👁';
}

function v1725Logout() {
  try { sessionStorage.removeItem(V1725_SESSION_KEY); } catch {}
  auth = '';
  if ($('admin')) $('admin').value = '';
  if ($('appShell')) $('appShell').hidden = true;
  if ($('loginScreen')) $('loginScreen').hidden = false;
  toast('Sicher aus diesem Browser-Tab abgemeldet.');
}

const v1725PrevLogin = login;
login = async function() {
  await v1725PrevLogin();
  if (auth && $('appShell') && !$('appShell').hidden) {
    try { sessionStorage.setItem(V1725_SESSION_KEY, auth); } catch {}
  }
};

// Auto-restore token within the same tab on reload (e.g. after F5)
window.addEventListener('DOMContentLoaded', async () => {
  v1725LoadBranding();
  v1725InitSettingsBadges();
  v1725TagAccountCards();
  v1725TagVideoGroups();
  v1725VideoTab('basis');
  try {
    const saved = sessionStorage.getItem(V1725_SESSION_KEY);
    if (saved && $('admin')) {
      try { await v18FinishSession(saved); } catch { auth = ''; sessionStorage.removeItem(V1725_SESSION_KEY); }
    }
    if (!auth && !new URLSearchParams(location.search).has('invite')) {
      const response = await fetch('/api/auth/resume', {method:'POST'});
      if (response.ok) {
        const body = await response.json();
        if (body.token) await v18FinishSession(body.token);
      }
    }
  } catch {}
});

// 3. Extend media sorting with 'big' and 'small' (file size)
const v1725PrevSortMedia = v17SortMedia;
v17SortMedia = function(kind, search, sort) {
  if (sort === 'big' || sort === 'small') {
    const list = v1725PrevSortMedia(kind, search, 'new');
    list.sort((a, b) => sort === 'big' ? ((b.bytes || 0) - (a.bytes || 0)) : ((a.bytes || 0) - (b.bytes || 0)));
    return list;
  }
  return v1725PrevSortMedia(kind, search, sort);
};

// 4. Dashboard: Interactive 3-Step Onboarding Checklist & Upcoming Posts
function v1725RenderDashboardExtras() {
  const itemsEl = $('v1725ChecklistItems');
  const barEl = $('v1725ChecklistBar');
  const badgeEl = $('v1725ChecklistBadge');
  if (itemsEl) {
    const step1 = accounts.length > 0;
    const step2 = media.some(m => !m.missing);
    const step3 = jobs.some(j => j.status !== 'cancelled');
    const doneCount = [step1, step2, step3].filter(Boolean).length;
    if (badgeEl) {
      badgeEl.textContent = doneCount + ' / 3 erledigt';
      badgeEl.className = 'pill ' + (doneCount === 3 ? 'green' : 'amber');
    }
    if (barEl) barEl.style.width = Math.round((doneCount / 3) * 100) + '%';
    const steps = [
      { done: step1, title: '1 · Erste Plattform verbinden', desc: step1 ? accounts.length + ' Konto/Konten verbunden' : 'Instagram, Facebook, Telegram, TikTok oder YouTube verknüpfen', action: () => nav('accounts'), label: 'Konten öffnen' },
      { done: step2, title: '2 · Bild oder Video hochladen', desc: step2 ? media.filter(m => !m.missing).length + ' Datei(en) in deiner Mediathek' : 'JPG, PNG oder MP4 direkt in TimeSave Social laden', action: () => nav('publish'), label: 'Hochladen' },
      { done: step3, title: '3 · Ersten Beitrag planen oder testen', desc: step3 ? jobs.filter(j => j.status !== 'cancelled').length + ' Beitrag/Beiträge in Planung & Archiv' : 'Medium, Ziel und Zeitpunkt wählen und bestätigen', action: () => nav('publish'), label: 'Loslegen' },
    ];
    itemsEl.replaceChildren();
    for (const s of steps) {
      const row = document.createElement('div');
      row.className = 'v1725-step-row' + (s.done ? ' done' : '');
      const left = document.createElement('div');
      left.innerHTML = `<strong>${s.done ? '✓ ' : '○ '}${esc(s.title)}</strong><small>${esc(s.desc)}</small>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = s.done ? 'outline tiny' : 'tiny';
      btn.textContent = s.done ? 'Öffnen' : s.label;
      btn.addEventListener('click', s.action);
      row.append(left, btn);
      itemsEl.appendChild(row);
    }
  }
  const upEl = $('v1725UpcomingList');
  if (upEl) {
    const upcoming = jobs
      .filter(j => j.status === 'scheduled' || j.status === 'awaiting_confirmation')
      .sort((a, b) => (a.due_at || '').localeCompare(b.due_at || ''))
      .slice(0, 4);
    if (!upcoming.length) {
      upEl.innerHTML = '<p class="v17-caption">Noch keine anstehenden Beiträge. Erstelle deinen nächsten Beitrag über „Veröffentlichen“.</p>';
    } else {
      upEl.innerHTML = upcoming.map(j =>
        `<div class="v1725-up-item"><div><strong>${icon[j.platform] || ''} ${esc(j.original_name)}</strong>` +
        `<small>${new Date(j.due_at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })} · ${esc(fmtNames[j.format] || j.format)}</small></div>` +
        `<span class="pill amber">${j.status === 'awaiting_confirmation' ? 'Verarbeitet' : 'Geplant'}</span></div>`
      ).join('');
    }
  }
}

// 5. Dynamic 4-Step Flow Indicator on #publish
function v1725UpdatePublishFlow() {
  const steps = document.querySelectorAll('#publish .v17-flow > span');
  if (steps.length < 4) return;
  const hasMedia = !!(v17State.defaultImage || v17State.defaultVideo || v17State.targets.some(t => t.mediaId));
  const hasTargets = v17State.targets.length > 0;
  const sendMode = document.querySelector('input[name="v17SendMode"]:checked')?.value || 'schedule';
  const hasWhen = sendMode === 'now' || !!$('v17Due')?.value;
  const ready = hasMedia && hasTargets && hasWhen;
  const states = [hasMedia, hasTargets, hasTargets && hasWhen, ready];
  let currentIdx = states.findIndex(ok => !ok);
  if (currentIdx === -1) currentIdx = 3;
  steps.forEach((el, idx) => {
    el.classList.toggle('done', states[idx] && idx < currentIdx);
    el.classList.toggle('current', idx === currentIdx);
  });
}

const v1725PrevRenderSelected = v17RenderSelectedTargets;
v17RenderSelectedTargets = function() {
  v1725PrevRenderSelected();
  v1725UpdatePublishFlow();
};
['v17Caption', 'v17Due'].forEach(id => $(id)?.addEventListener('input', v1725UpdatePublishFlow));
document.querySelectorAll('input[name="v17SendMode"]').forEach(r => r.addEventListener('change', v1725UpdatePublishFlow));

// 6. Queue: Quick Status Pills + Real Sorting
function v1725RenderQueuePills() {
  const box = $('v1725QueuePills');
  if (!box) return;
  const current = $('jobFilterState')?.value || '';
  const counts = {
    '': jobs.length,
    scheduled: jobs.filter(j => j.status === 'scheduled').length,
    published: jobs.filter(j => ['published', 'published_manual'].includes(j.status)).length,
    needs_review: jobs.filter(j => j.status === 'needs_review').length,
    manual: jobs.filter(j => j.status === 'manual').length,
  };
  const defs = [
    ['', 'Alle (' + counts[''] + ')'],
    ['scheduled', '⏳ Geplant (' + counts.scheduled + ')'],
    ['published', '✅ Veröffentlicht (' + counts.published + ')'],
    ['needs_review', '⚠️ Prüfen (' + counts.needs_review + ')'],
    ['manual', '✋ Manuell (' + counts.manual + ')'],
  ];
  box.innerHTML = defs.map(([val, label]) =>
    `<button type="button" class="${current === val ? 'selected' : ''}" data-qstate="${esc(val)}">${esc(label)}</button>`
  ).join('');
  box.querySelectorAll('[data-qstate]').forEach(b => b.addEventListener('click', () => {
    if ($('jobFilterState')) $('jobFilterState').value = b.dataset.qstate;
    renderJobs();
  }));
}

renderJobs = function() {
  v1725RenderQueuePills();
  const platform = $('jobFilterPlatform')?.value || '';
  const state = $('jobFilterState')?.value || '';
  const query = ($('jobSearch')?.value || '').toLowerCase().trim();
  const sortBy = $('v1725JobSort')?.value || 'due_desc';

  const filtered = jobs.filter(j =>
    (!platform || j.platform === platform) &&
    (!state || (state === 'published' ? ['published', 'published_manual'].includes(j.status) : j.status === state)) &&
    (!query || [j.original_name, j.caption, j.result, j.platform, new Date(j.due_at).toLocaleDateString('de-DE')].join(' ').toLowerCase().includes(query))
  );

  if (sortBy === 'due_asc') {
    const rank = s => s === 'scheduled' ? 0 : s === 'awaiting_confirmation' ? 1 : s === 'needs_review' ? 2 : 3;
    filtered.sort((a, b) => rank(a.status) - rank(b.status) || (a.due_at || '').localeCompare(b.due_at || ''));
  } else if (sortBy === 'due_old') {
    filtered.sort((a, b) => (a.due_at || '').localeCompare(b.due_at || ''));
  } else if (sortBy === 'platform') {
    filtered.sort((a, b) => (a.platform || '').localeCompare(b.platform || '') || (b.due_at || '').localeCompare(a.due_at || ''));
  } else if (sortBy === 'status') {
    filtered.sort((a, b) => (a.status || '').localeCompare(b.status || '') || (b.due_at || '').localeCompare(a.due_at || ''));
  } else {
    filtered.sort((a, b) => (b.due_at || '').localeCompare(a.due_at || ''));
  }

  $('jobRows').innerHTML = filtered.map(j => {
    const st = stateLabels[j.status] || [j.status, 'gray'];
    let buttons = '';
    if (j.status === 'scheduled') buttons = `<button class="outline tiny" onclick="editJob('${esc(j.id)}')">✏️ Bearbeiten</button> <button class="outline tiny" onclick="jobAction('${esc(j.id)}','cancel')">Stornieren</button>`;
    if (j.status === 'manual') buttons = `<button class="outline tiny" onclick="downloadMedia('${esc(j.media_id)}')">Bild ↓</button> <button class="outline tiny" onclick="jobAction('${esc(j.id)}','mark-published')">Erledigt ✓</button>`;
    if (j.status === 'needs_review') buttons = `<button class="danger tiny" onclick="jobAction('${esc(j.id)}','retry')">Nach Prüfung erneut</button>`;
    const pp = j.publication_progress;
    const progress = j.status === 'processing' ? `<div><progress max="100" ${j.platform === 'telegram_story' && pp?.progress ? 'value="'+Math.min(99,Number(pp.progress)||0)+'"' : ''} style="width:100%;accent-color:var(--accent,#a78bfa)"></progress><small>${esc(pp?.message || 'Wird verarbeitet …')}</small></div>` : '';
    const waiting = j.waiting_for ? `<br><span class="pill amber">⏳ Wartet auf Karte ${j.waiting_for}</span>` : '';
    return `<tr><td class="nowrap">${new Date(j.due_at).toLocaleString('de-DE')}</td><td>${esc(j.original_name)}${j.series_id ? `<br><small>🔮 Karte ${j.position} / 4</small>` : ''}</td><td>${icon[j.platform] || ''} ${esc(providers[j.platform]?.name || j.platform)}<br><small>${esc(fmtNames[j.format] || j.format)}</small></td><td><span class="pill ${st[1]}">${esc(st[0])}</span>${waiting}${progress}</td><td>${esc(j.result || '')}<br><small>${esc(j.caption || '')}</small></td><td><div class="row">${buttons}</div></td></tr>`;
  }).join('') || '<tr><td colspan="6">Keine passenden Veröffentlichungen.</td></tr>';
};

// 7. Accounts: Clean Category Subtabs (ends visual overwhelm)
function v1725TagAccountCards() {
  const cards = Array.from(document.querySelectorAll('#accounts > .card'));
  cards.forEach((card, idx) => {
    let group = 'overview';
    if (idx === 0) group = 'overview';
    else if (card.id === 'v1712TelegramPanel' || card.id === 'v16TelegramStoryConnect' || card.querySelector('#telegramToken')) group = 'telegram';
    else if (card.classList.contains('meta-card')) group = 'meta';
    else if (card.id === 'v1712TikTokPanel' || card.textContent.includes('TikTok for Developers')) group = 'tiktok';
    card.dataset.accGroup = group;
  });
}

function v1725AccountTab(tab) {
  v1725ActiveAccountTab = tab || 'all';
  document.querySelectorAll('#v1725AccountTabs button').forEach(b => b.classList.toggle('selected', b.dataset.accTab === v1725ActiveAccountTab));
  document.querySelectorAll('#accounts > .card').forEach(card => {
    const g = card.dataset.accGroup || 'overview';
    const visible = g === 'overview' || v1725ActiveAccountTab === 'all' || g === v1725ActiveAccountTab;
    card.classList.toggle('v1725-hidden', !visible);
  });
  v189FilterAccounts();
}

function v189FilterAccounts() {
  const groups = {meta:['facebook','instagram'], telegram:['telegram','telegram_story'], tiktok:['tiktok','youtube']};
  const allowed=groups[v1725ActiveAccountTab];
  document.querySelectorAll('#connectionCards > .connection').forEach(card=>card.classList.toggle('v1725-hidden', !!allowed && !allowed.includes(card.dataset.provider)));
}

// 8. Settings: Add clear beginner-friendly priority badges
function v1725InitSettingsBadges() {
  const summaries = document.querySelectorAll('#settings details > summary');
  summaries.forEach(sum => {
    if (sum.querySelector('.v1725-badge')) return;
    const text = sum.textContent || '';
    const badge = document.createElement('span');
    if (text.includes('Unified Login') || text.includes('Facebook')) {
      badge.className = 'v1725-badge main';
      badge.textContent = 'Empfohlen';
    } else if (text.includes('YouTube') || text.includes('TikTok')) {
      badge.className = 'v1725-badge opt';
      badge.textContent = 'Optional';
    } else {
      badge.className = 'v1725-badge alt';
      badge.textContent = 'Nur Alternative';
    }
    sum.appendChild(badge);
  });
}

// 9. Pro Video Editor: Tool Tabs, 1-Click Style Presets, ±1s Scrubbing, Shortcuts, Duplicate Layer, Export Summary
function v1725TagVideoGroups() {
  const panel = $('v1725VideoControls');
  if (!panel) return;
  let currentGroup = 'basis';
  for (const child of Array.from(panel.children)) {
    if (child.id === 'v1725VideoTabs') continue;
    if (child.dataset.vgroup) continue;
    if (child.classList.contains('v1724-panel')) {
      child.dataset.vgroup = 'cut';
      continue;
    }
    if (child.classList.contains('v177-section-head')) {
      const step = child.querySelector('.v177-step')?.textContent?.trim();
      if (step === '01') currentGroup = 'basis';
      else if (step === '02') currentGroup = 'cut';
      else if (step === '03') currentGroup = 'text';
      else if (step === '04') currentGroup = 'export';
    }
    child.dataset.vgroup = currentGroup;
  }
}

function v1725VideoTab(tab) {
  v1725ActiveVideoTab = tab || 'basis';
  document.querySelectorAll('#v1725VideoTabs button').forEach(b => b.classList.toggle('selected', b.dataset.vtab === v1725ActiveVideoTab));
  const panel = $('v1725VideoControls');
  if (!panel) return;
  for (const child of Array.from(panel.children)) {
    if (child.id === 'v1725VideoTabs') continue;
    const grp = child.dataset.vgroup || 'basis';
    child.classList.toggle('v1725-hidden', v1725ActiveVideoTab !== 'all' && grp !== v1725ActiveVideoTab);
  }
  v1725UpdateExportSummary();
}

function v1725UpdateExportSummary() {
  const el = $('v1725ExportSummary');
  if (!el) return;
  const id = $('v9VideoSource')?.value;
  const item = media.find(m => m.id === id);
  if (!item) {
    el.innerHTML = '<b>Noch kein Medium gewählt.</b> Wähle unter „1. Basis & Look“ zuerst ein Video oder Bild aus.';
    return;
  }
  const fmtNamesLocal = { story: '9:16 Hochkant', square: '1:1 Quadrat', portrait: '4:5 Feed', landscape: '16:9 Querformat' };
  const mode = document.querySelector('input[name="v177LengthMode"]:checked')?.value || 'full';
  const speed = Number($('v1724Speed')?.value || 1);
  const vol = Number($('v1724Volume')?.value ?? 100);
  const rot = Number($('v1724Rotation')?.value || 0);
  const mirror = !!$('v1724Mirror')?.checked;
  const activeTexts = (v177State?.layers || []).filter(l => (l.title || '').trim() || (l.subtitle || '').trim() || (l.badge || '').trim()).length;
  const lenText = v177State?.isVideo
    ? (mode === 'trim' ? ('Ausschnitt ' + ($('v9VideoDuration')?.value || '?') + ' s ab ' + ($('v9VideoTrim')?.value || '0') + ' s') : ('Komplettes Video' + (v177State.duration ? ' (' + v177FmtClock(v177State.duration / speed) + ')' : '')))
    : ('Foto-Video (' + ($('v177PhotoSeconds')?.value || 8) + ' s)');
  el.innerHTML =
    `<b>Export-Übersicht:</b> ${esc(item.original_name)}<br>` +
    `Format: <b>${esc(fmtNamesLocal[$('v9VideoFormat')?.value] || '9:16')}</b> · Länge: <b>${esc(lenText)}</b><br>` +
    `Tempo: <b>${speed}×</b> · Ton: <b>${vol === 0 ? 'Stumm' : vol + ' %'}</b>` +
    (rot ? ` · Drehung: <b>${rot}°</b>` : '') +
    (mirror ? ' · <b>Gespiegelt</b>' : '') +
    ` · Texteinblendungen: <b>${activeTexts}</b>`;
}

function v1725VideoPreset(name) {
  const presets = {
    royal:  { filter: 'cool', bg: 'blur', color: '#fff3dc', opacity: '76', fade: true },
    warm:   { filter: 'warm', bg: 'cover', color: '#fff4d4', opacity: '68', fade: true },
    cinema: { filter: 'vivid', bg: 'cover', color: '#ffffff', opacity: '60', fade: true },
    clean:  { filter: 'normal', bg: 'blur', color: '#ffffff', opacity: '75', fade: false },
  };
  const p = presets[name];
  if (!p) return;
  if ($('v9VideoFilter')) $('v9VideoFilter').value = p.filter;
  if ($('v179BackgroundMode')) $('v179BackgroundMode').value = p.bg;
  if ($('v9VideoColor')) $('v9VideoColor').value = p.color;
  if ($('v179BoxOpacity')) $('v179BoxOpacity').value = p.opacity;
  if ($('v9VideoFade')) $('v9VideoFade').checked = p.fade;
  if (typeof v177SyncInputsToLayer === 'function') v177SyncInputsToLayer();
  v1725UpdateExportSummary();
  toast('Video-Stil „' + name + '“ angewendet.');
}

function v1725VideoReset() {
  if ($('v9VideoFilter')) $('v9VideoFilter').value = 'normal';
  if ($('v179BackgroundMode')) $('v179BackgroundMode').value = 'cover';
  if ($('v1724Speed')) $('v1724Speed').value = '1';
  if ($('v1724Volume')) $('v1724Volume').value = '100';
  if ($('v1724Rotation')) $('v1724Rotation').value = '0';
  if ($('v1724Mirror')) $('v1724Mirror').checked = false;
  if ($('v9VideoFade')) $('v9VideoFade').checked = false;
  const fullRadio = document.querySelector('input[name="v177LengthMode"][value="full"]');
  if (fullRadio) fullRadio.checked = true;
  if (typeof v177UpdateLengthPanels === 'function') v177UpdateLengthPanels();
  if (typeof v1724ApplyPreviewTransform === 'function') v1724ApplyPreviewTransform();
  if (typeof v177SyncInputsToLayer === 'function') v177SyncInputsToLayer();
  v1725UpdateExportSummary();
  toast('Video-Einstellungen auf Original zurückgesetzt.');
}

function v1725DuplicateLayer() {
  if (!window.v177State) return;
  if (v177State.layers.length >= 8) { toast('Maximal 8 Texteinblendungen erreicht.', true); return; }
  v177SyncInputsToLayer();
  const cur = v177CurrentLayer();
  const nextStart = Math.round(((cur.end_seconds != null ? cur.end_seconds : (cur.start_seconds + 5)) + 0.2) * 10) / 10;
  const durCap = v177State.isVideo && v177State.duration > 0 ? v177State.duration : 14400;
  const safeStart = Math.min(Math.max(0, durCap - 1), nextStart);
  const safeEnd = Math.round(Math.min(durCap, safeStart + 5) * 10) / 10;
  v177State.layers.push({ ...cur, start_seconds: safeStart, end_seconds: safeEnd });
  v177State.activeIndex = v177State.layers.length - 1;
  v177LoadLayerToInputs();
  v1725UpdateExportSummary();
  toast('Texteinblendung dupliziert (ab ' + safeStart + ' s).');
}

// ±1s fine scrubbing buttons & keyboard shortcuts inside Video Studio
$('v1725Back1')?.addEventListener('click', () => {
  const vid = $('v9PreviewVideo');
  if (vid && v177State?.isVideo) vid.currentTime = Math.max(0, vid.currentTime - 1);
});
$('v1725Next1')?.addEventListener('click', () => {
  const vid = $('v9PreviewVideo');
  if (vid && v177State?.isVideo) vid.currentTime = Math.min(v177State.duration || 0, vid.currentTime + 1);
});

document.addEventListener('keydown', ev => {
  if (!$('videoStudio')?.classList.contains('active')) return;
  const tag = (document.activeElement?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || document.activeElement?.isContentEditable) return;
  const vid = $('v9PreviewVideo');
  if (!vid || !v177State?.isVideo) return;
  if (ev.code === 'Space') {
    ev.preventDefault();
    if (vid.paused) vid.play().catch(() => {}); else vid.pause();
  } else if (ev.key === 'ArrowLeft') {
    ev.preventDefault();
    vid.currentTime = Math.max(0, vid.currentTime - 1);
  } else if (ev.key === 'ArrowRight') {
    ev.preventDefault();
    vid.currentTime = Math.min(v177State.duration || 0, vid.currentTime + 1);
  } else if (ev.key.toLowerCase() === 'i') {
    $('v1724SetIn')?.click();
  } else if (ev.key.toLowerCase() === 'o') {
    $('v1724SetOut')?.click();
  }
});

// Keep export summary & dashboard widgets fresh on any refresh/change
const v1725PrevRefresh = refresh;
refresh = async function() {
  const res = await v1725PrevRefresh();
  v1725RenderDashboardExtras();
  v1725UpdatePublishFlow();
  v1725UpdateExportSummary();
  return res;
};

// V18.8: refresh only the queue, without disturbing edits elsewhere.
let v188QueuePolling=false;
setInterval(async()=>{
 if(v188QueuePolling || document.hidden || !$('queue')?.classList.contains('active') || !auth) return;
 v188QueuePolling=true;
 try { jobs=await api('/api/jobs'); renderJobs(); } catch(e) { /* next poll; no duplicate submission */ } finally {v188QueuePolling=false;}
},3000);
