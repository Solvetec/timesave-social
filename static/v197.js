/* TimeSave Social V19.8 – Saubere Kamera-Ausrichtung (9:16 / 1:1 / 16:9 + Waage/Raster) & exakter TikTok-Status */
(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);

  const camState = {
    stream: null,
    recorder: null,
    chunks: [],
    mode: 'photo', // 'photo' | 'video'
    facingMode: 'environment', // 'environment' | 'user'
    aspect: 'auto', // 'auto' | '9:16' | '1:1' | '16:9'
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
    if (gridEl) gridEl.hidden = !camState.showGrid;
    if (!frameBox) return;
    if (camState.aspect === '9:16') {
      frameBox.style.aspectRatio = '9 / 16';
      frameBox.style.maxWidth = '340px';
      frameBox.style.margin = '10px auto';
    } else if (camState.aspect === '1:1') {
      frameBox.style.aspectRatio = '1 / 1';
      frameBox.style.maxWidth = '420px';
      frameBox.style.margin = '10px auto';
    } else if (camState.aspect === '16:9') {
      frameBox.style.aspectRatio = '16 / 9';
      frameBox.style.maxWidth = '640px';
      frameBox.style.margin = '10px auto';
    } else {
      frameBox.style.aspectRatio = '';
      frameBox.style.maxWidth = '100%';
      frameBox.style.margin = '10px 0 0';
    }
  }

  function syncCamUi() {
    const stage = byId('v197CamStage');
    const modeLabel = byId('v197CamModeLabel');
    const recPill = byId('v197CamRecPill');
    const snapBtn = byId('v197CamSnapBtn');
    const recStartBtn = byId('v197CamRecStartBtn');
    const recStopBtn = byId('v197CamRecStopBtn');
    const vid = byId('v197CamVideo');

    if (stage) stage.hidden = !camState.stream;
    if (vid) vid.classList.toggle('is-mirrored', camState.facingMode === 'user');
    applyStageAspect();

    if (modeLabel) {
      const aspTxt = camState.aspect === 'auto' ? 'Gerät' : camState.aspect;
      modeLabel.textContent =
        (camState.mode === 'video' ? '🎬 Video' : '📸 Foto') +
        ' · ' +
        (camState.facingMode === 'user' ? 'Front' : 'Rückkamera') +
        ' · ' +
        aspTxt;
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
      base.width = { ideal: 1280 };
      base.height = { ideal: 720 };
    }
    return base;
  }

  async function openCamera(mode) {
    if (camState.recording) {
      notify('Bitte zuerst die laufende Videoaufnahme stoppen.', true);
      return;
    }
    camState.mode = mode === 'video' ? 'video' : 'photo';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      notify('Live-Kamera wird in diesem Browser nicht direkt unterstützt. Nutze unten die Geräte-Kamera.', true);
      return;
    }
    stopStream();
    notify('⏳ Kamera wird ausgerichtet und gestartet …');
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
      notify('Kamera bereit – nutze die Wasserwaage-/Rasterlinien und das Format (9:16 / 1:1 / 16:9) für gerade Aufnahmen.');
    } catch (err) {
      stopStream();
      syncCamUi();
      notify('Kamera konnte nicht geöffnet werden (' + (err.name || err.message || 'Berechtigung prüfen') + ').', true);
    }
  }

  async function switchCamera() {
    camState.facingMode = camState.facingMode === 'environment' ? 'user' : 'environment';
    if (camState.stream) {
      await openCamera(camState.mode);
    } else {
      syncCamUi();
    }
  }

  function closeCamera() {
    stopStream();
    syncCamUi();
    notify('Kamera geschlossen.');
  }

  function computeCroppedRect(srcW, srcH, aspectMode) {
    if (!aspectMode || aspectMode === 'auto') {
      return { sx: 0, sy: 0, sw: srcW, sh: srcH, dw: srcW, dh: srcH };
    }
    let targetRatio = srcW / srcH;
    let dw = srcW;
    let dh = srcH;
    if (aspectMode === '9:16') {
      targetRatio = 9 / 16;
      dw = 720;
      dh = 1280;
    } else if (aspectMode === '1:1') {
      targetRatio = 1;
      dw = 1080;
      dh = 1080;
    } else if (aspectMode === '16:9') {
      targetRatio = 16 / 9;
      dw = 1280;
      dh = 720;
    }
    const srcRatio = srcW / srcH;
    let sw = srcW;
    let sh = srcH;
    let sx = 0;
    let sy = 0;
    if (srcRatio > targetRatio) {
      sw = Math.round(srcH * targetRatio);
      sx = Math.round((srcW - sw) / 2);
    } else if (srcRatio < targetRatio) {
      sh = Math.round(srcW / targetRatio);
      sy = Math.round((srcH - sh) / 2);
    }
    return { sx, sy, sw, sh, dw, dh };
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
      notify('✓ ' + (kind === 'video' ? 'Video' : 'Foto') + ' in der Mediathek gespeichert!');
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
    const srcW = vid.videoWidth || 1280;
    const srcH = vid.videoHeight || 720;
    const rect = computeCroppedRect(srcW, srcH, camState.aspect);

    const canvas = document.createElement('canvas');
    canvas.width = rect.dw;
    canvas.height = rect.dh;
    const ctx = canvas.getContext('2d');
    if (camState.facingMode === 'user') {
      ctx.translate(rect.dw, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(vid, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.dw, rect.dh);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) {
      notify('Foto konnte nicht erzeugt werden.', true);
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = new File([blob], 'Kamera_Foto_' + stamp + '.jpg', { type: 'image/jpeg' });
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
      notify('Videoaufnahme wird in diesem Browser nicht direkt unterstützt. Nutze unten den Video-Kamera-Button.', true);
      return;
    }

    const srcW = vid.videoWidth || 1280;
    const srcH = vid.videoHeight || 720;
    const rect = computeCroppedRect(srcW, srcH, camState.aspect);

    let captureStream = camState.stream;
    let rafId = null;

    // Render straight, properly framed video onto a canvas so orientation/aspect is never crooked
    if (typeof HTMLCanvasElement.prototype.captureStream === 'function') {
      const canvas = document.createElement('canvas');
      canvas.width = rect.dw;
      canvas.height = rect.dh;
      const ctx = canvas.getContext('2d');

      const drawFrame = () => {
        if (!camState.recording) return;
        ctx.save();
        if (camState.facingMode === 'user') {
          ctx.translate(rect.dw, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(vid, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.dw, rect.dh);
        ctx.restore();
        rafId = requestAnimationFrame(drawFrame);
      };

      const vStream = canvas.captureStream(25);
      const combinedTracks = [...vStream.getVideoTracks(), ...camState.stream.getAudioTracks()];
      captureStream = new MediaStream(combinedTracks);
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
      const file = new File([blob], 'Kamera_Video_' + stamp + ext, { type: actualMime });
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
    notify('● Gerade Aufnahme läuft … Tippe auf „⏹ Stopp & in Mediathek speichern“.');
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
      '<span class="v17-kicker">DIREKTAUFNAHME · KAMERA</span>' +
      '<h3>📸 Foto &amp; Video gerade &amp; passend aufnehmen</h3>' +
      '<p class="v17-caption" style="margin:2px 0 0;">Wähle das Zielformat (9:16 Hochformat, 1:1 oder 16:9) und nutze das Ausrichtungsraster – die Aufnahme wird gerade ausgerichtet in der Mediathek gespeichert.</p>' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
      '<label style="margin:0;font-size:12px;">Format: <select id="v197CamAspect" style="padding:6px 8px;border-radius:8px;">' +
      '<option value="9:16" selected>9:16 Hochformat (TikTok/Reels)</option>' +
      '<option value="1:1">1:1 Quadrat</option>' +
      '<option value="16:9">16:9 Querformat</option>' +
      '<option value="auto">Gerät (unbeschnitten)</option>' +
      '</select></label>' +
      '<label style="margin:0;font-size:12px;display:inline-flex;align-items:center;gap:5px;cursor:pointer;"><input type="checkbox" id="v197CamGridToggle" checked/> Raster / Waage</label>' +
      '</div>' +
      '</div>' +
      '<div class="v197-cam-actions">' +
      '<button type="button" id="v197OpenPhotoCamBtn">📸 Foto-Kamera starten</button>' +
      '<button type="button" class="outline" id="v197OpenVideoCamBtn">🎬 Video-Kamera starten</button>' +
      '</div>' +
      '<div class="v197-cam-stage" id="v197CamStage" hidden>' +
      '<div class="v197-cam-hud">' +
      '<span id="v197CamModeLabel">📸 Foto · Rückkamera · 9:16</span>' +
      '<span class="v197-cam-rec-pill" id="v197CamRecPill" hidden><span class="v197-cam-rec-dot"></span> REC <span id="v197CamTimer">00:00</span></span>' +
      '</div>' +
      '<div id="v197CamFrameBox" style="position:relative;overflow:hidden;background:#0e0b1a;">' +
      '<video class="v197-cam-video" id="v197CamVideo" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover;"></video>' +
      '<div id="v197CamGrid" style="pointer-events:none;position:absolute;inset:0;border:1px solid rgba(255,255,255,0.22);background-image:linear-gradient(to right, rgba(255,255,255,0.16) 1px, transparent 1px),linear-gradient(to bottom, rgba(255,255,255,0.16) 1px, transparent 1px);background-size:33.33% 33.33%;"></div>' +
      '</div>' +
      '<div class="v197-cam-bar">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      '<button type="button" id="v197CamSnapBtn">📸 Foto aufnehmen &amp; speichern</button>' +
      '<button type="button" id="v197CamRecStartBtn" hidden>● Aufnahme starten</button>' +
      '<button type="button" class="danger" id="v197CamRecStopBtn" hidden>⏹ Stopp &amp; in Mediathek speichern</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      '<button type="button" class="outline" id="v197CamSwitchBtn">🔄 Kamera wechseln</button>' +
      '<button type="button" class="outline" id="v197CamCloseBtn">✕ Schließen</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="v197-native-fallback">' +
      '<label class="v197-native-btn" for="v197NativePhotoInput">📱 Geräte-Kamera: Foto<input id="v197NativePhotoInput" type="file" accept="image/*" capture="environment" hidden/></label>' +
      '<label class="v197-native-btn" for="v197NativeVideoInput">📱 Geräte-Kamera: Video<input id="v197NativeVideoInput" type="file" accept="video/*" capture="environment" hidden/></label>' +
      '</div>' +
      '<div class="v197-cam-status" id="v197CamStatus" role="status" aria-live="polite">Bereit · Status in Planung &amp; Archiv wechselt erst auf „Veröffentlicht“, wenn TikTok den Abschluss bestätigt.</div>';

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
    byId('v197CamSwitchBtn')?.addEventListener('click', switchCamera);
    byId('v197CamCloseBtn')?.addEventListener('click', closeCamera);
    byId('v197NativePhotoInput')?.addEventListener('change', (e) => handleNativeCaptureInput(e.target, 'image'));
    byId('v197NativeVideoInput')?.addEventListener('change', (e) => handleNativeCaptureInput(e.target, 'video'));

    const pubUploadBtn = byId('v17Upload');
    if (pubUploadBtn && !byId('v197PublishCamJumpBtn')) {
      const jumpBtn = document.createElement('button');
      jumpBtn.type = 'button';
      jumpBtn.className = 'outline';
      jumpBtn.id = 'v197PublishCamJumpBtn';
      jumpBtn.textContent = '📸 Mit Kamera aufnehmen';
      jumpBtn.addEventListener('click', () => {
        if (typeof nav === 'function') nav('mediaHub');
        setTimeout(() => openCamera('photo'), 120);
      });
      pubUploadBtn.parentNode.insertBefore(jumpBtn, pubUploadBtn.nextSibling);
    }
  }

  window.addEventListener('beforeunload', stopStream);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectCameraCard);
  } else {
    injectCameraCard();
  }
})();
