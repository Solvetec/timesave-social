/* TimeSave Social V17.5 · Tagesmappen / Storys zum Teilen (WhatsApp Status & TikTok Stories) */
'use strict';
let v175Data = null;
let v175SelectedDay = '';

function v175IsoToday() {
  return new Date().toLocaleDateString('sv-SE');
}

function v175Today() {
  const today = v175IsoToday();
  if ($('v175StartDate')) $('v175StartDate').value = today;
  v175SelectedDay = today;
  v175Load();
}

function v175ChangeStart() {
  v175SelectedDay = $('v175StartDate')?.value || v175IsoToday();
  v175Load();
}

async function v175Load() {
  if (!auth) return;
  const start = $('v175StartDate')?.value || v175IsoToday();
  if ($('v175StartDate') && !$('v175StartDate').value) $('v175StartDate').value = start;
  const days = Number($('v175Range')?.value || 7);
  try {
    const res = await api('/api/storykit?start=' + encodeURIComponent(start) + '&days=' + encodeURIComponent(days));
    v175Data = res;
    const openTotal = (res.whatsapp_open || 0) + (res.tiktok_open || 0);
    if ($('v175NavCount')) $('v175NavCount').textContent = String(openTotal);
    if ($('v175QuickStats')) {
      $('v175QuickStats').textContent = res.total + ' Story-Vorlage(n) im Zeitraum · WhatsApp offen: ' +
        res.whatsapp_open + ' · TikTok-Story offen: ' + res.tiktok_open;
    }
    if (!v175SelectedDay || !res.days.some(d => d.date === v175SelectedDay)) {
      v175SelectedDay = res.days.find(d => d.total > 0)?.date || res.days[0]?.date || start;
    }
    v175RenderDays();
    v175RenderSelectedDay();
  } catch (e) {
    if ($('v175QuickStats')) $('v175QuickStats').textContent = '⚠ ' + e.message;
  }
}

function v175RenderDays() {
  const bar = $('v175Daybar');
  if (!bar || !v175Data) return;
  bar.innerHTML = v175Data.days.map(d => {
    const dt = new Date(d.date + 'T12:00:00');
    const open = d.whatsapp_open + d.tiktok_open;
    return `<button type="button" class="v175-daybtn ${d.date === v175SelectedDay ? 'selected' : ''}" data-day="${esc(d.date)}">` +
      `<strong>${dt.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}</strong>` +
      `<small>${d.total} Datei(en)${open ? ' · ' + open + ' offen' : ''}</small></button>`;
  }).join('');
  bar.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => {
    v175SelectedDay = b.dataset.day;
    v175RenderDays();
    v175RenderSelectedDay();
  }));
}

function v175RenderSelectedDay() {
  const cards = $('v175Cards');
  if (!cards || !v175Data) return;
  const dayObj = v175Data.days.find(d => d.date === v175SelectedDay);
  if ($('v175CurrentDay')) {
    const dt = v175SelectedDay ? new Date(v175SelectedDay + 'T12:00:00') : new Date();
    $('v175CurrentDay').textContent = dt.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  }
  if ($('v175Zip')) $('v175Zip').disabled = !dayObj || !dayObj.items.length;
  if (!dayObj || !dayObj.items.length) {
    cards.innerHTML = '<p class="v17-empty">Für diesen Tag sind noch keine geplanten Beiträge vorhanden.</p>';
    return;
  }
  cards.innerHTML = dayObj.items.map(item =>
    `<div class="v175-card">` +
    `<div class="v175-card-thumb"><img data-sk-thumb="${esc(item.media_id)}" alt="Vorschau"></div>` +
    `<div class="v175-card-body">` +
    `<div class="v17-flex"><strong>${esc(item.time)} · ${esc(item.filename)}</strong><span class="pill">${esc(item.platforms.join(', '))}</span></div>` +
    (item.caption ? `<p class="v175-card-caption">${esc(item.caption)}</p>` : '') +
    `<div class="v175-card-actions">` +
    `<button type="button" data-sk-wa-express="${esc(item.media_id)}" data-sk-key="${esc(item.key)}" data-sk-cap="${esc(item.caption)}">⚡ WhatsApp Status (Text + Teilen)</button>` +
    `<button type="button" class="outline" data-sk-share="whatsapp" data-sk-media="${esc(item.media_id)}" data-sk-cap="${esc(item.caption)}">💚 Teilen-Dialog</button>` +
    `<button type="button" class="outline" data-sk-share="tiktok" data-sk-media="${esc(item.media_id)}" data-sk-cap="${esc(item.caption)}">🎵 TikTok-Story teilen</button>` +
    `<button type="button" class="outline" data-sk-qr="${esc(item.media_id)}">📱 Handy-QR</button>` +
    `<button type="button" class="outline" data-sk-dl="${esc(item.media_id)}">⬇ Datei</button>` +
    (item.caption ? `<button type="button" class="outline" data-sk-copy="${esc(item.caption)}">📋 Text kopieren</button>` : '') +
    `</div>` +
    `<div class="v175-checks">` +
    `<label><input type="checkbox" data-sk-done="whatsapp_status" data-sk-key="${esc(item.key)}" ${item.channels.whatsapp_status ? 'checked' : ''}> WhatsApp-Status erledigt</label>` +
    `<label><input type="checkbox" data-sk-done="tiktok_story" data-sk-key="${esc(item.key)}" ${item.channels.tiktok_story ? 'checked' : ''}> TikTok-Story erledigt</label>` +
    `</div></div></div>`
  ).join('');
  cards.querySelectorAll('[data-sk-thumb]').forEach(img => loadImageInto(img, img.dataset.skThumb));
  cards.querySelectorAll('[data-sk-share]').forEach(b => b.addEventListener('click', () => {
    if (typeof v178OpenShare === 'function') v178OpenShare(b.dataset.skMedia, b.dataset.skShare, b.dataset.skCap || '');
    else downloadMedia(b.dataset.skMedia);
  }));
  cards.querySelectorAll('[data-sk-wa-express]').forEach(b => b.addEventListener('click', async () => {
    const cap = (b.dataset.skCap || '').trim();
    if (cap) {
      try {
        await navigator.clipboard.writeText(cap);
        toast('📋 Begleittext in Zwischenablage kopiert · Öffne WhatsApp-Übergabe …');
      } catch {
        toast('Öffne WhatsApp-Übergabe (Text bitte manuell kopieren).');
      }
    }
    if (typeof v178OpenShare === 'function') v178OpenShare(b.dataset.skMedia, 'whatsapp', cap);
    else downloadMedia(b.dataset.skMedia);
  }));
  cards.querySelectorAll('[data-sk-qr]').forEach(b => b.addEventListener('click', () => v14OpenMobileQr(b.dataset.skQr)));
  cards.querySelectorAll('[data-sk-dl]').forEach(b => b.addEventListener('click', () => downloadMedia(b.dataset.skDl)));
  cards.querySelectorAll('[data-sk-copy]').forEach(b => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.skCopy); toast('Begleittext kopiert.'); }
    catch { toast('Kopieren im Browser blockiert.', true); }
  }));
  cards.querySelectorAll('[data-sk-done]').forEach(cb => cb.addEventListener('change', async () => {
    try {
      await json('/api/storykit/' + encodeURIComponent(cb.dataset.skKey) + '/complete', {
        date: v175SelectedDay,
        channel: cb.dataset.skDone,
        done: cb.checked,
      });
      await v175Load();
    } catch (e) {
      cb.checked = !cb.checked;
      toast(e.message, true);
    }
  }));
}

async function v175CopyDayLink() {
  const url = location.origin + '/?storykit=' + encodeURIComponent(v175SelectedDay || v175IsoToday());
  try { await navigator.clipboard.writeText(url); toast('Tageslink kopiert: ' + url); }
  catch { toast(url); }
}

async function v175DownloadDay() {
  const day = v175SelectedDay || v175IsoToday();
  try {
    const resp = await fetch('/api/storykit/' + encodeURIComponent(day) + '/zip', { headers: { 'X-Admin-Token': auth } });
    if (!resp.ok) {
      let msg = 'ZIP konnte nicht erstellt werden.';
      try { const b = await resp.json(); if (b.detail) msg = b.detail; } catch {}
      throw new Error(msg);
    }
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'TimeSave_Social_Storys_' + day + '.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Tagespaket heruntergeladen.');
  } catch (e) {
    toast(e.message, true);
  }
}

const v175PrevRefresh = refresh;
refresh = async function() {
  const res = await v175PrevRefresh();
  v175Load();
  return res;
};


async function v207MarkAllWhatsAppDone() {
  if (!v175Data || !v175SelectedDay) return;
  const dayObj = v175Data.days.find(d => d.date === v175SelectedDay);
  if (!dayObj || !dayObj.items.length) return;
  const openItems = dayObj.items.filter(it => !it.channels.whatsapp_status);
  if (!openItems.length) {
    toast('Alle WhatsApp-Status-Beiträge dieses Tages sind bereits abgehakt.');
    return;
  }
  try {
    for (const item of openItems) {
      await json('/api/storykit/' + encodeURIComponent(item.key) + '/complete', {
        date: v175SelectedDay,
        channel: 'whatsapp_status',
        done: true,
      });
    }
    await v175Load();
    toast('✓ ' + openItems.length + ' WhatsApp-Status-Beitrag/Beiträge als erledigt markiert.');
  } catch (e) {
    toast(e.message, true);
  }
}
