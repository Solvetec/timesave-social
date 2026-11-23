/* TimeSave Social V19.7 – Fotos & Videos direkt in der App aufnehmen und in der Mediathek speichern */
(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);

  const camState = {
    stream: null,
    recorder: null,
    chunks: [],
    mode: 'photo', // 'photo' | 'video'
    facingMode: 'environment', // 'environment' | 'user'
    recording: false,
    timerId: null,
    startedAt: 0,
    busy: false,
    autoSelectForPublish: false,
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
    if (vid) {
      vid.srcObject = null;
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
    if (modeLabel) {
      modeLabel.textContent =
        (camState.mode === 'video' ? '🎬 Video-Kamera' : '📸 Foto-Kamera') +
        (camState.facingMode === 'user' ? ' (Frontkamera)' : ' (Rückkamera)');
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

  async function openCamera(mode, opts) {
    if (camState.recording) {
      notify('Bitte zuerst die laufende Videoaufnahme stoppen.', true);
      return;
    }
    camState.mode = mode === 'video' ? 'video' : 'photo';
    if (opts && typeof opts.autoSelectForPublish === 'boolean') {
      camState.autoSelectForPublish = opts.autoSelectForPublish;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      notify('Live-Kamera wird in diesem Browser nicht direkt unterstützt. Nutze unten die Handy-Kamera-Buttons.', true);
      return;
    }
    stopStream();
    notify('⏳ Kamera wird gestartet …');
    try {
      const constraints = {
        video: {
          facingMode: { ideal: camState.facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: camState.mode === 'video',
      };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        if (camState.mode === 'video') {
          // Fallback without audio if no microphone is attached on desktop
          stream = await navigator.mediaDevices.getUserMedia({ video: constraints.video, audio: false });
        } else {
          throw err;
        }
      }
      camState.stream = stream;
      const vid = byId('v197CamVideo');
      if (vid) {
        vid.srcObject = stream;
        await vid.play().catch(() => {});
      }
      syncCamUi();
      notify(
        camState.mode === 'video'
          ? 'Kamera bereit. Tippe auf „● Aufnahme starten“, um ein Video für die Mediathek aufzunehmen.'
          : 'Kamera bereit. Tippe auf „📸 Foto aufnehmen“, um das Bild direkt in der Mediathek zu speichern.'
      );
    } catch (err) {
      stopStream();
      syncCamUi();
      notify('Kamera konnte nicht geöffnet werden (' + (err.name || err.message || 'Berechtigung prüfen') + '). Nutze unten alternativ die Geräte-Kamera.', true);
    }
  }

  async function switchCamera() {
    camState.facingMode = camState.facingMode === 'environment' ? 'user' : 'environment';
    if (camState.stream) {
      await openCamera(camState.mode);
    }
  }

  function closeCamera() {
    stopStream();
    syncCamUi();
    notify('Kamera geschlossen.');
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
      notify('✓ ' + (kind === 'video' ? 'Video' : 'Foto') + ' direkt in der Mediathek gespeichert!');
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
    const w = vid.videoWidth || 1280;
    const h = vid.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (camState.facingMode === 'user') {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(vid, 0, 0, w, h);
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
    if (!camState.stream || camState.recording || camState.busy) return;
    if (typeof MediaRecorder === 'undefined') {
      notify('Videoaufnahme wird in diesem Browser nicht direkt unterstützt. Nutze unten den Video-Kamera-Button.', true);
      return;
    }
    camState.chunks = [];
    const mime = pickRecorderMime();
    let recorder;
    try {
      recorder = mime ? new MediaRecorder(camState.stream, { mimeType: mime }) : new MediaRecorder(camState.stream);
    } catch (_) {
      recorder = new MediaRecorder(camState.stream);
    }
    camState.recorder = recorder;
    camState.recording = true;
    camState.startedAt = Date.now();

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) camState.chunks.push(ev.data);
    };

    recorder.onstop = async () => {
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
    notify('● Aufnahme läuft … Tippe auf „⏹ Stopp & in Mediathek speichern“.');
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
      '<h3>📸 Foto &amp; Video direkt aufnehmen</h3>' +
      '<p class="v17-caption" style="margin:2px 0 0;">Nimm Bilder oder Videos direkt über deine Kamera auf – sie werden automatisch als JPG bzw. MP4 in deiner Mediathek gespeichert.</p>' +
      '</div>' +
      '</div>' +
      '<div class="v197-cam-actions">' +
      '<button type="button" id="v197OpenPhotoCamBtn">📸 Foto-Kamera starten</button>' +
      '<button type="button" class="outline" id="v197OpenVideoCamBtn">🎬 Video-Kamera starten</button>' +
      '</div>' +
      '<div class="v197-cam-stage" id="v197CamStage" hidden>' +
      '<div class="v197-cam-hud">' +
      '<span id="v197CamModeLabel">📸 Foto-Kamera</span>' +
      '<span class="v197-cam-rec-pill" id="v197CamRecPill" hidden><span class="v197-cam-rec-dot"></span> REC <span id="v197CamTimer">00:00</span></span>' +
      '</div>' +
      '<video class="v197-cam-video" id="v197CamVideo" autoplay playsinline muted></video>' +
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
      '<div class="v197-cam-status" id="v197CamStatus" role="status" aria-live="polite">Bereit für Foto- oder Videoaufnahme.</div>';

    firstSurface.parentNode.insertBefore(card, firstSurface);

    byId('v197OpenPhotoCamBtn')?.addEventListener('click', () => openCamera('photo'));
    byId('v197OpenVideoCamBtn')?.addEventListener('click', () => openCamera('video'));
    byId('v197CamSnapBtn')?.addEventListener('click', takePhoto);
    byId('v197CamRecStartBtn')?.addEventListener('click', startVideoRecording);
    byId('v197CamRecStopBtn')?.addEventListener('click', stopVideoRecording);
    byId('v197CamSwitchBtn')?.addEventListener('click', switchCamera);
    byId('v197CamCloseBtn')?.addEventListener('click', closeCamera);
    byId('v197NativePhotoInput')?.addEventListener('change', (e) => handleNativeCaptureInput(e.target, 'image'));
    byId('v197NativeVideoInput')?.addEventListener('change', (e) => handleNativeCaptureInput(e.target, 'video'));

    // Also add a convenient shortcut button inside the Publish section's upload bar
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
