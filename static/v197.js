/* TimeSave Social V19.9 – Präzises 9:16-Format + 90°-Drehkorrektur + direkte Foto-/Video-Kamera-Buttons */
(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);

  const camState = {
    stream: null,
    recorder: null,
    chunks: [],
    mode: 'photo', // 'photo' | 'video'
    facingMode: 'environment', // 'environment' | 'user'
    aspect: '9:16', // '9:16' | '1:1' | '16:9' | 'auto'
    extraRotateDeg: 0, // 0 | 90 | 180 | 270
    showGrid: true,
    recording: false,
    timerId: null,
    startedAt: 0,
    busy: false,
  };

  function notify(msg, isError) {
    if (typeof toast === 'function') toast(msg, !!isError);
    const st = byId('v197CamStatus');
    if (st) {
      st.textContent = msg;
      st.style.color = isError ? '#9d3151' : '#352c4d';
    }
  }

  function formatTimer(sec) {
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return m + ':' + s;
  }

  function stopTimer() {
    if (camState.timerId) {
      clearInterval(camState.timerId);
      camState.timerId = null;
    }
  }

  function stopStream() {
    stopTimer();
    if (camState.recorder && camState.recorder.state !== 'inactive') {
      try { camState.recorder.stop(); } catch (_) {}
    }
    camState.recorder = null;
    camState.recording = false;
    if (camState.stream) {
      try {
        camState.stream.getTracks().forEach((t) => t.stop());
      } catch (_) {}
      camState.stream = null;
    }
    const vid = byId('v197CamVideo');
    if (vid) vid.srcObject = null;
  }

  function applyStageAspect() {
    const frameBox = byId('v197CamFrameBox');
    const gridEl = byId('v197CamGrid');
    const vid = byId('v197CamVideo');
    if (gridEl) gridEl.hidden = !camState.showGrid;
    if (!frameBox) return;

    if (camState.aspect === '9:16') {
      frameBox.style.aspectRatio = '9 / 16';
      frameBox.style.maxWidth = '330px';
      frameBox.style.maxHeight = '540px';
      frameBox.style.margin = '10px auto';
    } else if (camState.aspect === '1:1') {
      frameBox.style.aspectRatio = '1 / 1';
      frameBox.style.maxWidth = '400px';
      frameBox.style.maxHeight = '400px';
      frameBox.style.margin = '10px auto';
    } else if (camState.aspect === '16:9') {
      frameBox.style.aspectRatio = '16 / 9';
      frameBox.style.maxWidth = '640px';
      frameBox.style.maxHeight = '360px';
      frameBox.style.margin = '10px auto';
    } else {
      frameBox.style.aspectRatio = '9 / 16';
      frameBox.style.maxWidth = '330px';
      frameBox.style.maxHeight = '540px';
      frameBox.style.margin = '10px auto';
    }

    if (vid) {
      const mirror = camState.facingMode === 'user' ? 'scaleX(-1)' : '';
      const rot = camState.extraRotateDeg ? ' rotate(' + camState.extraRotateDeg + 'deg)' : '';
      const scale = camState.extraRotateDeg % 180 !== 0 ? ' scale(1.35)' : '';
      vid.style.transform = (mirror + rot + scale).trim() || 'none';
      vid.style.objectFit = 'cover';
    }
  }

  function syncCamUi() {
    const stage = byId('v197CamStage');
    const modeLabel = byId('v197CamModeLabel');
    const recPill = byId('v197CamRecPill');
    const snapBtn = byId('v197CamSnapBtn');
    const recStartBtn = byId('v197CamRecStartBtn');
    const recStopBtn = byId('v197CamRecStopBtn');

    if (stage) stage.hidden = !camState.stream;
    applyStageAspect();

    if (modeLabel) {
      const aspTxt = camState.aspect === 'auto' ? '9:16 (Gerät)' : camState.aspect;
      modeLabel.textContent =
        (camState.mode === 'video' ? '🎬 Video' : '📸 Foto') +
        ' · ' +
        (camState.facingMode === 'user' ? 'Front' : 'Rückkamera') +
        ' · ' +
        aspTxt +
        (camState.extraRotateDeg ? ' · ' + camState.extraRotateDeg + '°' : '');
    }
    if (recPill) recPill.hidden = !camState.recording;
    if (snapBtn) {
      snapBtn.hidden = camState.mode !== 'photo';
      snapBtn.disabled = camState.busy;
    }
    if (recStartBtn) {
      recStartBtn.hidden = camState.mode !== 'video' || camState.recording;
      recStartBtn.disabled = camState.busy;
    }
    if (recStopBtn) {
      recStopBtn.hidden = camState.mode !== 'video' || !camState.recording;
      recStopBtn.disabled = camState.busy;
    }
  }

  function buildVideoConstraints() {
    const base = { facingMode: { ideal: camState.facingMode } };
    if (camState.aspect === '9:16') {
      base.width = { ideal: 720 };
      base.height = { ideal: 1280 };
      base.aspectRatio = { ideal: 9 / 16 };
    } else if (camState.aspect === '1:1') {
      base.width = { ideal: 1080 };
      base.height = { ideal: 1080 };
      base.aspectRatio = { ideal: 1 };
    } else if (camState.aspect === '16:9') {
      base.width = { ideal: 1280 };
      base.height = { ideal: 720 };
      base.aspectRatio = { ideal: 16 / 9 };
    } else {
      base.width = { ideal: 720 };
      base.height = { ideal: 1280 };
    }
    return base;
  }

  async function openCameraForSection(mode) {
    const targetMode = mode === 'video' ? 'video' : 'photo';
    if (typeof nav === 'function') nav('mediaHub');
    const studio = byId('v197CameraStudio');
    if (studio) studio.scrollIntoView({ behavior: 'smooth', block: 'start' });
    await openCamera(targetMode);
  }

  async function openCamera(mode) {
    if (camState.recording) {
      notify('Bitte zuerst die laufende Videoaufnahme stoppen.', true);
      return;
    }
    camState.mode = mode === 'video' ? 'video' : 'photo';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      notify('Live-Kamera wird hier nicht direkt geöffnet – nutze direkt den Geräte-Kamera-Button daneben.', true);
      return;
    }
    stopStream();
    notify('⏳ Kamera wird im Format ' + camState.aspect + ' gestartet …');
    try {
      const vConstraints = buildVideoConstraints();
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: vConstraints,
          audio: camState.mode === 'video',
        });
      } catch (_) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: camState.facingMode } },
            audio: camState.mode === 'video',
          });
        } catch (err2) {
          if (camState.mode === 'video') {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: { ideal: camState.facingMode } },
              audio: false,
            });
          } else {
            throw err2;
          }
        }
      }
      camState.stream = stream;
      const vid = byId('v197CamVideo');
      if (vid) {
        vid.srcObject = stream;
        await vid.play().catch(() => {});
      }
      syncCamUi();
      notify('Kamera aktiv (' + camState.aspect + '). Falls das Bild verdreht wirkt, nutze „↻ 90° drehen“ oder die Geräte-Kamera.');
    } catch (err) {
      stopStream();
      syncCamUi();
      notify('Kamera-Zugriff nicht freigegeben (' + (err.name || err.message || 'Berechtigung prüfen') + '). Nutze den Geräte-Kamera-Button.', true);
    }
  }

  async function switchCamera() {
    camState.facingMode = camState.facingMode === 'environment' ? 'user' : 'environment';
    camState.extraRotateDeg = 0;
    if (camState.stream) {
      await openCamera(camState.mode);
    } else {
      syncCamUi();
    }
  }

  function rotateCamera90() {
    camState.extraRotateDeg = (camState.extraRotateDeg + 90) % 360;
    syncCamUi();
    notify('Kamera-Ausrichtung auf ' + camState.extraRotateDeg + '° gesetzt.');
  }

  function closeCamera() {
    stopStream();
    syncCamUi();
    notify('Kamera geschlossen.');
  }

  function getOutputDimensions(aspectMode) {
    if (aspectMode === '1:1') return { dw: 1080, dh: 1080, ratio: 1 };
    if (aspectMode === '16:9') return { dw: 1280, dh: 720, ratio: 16 / 9 };
    // Default & explicit 9:16 portrait for TikTok / Reels / Stories
    return { dw: 720, dh: 1280, ratio: 9 / 16 };
  }

  function drawVideoToCanvas(vid, canvas) {
    const srcW = vid.videoWidth || 1280;
    const srcH = vid.videoHeight || 720;
    const { dw, dh, ratio } = getOutputDimensions(camState.aspect);
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0e0b1a';
    ctx.fillRect(0, 0, dw, dh);

    // Build an intermediate rotated canvas if user applied manual 90/180/270 rotation
    let sourceEl = vid;
    let effW = srcW;
    let effH = srcH;
    if (camState.extraRotateDeg % 360 !== 0) {
      const rotCanvas = document.createElement('canvas');
      const rad = (camState.extraRotateDeg * Math.PI) / 180;
      if (camState.extraRotateDeg % 180 !== 0) {
        rotCanvas.width = srcH;
        rotCanvas.height = srcW;
      } else {
        rotCanvas.width = srcW;
        rotCanvas.height = srcH;
      }
      const rctx = rotCanvas.getContext('2d');
      rctx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
      rctx.rotate(rad);
      rctx.drawImage(vid, -srcW / 2, -srcH / 2, srcW, srcH);
      sourceEl = rotCanvas;
      effW = rotCanvas.width;
      effH = rotCanvas.height;
    }

    const effRatio = effW / effH;
    let sw = effW;
    let sh = effH;
    let sx = 0;
    let sy = 0;
    if (effRatio > ratio) {
      sw = Math.round(effH * ratio);
      sx = Math.round((effW - sw) / 2);
    } else if (effRatio < ratio) {
      sh = Math.round(effW / ratio);
      sy = Math.round((effH - sh) / 2);
    }

    ctx.save();
    if (camState.facingMode === 'user') {
      ctx.translate(dw, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(sourceEl, sx, sy, sw, sh, 0, 0, dw, dh);
    ctx.restore();
  }

  async function uploadCapturedFile(file, kind) {
    camState.busy = true;
    syncCamUi();
    notify('⏳ Speichere ' + (kind === 'video' ? 'Video' : 'Foto') + ' in der Mediathek …');
    try {
      let res;
      if (typeof v17TransmitMedia === 'function') {
        res = await v17TransmitMedia(file, (msg) => notify('⏳ ' + msg), true);
      } else {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('optimize_video', 'true');
        const token = typeof auth !== 'undefined' ? auth : '';
        const r = await fetch('/api/media', {
          method: 'POST',
          headers: token ? { 'X-Admin-Token': token } : {},
          body: fd,
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.detail || 'Upload fehlgeschlagen');
        res = body;
      }

      if (typeof refresh === 'function') await refresh();
      if (typeof v17HubKind === 'function') {
        v17HubKind(kind === 'video' ? 'video' : 'image');
      }
      if (res && res.id && typeof v17State !== 'undefined' && v17State) {
        if (kind === 'video') v17State.defaultVideo = res.id;
        else v17State.defaultImage = res.id;
        if (typeof v17UpdateDefaultsUI === 'function') v17UpdateDefaultsUI();
        if (typeof v17RenderAssets === 'function') v17RenderAssets();
      }
      notify('✓ ' + (kind === 'video' ? 'Video' : 'Foto') + ' (' + camState.aspect + ') in der Mediathek gespeichert!');
    } catch (err) {
      notify('Fehler beim Speichern: ' + (err.message || err), true);
    } finally {
      camState.busy = false;
      syncCamUi();
    }
  }

  async function takePhoto() {
    const vid = byId('v197CamVideo');
    if (!vid || !camState.stream || camState.busy) return;
    const canvas = document.createElement('canvas');
    drawVideoToCanvas(vid, canvas);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) {
      notify('Foto konnte nicht erzeugt werden.', true);
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = new File([blob], 'Kamera_Foto_9x16_' + stamp + '.jpg', { type: 'image/jpeg' });
    await uploadCapturedFile(file, 'image');
  }

  function pickRecorderMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
      'video/mp4;codecs=h264,aac',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  function startVideoRecording() {
    const vid = byId('v197CamVideo');
    if (!camState.stream || camState.recording || camState.busy || !vid) return;
    if (typeof MediaRecorder === 'undefined') {
      notify('Direkte Videoaufnahme wird hier nicht unterstützt – nutze den Button „📱 Video-App öffnen“.', true);
      return;
    }

    let captureStream = camState.stream;
    let rafId = null;

    if (typeof HTMLCanvasElement.prototype.captureStream === 'function') {
      const canvas = document.createElement('canvas');
      drawVideoToCanvas(vid, canvas);
      const ctx = canvas.getContext('2d');

      const drawFrame = () => {
        if (!camState.recording) return;
        drawVideoToCanvas(vid, canvas);
        rafId = requestAnimationFrame(drawFrame);
      };

      const vStream = canvas.captureStream(25);
      const audioTracks = camState.stream.getAudioTracks ? camState.stream.getAudioTracks() : [];
      captureStream = new MediaStream([...vStream.getVideoTracks(), ...audioTracks]);
      camState.recording = true;
      drawFrame();
    } else {
      camState.recording = true;
    }

    camState.chunks = [];
    const mime = pickRecorderMime();
    let recorder;
    try {
      recorder = mime ? new MediaRecorder(captureStream, { mimeType: mime }) : new MediaRecorder(captureStream);
    } catch (_) {
      recorder = new MediaRecorder(captureStream);
    }
    camState.recorder = recorder;
    camState.startedAt = Date.now();

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) camState.chunks.push(ev.data);
    };

    recorder.onstop = async () => {
      if (rafId) cancelAnimationFrame(rafId);
      stopTimer();
      camState.recording = false;
      syncCamUi();
      const actualMime = (recorder.mimeType || mime || 'video/webm').split(';')[0].trim();
      const blob = new Blob(camState.chunks, { type: actualMime });
      camState.chunks = [];
      if (!blob.size) {
        notify('Aufnahme war leer.', true);
        return;
      }
      const ext = actualMime === 'video/mp4' ? '.mp4' : '.webm';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = new File([blob], 'Kamera_Video_9x16_' + stamp + ext, { type: actualMime });
      await uploadCapturedFile(file, 'video');
    };

    recorder.start(500);
    const timerEl = byId('v197CamTimer');
    if (timerEl) timerEl.textContent = '00:00';
    camState.timerId = setInterval(() => {
      const sec = Math.max(0, Math.floor((Date.now() - camState.startedAt) / 1000));
      if (timerEl) timerEl.textContent = formatTimer(sec);
    }, 300);
    syncCamUi();
    notify('● 9:16-Videoaufnahme läuft … Tippe auf „⏹ Stopp & in Mediathek speichern“.');
  }

  function stopVideoRecording() {
    if (camState.recorder && camState.recorder.state !== 'inactive') {
      camState.recorder.stop();
    }
  }

  async function handleNativeCaptureInput(inputEl, kind) {
    const file = inputEl?.files?.[0];
    if (!file) return;
    await uploadCapturedFile(file, kind);
    inputEl.value = '';
  }

  function injectDirectAppButtons() {
    // 1. Place clear Foto-App & Video-App buttons directly next to the upload tiles in #publish
    const uploadPair = document.querySelector('#publish .v17-upload-pair');
    if (uploadPair && !byId('v197PublishAppButtons')) {
      const row = document.createElement('div');
      row.className = 'v197-inline-cam-row';
      row.id = 'v197PublishAppButtons';
      row.style.gridColumn = '1 / -1';
      row.innerHTML =
        '<label class="v197-inline-cam-btn" for="v197NativePhotoInput">📸 Foto-App aufnehmen (9:16)</label>' +
        '<label class="v197-inline-cam-btn" for="v197NativeVideoInput">🎬 Video-App aufnehmen (9:16)</label>';
      uploadPair.parentNode.insertBefore(row, uploadPair.nextSibling);
    }

    // 2. Place a direct Video-App capture button right inside Video Studio (#videoStudio) if present
    const vidStudio = byId('videoStudio');
    if (vidStudio && !byId('v197VideoStudioAppBtn')) {
      const heading = vidStudio.querySelector('h2, h3');
      if (heading && heading.parentNode) {
        const btnWrap = document.createElement('div');
        btnWrap.style.margin = '8px 0 12px';
        btnWrap.innerHTML =
          '<label class="v197-inline-cam-btn" for="v197NativeVideoInput" style="display:inline-flex;width:auto;">🎬 Video direkt mit Video-App aufnehmen</label>';
        heading.parentNode.insertBefore(btnWrap, heading.nextSibling);
      }
    }
  }

  function injectCameraCard() {
    const hub = byId('mediaHub');
    if (!hub || byId('v197CameraStudio')) return;
    const firstSurface = hub.querySelector('.v17-surface');
    if (!firstSurface) return;

    const card = document.createElement('div');
    card.className = 'v17-surface v197-cam-card';
    card.id = 'v197CameraStudio';
    card.innerHTML =
      '<div class="v197-cam-head">' +
      '<div>' +
      '<span class="v17-kicker">DIREKTAUFNAHME · 9:16 HOCHFORMAT &amp; GERÄTE-KAMERA</span>' +
      '<h3>📸 Foto &amp; Video direkt aufnehmen</h3>' +
      '<p class="v17-caption" style="margin:2px 0 0;">Standardmäßig auf <b>9:16 Hochformat</b> (720×1280) zugeschnitten und gerade ausgerichtet. Für das beste Ergebnis am Handy direkt die Buttons <b>Foto-App</b> oder <b>Video-App</b> nutzen.</p>' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
      '<label style="margin:0;font-size:12px;">Format: <select id="v197CamAspect" style="padding:6px 8px;border-radius:8px;">' +
      '<option value="9:16" selected>9:16 Hochformat (TikTok/Reels)</option>' +
      '<option value="1:1">1:1 Quadrat</option>' +
      '<option value="16:9">16:9 Querformat</option>' +
      '</select></label>' +
      '<label style="margin:0;font-size:12px;display:inline-flex;align-items:center;gap:5px;cursor:pointer;"><input type="checkbox" id="v197CamGridToggle" checked/> Raster</label>' +
      '</div>' +
      '</div>' +
      '<div class="v197-native-fallback">' +
      '<label class="v197-native-btn" for="v197NativePhotoInput">📸 Foto-App öffnen (Direkt)<input id="v197NativePhotoInput" type="file" accept="image/*" capture="environment" hidden/></label>' +
      '<label class="v197-native-btn" for="v197NativeVideoInput">🎬 Video-App öffnen (Direkt)<input id="v197NativeVideoInput" type="file" accept="video/*" capture="environment" hidden/></label>' +
      '</div>' +
      '<div class="v197-cam-actions">' +
      '<button type="button" class="outline" id="v197OpenPhotoCamBtn">Browser Foto-Vorschau</button>' +
      '<button type="button" class="outline" id="v197OpenVideoCamBtn">Browser Video-Vorschau</button>' +
      '</div>' +
      '<div class="v197-cam-stage" id="v197CamStage" hidden>' +
      '<div class="v197-cam-hud">' +
      '<span id="v197CamModeLabel">📸 Foto · Rückkamera · 9:16</span>' +
      '<span class="v197-cam-rec-pill" id="v197CamRecPill" hidden><span class="v197-cam-rec-dot"></span> REC <span id="v197CamTimer">00:00</span></span>' +
      '</div>' +
      '<div id="v197CamFrameBox" style="position:relative;overflow:hidden;background:#0e0b1a;">' +
      '<video class="v197-cam-video" id="v197CamVideo" autoplay playsinline muted></video>' +
      '<div id="v197CamGrid" style="pointer-events:none;position:absolute;inset:0;border:1px solid rgba(255,255,255,0.25);background-image:linear-gradient(to right, rgba(255,255,255,0.18) 1px, transparent 1px),linear-gradient(to bottom, rgba(255,255,255,0.18) 1px, transparent 1px);background-size:33.33% 33.33%;"></div>' +
      '</div>' +
      '<div class="v197-cam-bar">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      '<button type="button" id="v197CamSnapBtn">📸 Foto aufnehmen &amp; speichern</button>' +
      '<button type="button" id="v197CamRecStartBtn" hidden>● 9:16-Aufnahme starten</button>' +
      '<button type="button" class="danger" id="v197CamRecStopBtn" hidden>⏹ Stopp &amp; speichern</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      '<button type="button" class="outline" id="v197CamRotateBtn">↻ 90° drehen</button>' +
      '<button type="button" class="outline" id="v197CamSwitchBtn">🔄 Kamera wechseln</button>' +
      '<button type="button" class="outline" id="v197CamCloseBtn">✕ Schließen</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="v197-cam-status" id="v197CamStatus" role="status" aria-live="polite">Bereit · 9:16 Hochformat voreingestellt · Status wechselt erst auf „Veröffentlicht“, wenn TikTok den Abschluss bestätigt.</div>';

    firstSurface.parentNode.insertBefore(card, firstSurface);
    camState.aspect = byId('v197CamAspect')?.value || '9:16';
    camState.showGrid = !!byId('v197CamGridToggle')?.checked;
    applyStageAspect();

    byId('v197CamAspect')?.addEventListener('change', async (e) => {
      camState.aspect = e.target.value || '9:16';
      syncCamUi();
      if (camState.stream && !camState.recording) {
        await openCamera(camState.mode);
      }
    });
    byId('v197CamGridToggle')?.addEventListener('change', (e) => {
      camState.showGrid = !!e.target.checked;
      applyStageAspect();
    });

    byId('v197OpenPhotoCamBtn')?.addEventListener('click', () => openCamera('photo'));
    byId('v197OpenVideoCamBtn')?.addEventListener('click', () => openCamera('video'));
    byId('v197CamSnapBtn')?.addEventListener('click', takePhoto);
    byId('v197CamRecStartBtn')?.addEventListener('click', startVideoRecording);
    byId('v197CamRecStopBtn')?.addEventListener('click', stopVideoRecording);
    byId('v197CamRotateBtn')?.addEventListener('click', rotateCamera90);
    byId('v197CamSwitchBtn')?.addEventListener('click', switchCamera);
    byId('v197CamCloseBtn')?.addEventListener('click', closeCamera);
    byId('v197NativePhotoInput')?.addEventListener('change', (e) => handleNativeCaptureInput(e.target, 'image'));
    byId('v197NativeVideoInput')?.addEventListener('change', (e) => handleNativeCaptureInput(e.target, 'video'));

    injectDirectAppButtons();
  }

  window.addEventListener('beforeunload', stopStream);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectCameraCard);
  } else {
    injectCameraCard();
  }
})();
