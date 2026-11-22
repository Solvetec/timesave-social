/* TimeSave Social V17.24 · Schnitt+ (Tempo, Ton, Drehung, Spiegeln & In/Out-Schnittmarken) */
'use strict';

function v1724ApplyPreviewTransform() {
  const speed = Number($('v1724Speed')?.value || 1);
  const vol = Number($('v1724Volume')?.value ?? 100);
  const rot = Number($('v1724Rotation')?.value || 0);
  const mirror = !!$('v1724Mirror')?.checked;
  if ($('v1724VolumeValue')) $('v1724VolumeValue').textContent = vol + ' %';
  const vid = $('v9PreviewVideo');
  if (vid) {
    vid.playbackRate = speed;
    vid.muted = vol === 0;
    vid.volume = Math.min(1, vol / 100);
  }
  const transforms = [];
  if (rot) transforms.push('rotate(' + rot + 'deg)');
  if (mirror) transforms.push('scaleX(-1)');
  const tf = transforms.join(' ') || 'none';
  if ($('v9PreviewVideo')) $('v9PreviewVideo').style.transform = tf;
  if ($('v9PreviewImage')) $('v9PreviewImage').style.transform = tf;
  if ($('v1724EditorInfo') && v177State?.isVideo && v177State.duration > 0) {
    const outSec = Math.round((v177State.duration / speed) * 10) / 10;
    $('v1724EditorInfo').textContent = 'Original: ' + v177FmtClock(v177State.duration) + ' · Bei ' + speed + '× Tempo ca. ' + v177FmtClock(outSec) + ' Ausgabelänge.';
  }
}

['v1724Speed', 'v1724Volume', 'v1724Rotation', 'v1724Mirror'].forEach(id => {
  $(id)?.addEventListener('input', v1724ApplyPreviewTransform);
  $(id)?.addEventListener('change', v1724ApplyPreviewTransform);
});

$('v1724SetIn')?.addEventListener('click', () => {
  const vid = $('v9PreviewVideo');
  if (!vid || !v177State?.isVideo) return;
  const start = Math.round(vid.currentTime * 10) / 10;
  if ($('v9VideoTrim')) $('v9VideoTrim').value = String(start);
  const remaining = Math.max(1, Math.round(((v177State.duration || start + 8) - start) * 10) / 10);
  if ($('v9VideoDuration') && Number($('v9VideoDuration').value) > remaining) $('v9VideoDuration').value = String(remaining);
  toast('Ausschnitt-Start auf ' + v177FmtClock(start) + ' gesetzt.');
});

$('v1724SetOut')?.addEventListener('click', () => {
  const vid = $('v9PreviewVideo');
  if (!vid || !v177State?.isVideo) return;
  const start = Number($('v9VideoTrim')?.value) || 0;
  const cur = Math.round(vid.currentTime * 10) / 10;
  if (cur <= start + 0.9) { toast('Das Ende muss mindestens 1 Sekunde hinter dem Start liegen.', true); return; }
  if ($('v9VideoDuration')) $('v9VideoDuration').value = String(Math.round((cur - start) * 10) / 10);
  toast('Ausschnitt-Ende auf ' + v177FmtClock(cur) + ' gesetzt.');
});

$('v1724TrimFull')?.addEventListener('click', () => {
  const start = Number($('v9VideoTrim')?.value) || 0;
  const rem = Math.max(1, Math.round(((v177State?.duration || 8) - start) * 10) / 10);
  if ($('v9VideoDuration')) $('v9VideoDuration').value = String(rem);
  toast('Ganzen Rest ab Start gewählt (' + v177FmtClock(rem) + ').');
});

v1724ApplyPreviewTransform();
