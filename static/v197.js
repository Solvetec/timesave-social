/* TimeSave Social V20.3 – Creator Kamera-Studio (PC & Handy, Countdown, Live-Looks, 9:16 / 4:5 / 1:1 / 16:9, Direkt-Bearbeitung) */
(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);

  const CAM_FILTERS = {
    original: { label: 'Original', css: 'none' },
    clean:    { label: 'Klar & Edel', css: 'contrast(1.07) saturate(1.16) brightness(1.03)' },
    gold:     { label: 'Warm Gold', css: 'sepia(0.18) saturate(1.22) brightness(1.05) contrast(1.04)' },
    cinema:   { label: 'Kino', css: 'contrast(1.18) saturate(0.92) brightness(0.97)' },
    soft:     { label: 'Soft', css: 'brightness(1.08) contrast(0.94) saturate(1.06)' },
    mono:     { label: 'S/W', css: 'grayscale(1) contrast(1.12)' },
  };

  const camState = {
    stream: null,
    recorder: null,
    chunks: [],
    mode: 'photo',
    facingMode: 'environment',
    deviceId: '',
    audioDeviceId: '',
    aspect: '9:16',
    extraRotateDeg: 0,
    mirror: false,
    showGrid: true,
    timerSec: 0,
    filter: 'original',
    autoOpenEditor: true,
    recording: false,
    countingDown: false,
    countdownAbort: false,
    timerId: null,
    startedAt: 0,
    busy: false,
    lastCaptured: null,
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
    camState.countdownAbort = true;
    camState.countingDown = false;
    const cdEl = byId('v197CamCountdown');
    if (cdEl) cdEl.hidden = true;
    stopTimer();
    if (camState.recorder && camState.recorder.state !== 'inactive') {
      try { camState.recorder.stop(); } catch (_) {}
    }
    camState.recorder = null;
    camState.recording = false;
    if (camState.stream) {
      try { camState.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      camState.stream = null;
    }
    const vid = byId('v197CamVideo');
    if (vid) vid.srcObject = null;
  }

  function escHtml(v) {
    return String(v || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escAttr(v) { return escHtml(v); }

  async function refreshDevices() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videos = devices.filter((d) => d.kind === 'videoinput');
      const audios = devices.filter((d) => d.kind === 'audioinput');

      const camSel = byId('v197CamDevice');
      if (camSel) {
        const prev = camState.deviceId || camSel.value || '';
        const opts = ['<option value="">Automatisch (Standard-Kamera)</option>'];
        videos.forEach((d, idx) => {
          opts.push('<option value="' + escAttr(d.deviceId) + '">' + escHtml(d.label || ('Kamera ' + (idx + 1))) + '</option>');
        });
        camSel.innerHTML = opts.join('');
        if (prev && videos.some((d) => d.deviceId === prev)) camSel.value = prev;
      }

      const micSel = byId('v197MicDevice');
      if (micSel) {
        const prevA = camState.audioDeviceId || micSel.value || '';
        const aopts = [
          '<option value="">Automatisch (Standard-Mikrofon)</option>',
          '<option value="none">🔇 Ohne Ton aufnehmen</option>',
        ];
        audios.forEach((d, idx) => {
          aopts.push('<option value="' + escAttr(d.deviceId) + '">' + escHtml(d.label || ('Mikrofon ' + (idx + 1))) + '</option>');
        });
        micSel.innerHTML = aopts.join('');
        if (prevA === 'none' || audios.some((d) => d.deviceId === prevA)) micSel.value = prevA;
      }
    } catch (_) {}
  }

  function currentFilterCss() {
    return (CAM_FILTERS[camState.filter] && CAM_FILTERS[camState.filter].css) || 'none';
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
      frameBox.style.margin = '0 auto';
    } else if (camState.aspect === '4:5') {
      frameBox.style.aspectRatio = '4 / 5';
      frameBox.style.maxWidth = '380px';
      frameBox.style.maxHeight = '475px';
      frameBox.style.margin = '0 auto';
    } else if (camState.aspect === '1:1') {
      frameBox.style.aspectRatio = '1 / 1';
      frameBox.style.maxWidth = '410px';
      frameBox.style.maxHeight = '410px';
      frameBox.style.margin = '0 auto';
    } else {
      frameBox.style.aspectRatio = '16 / 9';
      frameBox.style.maxWidth = '640px';
      frameBox.style.maxHeight = '360px';
      frameBox.style.margin = '0 auto';
    }

    if (vid) {
      const shouldMirror = camState.mirror || (!camState.deviceId && camState.facingMode === 'user');
      const mirror = shouldMirror ? 'scaleX(-1)' : '';
      const rot = camState.extraRotateDeg ? ' rotate(' + camState.extraRotateDeg + 'deg)' : '';
      const scale = camState.extraRotateDeg % 180 !== 0 ? ' scale(1.35)' : '';
      vid.style.transform = (mirror + rot + scale).trim() || 'none';
      vid.style.objectFit = 'cover';
      vid.style.filter = currentFilterCss();
    }
  }

  function syncCamUi() {
    const stage = byId('v197CamStage');
    const modeLabel = byId('v197CamModeLabel');
    const recPill = byId('v197CamRecPill');
    const shutterBtn = byId('v197ShutterBtn');
    const shutterCap = byId('v197ShutterCaption');
    const photoModeBtn = byId('v197ModePhotoBtn');
    const videoModeBtn = byId('v197ModeVideoBtn');
    const mirrorBtn = byId('v197CamMirrorBtn');
    const gridBtn = byId('v197CamGridBtn');

    if (stage) stage.hidden = !camState.stream;
    applyStageAspect();

    if (photoModeBtn) photoModeBtn.classList.toggle('active', camState.mode === 'photo');
    if (videoModeBtn) videoModeBtn.classList.toggle('active', camState.mode === 'video');
    if (mirrorBtn) mirrorBtn.classList.toggle('active', camState.mirror);
    if (gridBtn) gridBtn.classList.toggle('active', camState.showGrid);

    document.querySelectorAll('[data-v197-aspect]').forEach((b) => {
      b.classList.toggle('active', b.dataset.v197Aspect === camState.aspect);
    });
    document.querySelectorAll('[data-v197-timer]').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.v197Timer) === camState.timerSec);
    });
    document.querySelectorAll('[data-v197-filter]').forEach((b) => {
      b.classList.toggle('active', b.dataset.v197Filter === camState.filter);
    });

    if (modeLabel) {
      const camSel = byId('v197CamDevice');
      const selectedLabel = camSel && camSel.value
        ? camSel.options[camSel.selectedIndex]?.textContent
        : (camState.facingMode === 'user' ? 'Frontkamera' : 'Kamera');
      modeLabel.textContent = selectedLabel + ' · ' + camState.aspect + (camState.extraRotateDeg ? ' · ' + camState.extraRotateDeg + '°' : '');
    }

    if (recPill) recPill.hidden = !camState.recording;

    if (shutterBtn) {
      shutterBtn.disabled = camState.busy;
      shutterBtn.classList.toggle('video-idle', camState.mode === 'video' && !camState.recording);
      shutterBtn.classList.toggle('video-rec', camState.mode === 'video' && camState.recording);
      if (camState.mode === 'photo') shutterBtn.setAttribute('aria-label', 'Foto aufnehmen');
      else if (camState.recording) shutterBtn.setAttribute('aria-label', 'Videoaufnahme stoppen und speichern');
      else shutterBtn.setAttribute('aria-label', 'Videoaufnahme starten');
    }

    if (shutterCap) {
      if (camState.countingDown) shutterCap.textContent = 'Countdown läuft …';
      else if (camState.mode === 'photo') shutterCap.textContent = camState.timerSec ? ('Foto (' + camState.timerSec + 's Timer)') : 'Foto aufnehmen';
      else if (camState.recording) shutterCap.textContent = 'Tippen zum Stoppen';
      else shutterCap.textContent = camState.timerSec ? ('Video (' + camState.timerSec + 's Timer)') : 'Video starten';
    }
  }

  function buildVideoConstraints() {
    const base = {};
    if (camState.deviceId) base.deviceId = { exact: camState.deviceId };
    else base.facingMode = { ideal: camState.facingMode };
    if (camState.aspect === '9:16') { base.width = { ideal: 1080 }; base.height = { ideal: 1920 }; }
    else if (camState.aspect === '4:5') { base.width = { ideal: 1080 }; base.height = { ideal: 1350 }; }
    else if (camState.aspect === '1:1') { base.width = { ideal: 1080 }; base.height = { ideal: 1080 }; }
    else { base.width = { ideal: 1280 }; base.height = { ideal: 720 }; }
    return base;
  }

  function buildAudioConstraints() {
    if (camState.audioDeviceId === 'none') return false;
    if (camState.audioDeviceId) return { deviceId: { exact: camState.audioDeviceId } };
    return true;
  }

  async function openCamera(mode) {
    if (camState.busy) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      notify('Dieser Browser unterstützt keine Live-Kamera. Nutze den Datei-Upload oder ein modernes Gerät über HTTPS.', true);
      return;
    }
    stopStream();
    camState.mode = mode === 'video' ? 'video' : 'photo';
    const wantAudio = camState.mode === 'video' && camState.audioDeviceId !== 'none';
    const videoConstraint = buildVideoConstraints();
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraint,
        audio: wantAudio ? buildAudioConstraints() : false,
      });
    } catch (err) {
      if (wantAudio) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false });
          notify('Kein Mikrofon verfügbar – Video-Kamera wurde ohne Ton gestartet.');
        } catch (err2) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            camState.deviceId = '';
            notify('Standard-Kamera ohne Ton gestartet.');
          } catch (err3) {
            notify('Kamera konnte nicht gestartet werden: ' + (err3?.message || 'Berechtigung prüfen'), true);
            return;
          }
        }
      } else {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          camState.deviceId = '';
        } catch (err2) {
          notify('Kamera konnte nicht gestartet werden: ' + (err2?.message || 'Berechtigung prüfen'), true);
          return;
        }
      }
    }

    camState.stream = stream;
    const vid = byId('v197CamVideo');
    if (vid) {
      vid.srcObject = stream;
      try { await vid.play(); } catch (_) {}
    }

    await refreshDevices();
    try {
      const track = stream.getVideoTracks()[0];
      const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
      if (settings.deviceId) {
        camState.deviceId = settings.deviceId;
        const camSel = byId('v197CamDevice');
        if (camSel) camSel.value = settings.deviceId;
      }
    } catch (_) {}

    syncCamUi();
    const stage = byId('v197CamStage');
    if (stage) stage.scrollIntoView({ behavior: 'smooth', block: 'center' });
    notify(camState.mode === 'video' ? 'Video-Kamera bereit. Tippe auf den roten Auslöser zum Starten.' : 'Foto-Kamera bereit. Tippe auf den Auslöser.');
  }

  async function openCameraFromAnywhere(mode) {
    if (typeof nav === 'function') nav('mediaHub');
    setTimeout(() => openCamera(mode), 120);
  }
  window.v197OpenCamera = openCameraFromAnywhere;

  async function switchCamera() {
    if (camState.recording) return;
    const camSel = byId('v197CamDevice');
    const options = camSel ? Array.from(camSel.options).filter((o) => o.value) : [];
    if (options.length > 1) {
      const currentIdx = options.findIndex((o) => o.value === camState.deviceId);
      const nextOpt = options[(currentIdx + 1) % options.length];
      camState.deviceId = nextOpt.value;
      if (camSel) camSel.value = nextOpt.value;
    } else {
      camState.deviceId = '';
      camState.facingMode = camState.facingMode === 'environment' ? 'user' : 'environment';
    }
    camState.extraRotateDeg = 0;
    await openCamera(camState.mode);
  }

  function rotateCamera90() {
    camState.extraRotateDeg = (camState.extraRotateDeg + 90) % 360;
    syncCamUi();
  }

  function closeCamera() {
    stopStream();
    syncCamUi();
    notify('Kamera geschlossen.');
  }

  function getOutputDimensions(aspectMode) {
    if (aspectMode === '4:5') return { dw: 1080, dh: 1350, ratio: 4 / 5 };
    if (aspectMode === '1:1') return { dw: 1080, dh: 1080, ratio: 1 };
    if (aspectMode === '16:9') return { dw: 1280, dh: 720, ratio: 16 / 9 };
    return { dw: 720, dh: 1280, ratio: 9 / 16 };
  }

  function drawVideoToCanvas(vid, canvas) {
    const srcW = vid.videoWidth || 1280;
    const srcH = vid.videoHeight || 720;
    const { dw, dh, ratio } = getOutputDimensions(camState.aspect);
    if (canvas.width !== dw || canvas.height !== dh) {
      canvas.width = dw;
      canvas.height = dh;
    }
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#060a16';
    ctx.fillRect(0, 0, dw, dh);

    let sourceEl = vid;
    let effW = srcW;
    let effH = srcH;
    if (camState.extraRotateDeg % 360 !== 0) {
      const rotCanvas = document.createElement('canvas');
      const rad = (camState.extraRotateDeg * Math.PI) / 180;
      if (camState.extraRotateDeg % 180 !== 0) { rotCanvas.width = srcH; rotCanvas.height = srcW; }
      else { rotCanvas.width = srcW; rotCanvas.height = srcH; }
      const rctx = rotCanvas.getContext('2d');
      rctx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
      rctx.rotate(rad);
      rctx.drawImage(vid, -srcW / 2, -srcH / 2, srcW, srcH);
      sourceEl = rotCanvas;
      effW = rotCanvas.width;
      effH = rotCanvas.height;
    }

    const effRatio = effW / effH;
    let sw = effW, sh = effH, sx = 0, sy = 0;
    if (effRatio > ratio) {
      sw = Math.round(effH * ratio);
      sx = Math.round((effW - sw) / 2);
    } else if (effRatio < ratio) {
      sh = Math.round(effW / ratio);
      sy = Math.round((effH - sh) / 2);
    }

    ctx.save();
    ctx.filter = currentFilterCss();
    const shouldMirror = camState.mirror || (!camState.deviceId && camState.facingMode === 'user');
    if (shouldMirror) {
      ctx.translate(dw, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(sourceEl, sx, sy, sw, sh, 0, 0, dw, dh);
    ctx.restore();
  }

  function triggerFlash() {
    const fl = byId('v197CamFlash');
    if (!fl) return;
    fl.classList.add('flash-on');
    requestAnimationFrame(() => { setTimeout(() => fl.classList.remove('flash-on'), 60); });
  }

  async function runCountdownIfNeeded() {
    if (!camState.timerSec) return true;
    const cdEl = byId('v197CamCountdown');
    camState.countingDown = true;
    camState.countdownAbort = false;
    syncCamUi();
    for (let left = camState.timerSec; left >= 1; left--) {
      if (camState.countdownAbort || !camState.stream) {
        if (cdEl) cdEl.hidden = true;
        camState.countingDown = false;
        syncCamUi();
        return false;
      }
      if (cdEl) { cdEl.textContent = String(left); cdEl.hidden = false; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (cdEl) cdEl.hidden = true;
    camState.countingDown = false;
    syncCamUi();
    return !camState.countdownAbort && !!camState.stream;
  }

  function showPostCaptureBar(id, kind, name) {
    camState.lastCaptured = { id, kind, name };
    const box = byId('v197CamResultBox');
    const info = byId('v197CamResultInfo');
    const editBtn = byId('v197CamEditNowBtn');
    const pubBtn = byId('v197CamPublishNowBtn');
    if (!box || !info) return;
    info.textContent = (kind === 'video' ? '🎬 Video gespeichert: ' : '📸 Foto gespeichert: ') + (name || 'Aufnahme');
    if (editBtn) {
      editBtn.textContent = kind === 'video' ? '🎬 Direkt im Video-Studio bearbeiten' : '✏️ Direkt im Bild-Studio bearbeiten';
      editBtn.onclick = () => openEditorForCaptured(id, kind);
    }
    if (pubBtn) {
      pubBtn.onclick = () => {
        if (typeof v17PickForPublish === 'function') v17PickForPublish(id, kind);
        else if (typeof nav === 'function') nav('composer');
      };
    }
    box.hidden = false;
  }

  function openEditorForCaptured(id, kind) {
    if (!id) return;
    if (kind === 'video') {
      if (typeof openVideoStudio === 'function') openVideoStudio(id);
      else if (typeof nav === 'function') nav('videoStudio');
    } else {
      if (typeof openStudio === 'function') openStudio(id);
      else if (typeof nav === 'function') nav('studio');
    }
  }

  async function uploadCapturedFile(file, kind) {
    if (!file) return;
    camState.busy = true;
    syncCamUi();
    notify(kind === 'video' ? 'Video wird gespeichert & für Social Media optimiert …' : 'Foto wird in der Mediathek gespeichert …');
    try {
      let res;
      if (typeof v17TransmitMedia === 'function') {
        res = await v17TransmitMedia(file, (txt) => notify(txt), true);
      } else {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('optimize_video', 'true');
        const r = await fetch('/api/media', {
          method: 'POST',
          headers: { 'X-Admin-Token': typeof auth !== 'undefined' ? auth : '' },
          body: fd,
        });
        res = await r.json();
        if (!r.ok) throw new Error(res.detail || 'Upload fehlgeschlagen');
      }
      if (typeof refresh === 'function') await refresh();
      const newId = res && res.id ? res.id : '';
      const newName = (res && res.name) || file.name;
      if (newId && typeof v17State !== 'undefined') {
        if (kind === 'video') { v17State.defaultVideo = newId; v17State.hubKind = 'video'; }
        else { v17State.defaultImage = newId; v17State.hubKind = 'image'; }
        if (typeof v17RenderHub === 'function') v17RenderHub();
        if (typeof v17RenderAssets === 'function') v17RenderAssets();
      }
      showPostCaptureBar(newId, kind, newName);
      notify(kind === 'video' ? '✓ Video gespeichert und bereit!' : '✓ Foto gespeichert und bereit!');
      if (camState.autoOpenEditor && newId) {
        stopStream();
        syncCamUi();
        setTimeout(() => openEditorForCaptured(newId, kind), 220);
      }
    } catch (err) {
      notify('Speichern fehlgeschlagen: ' + (err?.message || 'Unbekannter Fehler'), true);
    } finally {
      camState.busy = false;
      syncCamUi();
    }
  }

  async function takePhoto() {
    if (!camState.stream || camState.busy || camState.countingDown) return;
    const vid = byId('v197CamVideo');
    if (!vid || !vid.videoWidth) { notify('Kamera-Bild lädt noch … bitte kurz warten.', true); return; }
    const ok = await runCountdownIfNeeded();
    if (!ok) return;

    triggerFlash();
    const canvas = document.createElement('canvas');
    drawVideoToCanvas(vid, canvas);
    canvas.toBlob(async (blob) => {
      if (!blob) { notify('Foto konnte nicht erstellt werden.', true); return; }
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = new File([blob], 'kamera-foto-' + ts + '.jpg', { type: 'image/jpeg' });
      await uploadCapturedFile(file, 'image');
    }, 'image/jpeg', 0.93);
  }

  function pickRecorderMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (const mime of candidates) {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return '';
  }

  async function startVideoRecording() {
    if (!camState.stream || camState.recording || camState.busy || camState.countingDown) return;
    if (typeof MediaRecorder === 'undefined') { notify('Dieser Browser unterstützt keine direkte Video-Aufnahme.', true); return; }
    const ok = await runCountdownIfNeeded();
    if (!ok) return;

    const vid = byId('v197CamVideo');
    const canvas = document.createElement('canvas');
    drawVideoToCanvas(vid, canvas);

    let recordStream = camState.stream;
    let drawTimer = null;
    if (typeof canvas.captureStream === 'function') {
      const canvasStream = canvas.captureStream(30);
      const audioTracks = camState.stream.getAudioTracks();
      if (audioTracks.length) canvasStream.addTrack(audioTracks[0]);
      recordStream = canvasStream;
      drawTimer = setInterval(() => {
        if (!camState.stream || !vid || vid.readyState < 2) return;
        drawVideoToCanvas(vid, canvas);
      }, 33);
    }

    camState.chunks = [];
    const mimeType = pickRecorderMime();
    let rec;
    try { rec = mimeType ? new MediaRecorder(recordStream, { mimeType }) : new MediaRecorder(recordStream); }
    catch (_) { rec = new MediaRecorder(recordStream); }
    camState.recorder = rec;
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) camState.chunks.push(ev.data); };
    rec.onstop = async () => {
      if (drawTimer) clearInterval(drawTimer);
      stopTimer();
      camState.recording = false;
      syncCamUi();
      if (!camState.chunks.length) return;
      const finalMime = rec.mimeType || mimeType || 'video/webm';
      const ext = finalMime.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(camState.chunks, { type: finalMime });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = new File([blob], 'kamera-video-' + ts + '.' + ext, { type: finalMime });
      await uploadCapturedFile(file, 'video');
    };
    rec.start(400);
    camState.recording = true;
    camState.startedAt = Date.now();
    const timerEl = byId('v197CamTimer');
    if (timerEl) timerEl.textContent = '00:00';
    stopTimer();
    camState.timerId = setInterval(() => {
      const elapsed = Math.floor((Date.now() - camState.startedAt) / 1000);
      if (timerEl) timerEl.textContent = formatTimer(elapsed);
    }, 500);
    syncCamUi();
    notify('● Aufnahme läuft (' + camState.aspect + ') …');
  }

  function stopVideoRecording() {
    if (camState.recorder && camState.recorder.state !== 'inactive') camState.recorder.stop();
  }

  function handleShutterClick() {
    if (camState.mode === 'photo') takePhoto();
    else if (camState.recording) stopVideoRecording();
    else startVideoRecording();
  }

  async function handleNativeCaptureInput(inputEl, kind) {
    const file = inputEl && inputEl.files && inputEl.files[0];
    if (!file) return;
    await uploadCapturedFile(file, kind);
    inputEl.value = '';
  }

  function injectDirectAppButtons() {
    const v17UploadBtn = byId('v17Upload');
    if (v17UploadBtn && !byId('v197ComposerDirectStrip')) {
      const strip = document.createElement('div');
      strip.id = 'v197ComposerDirectStrip';
      strip.className = 'v197-direct-strip';
      strip.innerHTML =
        '<button type="button" class="outline" id="v197CompPhotoBtn">📸 Foto mit Kamera aufnehmen</button>' +
        '<button type="button" class="outline" id="v197CompVideoBtn">🎬 Video mit Kamera aufnehmen</button>';
      v17UploadBtn.parentNode.insertAdjacentElement('afterend', strip);
      byId('v197CompPhotoBtn')?.addEventListener('click', () => openCameraFromAnywhere('photo'));
      byId('v197CompVideoBtn')?.addEventListener('click', () => openCameraFromAnywhere('video'));
    }

    const v9Src = byId('v9VideoSource');
    if (v9Src && !byId('v197VideoStudioDirectStrip')) {
      const strip = document.createElement('div');
      strip.id = 'v197VideoStudioDirectStrip';
      strip.className = 'v197-direct-strip';
      strip.innerHTML =
        '<button type="button" class="outline" id="v197VidStudioCamBtn">🎬 Neues Video direkt mit Kamera aufnehmen &amp; hier bearbeiten</button>';
      v9Src.insertAdjacentElement('afterend', strip);
      byId('v197VidStudioCamBtn')?.addEventListener('click', () => openCameraFromAnywhere('video'));
    }

    const stSrc = byId('studioSource');
    if (stSrc && !byId('v197ImageStudioDirectStrip')) {
      const strip = document.createElement('div');
      strip.id = 'v197ImageStudioDirectStrip';
      strip.className = 'v197-direct-strip';
      strip.innerHTML =
        '<button type="button" class="outline tiny" id="v197ImgStudioCamBtn">📸 Neues Foto mit Kamera aufnehmen</button>';
      stSrc.insertAdjacentElement('afterend', strip);
      byId('v197ImgStudioCamBtn')?.addEventListener('click', () => openCameraFromAnywhere('photo'));
    }
  }

  function injectCameraCard() {
    const hub = byId('mediaHub');
    if (!hub || byId('v197CameraStudio')) return;
    const firstSurface = hub.querySelector('.v17-surface');
    if (!firstSurface) return;

    const filterChips = Object.entries(CAM_FILTERS)
      .map(([k, v]) => '<button type="button" class="v197-chip' + (k === 'original' ? ' active' : '') + '" data-v197-filter="' + k + '">' + v.label + '</button>')
      .join('');

    const card = document.createElement('div');
    card.className = 'v17-surface v197-cam-card';
    card.id = 'v197CameraStudio';
    card.innerHTML =
      '<div class="v197-cam-head">' +
      '<div>' +
      '<span class="v17-kicker">CREATOR KAMERA-STUDIO · PC &amp; HANDY</span>' +
      '<h3>📸 Foto &amp; Video direkt aufnehmen &amp; sofort bearbeiten</h3>' +
      '<p class="v17-caption" style="margin:2px 0 0;">Moderner Sucher mit Live-Looks, Selbstauslöser, 9:16/4:5-Formaten sowie PC-Kamera- &amp; Mikrofon-Auswahl.</p>' +
      '</div>' +
      '<button type="button" class="outline tiny" id="v197RefreshDevBtn" title="Angeschlossene Kameras und Mikrofone neu einlesen">↻ Geräte suchen</button>' +
      '</div>' +
      '<div class="v197-cam-controls-grid">' +
      '<label>Kamera auswählen<select id="v197CamDevice"><option value="">Automatisch (Standard-Kamera)</option></select></label>' +
      '<label>Mikrofon (für Video)<select id="v197MicDevice"><option value="">Automatisch (Standard-Mikrofon)</option><option value="none">🔇 Ohne Ton aufnehmen</option></select></label>' +
      '<label>Start-Format<select id="v197CamAspect">' +
      '<option value="9:16" selected>9:16 Hochformat (Story/Reel/TikTok)</option>' +
      '<option value="4:5">4:5 Hochformat (Instagram/FB Feed)</option>' +
      '<option value="1:1">1:1 Quadrat</option>' +
      '<option value="16:9">16:9 Querformat (YouTube)</option>' +
      '</select></label>' +
      '</div>' +
      '<div class="v197-cam-actions">' +
      '<button type="button" id="v197OpenPhotoCamBtn">📸 Foto-Kamera starten</button>' +
      '<button type="button" id="v197OpenVideoCamBtn">🎬 Video-Kamera starten</button>' +
      '<label class="v197-cam-auto-open"><input type="checkbox" id="v197CamAutoOpen" checked/> Nach Aufnahme direkt im Studio öffnen</label>' +
      '</div>' +
      '<div class="v197-cam-stage" id="v197CamStage" hidden>' +
      '<div class="v197-cam-hud">' +
      '<div class="v197-cam-hud-left">' +
      '<div class="v197-cam-mode-switch">' +
      '<button type="button" class="v197-cam-mode-btn active" id="v197ModePhotoBtn">📸 Foto</button>' +
      '<button type="button" class="v197-cam-mode-btn" id="v197ModeVideoBtn">🎬 Video</button>' +
      '</div>' +
      '<span id="v197CamModeLabel">Kamera · 9:16</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;">' +
      '<span class="v197-cam-rec-pill" id="v197CamRecPill" hidden><span class="v197-cam-rec-dot"></span> REC <span id="v197CamTimer">00:00</span></span>' +
      '<button type="button" class="v197-tool-btn" id="v197CamCloseBtn">✕ Schließen</button>' +
      '</div>' +
      '</div>' +
      '<div class="v197-cam-pill-row">' +
      '<div class="v197-pill-group"><span class="v197-pill-label">Format</span>' +
      '<button type="button" class="v197-chip active" data-v197-aspect="9:16">9:16</button>' +
      '<button type="button" class="v197-chip" data-v197-aspect="4:5">4:5</button>' +
      '<button type="button" class="v197-chip" data-v197-aspect="1:1">1:1</button>' +
      '<button type="button" class="v197-chip" data-v197-aspect="16:9">16:9</button>' +
      '</div>' +
      '<div class="v197-pill-group"><span class="v197-pill-label">Timer</span>' +
      '<button type="button" class="v197-chip active" data-v197-timer="0">Aus</button>' +
      '<button type="button" class="v197-chip" data-v197-timer="3">3s</button>' +
      '<button type="button" class="v197-chip" data-v197-timer="5">5s</button>' +
      '</div>' +
      '</div>' +
      '<div class="v197-cam-pill-row">' +
      '<div class="v197-pill-group"><span class="v197-pill-label">Live-Look</span>' + filterChips + '</div>' +
      '</div>' +
      '<div class="v197-cam-viewport">' +
      '<div id="v197CamFrameBox">' +
      '<video class="v197-cam-video" id="v197CamVideo" autoplay playsinline muted></video>' +
      '<div id="v197CamGrid" style="pointer-events:none;position:absolute;inset:0;background-image:linear-gradient(to right, rgba(255,255,255,0.2) 1px, transparent 1px),linear-gradient(to bottom, rgba(255,255,255,0.2) 1px, transparent 1px);background-size:33.33% 33.33%;"></div>' +
      '<div class="v197-cam-countdown" id="v197CamCountdown" hidden>3</div>' +
      '<div class="v197-cam-flash" id="v197CamFlash"></div>' +
      '</div>' +
      '</div>' +
      '<div class="v197-cam-bar">' +
      '<div class="v197-cam-bar-left">' +
      '<button type="button" class="v197-tool-btn active" id="v197CamGridBtn" title="Drittel-Raster ein/aus">⊞ Raster</button>' +
      '<button type="button" class="v197-tool-btn" id="v197CamMirrorBtn" title="Kamera horizontal spiegeln">⇄ Spiegeln</button>' +
      '</div>' +
      '<div class="v197-cam-bar-center">' +
      '<button type="button" class="v197-shutter-btn" id="v197ShutterBtn" aria-label="Foto aufnehmen"><span class="v197-shutter-inner"></span></button>' +
      '<span class="v197-shutter-caption" id="v197ShutterCaption">Foto aufnehmen</span>' +
      '</div>' +
      '<div class="v197-cam-bar-right">' +
      '<button type="button" class="v197-tool-btn" id="v197CamRotateBtn" title="Bild um 90 Grad drehen">↻ 90°</button>' +
      '<button type="button" class="v197-tool-btn" id="v197CamSwitchBtn" title="Kamera wechseln">🔄 Wechseln</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="v197-cam-result" id="v197CamResultBox" hidden>' +
      '<div class="v197-cam-result-info" id="v197CamResultInfo"></div>' +
      '<div class="v197-cam-result-actions">' +
      '<button type="button" id="v197CamEditNowBtn">✏️ Direkt bearbeiten</button>' +
      '<button type="button" class="outline" id="v197CamPublishNowBtn">✦ Direkt zum Veröffentlichen</button>' +
      '</div>' +
      '</div>' +
      '<div class="v197-native-fallback">' +
      '<span>Optional am Smartphone (native Handy-App):</span>' +
      '<label class="v197-native-btn" for="v197NativePhotoInput">📱 Handy Foto-App<input id="v197NativePhotoInput" type="file" accept="image/*" capture="environment" hidden/></label>' +
      '<label class="v197-native-btn" for="v197NativeVideoInput">📱 Handy Video-App<input id="v197NativeVideoInput" type="file" accept="video/*" capture="environment" hidden/></label>' +
      '</div>' +
      '<div class="v197-cam-status" id="v197CamStatus" role="status" aria-live="polite">Bereit · Wähle deine Kamera und starte Foto- oder Videoaufnahme.</div>';

    firstSurface.parentNode.insertBefore(card, firstSurface);
    camState.aspect = byId('v197CamAspect')?.value || '9:16';
    camState.autoOpenEditor = !!byId('v197CamAutoOpen')?.checked;
    applyStageAspect();
    refreshDevices();

    if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
      navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    }

    byId('v197RefreshDevBtn')?.addEventListener('click', async () => { await refreshDevices(); notify('Kamera- und Mikrofonliste aktualisiert.'); });
    byId('v197CamDevice')?.addEventListener('change', async (e) => {
      camState.deviceId = e.target.value || '';
      camState.extraRotateDeg = 0;
      if (camState.stream && !camState.recording) await openCamera(camState.mode);
      else syncCamUi();
    });
    byId('v197MicDevice')?.addEventListener('change', async (e) => {
      camState.audioDeviceId = e.target.value || '';
      if (camState.stream && camState.mode === 'video' && !camState.recording) await openCamera('video');
    });
    byId('v197CamAspect')?.addEventListener('change', async (e) => {
      camState.aspect = e.target.value || '9:16';
      syncCamUi();
      if (camState.stream && !camState.recording) await openCamera(camState.mode);
    });
    byId('v197CamAutoOpen')?.addEventListener('change', (e) => { camState.autoOpenEditor = !!e.target.checked; });

    byId('v197OpenPhotoCamBtn')?.addEventListener('click', () => openCamera('photo'));
    byId('v197OpenVideoCamBtn')?.addEventListener('click', () => openCamera('video'));
    byId('v197ModePhotoBtn')?.addEventListener('click', () => { if (!camState.recording && camState.mode !== 'photo') openCamera('photo'); });
    byId('v197ModeVideoBtn')?.addEventListener('click', () => { if (!camState.recording && camState.mode !== 'video') openCamera('video'); });
    byId('v197ShutterBtn')?.addEventListener('click', handleShutterClick);
    byId('v197CamGridBtn')?.addEventListener('click', () => { camState.showGrid = !camState.showGrid; syncCamUi(); });
    byId('v197CamMirrorBtn')?.addEventListener('click', () => { camState.mirror = !camState.mirror; syncCamUi(); });
    byId('v197CamRotateBtn')?.addEventListener('click', rotateCamera90);
    byId('v197CamSwitchBtn')?.addEventListener('click', switchCamera);
    byId('v197CamCloseBtn')?.addEventListener('click', closeCamera);
    byId('v197NativePhotoInput')?.addEventListener('change', (e) => handleNativeCaptureInput(e.target, 'image'));
    byId('v197NativeVideoInput')?.addEventListener('change', (e) => handleNativeCaptureInput(e.target, 'video'));

    card.querySelectorAll('[data-v197-aspect]').forEach((b) => {
      b.addEventListener('click', () => {
        if (camState.recording) return;
        camState.aspect = b.dataset.v197Aspect;
        const sel = byId('v197CamAspect');
        if (sel) sel.value = camState.aspect;
        syncCamUi();
      });
    });
    card.querySelectorAll('[data-v197-timer]').forEach((b) => {
      b.addEventListener('click', () => {
        if (camState.recording || camState.countingDown) return;
        camState.timerSec = Number(b.dataset.v197Timer) || 0;
        syncCamUi();
      });
    });
    card.querySelectorAll('[data-v197-filter]').forEach((b) => {
      b.addEventListener('click', () => {
        camState.filter = b.dataset.v197Filter || 'original';
        syncCamUi();
      });
    });

    document.addEventListener('keydown', (ev) => {
      if (!camState.stream || ev.code !== 'Space') return;
      const tag = (ev.target && ev.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return;
      const stage = byId('v197CamStage');
      if (stage && !stage.hidden) { ev.preventDefault(); handleShutterClick(); }
    });

    injectDirectAppButtons();
  }

  window.addEventListener('beforeunload', stopStream);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectCameraCard);
  else injectCameraCard();
})();
