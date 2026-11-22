/* TimeSave Social V16 · Telegram Business Profile Stories setup */
'use strict';

function v16GoToConnection() {
  nav('accounts');
  $('v16TelegramStoryConnect')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function v16SyncBotSelect() {
  const sel = $('v16StoryBot');
  if (!sel) return;
  const prev = sel.value;
  const tgBots = accounts.filter(a => a.provider === 'telegram');
  sel.innerHTML = tgBots.length
    ? tgBots.map(a => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('')
    : '<option value="">– Zuerst Telegram-Kanal-Bot verbinden –</option>';
  if (tgBots.some(a => a.id === prev)) sel.value = prev;
}

async function v16DiscoverStories() {
  const botId = $('v16StoryBot')?.value;
  const status = $('v16StoryConnectionStatus');
  const choicesBox = $('v16StoryChoices');
  if (!botId) { toast('Bitte zuerst einen Telegram-Kanal-Bot verbinden.', true); return; }
  const btn = $('v16DiscoverStory');
  if (btn) btn.disabled = true;
  if (status) status.textContent = '⏳ Suche verbundene Telegram-Business-Profile …';
  try {
    const res = await json('/api/telegram/story/discover', { channel_connection_id: botId });
    const opts = res.options || [];
    if (!opts.length) {
      if (choicesBox) choicesBox.hidden = true;
      if (status) status.textContent = res.message || 'Noch kein freigegebenes Telegram-Profil gefunden.';
      toast('Noch kein Telegram-Business-Profil mit Story-Recht gefunden.', true);
      return;
    }
    const sel = $('v16BusinessChoice');
    if (sel) {
      sel.innerHTML = opts.map(o =>
        `<option value="${esc(o.business_connection_id)}">${esc((o.name || 'Profil').trim())}${o.username ? ' (@' + esc(o.username) + ')' : ''}</option>`
      ).join('');
    }
    if (choicesBox) choicesBox.hidden = false;
    if (status) status.textContent = '✓ ' + opts.length + ' Profil(e) mit Story-Berechtigung gefunden. Jetzt unten bestätigen.';
  } catch (e) {
    if (status) status.textContent = '⚠ ' + e.message;
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function v16LinkStoryProfile() {
  const botId = $('v16StoryBot')?.value;
  const businessId = $('v16BusinessChoice')?.value;
  if (!botId || !businessId) { toast('Bitte zuerst ein Telegram-Profil suchen und auswählen.', true); return; }
  const btn = $('v16LinkStory');
  if (btn) btn.disabled = true;
  try {
    const res = await json('/api/telegram/story/connect', {
      channel_connection_id: botId,
      business_connection_id: businessId,
    });
    if ($('v16StoryConnectionStatus')) $('v16StoryConnectionStatus').textContent = '✓ ' + (res.message || 'Verbunden.');
    await refresh();
    toast(res.message || 'Telegram-Profil-Story verbunden.');
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

const v16PrevRenderConnections = renderConnections;
renderConnections = function() {
  v16PrevRenderConnections();
  v16SyncBotSelect();
};
