/* TimeSave Social V19.3 – Fix für globale jobs-Bindung, kompakte Planungskarten & 1-Zeilen-Wochenstreifen */
(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const escHtml = (v) =>
    typeof esc === 'function'
      ? esc(v)
      : String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function getJobs() {
    try {
      if (typeof jobs !== 'undefined' && Array.isArray(jobs)) return jobs;
    } catch (_) {}
    return Array.isArray(window.jobs) ? window.jobs : [];
  }
  function getStateLabels() {
    try {
      if (typeof stateLabels !== 'undefined' && stateLabels) return stateLabels;
    } catch (_) {}
    return window.stateLabels || {};
  }
  function getIcons() {
    try {
      if (typeof icon !== 'undefined' && icon) return icon;
    } catch (_) {}
    return window.icon || {};
  }
  function getProviders() {
    try {
      if (typeof providers !== 'undefined' && providers) return providers;
    } catch (_) {}
    return window.providers || {};
  }
  function getFmtNames() {
    try {
      if (typeof fmtNames !== 'undefined' && fmtNames) return fmtNames;
    } catch (_) {}
    return window.fmtNames || {};
  }
  function getWeekOffset() {
    try {
      if (typeof v17State !== 'undefined' && v17State) return Number(v17State.weekOffset) || 0;
    } catch (_) {}
    return (window.v17State && Number(window.v17State.weekOffset)) || 0;
  }

  let selectedDayKey = '';
  let onlyBusyDays = false;

  function formatCompactDate(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return iso || '';
    const datePart = d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
    const timePart = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    return datePart + ' · ' + timePart;
  }

  function updatePlannedBadges() {
    const allJobs = getJobs();
    const openCount = allJobs.filter((j) => ['scheduled', 'processing', 'awaiting_confirmation'].includes(j.status)).length;
    document.querySelectorAll('[data-v192-planned-count]').forEach((el) => {
      el.textContent = String(openCount);
      el.hidden = openCount === 0;
    });
  }

  function renderJobCardsV192() {
    if (typeof window.v1725RenderQueuePills === 'function') {
      try { window.v1725RenderQueuePills(); } catch (_) {}
    }
    updatePlannedBadges();

    const cardsRoot = byId('v192JobCards');
    if (!cardsRoot) return;

    const allJobs = getJobs();
    const platform = byId('jobFilterPlatform')?.value || '';
    const state = byId('jobFilterState')?.value || '';
    const query = (byId('jobSearch')?.value || '').toLowerCase().trim();
    const sortBy = byId('v1725JobSort')?.value || 'due_desc';

    const filtered = allJobs.filter((j) => {
      if (platform && j.platform !== platform) return false;
      if (state) {
        if (state === 'published') {
          if (!['published', 'published_manual'].includes(j.status)) return false;
        } else if (j.status !== state) {
          return false;
        }
      }
      if (selectedDayKey) {
        const dayStr = new Date(j.due_at).toLocaleDateString('sv-SE');
        if (dayStr !== selectedDayKey) return false;
      }
      if (query) {
        const hay = [
          j.original_name,
          j.caption,
          j.result,
          j.platform,
          new Date(j.due_at).toLocaleDateString('de-DE'),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    if (sortBy === 'due_asc') {
      const rank = (s) => (s === 'scheduled' ? 0 : s === 'awaiting_confirmation' ? 1 : s === 'needs_review' ? 2 : 3);
      filtered.sort((a, b) => rank(a.status) - rank(b.status) || (a.due_at || '').localeCompare(b.due_at || ''));
    } else if (sortBy === 'due_old') {
      filtered.sort((a, b) => (a.due_at || '').localeCompare(b.due_at || ''));
    } else if (sortBy === 'platform') {
      filtered.sort((a, b) => (a.platform || '').localeCompare(b.platform || '') || (b.due_at || '').localeCompare(a.due_at || ''));
    } else if (sortBy === 'status') {
      filtered.sort((a, b) => (a.status || '').localeCompare(b.status || '') || (b.due_at || '').localeCompare(a.due_at || ''));
    } else {
      filtered.sort((a, b) => (b.due_at || '').localeCompare(a.due_at || ''));
    }

    const dayBanner = selectedDayKey
      ? `<div class="v19-row" style="margin-bottom:4px;justify-content:space-between;padding:5px 9px;border-radius:9px;background:#f3ecff;font-size:12px;">` +
        `<span>📅 Tag: <b>${escHtml(new Date(selectedDayKey + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }))}</b></span>` +
        `<button type="button" class="outline tiny" id="v192ClearDayFilter" style="min-height:26px!important;padding:2px 8px!important;">Alle Tage ✕</button></div>`
      : '';

    if (!filtered.length) {
      cardsRoot.innerHTML =
        dayBanner +
        '<div class="v192-empty">Keine passenden Veröffentlichungen gefunden.</div>';
      byId('v192ClearDayFilter')?.addEventListener('click', clearDayFilter);
      return;
    }

    const stateMap = getStateLabels();
    const iconMap = getIcons();
    const provMap = getProviders();
    const fmtMap = getFmtNames();

    cardsRoot.innerHTML =
      dayBanner +
      filtered
        .map((j) => {
          const st = stateMap[j.status] || [j.status, 'gray'];
          let buttons = '';
          if (j.status === 'scheduled') {
            buttons =
              `<button class="outline tiny" type="button" onclick="editJob('${escHtml(j.id)}')">✏️ Bearbeiten</button>` +
              `<button class="outline tiny" type="button" onclick="jobAction('${escHtml(j.id)}','cancel')">Stornieren</button>`;
          } else if (j.status === 'manual') {
            buttons =
              `<button class="outline tiny" type="button" onclick="downloadMedia('${escHtml(j.media_id)}')">Bild ↓</button>` +
              `<button class="outline tiny" type="button" onclick="jobAction('${escHtml(j.id)}','mark-published')">Erledigt ✓</button>`;
          } else if (j.status === 'needs_review') {
            buttons = `<button class="danger tiny" type="button" onclick="jobAction('${escHtml(j.id)}','retry')">Erneut senden</button>`;
          }

          const pp = j.publication_progress;
          const progressHtml =
            j.status === 'processing'
              ? `<div style="margin-top:2px;"><progress max="100" ${
                  j.platform === 'telegram_story' && pp?.progress
                    ? 'value="' + Math.min(99, Number(pp.progress) || 0) + '"'
                    : ''
                } style="width:100%;height:7px;accent-color:#7c3aed;"></progress><small>${escHtml(
                  pp?.message || 'Wird verarbeitet …'
                )}</small></div>`
              : '';

          const waitingHtml = j.waiting_for
            ? `<span class="pill amber">⏳ Karte ${escHtml(j.waiting_for)}</span>`
            : '';

          const seriesHtml = j.series_id
            ? `<span class="v192-job-fmt">🔮 ${escHtml(j.position)}/4</span>`
            : '';

          const detailParts = [];
          if (j.result) detailParts.push(`<span class="v192-job-result">${escHtml(j.result)}</span>`);
          if (j.caption) detailParts.push(escHtml(j.caption));
          const extraHtml = detailParts.length
            ? `<div class="v192-job-extra" data-v192-expand title="Tippen zum Aufklappen">${detailParts.join(' · ')}</div>`
            : '';

          const platName = provMap[j.platform]?.name || j.platform;
          const fmtLabel = fmtMap[j.format] || j.format;

          return (
            `<article class="v192-job-card st-${escHtml(j.status)}">` +
            `<div class="v192-job-main">` +
            `<div class="v192-job-top">` +
            `<span class="v192-job-time">${escHtml(formatCompactDate(j.due_at))}</span>` +
            `<span class="v192-job-plat">${iconMap[j.platform] || ''} ${escHtml(platName)}</span>` +
            `<span class="v192-job-fmt">${escHtml(fmtLabel)}</span>` +
            seriesHtml +
            `<span class="pill ${escHtml(st[1])}">${escHtml(st[0])}</span>` +
            waitingHtml +
            `</div>` +
            `<div class="v192-job-title" data-v192-expand title="${escHtml(j.original_name)}">${escHtml(j.original_name)}</div>` +
            progressHtml +
            extraHtml +
            `</div>` +
            (buttons ? `<div class="v192-job-actions">${buttons}</div>` : '') +
            `</article>`
          );
        })
        .join('');

    cardsRoot.querySelectorAll('[data-v192-expand]').forEach((el) => {
      el.addEventListener('click', () => {
        el.closest('.v192-job-card')?.classList.toggle('is-expanded');
      });
    });
    byId('v192ClearDayFilter')?.addEventListener('click', clearDayFilter);
  }

  function clearDayFilter() {
    selectedDayKey = '';
    enhanceWeekCalendar();
    renderJobCardsV192();
  }

  function enhanceWeekCalendar() {
    const weekRoot = byId('v17Week');
    if (!weekRoot) return;
    weekRoot.classList.toggle('v192-only-busy', onlyBusyDays);

    const nowDate = new Date();
    const dayIdx = (nowDate.getDay() + 6) % 7;
    const weekOffset = getWeekOffset();
    const monday = new Date(nowDate);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - dayIdx + weekOffset * 7);

    const dayEls = Array.from(weekRoot.querySelectorAll('.v17-week-day'));
    dayEls.forEach((el, idx) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + idx);
      const key = d.toLocaleDateString('sv-SE');
      const hasChips = !!el.querySelector('.v17-week-chip');
      el.classList.toggle('v192-day-empty', !hasChips);
      el.classList.toggle('v192-day-selected', selectedDayKey === key);
      el.dataset.v192Day = key;
      if (!el.dataset.v192ClickBound) {
        el.dataset.v192ClickBound = '1';
        el.addEventListener('click', () => {
          selectedDayKey = selectedDayKey === key ? '' : key;
          enhanceWeekCalendar();
          renderJobCardsV192();
        });
      }
    });
  }

  function hookV192() {
    // Open filter drawer by default on desktop (> 900px), keep collapsed on mobile for minimal height
    const drawer = byId('v192FilterDrawer');
    if (drawer && window.innerWidth > 900) {
      drawer.open = true;
    }

    window.renderJobs = function () {
      renderJobCardsV192();
    };

    if (typeof window.v17RenderWeek === 'function' && !window.v17RenderWeek._v192Wrapped) {
      const origWeek = window.v17RenderWeek;
      const wrapped = function () {
        const res = origWeek.apply(this, arguments);
        enhanceWeekCalendar();
        updatePlannedBadges();
        return res;
      };
      wrapped._v192Wrapped = true;
      window.v17RenderWeek = wrapped;
    }

    const busyBtn = byId('v192WeekOnlyBusy');
    if (busyBtn && !busyBtn.dataset.v192Bound) {
      busyBtn.dataset.v192Bound = '1';
      busyBtn.addEventListener('click', () => {
        onlyBusyDays = !onlyBusyDays;
        busyBtn.classList.toggle('is-active', onlyBusyDays);
        busyBtn.textContent = onlyBusyDays ? 'Alle 7 Tage' : 'Nur belegte Tage';
        enhanceWeekCalendar();
      });
    }

    // Re-render once initial data is available
    renderJobCardsV192();
    enhanceWeekCalendar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hookV192);
  } else {
    hookV192();
  }
})();
