/* TimeSave Social V17.8 · Native Mobile Share Dialog (Web Share API + Safe Download Fallback) */
'use strict';
let v178PreparedFile = null;
let v178PreparedCaption = '';
let v178PreparedMediaId = '';
let v178ThumbUrl = '';

function v178Close() {
  if ($('v178Dialog')?.open) $('v178Dialog').close();
  if (v178ThumbUrl) { URL.revokeObjectURL(v178ThumbUrl); v178ThumbUrl = ''; }
}

async function v178OpenShare(mediaId, destination, caption = '') {
  const dialog = $('v178Dialog');
  if (!dialog) return;
  const item = media.find(m => m.id === mediaId);
  v178PreparedFile = null;
  v178PreparedCaption = caption || '';
  v178PreparedMediaId = mediaId;
  if ($('v178Destination')) $('v178Destination').textContent = destination === 'tiktok' ? 'TikTok-Story teilen' : 'WhatsApp-Status teilen';
  if ($('v178Name')) $('v178Name').textContent = item?.original_name || mediaId;
  if ($('v178Status')) $('v178Status').textContent = '⏳ Datei wird vorbereitet …';
  const shareBtn = $('v178ShareNow');
  if (shareBtn) { shareBtn.disabled = true; shareBtn.textContent = '📲 Datei wird vorbereitet …'; }
  if ($('v178Preview')) loadImageInto($('v178Preview'), mediaId);
  dialog.showModal();
  try {
    const resp = await fetch('/api/media/' + encodeURIComponent(mediaId), { headers: { 'X-Admin-Token': auth } });
    if (!resp.ok) throw new Error('Mediendatei konnte nicht geladen werden.');
    const blob = await resp.blob();
    const fileName = item?.original_name || ('story.' + (blob.type === 'video/mp4' ? 'mp4' : 'jpg'));
    const file = new File([blob], fileName, { type: item?.mime || blob.type });
    v178PreparedFile = file;
    const canNative = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    if (shareBtn) {
      shareBtn.disabled = !canNative;
      shareBtn.textContent = canNative ? '📲 Jetzt über Teilen-Menü öffnen' : '📱 Direktes Teilen auf diesem Browser nicht verfügbar';
    }
    if ($('v178Status')) {
      $('v178Status').textContent = canNative
        ? '✓ Datei bereit. Tippe auf „Jetzt über Teilen-Menü öffnen“.'
        : 'ℹ️ Dieser Browser unterstützt kein direktes Datei-Teilen. Lade die Datei einfach unten direkt herunter.';
    }
  } catch (e) {
    if ($('v178Status')) $('v178Status').textContent = '⚠ ' + e.message;
  }
}

$('v178Close')?.addEventListener('click', v178Close);
$('v178Save')?.addEventListener('click', () => { if (v178PreparedMediaId) downloadMedia(v178PreparedMediaId); });
$('v178ShareNow')?.addEventListener('click', async () => {
  if (!v178PreparedFile || !navigator.share) return;
  try {
    if (v178PreparedCaption) {
      try { await navigator.clipboard.writeText(v178PreparedCaption); } catch {}
    }
    await navigator.share({ files: [v178PreparedFile], text: v178PreparedCaption || undefined });
    toast('Datei an das Teilen-Menü übergeben.');
  } catch (e) {
    if (e.name !== 'AbortError') toast('Teilen fehlgeschlagen: ' + e.message, true);
  }
});
