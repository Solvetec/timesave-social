/* TimeSave Social V20.0 – PC & Handy Kamera-/Mikrofon-Auswahl, 9:16-Format & 1-Klick Direkt-Bearbeitung */
(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);

  const camState = {
    stream: null,
    recorder: null,
    chunks: [],
    mode: 'photo', // 'photo' | 'video'
    facingMode: 'environment', // 'environment' | 'user'
    deviceId: '', // selected videoinput deviceId (important for PC!)
    audioDeviceId: '', // selected audioinput deviceId or 'none'
    aspect: '9:16', // '9:16' | '1:1' | '16:9'
    extraRotateDeg: 0, // 0 | 90 | 180 | 270
    showGrid: true,
    autoOpenEditor: true,
    recording: false,
    timerId: null,
    startedAt: 0,
    busy: false,
    lastCaptured: null, // { id, kind, name }
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

  async function refreshDevices() {
    const camSel = byId('v197CamDevice');
    const micSel = byId('v197MicDevice');
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === 'videoinput');
      const mics = devices.filter((d) => d.kind === 'audioinput');

      if (camSel) {
        const prev = camState.deviceId || camSel.value || '';
        const opts = ['<option value="">Automatisch (Standard-Kamera)</option>'];
        cams.forEach((d, idx) => {
          const label = d.label || ('Kamera ' + (idx + 1));
          const sel = d.deviceId && d.deviceId === prev ? ' selected' : '';
          opts.push('<option value="' + escAttr(d.deviceId) + '"' + sel + '>' + escHtml(label) + '</option>');
        });
        camSel.innerHTML = opts.join('');
        if (prev && cams.some((d) => d.deviceId === prev)) {
          camSel.value = prev;
          camState.deviceId = prev;
        }
      }

      if (micSel) {
        const prevMic = camState.audioDeviceId || micSel.value || '';
        const mOpts = [
          '<option value="">Automatisch (Standard-Mikrofon)</option>',
          '<option value="none"' + (prevMic === 'none' ? ' selected' : '') + '>🔇 Ohne Ton aufnehmen</option>',
        ];
        mics.forEach((d, idx) => {
          const label = d.label || ('Mikrofon ' + (idx + 1));
          const sel = d.deviceId && d.deviceId === prevMic ? ' selected' : '';
          mOpts.push('<option value="' + escAttr(d.deviceId) + '"' + sel + '>' + escHtml(label) + '</option>');
        });
        micSel.innerHTML = mOpts.join('');
        if (prevMic === 'none' || mics.some((d) => d.deviceId === prevMic)) {
          micSel.value = prevMic;
          camState.audioDeviceId = prevMic;
        }
      }
    } catch (_) {
      // Ignore device enumeration errors prior to permission
    }
  }

  function escHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escAttr(v) {
    return escHtml(v);
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
    } else {
      frameBox.style.aspectRatio = '16 / 9';
      frameBox.style.maxWidth = '640px';
      frameBox.style.maxHeight = '360px';
      frameBox.style.margin = '10px auto';
    }

    if (vid) {
      const mirror = !camState.deviceId && camState.facingMode === 'user' ? 'scaleX(-1)' : '';
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
      const camSel = byId('v197CamDevice');
      const selectedLabel = camSel && camSel.value ? camSel.options[camSel.selectedIndex]?.textContent : (camState.facingMode === 'user' ? 'Frontkamera' : 'Kamera');
      modeLabel.textContent =
        (camState.mode === 'video' ? '🎬 Video' : '📸 Foto') +
        ' · ' +
        selectedLabel +
        ' · ' +
        camState.aspect +
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
    const base = {};
    if (camState.deviceId) {
      base.deviceId = { exact: camState.deviceId };
    } else {
      base.facingMode = { ideal: camState.facingMode };
    }
    if (camState.aspect === '9:16') {
      base.width = { ideal: 720 };
      base.height = { ideal: 1280 };
    } else if (camState.aspect === '1:1') {
      base.width = { ideal: 1080 };
      base.height = { ideal: 1080 };
    } else {
      base.width = { ideal: 1280 };
      base.height = { ideal: 720 };
    }
    return base;
  }

  function buildAudioConstraints() {
    if (camState.mode !== 'video' || camState.audioDeviceId === 'none') return false;
    if (camState.audioDeviceId) return { deviceId: { exact: camState.audioDeviceId } };
    return true;
  }

  async function openCamera(mode) {
    if (camState.recording) {
      notify('Bitte zuerst die laufende Videoaufnahme stoppen.', true);
      return;
    }
    camState.mode = mode === 'video' ? 'video' : 'photo';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      notify('Browser-Kamera wird hier nicht unterstützt (HTTPS oder localhost erforderlich).', true);
      return;
    }
    stopStream();
    notify('⏳ Kamera wird gestartet …');
    try {
      const vConstraints = buildVideoConstraints();
      const aConstraints = buildAudioConstraints();
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: vConstraints, audio: aConstraints });
      } catch (_) {
        try {
          const fallbackV = camState.deviceId ? { deviceId: { ideal: camState.deviceId } } : true;
          stream = await navigator.mediaDevices.getUserMedia({ video: fallbackV, audio: aConstraints });
        } catch (err2) {
          if (camState.mode === 'video' && aConstraints !== false) {
            // PC without microphone fallback
            const fallbackV = camState.deviceId ? { deviceId: { ideal: camState.deviceId } } : true;
            stream = await navigator.mediaDevices.getUserMedia({ video: fallbackV, audio: false });
            notify('Kein Mikrofon gefunden – Video-Kamera wurde ohne Ton gestartet.');
          } else {
            throw err2;
          }
        }
      }
      camState.stream = stream;
      const activeTrack = stream.getVideoTracks()[0];
      const activeSettings = activeTrack && activeTrack.getSettings ? activeTrack.getSettings() : {};
      if (activeSettings.deviceId) {
        camState.deviceId = activeSettings.deviceId;
      }
      const vid = byId('v197CamVideo');
      if (vid) {
        vid.srcObject = stream;
        await vid.play().catch(() => {});
      }
      // Refresh device list now that browser permission is granted (reveals real webcam names!)
      await refreshDevices();
      syncCamUi();
      notify(
        camState.mode === 'video'
          ? 'Kamera bereit. Klicke auf „● Aufnahme starten“ – danach kannst du das Video direkt im Video-Studio bearbeiten.'
          : 'Kamera bereit. Klicke auf „📸 Foto aufnehmen“ – danach kannst du das Bild direkt im Bild-Studio bearbeiten.'
      );
    } catch (err) {
      stopStream();
      syncCamUi();
      notify('Kamera konnte nicht gestartet werden (' + (err.name || err.message || 'Bitte Kamera-Zugriff im Browser erlauben') + ').', true);
    }
  }

  async function openCameraFromAnywhere(mode) {
    if (typeof nav === 'function') nav('mediaHub');
    const studio = byId('v197CameraStudio');
    if (studio) studio.scrollIntoView({ behavior: 'smooth', block: 'start' });
    await openCamera(mode === 'video' ? 'video' : 'photo');
  }

  async function switchCamera() {
    const camSel = byId('v197CamDevice');
    // On PC with multiple cameras, cycle through the dropdown options!
    if (camSel && camSel.options.length > 2) {
      let nextIdx = camSel.selectedIndex + 1;
      if (nextIdx >= camSel.options.length || !camSel.options[nextIdx].value) nextIdx = 1;
      camSel.selectedIndex = nextIdx;
      camState.deviceId = camSel.value;
    } else {
      camState.deviceId = '';
      camState.facingMode = camState.facingMode === 'environment' ? 'user' : 'environment';
    }
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
    if (!camState.deviceId && camState.facingMode === 'user') {
      ctx.translate(dw, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(sourceEl, sx, sy, sw, sh, 0, 0, dw, dh);
    ctx.restore();
  }

  function showPostCaptureBar(id, kind, name) {
    camState.lastCaptured = { id, kind, name };
    const box = byId('v197CamResultBox');
    const info = byId('v197CamResultInfo');
    const editBtn = byId('v197CamEditNowBtn');
    const pubBtn = byId('v197CamPublishNowBtn');
    if (!box || !info || !editBtn || !pubBtn) return;

    info.innerHTML = '✅ Gespeichert in der Mediathek: <b>' + escHtml(name || id) + '</b>';
    editBtn.textContent = kind === 'video' ? '🎬 Direkt im Video-Studio bearbeiten' : '✏️ Direkt im Bild-Studio bearbeiten';
    editBtn.onclick = () => openEditorForCaptured(id, kind);
    pubBtn.onclick = () => {
      closeCamera();
      if (typeof v17State !== 'undefined' && v17State) {
        if (kind === 'video') v17State.defaultVideo = id;
        else v17State.defaultImage = id;
        if (typeof v17SetKind === 'function') v17SetKind(kind === 'video' ? 'video' : 'image');
        if (typeof v17UpdateDefaultsUI === 'function') v17UpdateDefaultsUI();
      }
      if (typeof nav === 'function') nav('publish');
    };
    box.hidden = false;
  }

  function openEditorForCaptured(id, kind) {
    closeCamera();
    if (kind === 'video') {
      if (typeof openVideoStudio === 'function') openVideoStudio(id);
    } else {
      if (typeof openStudio === 'function') openStudio(id);
    }
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
      const savedName = res?.original_name || file.name;
      notify('✓ ' + (kind === 'video' ? 'Video' : 'Foto') + ' gespeichert!');
      if (res && res.id) {
        showPostCaptureBar(res.id, kind, savedName);
        if (camState.autoOpenEditor) {
          setTimeout(() => openEditorForCaptured(res.id, kind), 350);
        }
      }
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
    const file = new File([blob], 'Kamera_Foto_' + camState.aspect.replace(':', 'x') + '_' + stamp + '.jpg', { type: 'image/jpeg' });
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
      notify('Direkte Videoaufnahme wird in diesem Browser nicht unterstützt.', true);
      return;
    }

    let captureStream = camState.stream;
    let rafId = null;

    if (typeof HTMLCanvasElement.prototype.captureStream === 'function') {
      const canvas = document.createElement('canvas');
      drawVideoToCanvas(vid, canvas);

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
      const file = new File([blob], 'Kamera_Video_' + camState.aspect.replace(':', 'x') + '_' + stamp + ext, { type: actualMime });
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
    notify('● Aufnahme läuft … Klicke auf „⏹ Stopp & speichern“.');
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
    // 1. In #publish: buttons open the real in-app camera (works on PC AND mobile!)
    const uploadPair = document.querySelector('#publish .v17-upload-pair');
    if (uploadPair && !byId('v197PublishAppButtons')) {
      const row = document.createElement('div');
      row.className = 'v197-inline-cam-row';
      row.id = 'v197PublishAppButtons';
      row.style.gridColumn = '1 / -1';
      row.innerHTML =
        '<button type="button" class="v197-inline-cam-btn" id="v197PubPhotoCamBtn">📸 Foto mit Kamera aufnehmen</button>' +
        '<button type="button" class="v197-inline-cam-btn" id="v197PubVideoCamBtn">🎬 Video mit Kamera aufnehmen</button>';
      uploadPair.parentNode.insertBefore(row, uploadPair.nextSibling);
      byId('v197PubPhotoCamBtn')?.addEventListener('click', () => openCameraFromAnywhere('photo'));
      byId('v197PubVideoCamBtn')?.addEventListener('click', () => openCameraFromAnywhere('video'));
    }

    // 2. In #videoStudio: direct button to record a new video and jump straight back into Video Studio
    const vidStudio = byId('videoStudio');
    if (vidStudio && !byId('v197VideoStudioAppBtn')) {
      const heading = vidStudio.querySelector('h2, h3');
      if (heading && heading.parentNode) {
        const btnWrap = document.createElement('div');
        btnWrap.style.margin = '8px 0 12px';
        btnWrap.innerHTML =
          '<button type="button" class="v197-inline-cam-btn" id="v197VideoStudioAppBtn" style="display:inline-flex;width:auto;">🎬 Neues Video direkt mit Kamera aufnehmen &amp; hier bearbeiten</button>';
        heading.parentNode.insertBefore(btnWrap, heading.nextSibling);
        byId('v197VideoStudioAppBtn')?.addEventListener('click', () => {
          camState.autoOpenEditor = true;
          const cb = byId('v197CamAutoOpen');
          if (cb) cb.checked = true;
          openCameraFromAnywhere('video');
        });
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
      '<span class="v17-kicker">DIREKTAUFNAHME · PC &amp; HANDY KAMERA-STUDIO</span>' +
      '<h3>📸 Foto &amp; Video direkt aufnehmen &amp; sofort bearbeiten</h3>' +
      '<p class="v17-caption" style="margin:2px 0 0;">Wähle deine Kamera und dein Mikrofon (funktioniert auf PC &amp; Smartphone direkt im Browser), nimm auf und bearbeite das Foto oder Video sofort mit einem Klick.</p>' +
      '</div>' +
      '<button type="button" class="outline tiny" id="v197RefreshDevBtn" title="Angeschlossene Kameras und Mikrofone neu einlesen">↻ Kameras suchen</button>' +
      '</div>' +
      '<div class="v197-cam-controls-grid">' +
      '<label>Kamera auswählen<select id="v197CamDevice"><option value="">Automatisch (Standard-Kamera)</option></select></label>' +
      '<label>Mikrofon (für Video)<select id="v197MicDevice"><option value="">Automatisch (Standard-Mikrofon)</option><option value="none">🔇 Ohne Ton aufnehmen</option></select></label>' +
      '<label>Format<select id="v197CamAspect">' +
      '<option value="9:16" selected>9:16 Hochformat (TikTok/Reels)</option>' +
      '<option value="1:1">1:1 Quadrat</option>' +
      '<option value="16:9">16:9 Querformat</option>' +
      '</select></label>' +
      '</div>' +
      '<div class="v197-cam-actions">' +
      '<button type="button" id="v197OpenPhotoCamBtn">📸 Foto-Kamera starten</button>' +
      '<button type="button" id="v197OpenVideoCamBtn">🎬 Video-Kamera starten</button>' +
      '<label class="v197-cam-auto-open"><input type="checkbox" id="v197CamAutoOpen" checked/> Nach Aufnahme direkt im Studio öffnen</label>' +
      '</div>' +
      '<div class="v197-cam-stage" id="v197CamStage" hidden>' +
      '<div class="v197-cam-hud">' +
      '<span id="v197CamModeLabel">📸 Foto · Kamera · 9:16</span>' +
      '<span class="v197-cam-rec-pill" id="v197CamRecPill" hidden><span class="v197-cam-rec-dot"></span> REC <span id="v197CamTimer">00:00</span></span>' +
      '</div>' +
      '<div id="v197CamFrameBox" style="position:relative;overflow:hidden;background:#0e0b1a;">' +
      '<video class="v197-cam-video" id="v197CamVideo" autoplay playsinline muted></video>' +
      '<div id="v197CamGrid" style="pointer-events:none;position:absolute;inset:0;border:1px solid rgba(255,255,255,0.25);background-image:linear-gradient(to right, rgba(255,255,255,0.18) 1px, transparent 1px),linear-gradient(to bottom, rgba(255,255,255,0.18) 1px, transparent 1px);background-size:33.33% 33.33%;"></div>' +
      '</div>' +
      '<div class="v197-cam-bar">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      '<button type="button" id="v197CamSnapBtn">📸 Foto aufnehmen &amp; speichern</button>' +
      '<button type="button" id="v197CamRecStartBtn" hidden>● Aufnahme starten</button>' +
      '<button type="button" class="danger" id="v197CamRecStopBtn" hidden>⏹ Stopp &amp; speichern</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
      '<label style="margin:0;color:#e5ddf7;font-size:12px;display:inline-flex;align-items:center;gap:4px;"><input type="checkbox" id="v197CamGridToggle" checked/> Raster</label>' +
      '<button type="button" class="outline" id="v197CamRotateBtn">↻ 90°</button>' +
      '<button type="button" class="outline" id="v197CamSwitchBtn">🔄 Wechseln</button>' +
      '<button type="button" class="outline" id="v197CamCloseBtn">✕ Schließen</button>' +
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
    camState.showGrid = !!byId('v197CamGridToggle')?.checked;
    camState.autoOpenEditor = !!byId('v197CamAutoOpen')?.checked;
    applyStageAspect();
    refreshDevices();

    if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
      navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    }

    byId('v197RefreshDevBtn')?.addEventListener('click', async () => {
      await refreshDevices();
      notify('Kamera- und Mikrofonliste aktualisiert.');
    });
    byId('v197CamDevice')?.addEventListener('change', async (e) => {
      camState.deviceId = e.target.value || '';
      camState.extraRotateDeg = 0;
      if (camState.stream && !camState.recording) {
        await openCamera(camState.mode);
      } else {
        syncCamUi();
      }
    });
    byId('v197MicDevice')?.addEventListener('change', async (e) => {
      camState.audioDeviceId = e.target.value || '';
      if (camState.stream && camState.mode === 'video' && !camState.recording) {
        await openCamera('video');
      }
    });
    byId('v197CamAspect')?.addEventListener('change', async (e) => {
      camState.aspect = e.target.value || '9:16';
      syncCamUi();
      if (camState.stream && !camState.recording) {
        await openCamera(camState.mode);
      }
    });
    byId('v197CamAutoOpen')?.addEventListener('change', (e) => {
      camState.autoOpenEditor = !!e.target.checked;
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
