/* TimeSave Social V14 · Private Mobile QR Handoff Dialog */
'use strict';
let v14QrBlobUrl = '';
let v14CurrentMediaId = '';

function v14CloseMobileQr() {
  if ($('v14MobileDialog')?.open) $('v14MobileDialog').close();
  if (v14QrBlobUrl) { URL.revokeObjectURL(v14QrBlobUrl); v14QrBlobUrl = ''; }
}

async function v14OpenMobileQr(mediaId) {
  const dialog = $('v14MobileDialog');
  if (!dialog) return;
  const item = media.find(m => m.id === mediaId);
  v14CurrentMediaId = mediaId;
  if ($('v14MobileFilename')) $('v14MobileFilename').textContent = item ? item.original_name : mediaId;
  const img = $('v14QrImage'), loading = $('v14QrLoading');
  if (img) { img.hidden = true; img.removeAttribute('src'); }
  if (loading) { loading.hidden = false; loading.textContent = 'Erstelle privaten QR-Code …'; }
  if (v14QrBlobUrl) { URL.revokeObjectURL(v14QrBlobUrl); v14QrBlobUrl = ''; }
  dialog.showModal();
  try {
    const resp = await fetch('/api/whatsapp/mobile-qr/' + encodeURIComponent(mediaId), {
      headers: { 'X-Admin-Token': auth },
    });
    if (!resp.ok) {
      let msg = 'QR-Code konnte nicht erstellt werden.';
      try { const body = await resp.json(); if (body.detail) msg = body.detail; } catch {}
      throw new Error(msg);
    }
    const blob = await resp.blob();
    if (v14CurrentMediaId !== mediaId) return;
    v14QrBlobUrl = URL.createObjectURL(blob);
    if (img) { img.src = v14QrBlobUrl; img.hidden = false; }
    if (loading) loading.hidden = true;
  } catch (e) {
    if (loading) loading.textContent = '⚠ ' + e.message;
  }
}

$('v14MobileClose')?.addEventListener('click', v14CloseMobileQr);
$('v14MobileDialog')?.addEventListener('close', () => {
  if (v14QrBlobUrl) { URL.revokeObjectURL(v14QrBlobUrl); v14QrBlobUrl = ''; }
});
$('v14MobileDownload')?.addEventListener('click', () => {
  if (v14CurrentMediaId) downloadMedia(v14CurrentMediaId);
});
