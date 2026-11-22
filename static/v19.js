/* TimeSave Social V19.0 Frontend Enhancements
 * - TikTok / Reels Safe-Zone UI Overlay & 3-Second Hook Check
 * - Video Studio Brand-Presets (save / apply / delete)
 * - Auto-Jump-Cut Silence Removal (FFmpeg silencedetect)
 * - WhatsApp Status Video-Optimierer + Auto-Splitter (30/60s) + QR & Web Share
 */
(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);

  async function v19Api(url, opts) {
    if (typeof window.api === 'function') {
      return window.api(url, opts);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || 'Anfrage fehlgeschlagen');
    return data;
  }

  function v19Notify(msg, isError) {
    if (typeof window.toast === 'function') {
      window.toast(msg);
      return;
    }
    const box = byId('v19ToastFallback');
    if (box) {
      box.textContent = msg;
      box.style.color = isError ? '#b91c1c' : '#065f46';
    }
  }

  async function pollV19Job(jobId, onProgress) {
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      const data = await v19Api('/api/studio/slideshow/' + encodeURIComponent(jobId));
      if (onProgress) onProgress(data);
      if (data.status === 'done' || data.status === 'error') {
        return data;
      }
    }
    throw new Error('Zeitüberschreitung beim Warten auf die Videoverarbeitung.');
  }

  function refreshMediaLists() {
    if (typeof window.loadAll === 'function') {
      try { window.loadAll(); } catch (_) {}
    }
    setTimeout(populateWhatsAppVideoSelect, 700);
  }

  // ------------------------------------------------------------------
  // 1. TikTok / Reels Safe-Zone Overlay + 3-Sekunden-Hook-Check
  // ------------------------------------------------------------------
  function initTikTokSafeZoneAndHook() {
    const frame = byId('v9PreviewFrame');
    if (!frame || byId('v19TikTokSafeOverlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'v19TikTokSafeOverlay';
    overlay.className = 'v19-tiktok-safe';
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="v19-tt-top">TikTok / Reels Kopfzeile</div>' +
      '<div class="v19-tt-safebox"></div>' +
      '<div class="v19-tt-right" aria-hidden="true"><span>●</span><span>♥</span><span>💬</span><span>🔖</span><span>↗</span></div>' +
      '<div class="v19-tt-bottom">Caption, Benutzername &amp; Sound-Leiste</div>';
    frame.appendChild(overlay);

    const safeToggleContainer = document.querySelector('.v1712-safe-toggle');
    if (safeToggleContainer && !byId('v19TikTokSafeToggle')) {
      const row = document.createElement('div');
      row.className = 'v19-safe-row';
      row.innerHTML =
        '<label><input type="checkbox" id="v19TikTokSafeToggle"/> TikTok / Reels UI-Safe-Zone anzeigen (Buttons &amp; Caption)</label>';
      safeToggleContainer.appendChild(row);

      const cb = byId('v19TikTokSafeToggle');
      cb.addEventListener('change', () => {
        overlay.hidden = !cb.checked;
      });

      const hookStrip = document.createElement('div');
      hookStrip.id = 'v19HookCheck';
      hookStrip.className = 'v19-hook-strip';
      safeToggleContainer.insertAdjacentElement('afterend', hookStrip);
    }

    function updateHookCheck() {
      const strip = byId('v19HookCheck');
      if (!strip) return;
      const fmt = byId('v9VideoFormat')?.value || 'story';
      const title = (byId('v9VideoTitle')?.value || '').trim();
      const subtitle = (byId('v9VideoSubtitle')?.value || '').trim();
      const durVal = parseFloat(byId('v9VideoDuration')?.value || '0') || 0;
      const vidEl = byId('v9PreviewVideo');
      const actualDur = durVal || (vidEl && isFinite(vidEl.duration) ? vidEl.duration : 0);

      const isPortrait = fmt === 'story';
      const hasHook = title.length >= 2 || subtitle.length >= 2;
      const goodLen = actualDur > 0 && actualDur <= 60;

      strip.innerHTML =
        '<span class="v19-hook-title">⚡ 3-Sek.-Hook-Check:</span>' +
        `<span class="v19-badge ${isPortrait ? 'ok' : 'warn'}">${isPortrait ? '✓' : '!'} Format: ${isPortrait ? '9:16 optimal' : fmt + ' (für TikTok/Status 9:16 empfohlen)'}</span>` +
        `<span class="v19-badge ${hasHook ? 'ok' : 'warn'}">${hasHook ? '✓' : '!'} ${hasHook ? 'Hook-Text gesetzt' : 'Kein Hook-Text für den Einstieg'}</span>` +
        `<span class="v19-badge ${goodLen || !actualDur ? 'ok' : 'warn'}">${!actualDur ? 'ℹ Länge noch offen' : (goodLen ? '✓ ' + Math.round(actualDur) + ' Sek. (Sweetspot)' : '! ' + Math.round(actualDur) + ' Sek. (ggf. straffen oder für Status teilen)')}</span>`;
    }

    ['v9VideoFormat', 'v9VideoTitle', 'v9VideoSubtitle', 'v9VideoDuration', 'v9VideoSource'].forEach((id) => {
      const el = byId(id);
      if (el) {
        el.addEventListener('input', updateHookCheck);
        el.addEventListener('change', updateHookCheck);
      }
    });
    const vidEl = byId('v9PreviewVideo');
    if (vidEl) vidEl.addEventListener('loadedmetadata', updateHookCheck);
    updateHookCheck();
  }

  // ------------------------------------------------------------------
  // 2. Studio Brand-Presets + Auto-Jump-Cut Stille-Entfernung
  // ------------------------------------------------------------------
  function initStudioV19Tools() {
    const controls = byId('v1725VideoControls');
    if (!controls || byId('v19StudioToolsWrap')) return;

    const wrap = document.createElement('div');
    wrap.id = 'v19StudioToolsWrap';
    wrap.innerHTML = `
      <div class="v19-card" id="v19PresetsCard">
        <h3>🎨 Brand-Vorlagen (V19)</h3>
        <p class="v19-sub">Speichere deine aktuellen Studio-Einstellungen (Format, Filter, Textfarbe, Position, Badge) und lade sie mit einem Klick.</p>
        <div class="v19-row">
          <input type="text" id="v19PresetName" maxlength="60" placeholder="z. B. TikTok Hook Gold" style="flex:1;min-width:160px;"/>
          <button type="button" id="v19SavePresetBtn">Vorlage speichern</button>
        </div>
        <div id="v19PresetList" class="v19-preset-list"></div>
      </div>

      <div class="v19-card" id="v19SilenceCard">
        <h3>✂️ Auto-Jump-Cuts: Stille entfernen (V19)</h3>
        <p class="v19-sub">Erkennt Sprechpausen automatisch über die Tonspur und erstellt ein flotteres MP4 in deiner Mediathek – ideal für höhere Watchtime auf TikTok.</p>
        <div class="v19-grid">
          <label>Schwellenwert (dB)
            <select id="v19NoiseDb">
              <option value="-35">−35 dB (sehr sensibel / ruhiger Raum)</option>
              <option value="-32" selected>−32 dB (Standard)</option>
              <option value="-28">−28 dB (etwas Hintergrundgeräusch)</option>
              <option value="-24">−24 dB (aggressiv)</option>
            </select>
          </label>
          <label>Mindestpause (Sek.)
            <select id="v19MinSilence">
              <option value="0.4">0,4 Sek. (sehr schnell)</option>
              <option value="0.6" selected>0,6 Sek. (Standard)</option>
              <option value="0.9">0,9 Sek. (entspannt)</option>
              <option value="1.2">1,2 Sek. (nur lange Pausen)</option>
            </select>
          </label>
        </div>
        <div class="v19-row">
          <button type="button" id="v19SilenceBtn">✂️ Sprechpausen aus gewähltem Video entfernen</button>
        </div>
        <div class="v19-progress-wrap" id="v19SilenceProgressWrap" hidden>
          <div class="v19-progress-bar"><div class="v19-progress-fill" id="v19SilenceBar"></div></div>
          <div class="v19-status-text" id="v19SilenceStatus"></div>
        </div>
      </div>
    `;
    controls.appendChild(wrap);

    // Presets logic
    async function loadPresets() {
      const list = byId('v19PresetList');
      if (!list) return;
      try {
        const res = await v19Api('/api/v19/studio/presets');
        const items = res.presets || [];
        if (!items.length) {
          list.innerHTML = '<small style="opacity:.75;">Noch keine Vorlagen gespeichert.</small>';
          return;
        }
        list.innerHTML = '';
        items.forEach((p) => {
          const chip = document.createElement('span');
          chip.className = 'v19-preset-chip';
          const label = document.createElement('strong');
          label.textContent = p.name;
          const applyBtn = document.createElement('button');
          applyBtn.type = 'button';
          applyBtn.className = 'outline';
          applyBtn.textContent = 'Anwenden';
          applyBtn.addEventListener('click', () => applyPreset(p));
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'outline';
          delBtn.textContent = '✕';
          delBtn.title = 'Vorlage löschen';
          delBtn.addEventListener('click', async () => {
            await v19Api('/api/v19/studio/presets/' + encodeURIComponent(p.id), { method: 'DELETE' });
            loadPresets();
          });
          chip.append(label, applyBtn, delBtn);
          list.appendChild(chip);
        });
      } catch (_) {
        list.innerHTML = '';
      }
    }

    function applyPreset(p) {
      const setVal = (id, val) => {
        const el = byId(id);
        if (!el || val === undefined || val === null) return;
        if (el.type === 'checkbox') el.checked = !!val;
        else el.value = String(val);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setVal('v9VideoFormat', p.format);
      setVal('v9VideoFilter', p.filter);
      setVal('v9VideoColor', p.title_color);
      setVal('v9VideoPosition', p.position);
      setVal('v9VideoBadge', p.badge);
      setVal('v9VideoMotion', p.motion);
      setVal('v9VideoFade', p.fade);
      v19Notify('Vorlage „' + p.name + '“ angewendet.');
    }

    byId('v19SavePresetBtn')?.addEventListener('click', async () => {
      const nameEl = byId('v19PresetName');
      const name = (nameEl?.value || '').trim();
      if (!name) {
        v19Notify('Bitte zuerst einen Namen für die Vorlage eingeben.', true);
        return;
      }
      const payload = {
        name,
        format: byId('v9VideoFormat')?.value || 'story',
        filter: byId('v9VideoFilter')?.value || 'normal',
        background_mode: 'cover',
        background_color: '#221828',
        title_color: byId('v9VideoColor')?.value || '#ffffff',
        position: byId('v9VideoPosition')?.value || 'center',
        badge: byId('v9VideoBadge')?.value || '',
        motion: byId('v9VideoMotion')?.value || 'static',
        fade: !!byId('v9VideoFade')?.checked,
      };
      try {
        await v19Api('/api/v19/studio/presets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (nameEl) nameEl.value = '';
        await loadPresets();
        v19Notify('Studio-Vorlage gespeichert.');
      } catch (err) {
        v19Notify(err.message || 'Vorlage konnte nicht gespeichert werden.', true);
      }
    });

    // Silence removal logic
    byId('v19SilenceBtn')?.addEventListener('click', async () => {
      const mediaId = byId('v9VideoSource')?.value;
      if (!mediaId) {
        v19Notify('Bitte oben zuerst ein MP4-Video im Video-Studio auswählen.', true);
        return;
      }
      const btn = byId('v19SilenceBtn');
      const pWrap = byId('v19SilenceProgressWrap');
      const bar = byId('v19SilenceBar');
      const st = byId('v19SilenceStatus');
      btn.disabled = true;
      pWrap.hidden = false;
      bar.style.width = '5%';
      st.textContent = 'Stille-Erkennung wird gestartet …';
      try {
        const start = await v19Api('/api/v19/video/remove-silence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            media_id: mediaId,
            noise_db: parseInt(byId('v19NoiseDb')?.value || '-32', 10),
            min_silence: parseFloat(byId('v19MinSilence')?.value || '0.6'),
            padding: 0.12,
          }),
        });
        const done = await pollV19Job(start.job_id, (d) => {
          bar.style.width = (d.progress || 10) + '%';
          st.textContent = d.message || 'Verarbeitung läuft …';
        });
        if (done.status === 'done') {
          bar.style.width = '100%';
          st.textContent = '✓ ' + done.message;
          refreshMediaLists();
        } else {
          st.textContent = '⚠ ' + (done.message || 'Stille-Entfernung fehlgeschlagen.');
        }
      } catch (err) {
        st.textContent = '⚠ ' + (err.message || 'Fehler bei der Stille-Entfernung.');
      } finally {
        btn.disabled = false;
      }
    });

    loadPresets();
  }

  // ------------------------------------------------------------------
  // 3. WhatsApp Status Video-Optimierer & Auto-Splitter (ohne Business API)
  // ------------------------------------------------------------------
  async function populateWhatsAppVideoSelect() {
    const sel = byId('v19WaMediaSelect');
    if (!sel) return;
    try {
      const res = await v19Api('/api/media');
      const items = (res.items || res || []).filter((m) => m.mime === 'video/mp4');
      const prev = sel.value;
      sel.innerHTML = '';
      if (!items.length) {
        sel.innerHTML = '<option value="">Noch keine MP4-Videos in der Mediathek</option>';
        return;
      }
      items.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.original_name || m.filename || m.id;
        sel.appendChild(opt);
      });
      if (prev && items.some((m) => m.id === prev)) sel.value = prev;
    } catch (_) {}
  }

  function initWhatsAppV19Optimizer() {
    const waSection = byId('whatsapp');
    if (!waSection || byId('v19WaOptimizerCard')) return;

    const card = document.createElement('div');
    card.id = 'v19WaOptimizerCard';
    card.className = 'card v19-card';
    card.innerHTML = `
      <span class="section-kicker">WHATSAPP STATUS · ANTI-KOMPRIMIERUNG &amp; AUTO-SPLITTER (V19)</span>
      <h3>💚 Videos knackscharf für WhatsApp vorbereiten</h3>
      <p class="v19-sub">WhatsApp rechnet große Videos stark herunter. Dieses Preset exportiert 720p H.264/AAC unter 15 MB pro Clip und teilt lange Videos auf Wunsch automatisch in 30- oder 60-Sekunden-Status-Teile.</p>
      <div class="v19-grid">
        <label>MP4-Video aus deiner Mediathek
          <select id="v19WaMediaSelect"><option value="">Wird geladen …</option></select>
        </label>
        <label>Status-Auto-Splitter
          <select id="v19WaSplit">
            <option value="0">Nicht teilen (einzelnes Video)</option>
            <option value="30" selected>Automatisch in 30-Sek.-Clips teilen (Status)</option>
            <option value="60">Automatisch in 60-Sek.-Clips teilen (Status)</option>
          </select>
        </label>
        <label>Qualitätsprofil
          <select id="v19WaQuality">
            <option value="balanced" selected>Ausgewogen (720p, scharf, ≤ 14,5 MB)</option>
            <option value="compact">Kompakt (schneller mobiler Upload)</option>
          </select>
        </label>
      </div>
      <div class="v19-row">
        <button type="button" id="v19WaRunBtn">⚡ Für WhatsApp optimieren</button>
        <button type="button" class="outline" id="v19WaRefreshBtn">↻ Videoliste aktualisieren</button>
      </div>
      <div class="v19-progress-wrap" id="v19WaProgressWrap" hidden>
        <div class="v19-progress-bar"><div class="v19-progress-fill" id="v19WaBar"></div></div>
        <div class="v19-status-text" id="v19WaStatus"></div>
      </div>
      <div id="v19WaClips" class="v19-wa-clips"></div>
      <div class="v19-caption-box">
        <label style="font-size:13px;font-weight:600;">Begleittext für Status / Kanal (1-Klick-Kopie)
          <textarea id="v19WaCaption" placeholder="Optionalen Begleittext hier eingeben oder einfügen …"></textarea>
        </label>
        <button type="button" class="outline" id="v19WaCopyCaptionBtn">📋 Begleittext kopieren</button>
        <span id="v19ToastFallback" style="margin-left:10px;font-size:12.5px;font-weight:600;"></span>
      </div>
    `;
    waSection.appendChild(card);

    byId('v19WaRefreshBtn')?.addEventListener('click', populateWhatsAppVideoSelect);

    byId('v19WaCopyCaptionBtn')?.addEventListener('click', async () => {
      const txt = (byId('v19WaCaption')?.value || '').trim();
      if (!txt) {
        v19Notify('Kein Text zum Kopieren eingegeben.', true);
        return;
      }
      try {
        await navigator.clipboard.writeText(txt);
        v19Notify('Begleittext in die Zwischenablage kopiert!');
      } catch (_) {
        v19Notify('Kopieren vom Browser blockiert – bitte manuell markieren.', true);
      }
    });

    byId('v19WaRunBtn')?.addEventListener('click', async () => {
      const mediaId = byId('v19WaMediaSelect')?.value;
      if (!mediaId) {
        v19Notify('Bitte zuerst ein MP4-Video auswählen.', true);
        return;
      }
      const btn = byId('v19WaRunBtn');
      const pWrap = byId('v19WaProgressWrap');
      const bar = byId('v19WaBar');
      const st = byId('v19WaStatus');
      const clipsBox = byId('v19WaClips');
      btn.disabled = true;
      pWrap.hidden = false;
      bar.style.width = '6%';
      st.textContent = 'WhatsApp-Optimierung wird gestartet …';
      clipsBox.innerHTML = '';

      try {
        const start = await v19Api('/api/v19/whatsapp/prepare-video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            media_id: mediaId,
            split_seconds: parseInt(byId('v19WaSplit')?.value || '30', 10),
            quality: byId('v19WaQuality')?.value || 'balanced',
          }),
        });
        const done = await pollV19Job(start.job_id, (d) => {
          bar.style.width = (d.progress || 10) + '%';
          st.textContent = d.message || 'Optimierung läuft …';
        });
        if (done.status === 'done') {
          bar.style.width = '100%';
          st.textContent = '✓ ' + done.message;
          renderWaClips(done.clips || []);
          refreshMediaLists();
        } else {
          st.textContent = '⚠ ' + (done.message || 'Optimierung fehlgeschlagen.');
        }
      } catch (err) {
        st.textContent = '⚠ ' + (err.message || 'Fehler bei der WhatsApp-Optimierung.');
      } finally {
        btn.disabled = false;
      }
    });

    populateWhatsAppVideoSelect();
  }

  function renderWaClips(clips) {
    const box = byId('v19WaClips');
    if (!box) return;
    box.innerHTML = '';
    clips.forEach((c) => {
      const el = document.createElement('div');
      el.className = 'v19-wa-clip';
      const downloadUrl = '/api/media/' + encodeURIComponent(c.id) + '/download';
      const qrUrl = '/api/whatsapp/mobile-qr/' + encodeURIComponent(c.id);
      el.innerHTML = `
        <strong>${c.total > 1 ? `Teil ${c.part}/${c.total}: ` : ''}${c.name}</strong>
        <small>${c.duration} Sek. · ${c.size_mb} MB · WhatsApp-H.264/720p</small>
        <div class="v19-row">
          <a class="button outline" href="${downloadUrl}" download>⬇ Herunterladen</a>
          <button type="button" class="outline v19-qr-btn">📱 QR fürs Handy</button>
          <button type="button" class="outline v19-share-btn">↗ Direkt teilen</button>
        </div>
        <div class="v19-qr-box" hidden></div>
      `;
      const qrBtn = el.querySelector('.v19-qr-btn');
      const qrBox = el.querySelector('.v19-qr-box');
      qrBtn.addEventListener('click', () => {
        if (!qrBox.hidden) {
          qrBox.hidden = true;
          return;
        }
        qrBox.hidden = false;
        qrBox.innerHTML = `<img src="${qrUrl}" alt="QR-Code für Handy-Download"/><br/><small>Mit dem Smartphone scannen (20 Min. gültig)</small>`;
      });

      const shareBtn = el.querySelector('.v19-share-btn');
      shareBtn.addEventListener('click', async () => {
        if (!navigator.share) {
          v19Notify('Direkt-Teilen ist vor allem am Smartphone-Browser verfügbar – nutze am PC den QR-Code oder Download.');
          return;
        }
        try {
          const resp = await fetch(downloadUrl);
          const blob = await resp.blob();
          const file = new File([blob], c.name, { type: 'video/mp4' });
          const text = (byId('v19WaCaption')?.value || '').trim();
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: c.name, text });
          } else {
            await navigator.share({ title: c.name, text });
          }
        } catch (e) {
          if (e && e.name !== 'AbortError') {
            v19Notify('Teilen abgebrochen oder nicht unterstützt – bitte Datei herunterladen.');
          }
        }
      });

      box.appendChild(el);
    });
  }


  // ------------------------------------------------------------------
  // 4. V19.1: TikTok Audit-konforme UI & HTTPS-Erreichbarkeitstest
  // ------------------------------------------------------------------
  function v19SyncTikTokUi() {
    const targets = (window.v17State && Array.isArray(window.v17State.targets)) ? window.v17State.targets : [];
    const ttTargets = targets.filter((t) => t.provider === 'tiktok');
    const hasVideo = ttTargets.some((t) => t.format === 'video');
    const duetWrap = byId('v19TikTokDuetWrap');
    const stitchWrap = byId('v19TikTokStitchWrap');
    if (duetWrap) duetWrap.hidden = !hasVideo;
    if (stitchWrap) stitchWrap.hidden = !hasVideo;

    const commercialOn = !!byId('v19TikTokCommercialToggle')?.checked;
    const commercialDetails = byId('v19TikTokCommercialDetails');
    if (commercialDetails) commercialDetails.hidden = !commercialOn;

    const brandOrg = commercialOn && !!byId('v19TikTokBrandOrganic')?.checked;
    const brandCont = commercialOn && !!byId('v19TikTokBrandContent')?.checked;

    // Disable SELF_ONLY option when Branded Content is active (TikTok Audit rule)
    const privSel = byId('v17TikTokPrivacy');
    if (privSel) {
      const selfOpt = Array.from(privSel.options).find((o) => o.value === 'SELF_ONLY');
      if (selfOpt) {
        selfOpt.disabled = brandCont;
        if (brandCont && privSel.value === 'SELF_ONLY') {
          privSel.value = '';
        }
      }
    }

    // Dynamic TikTok policy notice (Music Usage Confirmation vs. Branded Content Policy)
    const policyEl = byId('v19TikTokPolicyNotice');
    if (policyEl) {
      if (brandCont) {
        policyEl.innerHTML =
          'Mit dem Veröffentlichen stimmst du der <b>TikTok Branded Content Policy</b> und der <b>TikTok Music Usage Confirmation</b> zu. ' +
          'Hinweis: Nach dem Hochladen kann es einige Minuten dauern, bis der Beitrag auf deinem TikTok-Profil erscheint.';
      } else if (brandOrg) {
        policyEl.innerHTML =
          'Mit dem Veröffentlichen stimmst du der <b>TikTok Music Usage Confirmation</b> zu (Beitrag wird als Werbung für deine eigene Marke gekennzeichnet). ' +
          'Hinweis: Nach dem Hochladen kann es einige Minuten dauern, bis der Beitrag auf deinem TikTok-Profil erscheint.';
      } else {
        policyEl.innerHTML =
          'Mit dem Veröffentlichen stimmst du der <b>TikTok Music Usage Confirmation</b> zu. ' +
          'Nach dem Hochladen kann es einige Minuten dauern, bis der Beitrag auf deinem TikTok-Profil sichtbar ist.';
      }
    }
  }

  function v19ApplyCreatorLimits(data) {
    if (!data) return;
    const cmt = byId('v19TikTokAllowComment');
    const duet = byId('v19TikTokAllowDuet');
    const stitch = byId('v19TikTokAllowStitch');
    // Audit rule: never pre-check interaction boxes; disable if creator disabled them on TikTok
    if (cmt) {
      cmt.checked = false;
      cmt.disabled = !!data.comment_disabled;
      cmt.title = data.comment_disabled ? 'Im TikTok-Profil deaktiviert' : '';
    }
    if (duet) {
      duet.checked = false;
      duet.disabled = !!data.duet_disabled;
      duet.title = data.duet_disabled ? 'Im TikTok-Profil deaktiviert' : '';
    }
    if (stitch) {
      stitch.checked = false;
      stitch.disabled = !!data.stitch_disabled;
      stitch.title = data.stitch_disabled ? 'Im TikTok-Profil deaktiviert' : '';
    }
    v19SyncTikTokUi();
  }

  function initTikTokV191Controls() {
    ['v19TikTokCommercialToggle', 'v19TikTokBrandOrganic', 'v19TikTokBrandContent', 'v19TikTokPostMode', 'v17TikTokPrivacy'].forEach((id) => {
      const el = byId(id);
      if (el) el.addEventListener('change', v19SyncTikTokUi);
    });

    const reachBtn = byId('v19TikTokTestReachBtn');
    const reachBox = byId('v19TikTokTestReachResult');
    if (reachBtn && reachBox && !reachBtn.dataset.v19Bound) {
      reachBtn.dataset.v19Bound = '1';
      reachBtn.addEventListener('click', async () => {
        reachBtn.disabled = true;
        reachBox.hidden = false;
        reachBox.innerHTML = '<span>⏳ Prüfe HTTPS-URL, Verifizierungsdatei und öffentlichen Bildabruf …</span>';
        try {
          const res = await v19Api('/api/v19/tiktok/test-reachability', { method: 'POST' });
          const rows = (res.checks || []).map((c) => {
            const cls = c.ok ? 'ok' : 'fail';
            const icon = c.ok ? '✓' : '✗';
            const div = document.createElement('div');
            div.className = 'v19-reach-row ' + cls;
            const strong = document.createElement('strong');
            strong.textContent = icon + ' ' + c.label + ':';
            const span = document.createElement('span');
            span.textContent = ' ' + c.detail;
            div.append(strong, span);
            return div;
          });
          reachBox.innerHTML = '';
          rows.forEach((r) => reachBox.appendChild(r));
          v19Notify(res.ok ? 'TikTok HTTPS-Erreichbarkeit erfolgreich geprüft!' : 'Einige TikTok-HTTPS-Prüfungen sind noch offen.', !res.ok);
        } catch (err) {
          reachBox.innerHTML = '<div class="v19-reach-row fail"><strong>✗ Fehler:</strong> ' + (err.message || 'Prüfung fehlgeschlagen') + '</div>';
          v19Notify(err.message || 'Prüfung fehlgeschlagen', true);
        } finally {
          reachBtn.disabled = false;
        }
      });
    }
    v19SyncTikTokUi();
  }

  window.v19SyncTikTokUi = v19SyncTikTokUi;
  window.v19ApplyCreatorLimits = v19ApplyCreatorLimits;

  function bootV19() {
    initTikTokSafeZoneAndHook();
    initStudioV19Tools();
    initWhatsAppV19Optimizer();
    initTikTokV191Controls();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootV19);
  } else {
    bootV19();
  }
})();
