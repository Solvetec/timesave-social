/* TimeSave Social V17.7 + V17.9 · Full-Length Video Editor, Multi-Text Timeline & Draggable Overlay */
'use strict';

function v177MakeLayer(start = 0, end = 5) {
  return {
    title: '',
    subtitle: '',
    badge: '',
    title_color: '#ffffff',
    position: 'center',
    x_pct: 50,
    y_pct: 50,
    box_opacity: 72,
    text_scale: 100,
    start_seconds: start,
    end_seconds: end,
  };
}

const v177State = window.v177State = {
  layers: [v177MakeLayer(0, 5)],
  activeIndex: 0,
  duration: 0,
  isVideo: false,
  rendering: false,
};

function v177FmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}

function v177CurrentLayer() {
  return v177State.layers[v177State.activeIndex] || v177State.layers[0];
}

function v177LoadLayerToInputs() {
  const layer = v177CurrentLayer();
  if (!layer) return;
  if ($('v177ActiveLayer')) $('v177ActiveLayer').textContent = 'Text ' + (v177State.activeIndex + 1) + ' bearbeiten';
  if ($('v177LayerCount')) $('v177LayerCount').textContent = v177State.layers.length + ' / 8';
  if ($('v177TextStart')) $('v177TextStart').value = String(layer.start_seconds ?? 0);
  if ($('v177TextEnd')) $('v177TextEnd').value = String(layer.end_seconds ?? 5);
  if ($('v9VideoTitle')) $('v9VideoTitle').value = layer.title || '';
  if ($('v9VideoSubtitle')) $('v9VideoSubtitle').value = layer.subtitle || '';
  if ($('v9VideoBadge')) $('v9VideoBadge').value = layer.badge || '';
  if ($('v9VideoPosition')) $('v9VideoPosition').value = layer.position || 'center';
  if ($('v9VideoColor')) $('v9VideoColor').value = layer.title_color || '#ffffff';
  if ($('v179X')) $('v179X').value = String(layer.x_pct ?? 50);
  if ($('v179Y')) $('v179Y').value = String(layer.y_pct ?? 50);
  if ($('v179BoxOpacity')) $('v179BoxOpacity').value = String(layer.box_opacity ?? 72);
  if ($('v179FontScale')) $('v179FontScale').value = String(layer.text_scale ?? 100);
  if ($('v177RemoveLayer')) $('v177RemoveLayer').disabled = v177State.layers.length <= 1;
  v177RenderLayerChips();
  v177RenderTimeline();
  v177PaintOverlay();
}

function v177SyncInputsToLayer() {
  const layer = v177CurrentLayer();
  if (!layer) return;
  layer.start_seconds = Math.max(0, Number($('v177TextStart')?.value) || 0);
  const rawEnd = $('v177TextEnd')?.value;
  layer.end_seconds = rawEnd === '' ? null : Math.max(layer.start_seconds + 0.1, Number(rawEnd) || (layer.start_seconds + 5));
  layer.title = $('v9VideoTitle')?.value || '';
  layer.subtitle = $('v9VideoSubtitle')?.value || '';
  layer.badge = $('v9VideoBadge')?.value || '';
  layer.position = $('v9VideoPosition')?.value || 'center';
  layer.title_color = $('v9VideoColor')?.value || '#ffffff';
  layer.x_pct = Number($('v179X')?.value || 50);
  layer.y_pct = Number($('v179Y')?.value || 50);
  layer.box_opacity = Number($('v179BoxOpacity')?.value ?? 72);
  layer.text_scale = Number($('v179FontScale')?.value ?? 100);
  v177RenderLayerChips();
  v177RenderTimeline();
  v177PaintOverlay();
}

function v177RenderLayerChips() {
  const root = $('v177LayerList');
  if (!root) return;
  root.innerHTML = v177State.layers.map((l, idx) =>
    `<button type="button" class="v177-layer-chip ${idx === v177State.activeIndex ? 'active' : ''}" data-layer-idx="${idx}">Text ${idx + 1}${l.title ? ': ' + esc(l.title.slice(0, 14)) : ''}</button>`
  ).join('');
  root.querySelectorAll('[data-layer-idx]').forEach(b => b.addEventListener('click', () => {
    v177State.activeIndex = Number(b.dataset.layerIdx);
    v177LoadLayerToInputs();
    const vid = $('v9PreviewVideo');
    if (v177State.isVideo && vid && Number.isFinite(v177CurrentLayer().start_seconds)) {
      vid.currentTime = Math.min(v177State.duration || 0, v177CurrentLayer().start_seconds);
    }
  }));
}

function v177RenderTimeline() {
  const root = $('v177Timeline');
  if (!root) return;
  const total = Math.max(1, v177State.isVideo ? (v177State.duration || 10) : (Number($('v177PhotoSeconds')?.value) || 8));
  root.innerHTML = v177State.layers.map((l, idx) => {
    const start = Math.max(0, Math.min(total, Number(l.start_seconds) || 0));
    const end = Math.max(start + 0.2, Math.min(total, l.end_seconds != null ? Number(l.end_seconds) : total));
    const leftPct = (start / total) * 100;
    const widthPct = Math.max(4, ((end - start) / total) * 100);
    const label = (l.title || l.subtitle || 'Text ' + (idx + 1)).slice(0, 24);
    return `<div class="v177-tl-bar ${idx === v177State.activeIndex ? 'active' : ''}" data-tl-idx="${idx}">` +
      `<div class="v177-tl-seg" style="left:${leftPct.toFixed(1)}%;width:${widthPct.toFixed(1)}%">${esc(label)} (${start.toFixed(1)}–${end.toFixed(1)}s)</div></div>`;
  }).join('');
  root.querySelectorAll('[data-tl-idx]').forEach(bar => bar.addEventListener('click', () => {
    v177State.activeIndex = Number(bar.dataset.tlIdx);
    v177LoadLayerToInputs();
    const vid = $('v9PreviewVideo');
    if (v177State.isVideo && vid) vid.currentTime = Math.min(v177State.duration || 0, v177CurrentLayer().start_seconds || 0);
  }));
}

function v177PaintOverlay() {
  const frame = $('v9PreviewFrame');
  if (!frame) return;
  const fmt = $('v9VideoFormat')?.value || 'story';
  frame.classList.toggle('square', fmt === 'square');
  frame.classList.toggle('portrait', fmt === 'portrait');
  frame.classList.toggle('landscape', fmt === 'landscape');
  const bgMode = $('v179BackgroundMode')?.value || 'cover';
  const bgColor = $('v179BackgroundColor')?.value || '#221828';
  const fit = bgMode === 'cover' ? 'cover' : 'contain';
  if ($('v9PreviewImage')) $('v9PreviewImage').style.objectFit = fit;
  if ($('v9PreviewVideo')) $('v9PreviewVideo').style.objectFit = fit;
  frame.style.background = bgMode === 'solid' ? bgColor : '';

  const filters = {
    normal: 'none',
    warm: 'sepia(.18) saturate(1.2) brightness(1.07)',
    cool: 'hue-rotate(8deg) saturate(1.15)',
    vivid: 'saturate(1.4) contrast(1.08)',
    mono: 'grayscale(1)',
  };
  const fCss = filters[$('v9VideoFilter')?.value || 'normal'] || 'none';
  if ($('v9PreviewImage')) $('v9PreviewImage').style.filter = fCss;
  if ($('v9PreviewVideo')) $('v9PreviewVideo').style.filter = fCss;

  const vid = $('v9PreviewVideo');
  const t = v177State.isVideo && vid ? (vid.currentTime || 0) : null;
  let active = v177CurrentLayer();
  if (t !== null && vid && !vid.paused) {
    active = v177State.layers.find(l => t >= (l.start_seconds || 0) && t <= (l.end_seconds != null ? l.end_seconds : 1e9)) || null;
  }
  const overlay = $('v9PreviewOverlay'), badgeEl = $('v9PreviewBadge');
  if (!active || (!active.title?.trim() && !active.subtitle?.trim())) {
    if (overlay) overlay.hidden = true;
  } else if (overlay) {
    overlay.hidden = false;
    $('v9PreviewTitle').textContent = active.title || '';
    $('v9PreviewSubtitle').textContent = active.subtitle || '';
    $('v9PreviewTitle').style.color = active.title_color || '#ffffff';
    overlay.style.left = (active.x_pct ?? 50) + '%';
    overlay.style.top = (active.y_pct ?? 50) + '%';
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
    overlay.style.width = '84%';
    overlay.style.transform = 'translate(-50%, -50%) scale(' + ((active.text_scale ?? 100) / 100) + ')';
    const alpha = Math.max(0, Math.min(1, (active.box_opacity ?? 72) / 100));
    overlay.style.background = 'rgba(22, 15, 44, ' + alpha.toFixed(2) + ')';
  }
  if (badgeEl) {
    const bText = active?.badge?.trim() || '';
    badgeEl.textContent = bText;
    badgeEl.hidden = !bText;
  }
}

function v177UpdateLengthPanels() {
  const mode = document.querySelector('input[name="v177LengthMode"]:checked')?.value || 'full';
  if ($('v177TrimControls')) $('v177TrimControls').hidden = !v177State.isVideo || mode !== 'trim';
  if ($('v177PhotoControls')) $('v177PhotoControls').hidden = v177State.isVideo;
  if ($('v177VideoStatus')) {
    $('v177VideoStatus').textContent = v177State.isVideo
      ? (mode === 'trim' ? 'Freiwilliger Ausschnitt' : 'Komplettes Video bleibt erhalten')
      : 'Foto → Video (' + (Number($('v177PhotoSeconds')?.value) || 8) + ' s)';
  }
}

// Override v9PreviewVideoUpdate & v9ChooseVideoSource cleanly
v9PreviewVideoUpdate = function() {
  v177SyncInputsToLayer();
  v177UpdateLengthPanels();
};

const v177PrevChooseSource = v9ChooseVideoSource;
v9ChooseVideoSource = async function() {
  await v177PrevChooseSource();
  const id = $('v9VideoSource')?.value;
  const item = media.find(m => m.id === id);
  v177State.isVideo = item?.mime === 'video/mp4';
  v177State.duration = 0;
  v177UpdateLengthPanels();
  if ($('v177LengthInfo')) $('v177LengthInfo').textContent = item ? (v177State.isVideo ? 'Lade Videodauer …' : 'Foto ausgewählt') : 'Video auswählen';
  v177RenderTimeline();
  v177PaintOverlay();
};

// Video player transport wiring
const v177Vid = $('v9PreviewVideo');
if (v177Vid) {
  v177Vid.addEventListener('loadedmetadata', () => {
    v177State.duration = Number.isFinite(v177Vid.duration) ? v177Vid.duration : 0;
    if ($('v177ClockTotal')) $('v177ClockTotal').textContent = v177FmtClock(v177State.duration);
    if ($('v177Scrubber')) { $('v177Scrubber').max = String(Math.max(1, v177State.duration)); $('v177Scrubber').value = '0'; }
    if ($('v177LengthInfo')) $('v177LengthInfo').textContent = 'Originaldauer: ' + v177FmtClock(v177State.duration);
    if ($('v9VideoDuration') && v177State.duration > 0) $('v9VideoDuration').value = String(Math.min(Math.round(v177State.duration * 10) / 10, 14400));
    v177RenderTimeline();
  });
  v177Vid.addEventListener('timeupdate', () => {
    if ($('v177ClockNow')) $('v177ClockNow').textContent = v177FmtClock(v177Vid.currentTime);
    if ($('v177Scrubber')) $('v177Scrubber').value = String(v177Vid.currentTime);
    v177PaintOverlay();
  });
  v177Vid.addEventListener('play', () => { if ($('v177PlayPause')) $('v177PlayPause').textContent = '⏸ Pause'; });
  v177Vid.addEventListener('pause', () => { if ($('v177PlayPause')) $('v177PlayPause').textContent = '▶ Abspielen'; v177PaintOverlay(); });
}

$('v177PlayPause')?.addEventListener('click', () => {
  if (!v177Vid || !v177State.isVideo) return;
  if (v177Vid.paused) v177Vid.play().catch(() => {});
  else v177Vid.pause();
});
$('v177Back5')?.addEventListener('click', () => { if (v177Vid && v177State.isVideo) v177Vid.currentTime = Math.max(0, v177Vid.currentTime - 5); });
$('v177Next5')?.addEventListener('click', () => { if (v177Vid && v177State.isVideo) v177Vid.currentTime = Math.min(v177State.duration || 0, v177Vid.currentTime + 5); });
$('v177Scrubber')?.addEventListener('input', () => { if (v177Vid && v177State.isVideo) v177Vid.currentTime = Number($('v177Scrubber').value) || 0; });

document.querySelectorAll('input[name="v177LengthMode"]').forEach(r => r.addEventListener('change', v177UpdateLengthPanels));
$('v177PhotoSeconds')?.addEventListener('input', () => { v177UpdateLengthPanels(); v177RenderTimeline(); });

$('v177AddLayer')?.addEventListener('click', () => {
  if (v177State.layers.length >= 8) { toast('Maximal 8 Texteinblendungen pro Video.', true); return; }
  const start = v177State.isVideo && v177Vid ? Math.round(v177Vid.currentTime * 10) / 10 : 0;
  const end = v177State.duration > 0 ? Math.min(v177State.duration, start + 5) : start + 5;
  v177State.layers.push(v177MakeLayer(start, Math.round(end * 10) / 10));
  v177State.activeIndex = v177State.layers.length - 1;
  v177LoadLayerToInputs();
});
$('v177RemoveLayer')?.addEventListener('click', () => {
  if (v177State.layers.length <= 1) return;
  v177State.layers.splice(v177State.activeIndex, 1);
  v177State.activeIndex = Math.max(0, v177State.activeIndex - 1);
  v177LoadLayerToInputs();
});
$('v177UsePlayhead')?.addEventListener('click', () => {
  const t = v177State.isVideo && v177Vid ? Math.round(v177Vid.currentTime * 10) / 10 : 0;
  if ($('v177TextStart')) $('v177TextStart').value = String(t);
  if ($('v177TextEnd') && Number($('v177TextEnd').value) <= t) {
    const maxD = v177State.duration || (t + 5);
    $('v177TextEnd').value = String(Math.round(Math.min(maxD, t + 5) * 10) / 10);
  }
  v177SyncInputsToLayer();
});
$('v177AddFive')?.addEventListener('click', () => {
  const start = Number($('v177TextStart')?.value) || 0;
  const maxD = v177State.isVideo && v177State.duration > 0 ? v177State.duration : 14400;
  if ($('v177TextEnd')) $('v177TextEnd').value = String(Math.round(Math.min(maxD, start + 5) * 10) / 10);
  v177SyncInputsToLayer();
});

['v177TextStart', 'v177TextEnd', 'v179X', 'v179Y', 'v179BoxOpacity', 'v179FontScale', 'v179BackgroundMode', 'v179BackgroundColor'].forEach(id => {
  $(id)?.addEventListener('input', v177SyncInputsToLayer);
  $(id)?.addEventListener('change', v177SyncInputsToLayer);
});
$('v9VideoPosition')?.addEventListener('change', () => {
  const map = { top: 24, center: 50, bottom: 76 };
  const y = map[$('v9VideoPosition').value];
  if (y && $('v179Y')) $('v179Y').value = String(y);
  v177SyncInputsToLayer();
});
$('v179CenterText')?.addEventListener('click', () => {
  if ($('v179X')) $('v179X').value = '50';
  if ($('v179Y')) $('v179Y').value = '50';
  v177SyncInputsToLayer();
});

// Direct drag & keyboard positioning on the preview overlay
const v177Overlay = $('v9PreviewOverlay');
if (v177Overlay) {
  let dragging = false;
  const setFromEvent = ev => {
    const rect = $('v9PreviewFrame').getBoundingClientRect();
    const x = Math.max(5, Math.min(95, Math.round(((ev.clientX - rect.left) / rect.width) * 100)));
    const y = Math.max(5, Math.min(95, Math.round(((ev.clientY - rect.top) / rect.height) * 100)));
    if ($('v179X')) $('v179X').value = String(x);
    if ($('v179Y')) $('v179Y').value = String(y);
    v177SyncInputsToLayer();
  };
  v177Overlay.addEventListener('pointerdown', ev => {
    dragging = true;
    v177Overlay.setPointerCapture(ev.pointerId);
    setFromEvent(ev);
  });
  v177Overlay.addEventListener('pointermove', ev => { if (dragging) setFromEvent(ev); });
  v177Overlay.addEventListener('pointerup', () => { dragging = false; });
  v177Overlay.addEventListener('keydown', ev => {
    const step = ev.shiftKey ? 5 : 2;
    let x = Number($('v179X')?.value || 50), y = Number($('v179Y')?.value || 50);
    if (ev.key === 'ArrowLeft') x = Math.max(5, x - step);
    else if (ev.key === 'ArrowRight') x = Math.min(95, x + step);
    else if (ev.key === 'ArrowUp') y = Math.max(5, y - step);
    else if (ev.key === 'ArrowDown') y = Math.min(95, y + step);
    else return;
    ev.preventDefault();
    if ($('v179X')) $('v179X').value = String(x);
    if ($('v179Y')) $('v179Y').value = String(y);
    v177SyncInputsToLayer();
  });
}

// Direct upload inside Video Studio
$('v177StudioUpload')?.addEventListener('change', async ev => {
  const file = ev.target.files?.[0];
  if (!file) return;
  const st = $('v177StudioUploadStatus');
  if (st) st.textContent = '⏳ Lade ' + file.name + ' hoch …';
  try {
    const res = await v17TransmitMedia(file, msg => { if (st) st.textContent = '⏳ ' + msg; });
    await refresh();
    if ($('v9VideoSource')) $('v9VideoSource').value = res.id;
    await v9ChooseVideoSource();
    if (st) st.textContent = '✓ ' + file.name + ' geladen' + (res.optimized ? ' (automatisch optimiert)' : '') + '.';
    toast('Datei importiert und im Videoeditor geöffnet.');
  } catch (e) {
    if (st) st.textContent = '⚠ ' + e.message;
    toast(e.message, true);
  } finally {
    ev.target.value = '';
  }
});

// Upgrade v9RenderVideo to full V17.7 + V17.24 capabilities (full length by default!)
v9RenderVideo = async function(continuePlanning) {
  if (v177State.rendering) return;
  const mid = $('v9VideoSource')?.value;
  if (!mid) { toast('Bitte zuerst ein Bild oder Video auswählen.', true); return; }
  v177SyncInputsToLayer();
  const mode = document.querySelector('input[name="v177LengthMode"]:checked')?.value || 'full';
  let seconds = null;
  let startSeconds = 0;
  if (v177State.isVideo) {
    if (mode === 'trim') {
      startSeconds = Math.max(0, Number($('v9VideoTrim')?.value) || 0);
      seconds = Number($('v9VideoDuration')?.value);
      if (!Number.isFinite(seconds) || seconds < 1) { toast('Bitte eine gültige Ausschnitt-Länge (mind. 1 Sek.) eingeben.', true); return; }
    }
  } else {
    seconds = Math.max(1, Number($('v177PhotoSeconds')?.value) || 8);
  }
  const activeLayers = v177State.layers.filter(l => (l.title || '').trim() || (l.subtitle || '').trim() || (l.badge || '').trim());
  const payload = {
    media_id: mid,
    seconds,
    start_seconds: startSeconds,
    format: $('v9VideoFormat')?.value || 'story',
    motion: $('v9VideoMotion')?.value || 'static',
    filter: $('v9VideoFilter')?.value || 'normal',
    background_mode: $('v179BackgroundMode')?.value || 'cover',
    background_color: $('v179BackgroundColor')?.value || '#221828',
    fade: !!$('v9VideoFade')?.checked,
    playback_speed: v177State.isVideo ? Number($('v1724Speed')?.value || 1) : 1,
    audio_volume: Number($('v1724Volume')?.value ?? 100),
    rotation: Number($('v1724Rotation')?.value || 0),
    mirror: !!$('v1724Mirror')?.checked,
    text_layers: activeLayers,
  };
  try {
    v177State.rendering = true;
    if ($('v9RenderOnly')) $('v9RenderOnly').disabled = true;
    if ($('v9RenderPlan')) $('v9RenderPlan').disabled = true;
    if ($('v9VideoProgress')) $('v9VideoProgress').textContent = '⏳ Dein MP4 wird gerendert. Bitte die Seite geöffnet lassen …';
    const bar = $('v184VideoBar'), info = $('v184VideoInfo');
    bar.hidden=false; bar.value=0; info.textContent='Videoexport wird gestartet …';
    const started = await json('/api/studio/video-export', payload);
    let res, failures=0;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      try { res = await api('/api/studio/slideshow/' + encodeURIComponent(started.job_id), {cache:'no-store'}); failures=0; }
      catch (err) {
        if (++failures >= 8 || !/^HTTP (502|503|504)$|Failed to fetch|Load failed|NetworkError/i.test(err.message)) throw err;
        info.textContent='Verbindung wird wiederhergestellt …'; continue;
      }
      bar.value=res.progress; info.textContent=res.progress+'% · '+res.message;
      if (res.status==='error') throw new Error(res.message);
      if (res.status==='done') break;
    }
    await refresh();
    v17State.defaultVideo = res.id;
    chosen = res.id;
    if ($('v9VideoProgress')) $('v9VideoProgress').textContent = '✓ ' + res.message + ' (' + res.seconds + ' s)';
    if (continuePlanning) {
      nav('publish');
      v17SetKind('video');
      toast('Fertiges MP4 erstellt und für die Veröffentlichung ausgewählt.');
    } else {
      nav('mediaHub');
      v17HubKind('video');
      toast('Neues MP4 in der Mediathek gespeichert. Original unverändert.');
    }
  } catch (e) {
    if ($('v184VideoInfo')) $('v184VideoInfo').textContent = '⚠ ' + e.message;
    if ($('v9VideoProgress')) $('v9VideoProgress').textContent = '⚠ ' + e.message;
    toast(e.message, true);
  } finally {
    v177State.rendering = false;
    if ($('v9RenderOnly')) $('v9RenderOnly').disabled = false;
    if ($('v9RenderPlan')) $('v9RenderPlan').disabled = false;
  }
};

v177LoadLayerToInputs();
v177UpdateLengthPanels();
