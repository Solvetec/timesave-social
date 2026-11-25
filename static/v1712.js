/* TimeSave Social V17.12 · Telegram/TikTok Health Panels, Quickbars & Safe Guides */
'use strict';

async function v1712TelegramHealth() {
  const btn = $('v1712TelegramCheck'), status = $('v1712TelegramStatus'),
    pill = $('v1712TelegramPill'), results = $('v1712TelegramResults');
  if (btn) btn.disabled = true;
  if (status) status.textContent = '⏳ Prüfe Telegram-Bot, Kanal und Rechte …';
  try {
    const res = await api('/api/telegram/health', { method: 'POST' });
    if (pill) {
      pill.className = 'pill ' + (!res.connected ? 'gray' : res.ok ? 'green' : 'red');
      pill.textContent = !res.connected ? 'Nicht verbunden' : res.ok ? '✓ Bereit' : '⚠ Prüfen';
    }
    if (status) status.textContent = res.message || '';
    if (results) {
      results.innerHTML = (res.accounts || []).map(a =>
        `<div class="v1712-health-item"><div><strong>${esc(a.label)}</strong><br><small>${esc(a.message)}</small></div>` +
        `<span class="pill ${a.ok ? 'green' : a.temporary ? 'amber' : 'red'}">${a.ok ? '✓ OK' : a.temporary ? '⏳ Temporär' : '✕ Fehler'}</span></div>`
      ).join('');
    }
    await refresh();
  } catch (e) {
    if (status) status.textContent = '⚠ ' + e.message;
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function v1712RenderTikTokPanel() {
  const tt = accounts.filter(a => a.provider === 'tiktok');
  const pill = $('v1712TikTokPill'), status = $('v1712TikTokStatus');
  if (!pill || !status) return;
  if (!tt.length) {
    pill.className = 'pill gray';
    pill.textContent = 'Nicht verbunden';
    status.textContent = 'Noch kein TikTok-Konto angemeldet. Nutze „Mit TikTok anmelden“ in deiner Plattformkarte.';
  } else {
    const bad = tt.some(a => a.status === 'error');
    pill.className = 'pill ' + (bad ? 'red' : 'green');
    pill.textContent = bad ? '⚠ Prüfen' : '● Verbunden';
    status.textContent = 'Verbunden: ' + tt.map(a => a.label).join(', ');
  }
}

function v1712ImagePosition(yPct) {
  if ($('studioY')) $('studioY').value = String(yPct);
  if ($('studioX')) $('studioX').value = '50';
  paintStudio();
}

function v1712ImageReadable() {
  if ($('studioBox')) $('studioBox').value = 'glass';
  if ($('studioColor')) $('studioColor').value = '#ffffff';
  if ($('studioAlign')) $('studioAlign').value = 'center';
  paintStudio();
}

document.querySelectorAll('[data-v1712-bg]').forEach(btn => {
  btn.addEventListener('click', () => {
    if ($('v179BackgroundMode')) $('v179BackgroundMode').value = btn.dataset.v1712Bg;
    if (typeof v177SyncInputsToLayer === 'function') v177SyncInputsToLayer();
  });
});
document.querySelectorAll('[data-v1712-position]').forEach(btn => {
  btn.addEventListener('click', () => {
    if ($('v179X')) $('v179X').value = '50';
    if ($('v179Y')) $('v179Y').value = btn.dataset.v1712Position;
    if (typeof v177SyncInputsToLayer === 'function') v177SyncInputsToLayer();
  });
});
$('v1712ReadableText')?.addEventListener('click', () => {
  if ($('v9VideoColor')) $('v9VideoColor').value = '#ffffff';
  if ($('v179BoxOpacity')) $('v179BoxOpacity').value = '80';
  if ($('v179FontScale')) $('v179FontScale').value = '105';
  if (typeof v177SyncInputsToLayer === 'function') v177SyncInputsToLayer();
});
$('v1712SafeGuides')?.addEventListener('change', ev => {
  $('v9PreviewFrame')?.classList.toggle('show-safe-guides', !!ev.target.checked);
});

const v1712PrevRefresh = refresh;
refresh = async function() {
  const res = await v1712PrevRefresh();
  v1712RenderTikTokPanel();
  return res;
};


function v207ApplySolvetecBrand(variant) {
  const isGold = variant !== 'white';
  if ($('studioBox')) $('studioBox').value = 'glass';
  if ($('studioColor')) $('studioColor').value = isGold ? '#f5c451' : '#ffffff';
  if ($('studioAlign')) $('studioAlign').value = 'center';
  if ($('studioDecor')) $('studioDecor').value = isGold ? 'stars' : 'line';
  if ($('studioSignature') && !$('studioSignature').value.trim()) {
    $('studioSignature').value = 'Solvetec';
  }
  if ($('v9VideoColor')) $('v9VideoColor').value = isGold ? '#f5c451' : '#ffffff';
  if ($('v9VideoBadge') && !$('v9VideoBadge').value.trim()) {
    $('v9VideoBadge').value = 'Solvetec';
  }
  if ($('v179BoxOpacity')) $('v179BoxOpacity').value = '84';
  if (typeof v177SyncInputsToLayer === 'function') v177SyncInputsToLayer();
  if (typeof paintStudio === 'function') paintStudio();
  if (typeof toast === 'function') {
    toast(isGold ? '✨ Solvetec Dunkelblau & Gold Stil angewendet.' : '✨ Solvetec Clean Weiß Stil angewendet.');
  }
}
