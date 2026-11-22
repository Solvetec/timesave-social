/* TimeSave Social V17.22 · One-Click Telegram Connect from Render Environment */
'use strict';

async function v1722LoadTelegramEnvStatus() {
  if (!auth) return;
  try {
    const st = await api('/api/telegram/env/status');
    if ($('v1722EnvStatus')) $('v1722EnvStatus').textContent = st.message || '';
  } catch {}
}

async function v1722ConnectTelegramEnv() {
  try {
    const res = await api('/api/telegram/env/connect', { method: 'POST' });
    await refresh();
    toast(res.message || 'Telegram über Render verbunden.');
  } catch (e) {
    toast(e.message, true);
  }
}

async function v1722CopyBusinessId() {
  const selected = $('v16BusinessChoice')?.value || accounts.find(a => a.provider === 'telegram_story')?.external_id || '';
  if (!selected) {
    toast('Noch keine Telegram-Profil-Verbindungs-ID gefunden. Zuerst oben „Mein Telegram-Profil finden“ klicken.', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(selected);
    toast('TELEGRAM_BUSINESS_CONNECTION_ID kopiert.');
  } catch {
    prompt('Kopiere diese ID für Render (TELEGRAM_BUSINESS_CONNECTION_ID):', selected);
  }
}

const v1722PrevRefresh = refresh;
refresh = async function() {
  const res = await v1722PrevRefresh();
  v1722LoadTelegramEnvStatus();
  return res;
};
