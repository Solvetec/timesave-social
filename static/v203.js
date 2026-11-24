/* TimeSave Social V20.3 – Bild- & Video-Studio Komfort-Upgrade (1-Klick-Looks, Licht & Farbe, Vignette) */
(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);

  const STUDIO_LOOKS = [
    { id: 'original', label: 'Original' },
    { id: 'clean',    label: '✦ Klar & Edel' },
    { id: 'vivid',    label: '🌈 Lebendig' },
    { id: 'warm',     label: '☀ Warm Gold' },
    { id: 'cinema',   label: '🎬 Kino' },
    { id: 'soft',     label: '☁ Soft' },
    { id: 'cool',     label: '❄ Kühl' },
    { id: 'mono',     label: '◐ S/W' },
  ];

  const VIDEO_LOOKS = [
    { id: 'normal', label: 'Original' },
    { id: 'warm',   label: '☀ Golden warm' },
    { id: 'cool',   label: '❄ Mystisch kühl' },
    { id: 'vivid',  label: '🌈 Kräftig' },
    { id: 'mono',   label: '◐ Schwarzweiß' },
  ];

  window.v203StudioFilterString = function () {
    const br = Number(byId('v203Bright')?.value ?? 100);
    const co = Number(byId('v203Contrast')?.value ?? 100);
    const sa = Number(byId('v203Sat')?.value ?? 100);
    const wa = Number(byId('v203Warm')?.value ?? 0);
    const parts = [];
    if (br !== 100) parts.push('brightness(' + (br / 100).toFixed(2) + ')');
    if (co !== 100) parts.push('contrast(' + (co / 100).toFixed(2) + ')');
    if (sa !== 100) parts.push('saturate(' + (sa / 100).toFixed(2) + ')');
    if (wa > 0) parts.push('sepia(' + (wa / 100 * 0.45).toFixed(2) + ')');
    else if (wa < 0) parts.push('hue-rotate(' + Math.round(wa * 0.3) + 'deg)');
    return parts.join(' ');
  };

  function updateSliderOutputs() {
    const map = [
      ['v203Bright', 'v203BrightOut', '%'],
      ['v203Contrast', 'v203ContrastOut', '%'],
      ['v203Sat', 'v203SatOut', '%'],
      ['v203Warm', 'v203WarmOut', ''],
      ['v203Vignette', 'v203VigOut', '%'],
    ];
    map.forEach(([inpId, outId, unit]) => {
      const inp = byId(inpId);
      const out = byId(outId);
      if (inp && out) out.textContent = inp.value + unit;
    });
  }

  function resetStudioLightColor() {
    const defaults = { v203Bright: 100, v203Contrast: 100, v203Sat: 100, v203Warm: 0, v203Vignette: 0 };
    Object.entries(defaults).forEach(([id, val]) => {
      const el = byId(id);
      if (el) el.value = String(val);
    });
    updateSliderOutputs();
    if (typeof paintStudio === 'function') paintStudio();
  }

  function enhanceImageStudio() {
    const lookSel = byId('studioLook');
    if (!lookSel || byId('v203ImageEnhancePanel')) return;

    // Ensure new look options exist in <select id="studioLook">
    STUDIO_LOOKS.forEach((lk) => {
      if (!Array.from(lookSel.options).some((o) => o.value === lk.id)) {
        const opt = document.createElement('option');
        opt.value = lk.id;
        opt.textContent = lk.label;
        lookSel.appendChild(opt);
      }
    });

    const panel = document.createElement('div');
    panel.id = 'v203ImageEnhancePanel';
    panel.className = 'v203-panel';
    panel.innerHTML =
      '<div class="v203-panel-head">' +
      '<span class="v203-panel-title">✨ 1-Klick-Looks &amp; Licht / Farbe</span>' +
      '<button type="button" class="outline v203-reset-btn" id="v203ResetLightBtn">↺ Zurücksetzen</button>' +
      '</div>' +
      '<div class="v203-chip-grid" id="v203ImageLookChips">' +
      STUDIO_LOOKS.map((lk) => '<button type="button" class="v203-look-chip" data-v203-look="' + lk.id + '">' + lk.label + '</button>').join('') +
      '</div>' +
      '<div class="v203-sliders">' +
      '<div class="v203-slider-row"><label>Helligkeit <output id="v203BrightOut">100%</output></label><input id="v203Bright" type="range" min="65" max="140" value="100"/></div>' +
      '<div class="v203-slider-row"><label>Kontrast <output id="v203ContrastOut">100%</output></label><input id="v203Contrast" type="range" min="70" max="145" value="100"/></div>' +
      '<div class="v203-slider-row"><label>Sättigung <output id="v203SatOut">100%</output></label><input id="v203Sat" type="range" min="0" max="165" value="100"/></div>' +
      '<div class="v203-slider-row"><label>Wärme <output id="v203WarmOut">0</output></label><input id="v203Warm" type="range" min="-40" max="60" value="0"/></div>' +
      '<div class="v203-slider-row"><label>Vignette <output id="v203VigOut">0%</output></label><input id="v203Vignette" type="range" min="0" max="80" value="0"/></div>' +
      '</div>';

    const extras = lookSel.closest('.studio-extras') || lookSel.parentNode;
    extras.insertAdjacentElement('beforebegin', panel);

    function syncLookChips() {
      const val = lookSel.value || 'original';
      panel.querySelectorAll('[data-v203-look]').forEach((b) => {
        b.classList.toggle('active', b.dataset.v203Look === val);
      });
    }

    panel.querySelectorAll('[data-v203-look]').forEach((b) => {
      b.addEventListener('click', () => {
        lookSel.value = b.dataset.v203Look;
        syncLookChips();
        if (typeof paintStudio === 'function') paintStudio();
      });
    });
    lookSel.addEventListener('change', syncLookChips);

    ['v203Bright', 'v203Contrast', 'v203Sat', 'v203Warm', 'v203Vignette'].forEach((id) => {
      byId(id)?.addEventListener('input', () => {
        updateSliderOutputs();
        if (typeof paintStudio === 'function') paintStudio();
      });
    });

    byId('v203ResetLightBtn')?.addEventListener('click', resetStudioLightColor);

    // Also reset light/color when user clicks existing resetStudioDecor
    if (typeof window.resetStudioDecor === 'function') {
      const origReset = window.resetStudioDecor;
      window.resetStudioDecor = function () {
        resetStudioLightColor();
        const res = origReset.apply(this, arguments);
        syncLookChips();
        return res;
      };
    }

    syncLookChips();
    updateSliderOutputs();
  }

  function enhanceVideoStudio() {
    const vfSel = byId('v9VideoFilter');
    if (!vfSel || byId('v203VideoLookPanel')) return;

    const panel = document.createElement('div');
    panel.id = 'v203VideoLookPanel';
    panel.className = 'v203-panel';
    panel.innerHTML =
      '<div class="v203-panel-head"><span class="v203-panel-title">🎨 Video-Farblook (1-Klick)</span></div>' +
      '<div class="v203-chip-grid">' +
      VIDEO_LOOKS.map((lk) => '<button type="button" class="v203-look-chip" data-v203-vlook="' + lk.id + '">' + lk.label + '</button>').join('') +
      '</div>';

    const parentRow = vfSel.closest('.fields') || vfSel.parentNode;
    parentRow.insertAdjacentElement('afterend', panel);

    function syncVideoChips() {
      const val = vfSel.value || 'normal';
      panel.querySelectorAll('[data-v203-vlook]').forEach((b) => {
        b.classList.toggle('active', b.dataset.v203Vlook === val);
      });
    }

    panel.querySelectorAll('[data-v203-vlook]').forEach((b) => {
      b.addEventListener('click', () => {
        vfSel.value = b.dataset.v203Vlook;
        syncVideoChips();
        if (typeof v9PreviewVideoUpdate === 'function') v9PreviewVideoUpdate();
      });
    });
    vfSel.addEventListener('change', syncVideoChips);
    syncVideoChips();
  }

  function init() {
    enhanceImageStudio();
    enhanceVideoStudio();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
