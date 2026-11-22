/* TimeSave Social V19.5 – Datenbank-/PostgreSQL-Status, 1-Klick 16:9->9:16 Reframing & TikTok-Stil Untertitel */
(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);

  async function v195Api(url, opts) {
    if (typeof window.api === 'function') return window.api(url, opts);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || 'Anfrage fehlgeschlagen');
    return data;
  }

  function v195Toast(msg, isErr) {
    if (typeof window.toast === 'function') window.toast(msg, !!isErr);
  }

  async function pollV195Job(jobId, onProgress) {
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      const data = await v195Api('/api/studio/slideshow/' + encodeURIComponent(jobId));
      if (onProgress) onProgress(data);
      if (data.status === 'done' || data.status === 'error') return data;
    }
    throw new Error('Zeitüberschreitung bei der Videoverarbeitung.');
  }

  function refreshAllMedia() {
    if (typeof window.refresh === 'function') {
      try { window.refresh(); } catch (_) {}
    } else if (typeof window.loadAll === 'function') {
      try { window.loadAll(); } catch (_) {}
    }
  }

  // ------------------------------------------------------------------
  // 1. Datenbank- & Speicher-Status (SQLite vs. PostgreSQL) in #mediaHub
  // ------------------------------------------------------------------
  async function initDbStatusCard() {
    const storageBox = document.querySelector('#mediaHub .v1723-storage');
    if (!storageBox || byId('v195DbStatusCard')) return;

    const card = document.createElement('div');
    card.id = 'v195DbStatusCard';
    card.className = 'v195-db-card';
    card.innerHTML = '<span>⏳ Prüfe Datenbank- &amp; Speicherstatus …</span>';
    storageBox.appendChild(card);

    try {
      const info = await v195Api('/api/v19/system/db-status');
      const dbBadge = info.is_postgres
        ? '<span class="v19-badge ok">✓ Datenbank: PostgreSQL aktiv</span>'
        : '<span class="v19-badge warn">ℹ Datenbank: SQLite (lokale Datei)</span>';
      const diskBadge = info.persistent_storage
        ? '<span class="v19-badge ok">✓ Render Disk: aktiv</span>'
        : '<span class="v19-badge warn">! Render Free: kein dauerhafter Disk-Speicher</span>';
      const keyBadge = info.encryption_key_set
        ? '<span class="v19-badge ok">✓ Fernet-Key gesetzt</span>'
        : '<span class="v19-badge warn">! Fernet-Key noch nicht fest gesetzt</span>';

      const keyHelper = info.suggested_fernet_key
        ? `<div class="v195-db-keybox">` +
          `<small>Vorschlag für <code>TIMESAVE_ENCRYPTION_KEY</code> (einmalig in Render → Environment kopieren):</small>` +
          `<code id="v195FernetCode">${info.suggested_fernet_key}</code>` +
          `<button type="button" class="outline tiny" id="v195CopyFernetBtn">📋 Key kopieren</button>` +
          `</div>`
        : '';

      card.innerHTML =
        `<div class="v195-db-row">${dbBadge}${diskBadge}${keyBadge}</div>` +
        `<small>Datenverzeichnis: <code>${info.data_dir || '/tmp/timesave'}</code> · ` +
        (info.is_postgres
          ? 'Deine Konten, Vorlagen und Pläne werden dauerhaft in PostgreSQL gespeichert.'
          : 'Tipp: Sobald du in Render → Environment <code>DATABASE_URL</code> (z. B. Neon/Supabase/Render Postgres) und <code>TIMESAVE_ENCRYPTION_KEY</code> hinterlegst, schaltet TimeSave Social beim Neustart automatisch auf PostgreSQL um.') +
        `</small>` +
        keyHelper;

      byId('v195CopyFernetBtn')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(info.suggested_fernet_key);
          v195Toast('TIMESAVE_ENCRYPTION_KEY in die Zwischenablage kopiert!');
        } catch (_) {
          v195Toast('Bitte den Schlüssel manuell markieren und kopieren.', true);
        }
      });
    } catch (_) {
      card.innerHTML = '<small>Datenbankstatus wird nach dem Login angezeigt.</small>';
    }
  }

  // ------------------------------------------------------------------
  // 2. Video-Studio V19.5: 1-Klick 16:9 -> 9:16 Reframing + TikTok-Untertitel
  // ------------------------------------------------------------------
  let captionCues = [];

  function parseSrtOrScript(rawText, totalDuration) {
    const text = (rawText || '').trim();
    if (!text) return [];
    const timeRe = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/;
    if (timeRe.test(text)) {
      const blocks = text.split(/\r?\n\r?\n/);
      const parsed = [];
      for (const blk of blocks) {
        const m = blk.match(timeRe);
        if (!m) continue;
        const st = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0').slice(0, 3) / 1000;
        const en = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8].padEnd(3, '0').slice(0, 3) / 1000;
        const body = blk
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !/^\d+$/.test(l) && !l.includes('-->'))
          .join(' ');
        if (body) parsed.push({ start: Number(st.toFixed(2)), end: Number(Math.max(st + 0.25, en).toFixed(2)), text: body.slice(0, 220) });
      }
      if (parsed.length) return parsed.slice(0, 250);
    }

    // Plain text -> punchy 4-word TikTok chunks evenly distributed across duration
    const words = text.replace(/\s+/g, ' ').split(' ').filter(Boolean);
    const chunks = [];
    for (let i = 0; i < words.length; i += 4) {
      chunks.push(words.slice(i, i + 4).join(' '));
    }
    const dur = Math.max(2, Number(totalDuration) || Math.max(chunks.length * 1.6, 8));
    const step = dur / Math.max(1, chunks.length);
    return chunks.slice(0, 250).map((chunk, idx) => ({
      start: Number((idx * step).toFixed(2)),
      end: Number(Math.min(dur, (idx + 1) * step - 0.04).toFixed(2)),
      text: chunk,
    }));
  }

  function renderCaptionCueRows() {
    const list = byId('v195CueList');
    if (!list) return;
    if (!captionCues.length) {
      list.innerHTML = '<small style="opacity:.75;">Noch keine Untertitel-Zeilen. Füge oben Text/SRT ein oder starte die Spracherkennung.</small>';
      return;
    }
    list.innerHTML = '';
    captionCues.forEach((cue, idx) => {
      const row = document.createElement('div');
      row.className = 'v195-cue-row';

      const stIn = document.createElement('input');
      stIn.type = 'number';
      stIn.step = '0.1';
      stIn.min = '0';
      stIn.value = cue.start;
      stIn.title = 'Start (Sek.)';
      stIn.addEventListener('change', () => { captionCues[idx].start = Math.max(0, parseFloat(stIn.value) || 0); });

      const enIn = document.createElement('input');
      enIn.type = 'number';
      enIn.step = '0.1';
      enIn.min = '0.2';
      enIn.value = cue.end;
      enIn.title = 'Ende (Sek.)';
      enIn.addEventListener('change', () => { captionCues[idx].end = Math.max(captionCues[idx].start + 0.15, parseFloat(enIn.value) || 0.5); });

      const txIn = document.createElement('input');
      txIn.type = 'text';
      txIn.maxLength = 220;
      txIn.value = cue.text;
      txIn.addEventListener('input', () => { captionCues[idx].text = txIn.value; });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'outline';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => {
        captionCues.splice(idx, 1);
        renderCaptionCueRows();
      });

      row.append(stIn, enIn, txIn, delBtn);
      list.appendChild(row);
    });
  }

  function initVideoStudioV195() {
    const controls = byId('v1725VideoControls');
    if (!controls || byId('v195ReframeCard')) return;

    const container = document.createElement('div');
    container.id = 'v195VideoToolsWrap';
    container.innerHTML = `
      <div class="v19-card" id="v195ReframeCard">
        <h3>📱 1-Klick-Formatwechsel: 16:9 → 9:16 Hochformat (V19.5)</h3>
        <p class="v19-sub">Wandelt Querformat-Videos mit einem Klick perfekt für TikTok, Reels &amp; WhatsApp-Status um – als neues MP4 in deiner Mediathek.</p>
        <div class="v19-grid">
          <label>Zuschnitt-Modus
            <select id="v195ReframeMode">
              <option value="blur" selected>Unscharfer Hintergrund (komplettes Bild bleibt sichtbar)</option>
              <option value="crop_center">Vollbild Fokus-Zuschnitt (Mitte)</option>
              <option value="crop_left">Vollbild Fokus-Zuschnitt (Links)</option>
              <option value="crop_right">Vollbild Fokus-Zuschnitt (Rechts)</option>
            </select>
          </label>
        </div>
        <div class="v19-row">
          <button type="button" id="v195ReframeBtn">📱 Gewähltes Video in 9:16 umwandeln</button>
        </div>
        <div class="v19-progress-wrap" id="v195ReframeProgWrap" hidden>
          <div class="v19-progress-bar"><div class="v19-progress-fill" id="v195ReframeBar"></div></div>
          <div class="v19-status-text" id="v195ReframeStatus"></div>
        </div>
      </div>

      <div class="v19-card" id="v195CaptionsCard">
        <h3>💬 TikTok-Stil Untertitel einbrennen (V19.5)</h3>
        <p class="v19-sub">Brennt fette, gut lesbare Untertitel direkt im sicheren 9:16-Bereich ein. Füge einfach deinen Text (oder SRT) ein – oder nutze bei hinterlegtem <code>OPENAI_API_KEY</code> die 1-Klick-Spracherkennung.</p>
        <div class="v19-grid">
          <label>Untertitel-Stil
            <select id="v195CapStyle">
              <option value="tiktok_yellow" selected>TikTok Gelb (fett + schwarze Kontur)</option>
              <option value="tiktok_white">TikTok Weiß (fett + schwarze Kontur)</option>
              <option value="clean_box">Clean Box (Weiß auf dunkler Box)</option>
            </select>
          </label>
          <label>Position (Safe-Zone)
            <select id="v195CapPos">
              <option value="safe_lower" selected>Unten im sicheren Bereich (über TikTok-Caption)</option>
              <option value="center">Mittig im Bild</option>
              <option value="upper">Oben im sicheren Bereich</option>
            </select>
          </label>
        </div>
        <label style="display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;">
          Gesprochenen Text oder SRT-Untertitel einfügen
          <textarea id="v195CapInput" rows="3" style="width:100%;margin-top:4px;" placeholder="Hier deinen gesprochenen Text oder SRT einfügen …"></textarea>
        </label>
        <div class="v19-row" style="margin-bottom:8px;">
          <button type="button" class="outline" id="v195AutoSplitBtn">⚡ Text automatisch in TikTok-Zeilen takten</button>
          <button type="button" class="outline" id="v195WhisperBtn">🎙 Aus Tonspur transkribieren (Whisper API)</button>
          <button type="button" class="outline" id="v195AddCueBtn">+ Zeile</button>
        </div>
        <div id="v195CueList" class="v195-cue-list"></div>
        <div class="v19-row">
          <button type="button" id="v195BurnCapBtn">🔥 Untertitel ins gewählte Video einbrennen</button>
        </div>
        <div class="v19-progress-wrap" id="v195CapProgWrap" hidden>
          <div class="v19-progress-bar"><div class="v19-progress-fill" id="v195CapBar"></div></div>
          <div class="v19-status-text" id="v195CapStatus"></div>
        </div>
      </div>
    `;
    controls.appendChild(container);
    renderCaptionCueRows();

    // 1-Click 16:9 -> 9:16 Reframe
    byId('v195ReframeBtn')?.addEventListener('click', async () => {
      const mediaId = byId('v9VideoSource')?.value;
      if (!mediaId) {
        v195Toast('Bitte oben zuerst ein MP4-Video im Video-Studio auswählen.', true);
        return;
      }
      const btn = byId('v195ReframeBtn');
      const wrap = byId('v195ReframeProgWrap');
      const bar = byId('v195ReframeBar');
      const st = byId('v195ReframeStatus');
      btn.disabled = true;
      wrap.hidden = false;
      bar.style.width = '10%';
      st.textContent = '9:16-Formatwechsel wird gestartet …';
      try {
        const start = await v195Api('/api/v19/video/reframe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ media_id: mediaId, mode: byId('v195ReframeMode')?.value || 'blur' }),
        });
        const done = await pollV195Job(start.job_id, (d) => {
          bar.style.width = (d.progress || 20) + '%';
          st.textContent = d.message || 'Konvertierung läuft …';
        });
        if (done.status === 'done') {
          bar.style.width = '100%';
          st.textContent = '✓ ' + done.message;
          refreshAllMedia();
        } else {
          st.textContent = '⚠ ' + (done.message || 'Konvertierung fehlgeschlagen.');
        }
      } catch (err) {
        st.textContent = '⚠ ' + (err.message || 'Fehler beim Formatwechsel.');
      } finally {
        btn.disabled = false;
      }
    });

    // Auto-split text/SRT into timed TikTok cues
    byId('v195AutoSplitBtn')?.addEventListener('click', () => {
      const raw = byId('v195CapInput')?.value || '';
      const vid = byId('v9PreviewVideo');
      const dur = (vid && isFinite(vid.duration) && vid.duration > 0) ? vid.duration : 15;
      const parsed = parseSrtOrScript(raw, dur);
      if (!parsed.length) {
        v195Toast('Bitte zuerst Text oder SRT oben in das Feld einfügen.', true);
        return;
      }
      captionCues = parsed;
      renderCaptionCueRows();
      v195Toast(parsed.length + ' TikTok-Untertitelzeilen erstellt.');
    });

    byId('v195AddCueBtn')?.addEventListener('click', () => {
      const lastEnd = captionCues.length ? captionCues[captionCues.length - 1].end : 0;
      captionCues.push({ start: Number(lastEnd.toFixed(1)), end: Number((lastEnd + 2.0).toFixed(1)), text: 'Neuer Untertitel' });
      renderCaptionCueRows();
    });

    // Optional Whisper API transcription
    byId('v195WhisperBtn')?.addEventListener('click', async () => {
      const mediaId = byId('v9VideoSource')?.value;
      if (!mediaId) {
        v195Toast('Bitte oben zuerst ein MP4-Video auswählen.', true);
        return;
      }
      const btn = byId('v195WhisperBtn');
      btn.disabled = true;
      const oldTxt = btn.textContent;
      btn.textContent = '⏳ Transkribiere …';
      try {
        const res = await v195Api('/api/v19/video/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ media_id: mediaId, language: 'de' }),
        });
        captionCues = res.cues || [];
        renderCaptionCueRows();
        v195Toast(captionCues.length + ' Untertitelzeilen automatisch erkannt!');
      } catch (err) {
        v195Toast(err.message || 'Transkription nicht verfügbar.', true);
      } finally {
        btn.disabled = false;
        btn.textContent = oldTxt;
      }
    });

    // Burn captions into MP4
    byId('v195BurnCapBtn')?.addEventListener('click', async () => {
      const mediaId = byId('v9VideoSource')?.value;
      if (!mediaId) {
        v195Toast('Bitte oben zuerst ein MP4-Video im Video-Studio auswählen.', true);
        return;
      }
      const validCues = captionCues.filter((c) => (c.text || '').trim().length > 0);
      if (!validCues.length) {
        v195Toast('Bitte zuerst Untertitel-Zeilen erzeugen oder hinzufügen.', true);
        return;
      }
      const btn = byId('v195BurnCapBtn');
      const wrap = byId('v195CapProgWrap');
      const bar = byId('v195CapBar');
      const st = byId('v195CapStatus');
      btn.disabled = true;
      wrap.hidden = false;
      bar.style.width = '10%';
      st.textContent = 'Untertitel werden eingebrannt …';
      try {
        const start = await v195Api('/api/v19/video/burn-captions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            media_id: mediaId,
            style: byId('v195CapStyle')?.value || 'tiktok_yellow',
            position: byId('v195CapPos')?.value || 'safe_lower',
            cues: validCues,
          }),
        });
        const done = await pollV195Job(start.job_id, (d) => {
          bar.style.width = (d.progress || 25) + '%';
          st.textContent = d.message || 'Untertitel-Rendering läuft …';
        });
        if (done.status === 'done') {
          bar.style.width = '100%';
          st.textContent = '✓ ' + done.message;
          refreshAllMedia();
        } else {
          st.textContent = '⚠ ' + (done.message || 'Untertitel-Export fehlgeschlagen.');
        }
      } catch (err) {
        st.textContent = '⚠ ' + (err.message || 'Fehler beim Einbrennen.');
      } finally {
        btn.disabled = false;
      }
    });
  }

  function bootV195() {
    initVideoStudioV195();
    setTimeout(initDbStatusCard, 900);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootV195);
  } else {
    bootV195();
  }
})();
