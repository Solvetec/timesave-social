"""TimeSave Social by Solvetec (V19.5) – Modular router for WhatsApp Status optimization,
Auto-Jump-Cut silence removal, and Studio Brand-Presets.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re

import httpx
import subprocess
import tempfile
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field


class WhatsAppPrepareRequest(BaseModel):
    media_id: str
    split_seconds: int = Field(0, ge=0, le=60)  # 0 = no split, 30 or 60 for Status
    quality: str = Field('balanced', pattern='^(balanced|compact)$')


class SilenceRemovalRequest(BaseModel):
    media_id: str
    noise_db: int = Field(-32, ge=-50, le=-15)
    min_silence: float = Field(0.6, ge=0.25, le=3.0)
    padding: float = Field(0.12, ge=0.0, le=0.4)


class ReframeRequest(BaseModel):
    media_id: str
    mode: str = Field('blur', pattern='^(blur|crop_center|crop_left|crop_right)$')


class CaptionCue(BaseModel):
    start: float = Field(..., ge=0, le=14400)
    end: float = Field(..., ge=0.1, le=14400)
    text: str = Field(..., min_length=1, max_length=220)


class BurnCaptionsRequest(BaseModel):
    media_id: str
    style: str = Field('tiktok_yellow', pattern='^(tiktok_yellow|tiktok_white|clean_box)$')
    position: str = Field('safe_lower', pattern='^(safe_lower|center|upper)$')
    cues: list[CaptionCue] = Field(..., min_length=1, max_length=250)


class TranscribeRequest(BaseModel):
    media_id: str
    language: str = Field('de', max_length=12)


class StudioPresetCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=60)
    format: str = Field('story', pattern='^(story|portrait|square|landscape)$')
    filter: str = Field('normal', pattern='^(normal|warm|cool|vivid|mono)$')
    background_mode: str = Field('cover', pattern='^(cover|blur|solid)$')
    background_color: str = Field('#0f1b33', pattern=r'^#[0-9a-fA-F]{6}$')
    title_color: str = Field('#ffffff', pattern=r'^#[0-9a-fA-F]{6}$')
    position: str = Field('center', pattern='^(top|center|bottom)$')
    badge: str = Field('', max_length=32)
    motion: str = Field('static', pattern='^(static|zoom)$')
    fade: bool = False


def create_v19_router(deps: dict[str, Any]) -> APIRouter:
    """Build the V19.0 API router using shared helpers from app.main."""
    router = APIRouter(prefix='/api/v19', tags=['v19'])

    current_user = deps['current_user']
    media_row = deps['media_row']
    dbconn = deps['dbconn']
    now = deps['now']
    APP_TZ = deps['APP_TZ']
    MEDIA: Path = deps['MEDIA']
    MAX_VIDEO: int = deps['MAX_VIDEO']
    _find_ffmpeg = deps['_find_ffmpeg']
    _run_ffmpeg = deps['_run_ffmpeg']
    _video_duration_seconds = deps['_video_duration_seconds']
    _v183_jobs: dict = deps['_v183_jobs']
    _v183_lock = deps['_v183_lock']
    _v183_tasks: set = deps['_v183_tasks']
    get_user_pref = deps['get_user_pref']
    save_user_pref = deps['save_user_pref']
    logger = deps['logger']

    def _register_bg_job(owner_id: str, start_msg: str) -> str:
        job_id = uuid.uuid4().hex
        with _v183_lock:
            if any(x.get('status') == 'running' for x in _v183_jobs.values()):
                raise HTTPException(
                    409,
                    'Es läuft bereits eine Videoverarbeitung. Bitte warte, bis sie fertig ist.',
                )
            while len(_v183_jobs) >= 40:
                _v183_jobs.pop(next(iter(_v183_jobs)))
            _v183_jobs[job_id] = {
                'owner': owner_id,
                'status': 'running',
                'progress': 2,
                'message': start_msg,
            }
        return job_id

    def _update_job(job_id: str, **values: Any) -> None:
        with _v183_lock:
            if job_id in _v183_jobs:
                _v183_jobs[job_id].update(values)

    # ------------------------------------------------------------------
    # 1. WhatsApp Status Video-Optimierer + Auto-Splitter (ohne Business API)
    # ------------------------------------------------------------------
    def _wa_encode_clip(
        ffmpeg: str,
        src: Path,
        dst: Path,
        start_s: float,
        dur_s: float,
        quality: str,
    ) -> None:
        # Target <= 14.5 MB per clip so WhatsApp does not crush quality.
        target_bytes = 14_500_000
        audio_kbps = 128
        max_v_kbps = 3200 if quality == 'balanced' else 2000
        calc_v_kbps = int(((target_bytes * 8) / max(dur_s, 1.0)) / 1000) - audio_kbps - 64
        video_kbps = max(650, min(max_v_kbps, calc_v_kbps))
        vf = (
            "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'"
            ":force_original_aspect_ratio=decrease,"
            "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30,format=yuv420p"
        )
        cmd = [
            ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
            '-ss', f'{start_s:.3f}',
            '-i', str(src),
            '-t', f'{dur_s:.3f}',
            '-vf', vf,
            '-c:v', 'libx264', '-profile:v', 'main', '-level', '3.1',
            '-preset', 'veryfast', '-threads', '1',
            '-b:v', f'{video_kbps}k', '-maxrate', f'{int(video_kbps * 1.15)}k',
            '-bufsize', f'{int(video_kbps * 2)}k',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', f'{audio_kbps}k', '-ar', '44100', '-ac', '2',
            '-movflags', '+faststart',
            str(dst),
        ]
        proc = _run_ffmpeg(cmd, capture_output=True, timeout=240)
        if proc.returncode or not dst.exists() or not dst.stat().st_size:
            stderr = (proc.stderr or b'').decode('utf-8', errors='replace')[-1200:]
            logger.error('V19 WhatsApp encode failed: %s', stderr)
            raise RuntimeError('WhatsApp-Video konnte nicht kodiert werden.')

    def _wa_worker(job_id: str, req: WhatsAppPrepareRequest, source: dict, ffmpeg: str, owner_id: str) -> None:
        created_paths: list[Path] = []
        try:
            src_path = MEDIA / source['filename']
            duration = _video_duration_seconds(src_path, ffmpeg)
            split_s = req.split_seconds if req.split_seconds in (30, 60) else 0

            segments: list[tuple[float, float]] = []
            if split_s and duration > split_s + 0.5:
                count = int(math.ceil(duration / split_s))
                if count > 12:
                    raise RuntimeError(
                        f'Das Video würde in {count} Status-Teile zerfallen (Maximum: 12). Bitte vorher kürzen.'
                    )
                for idx in range(count):
                    st = idx * split_s
                    seg_dur = min(float(split_s), duration - st)
                    if seg_dur >= 0.8:
                        segments.append((st, seg_dur))
            else:
                segments.append((0.0, duration))

            base_stem = Path(source['original_name']).stem[:48]
            stamp = datetime.now(APP_TZ).strftime('%Y%m%d-%H%M')
            clips_meta: list[dict[str, Any]] = []
            total = len(segments)

            for idx, (st, seg_dur) in enumerate(segments):
                pct = 8 + int(84 * idx / total)
                _update_job(
                    job_id,
                    progress=pct,
                    message=f'WhatsApp-Clip {idx + 1}/{total} wird optimiert …',
                )
                clip_id = uuid.uuid4().hex
                out_path = MEDIA / f'{clip_id}.mp4'
                created_paths.append(out_path)
                _wa_encode_clip(ffmpeg, src_path, out_path, st, seg_dur, req.quality)
                if out_path.stat().st_size > MAX_VIDEO:
                    raise RuntimeError('Erstellter Clip überschreitet das Video-Limit.')
                suffix = f'-WA-Teil{idx + 1}von{total}' if total > 1 else '-WhatsApp'
                display_name = f'{base_stem}{suffix}-{stamp}.mp4'
                with dbconn() as db:
                    db.execute(
                        'INSERT INTO media(id,filename,original_name,mime,created_at,owner_id) VALUES(?,?,?,?,?,?)',
                        (clip_id, out_path.name, display_name, 'video/mp4', now(), owner_id),
                    )
                clips_meta.append({
                    'id': clip_id,
                    'name': display_name,
                    'part': idx + 1,
                    'total': total,
                    'duration': round(seg_dur, 1),
                    'size_mb': round(out_path.stat().st_size / (1024 * 1024), 2),
                })

            summary = (
                f'{total} WhatsApp-Status-Clips erstellt (je ≤ {split_s} Sek., Anti-Komprimierung aktiv).'
                if total > 1
                else f'Video für WhatsApp optimiert ({clips_meta[0]["size_mb"]} MB, H.264/720p).'
            )
            _update_job(
                job_id,
                status='done',
                progress=100,
                message=summary,
                id=clips_meta[0]['id'],
                clips=clips_meta,
            )
        except Exception as exc:
            for p in created_paths:
                p.unlink(missing_ok=True)
            logger.exception('V19 WhatsApp prepare failed')
            msg = str(exc) if isinstance(exc, RuntimeError) else 'WhatsApp-Optimierung fehlgeschlagen.'
            if isinstance(exc, subprocess.TimeoutExpired):
                msg = 'Die WhatsApp-Optimierung hat zu lange gedauert.'
            _update_job(job_id, status='error', message=msg)

    @router.post('/whatsapp/prepare-video', status_code=202)
    async def prepare_whatsapp_video(req: WhatsAppPrepareRequest, user: dict = Depends(current_user)):
        if req.split_seconds not in (0, 30, 60):
            raise HTTPException(400, 'Split-Dauer muss 0 (kein Split), 30 oder 60 Sekunden sein.')
        source = media_row(req.media_id, user['id'])
        if source['mime'] != 'video/mp4':
            raise HTTPException(400, 'Bitte ein MP4-Video für die WhatsApp-Optimierung auswählen.')
        if not (MEDIA / source['filename']).is_file():
            raise HTTPException(404, 'Videodatei nicht gefunden.')
        try:
            ffmpeg = _find_ffmpeg('WhatsApp-Optimierung benötigt FFmpeg.')
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from None
        job_id = _register_bg_job(user['id'], 'WhatsApp-Optimierung gestartet …')
        task = asyncio.create_task(
            asyncio.to_thread(_wa_worker, job_id, req, source, ffmpeg, user['id'])
        )
        _v183_tasks.add(task)
        task.add_done_callback(_v183_tasks.discard)
        return {'job_id': job_id}

    # ------------------------------------------------------------------
    # 2. Auto-Stille-Entfernung (Auto-Jump-Cuts)
    # ------------------------------------------------------------------
    def _detect_speech_segments(
        ffmpeg: str,
        src: Path,
        duration: float,
        noise_db: int,
        min_silence: float,
        padding: float,
    ) -> list[tuple[float, float]]:
        cmd = [
            ffmpeg, '-nostdin', '-hide_banner', '-i', str(src),
            '-af', f'silencedetect=noise={noise_db}dB:d={min_silence}',
            '-f', 'null', '-',
        ]
        proc = _run_ffmpeg(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=180)
        log = (proc.stderr or b'').decode('utf-8', errors='replace')
        if 'Audio:' not in log:
            raise RuntimeError('Dieses Video enthält keine Tonspur für die Stille-Erkennung.')

        silences: list[tuple[float, float]] = []
        current_start: float | None = None
        for line in log.splitlines():
            m_start = re.search(r'silence_start:\s*([0-9.]+)', line)
            if m_start:
                current_start = float(m_start.group(1))
                continue
            m_end = re.search(r'silence_end:\s*([0-9.]+)', line)
            if m_end and current_start is not None:
                silences.append((current_start, float(m_end.group(1))))
                current_start = None
        if current_start is not None:
            silences.append((current_start, duration))

        if not silences:
            return [(0.0, duration)]

        raw_keep: list[tuple[float, float]] = []
        cursor = 0.0
        for s_start, s_end in silences:
            k_start = max(0.0, cursor - padding)
            k_end = min(duration, s_start + padding)
            if k_end - k_start >= 0.18:
                raw_keep.append((k_start, k_end))
            cursor = s_end
        if duration - cursor >= 0.18:
            raw_keep.append((max(0.0, cursor - padding), duration))

        if not raw_keep:
            return []

        merged: list[tuple[float, float]] = [raw_keep[0]]
        for st, en in raw_keep[1:]:
            prev_st, prev_en = merged[-1]
            if st <= prev_en + 0.08:
                merged[-1] = (prev_st, max(prev_en, en))
            else:
                merged.append((st, en))
        return merged

    def _silence_worker(job_id: str, req: SilenceRemovalRequest, source: dict, ffmpeg: str, owner_id: str) -> None:
        out_id = uuid.uuid4().hex
        out_path = MEDIA / f'{out_id}.mp4'
        try:
            src_path = MEDIA / source['filename']
            duration = _video_duration_seconds(src_path, ffmpeg)
            _update_job(job_id, progress=12, message='Tonspur wird auf Sprechpausen analysiert …')
            segments = _detect_speech_segments(
                ffmpeg, src_path, duration, req.noise_db, req.min_silence, req.padding
            )
            if not segments:
                raise RuntimeError('Es wurde kein hörbarer Ton oberhalb des Schwellenwerts gefunden.')
            kept_duration = sum(en - st for st, en in segments)
            saved = max(0.0, duration - kept_duration)
            if saved < 0.4:
                raise RuntimeError(
                    'Keine nennenswerten Sprechpausen gefunden (weniger als 0,4 Sek. Einsparung).'
                )
            if len(segments) > 90:
                segments = segments[:90]

            with tempfile.TemporaryDirectory(prefix='sp_v19_jc_') as td:
                td_path = Path(td)
                part_files: list[Path] = []
                total = len(segments)
                for idx, (st, en) in enumerate(segments):
                    pct = 20 + int(68 * idx / total)
                    _update_job(
                        job_id,
                        progress=pct,
                        message=f'Jump-Cut {idx + 1}/{total} wird geschnitten …',
                    )
                    part = td_path / f'seg_{idx:03d}.mp4'
                    cmd = [
                        ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                        '-ss', f'{st:.3f}', '-to', f'{en:.3f}',
                        '-i', str(src_path),
                        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
                        '-threads', '1', '-pix_fmt', 'yuv420p',
                        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                        str(part),
                    ]
                    proc = _run_ffmpeg(cmd, capture_output=True, timeout=180)
                    if proc.returncode or not part.exists():
                        stderr = (proc.stderr or b'').decode('utf-8', errors='replace')[-1000:]
                        logger.error('V19 jump-cut segment failed: %s', stderr)
                        raise RuntimeError('Ein Schnittsegment konnte nicht gerendert werden.')
                    part_files.append(part)

                _update_job(job_id, progress=92, message='Szenen werden zusammengefügt …')
                concat_list = td_path / 'list.txt'
                concat_list.write_text(
                    ''.join(f"file '{p.name}'\n" for p in part_files),
                    encoding='utf-8',
                )
                proc = _run_ffmpeg(
                    [
                        ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                        '-f', 'concat', '-safe', '1', '-i', str(concat_list),
                        '-c', 'copy', '-movflags', '+faststart', str(out_path),
                    ],
                    capture_output=True,
                    timeout=120,
                )
                if proc.returncode or not out_path.exists() or not out_path.stat().st_size:
                    raise RuntimeError('Jump-Cut-Video konnte nicht zusammengefügt werden.')
                if out_path.stat().st_size > MAX_VIDEO:
                    raise RuntimeError('Erstelltes Video überschreitet 100 MB.')

            base_stem = Path(source['original_name']).stem[:48]
            stamp = datetime.now(APP_TZ).strftime('%Y%m%d-%H%M')
            display_name = f'{base_stem}-JumpCut-{stamp}.mp4'
            with dbconn() as db:
                db.execute(
                    'INSERT INTO media(id,filename,original_name,mime,created_at,owner_id) VALUES(?,?,?,?,?,?)',
                    (out_id, out_path.name, display_name, 'video/mp4', now(), owner_id),
                )
            _update_job(
                job_id,
                status='done',
                progress=100,
                id=out_id,
                name=display_name,
                saved_seconds=round(saved, 1),
                new_duration=round(kept_duration, 1),
                cuts=len(segments),
                message=f'Fertig! {saved:.1f} Sek. Stille entfernt ({len(segments)} Schnitte). Neues Video liegt in der Mediathek.',
            )
        except Exception as exc:
            out_path.unlink(missing_ok=True)
            logger.exception('V19 silence removal failed')
            msg = str(exc) if isinstance(exc, RuntimeError) else 'Stille-Entfernung fehlgeschlagen.'
            if isinstance(exc, subprocess.TimeoutExpired):
                msg = 'Die Stille-Entfernung hat zu lange gedauert.'
            _update_job(job_id, status='error', message=msg)

    @router.post('/video/remove-silence', status_code=202)
    async def remove_silence(req: SilenceRemovalRequest, user: dict = Depends(current_user)):
        source = media_row(req.media_id, user['id'])
        if source['mime'] != 'video/mp4':
            raise HTTPException(400, 'Stille-Entfernung funktioniert nur bei MP4-Videos.')
        if not (MEDIA / source['filename']).is_file():
            raise HTTPException(404, 'Videodatei nicht gefunden.')
        try:
            ffmpeg = _find_ffmpeg('Stille-Entfernung benötigt FFmpeg.')
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from None
        job_id = _register_bg_job(user['id'], 'Stille-Entfernung gestartet …')
        task = asyncio.create_task(
            asyncio.to_thread(_silence_worker, job_id, req, source, ffmpeg, user['id'])
        )
        _v183_tasks.add(task)
        task.add_done_callback(_v183_tasks.discard)
        return {'job_id': job_id}

    # ------------------------------------------------------------------
    # 3. Studio Brand-Presets (per user in encrypted user_prefs)
    # ------------------------------------------------------------------
    PRESET_KEY = 'v19_studio_presets'

    DEFAULT_SOLVETEC_PRESETS = [
        {
            'id': 'solvetec-gold-916',
            'name': 'Solvetec Dunkelblau & Gold (9:16)',
            'format': 'story',
            'filter': 'normal',
            'background_mode': 'blur',
            'background_color': '#0f1b33',
            'title_color': '#f5c451',
            'position': 'center',
            'badge': 'Solvetec',
            'motion': 'zoom',
            'fade': True,
        },
        {
            'id': 'solvetec-clean-white',
            'name': 'Solvetec Clean Weiß & Royalblau',
            'format': 'story',
            'filter': 'cool',
            'background_mode': 'solid',
            'background_color': '#132442',
            'title_color': '#ffffff',
            'position': 'bottom',
            'badge': 'TimeSave Social',
            'motion': 'static',
            'fade': True,
        },
        {
            'id': 'solvetec-portrait-gold',
            'name': 'Solvetec 4:5 Feed Gold-Akzent',
            'format': 'portrait',
            'filter': 'warm',
            'background_mode': 'cover',
            'background_color': '#0f1b33',
            'title_color': '#ffd166',
            'position': 'top',
            'badge': 'Solvetec',
            'motion': 'static',
            'fade': False,
        },
    ]

    def _load_presets(owner_id: str) -> list[dict[str, Any]]:
        raw = get_user_pref(owner_id, PRESET_KEY)
        if not raw:
            return list(DEFAULT_SOLVETEC_PRESETS)
        try:
            data = json.loads(raw)
            return data if isinstance(data, list) and data else list(DEFAULT_SOLVETEC_PRESETS)
        except json.JSONDecodeError:
            return list(DEFAULT_SOLVETEC_PRESETS)

    @router.get('/studio/presets')
    def list_studio_presets(user: dict = Depends(current_user)):
        return {'presets': _load_presets(user['id'])}

    @router.post('/studio/presets')
    def save_studio_preset(req: StudioPresetCreate, user: dict = Depends(current_user)):
        presets = _load_presets(user['id'])
        if len(presets) >= 20:
            raise HTTPException(400, 'Maximal 20 Studio-Vorlagen pro Konto möglich.')
        item = {
            'id': uuid.uuid4().hex[:12],
            'name': req.name.strip(),
            'format': req.format,
            'filter': req.filter,
            'background_mode': req.background_mode,
            'background_color': req.background_color,
            'title_color': req.title_color,
            'position': req.position,
            'badge': req.badge.strip(),
            'motion': req.motion,
            'fade': bool(req.fade),
        }
        presets = [p for p in presets if p.get('name', '').lower() != item['name'].lower()]
        presets.insert(0, item)
        save_user_pref(user['id'], PRESET_KEY, json.dumps(presets, ensure_ascii=False))
        return {'preset': item, 'presets': presets}

    @router.delete('/studio/presets/{preset_id}')
    def delete_studio_preset(preset_id: str, user: dict = Depends(current_user)):
        presets = _load_presets(user['id'])
        filtered = [p for p in presets if p.get('id') != preset_id]
        save_user_pref(user['id'], PRESET_KEY, json.dumps(filtered, ensure_ascii=False))
        return {'presets': filtered}

    setting = deps.get('setting')
    public_base = deps.get('public_base')
    secure_media_url = deps.get('secure_media_url')
    tiktok_photo_readiness = deps.get('tiktok_photo_readiness')

    # ------------------------------------------------------------------
    # 4. TikTok HTTPS-Erreichbarkeit & Verifizierungsdatei Live-Test
    # ------------------------------------------------------------------
    @router.post('/tiktok/test-reachability')
    async def test_tiktok_reachability(user: dict = Depends(current_user)):
        checks: list[dict[str, Any]] = []
        readiness = tiktok_photo_readiness() if tiktok_photo_readiness else {'configured': False, 'problems': ['Readiness-Check nicht verfügbar']}
        base = public_base() if public_base else ''
        prefix = (setting('tiktok_verified_media_prefix') or '').strip() if setting else ''
        verify_name = (os.getenv('TIKTOK_VERIFY_FILENAME') or (setting('tiktok_verify_filename') if setting else '') or '').strip()
        verify_body = (os.getenv('TIKTOK_VERIFY_CONTENT') or (setting('tiktok_verify_content') if setting else '') or '').strip()

        checks.append({
            'label': 'Öffentliche HTTPS-URL & Präfix',
            'ok': bool(readiness.get('configured')),
            'detail': (
                f'Passt zusammen: {base.rstrip("/")}/public/media/ beginnt mit {prefix}'
                if readiness.get('configured')
                else ' '.join(readiness.get('problems') or ['Noch nicht konfiguriert.'])
            ),
        })

        if verify_name and verify_body:
            if base.startswith('https://'):
                test_urls = [
                    (f'{prefix}{verify_name}' if prefix.startswith('https://') and prefix.endswith('/') else f'{base.rstrip("/")}/public/media/{verify_name}'),
                    f'{base.rstrip("/")}/{verify_name}',
                ]
                verify_ok = False
                details = []
                async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
                    for u in dict.fromkeys(test_urls):
                        try:
                            resp = await client.get(u)
                            matched = resp.status_code == 200 and resp.text.strip() == verify_body
                            if matched:
                                verify_ok = True
                                details.append(f'✓ {u} (HTTP 200, Inhalt stimmt)')
                            else:
                                details.append(f'✗ {u} (HTTP {resp.status_code})')
                        except httpx.HTTPError as exc:
                            details.append(f'✗ {u} ({type(exc).__name__})')
                checks.append({
                    'label': 'TikTok-Verifizierungsdatei (externer Abruf)',
                    'ok': verify_ok,
                    'detail': ' · '.join(details),
                })
            else:
                checks.append({
                    'label': 'TikTok-Verifizierungsdatei',
                    'ok': False,
                    'detail': f'Datei {verify_name} gespeichert, aber öffentliche HTTPS-URL fehlt noch.',
                })
        else:
            checks.append({
                'label': 'TikTok-Verifizierungsdatei (optional bei DNS-TXT)',
                'ok': True,
                'detail': 'Keine Verifizierungsdatei eingetragen. Falls du die Domain per DNS-TXT verifiziert hast, ist das okay; sonst Dateiname & Inhalt oben speichern.',
            })

        with dbconn() as db:
            jpg_row = db.execute(
                "SELECT id, filename, original_name, mime FROM media WHERE owner_id=? AND mime='image/jpeg' ORDER BY created_at DESC LIMIT 1",
                (user['id'],),
            ).fetchone()
        if jpg_row and base.startswith('https://') and secure_media_url:
            signed_url = secure_media_url(jpg_row['id'], minutes=15)
            try:
                async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
                    resp = await client.get(signed_url)
                ctype = (resp.headers.get('content-type') or '').lower()
                img_ok = resp.status_code == 200 and 'image/jpeg' in ctype and len(resp.content) > 100
                checks.append({
                    'label': 'Öffentlicher JPG-Abruf (PULL_FROM_URL)',
                    'ok': img_ok,
                    'detail': (
                        f'✓ Testbild „{jpg_row["original_name"]}“ per HTTPS abrufbar ({len(resp.content) // 1024} KB, image/jpeg).'
                        if img_ok
                        else f'✗ HTTP {resp.status_code}, Content-Type: {ctype or "unbekannt"}'
                    ),
                })
            except httpx.HTTPError as exc:
                checks.append({
                    'label': 'Öffentlicher JPG-Abruf (PULL_FROM_URL)',
                    'ok': False,
                    'detail': f'✗ Bild-URL nicht von außen erreichbar ({type(exc).__name__}).',
                })
        else:
            checks.append({
                'label': 'Öffentlicher JPG-Abruf (PULL_FROM_URL)',
                'ok': False,
                'detail': 'Bitte mindestens ein JPG in der Mediathek haben und öffentliche HTTPS-URL setzen.',
            })

        all_ok = all(c['ok'] for c in checks)
        return {
            'ok': all_ok,
            'configured': bool(readiness.get('configured')),
            'expected_prefix': (base.rstrip('/') + '/public/media/') if base.startswith('https://') else '',
            'checks': checks,
        }

    DB_BACKEND = deps.get('DB_BACKEND', 'sqlite')
    DATA_DIR = deps.get('DATA_DIR')

    # ------------------------------------------------------------------
    # 5. V19.5: Speicher- & Datenbank-Status (SQLite vs. PostgreSQL + Fernet-Key-Hilfe)
    # ------------------------------------------------------------------
    @router.get('/system/db-status')
    def v195_db_status(user: dict = Depends(current_user)):
        from cryptography.fernet import Fernet
        persistent = (os.getenv('TIMESAVE_PERSISTENT_STORAGE') or os.getenv('STORYPILOT_PERSISTENT_STORAGE') or '0').strip() in ('1', 'true', 'yes')
        enc_set = bool((os.getenv('TIMESAVE_ENCRYPTION_KEY') or os.getenv('STORYPILOT_ENCRYPTION_KEY') or '').strip())
        openai_set = bool(os.getenv('OPENAI_API_KEY', '').strip())
        return {
            'db_backend': DB_BACKEND,
            'is_postgres': DB_BACKEND == 'postgres',
            'persistent_storage': persistent,
            'data_dir': str(DATA_DIR or os.getenv('TIMESAVE_DATA_DIR') or os.getenv('STORYPILOT_DATA_DIR', '')),
            'encryption_key_set': enc_set,
            'openai_whisper_configured': openai_set,
            'suggested_fernet_key': '' if enc_set else Fernet.generate_key().decode('ascii'),
        }

    # ------------------------------------------------------------------
    # 6. V19.5: 1-Klick-Formatwechsel (16:9 -> 9:16 Hochformat)
    # ------------------------------------------------------------------
    def _reframe_worker(job_id: str, req: ReframeRequest, source: dict, ffmpeg: str, owner_id: str) -> None:
        out_id = uuid.uuid4().hex
        out_path = MEDIA / f'{out_id}.mp4'
        try:
            src_path = MEDIA / source['filename']
            _update_job(job_id, progress=12, message='Video wird für 9:16 Hochformat vorbereitet …')
            if req.mode == 'blur':
                vf = (
                    "split=2[bg][fg];"
                    "[bg]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=18:2[blurred];"
                    "[fg]scale=720:1280:force_original_aspect_ratio=decrease[sharp];"
                    "[blurred][sharp]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,format=yuv420p"
                )
                label = '9zu16-Blur'
            else:
                crop_x = {
                    'crop_center': '(iw-720)/2',
                    'crop_left': '0',
                    'crop_right': 'iw-720',
                }[req.mode]
                vf = (
                    f"scale=720:1280:force_original_aspect_ratio=increase,"
                    f"crop=720:1280:{crop_x}:(ih-1280)/2,setsar=1,fps=30,format=yuv420p"
                )
                label = '9zu16-Vollbild'

            _update_job(job_id, progress=35, message='9:16 Hochformat wird gerendert …')
            cmd = [
                ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                '-filter_threads', '1', '-filter_complex_threads', '1',
                '-i', str(src_path),
                '-vf', vf,
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
                '-threads', '1', '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                '-movflags', '+faststart',
                str(out_path),
            ]
            proc = _run_ffmpeg(cmd, capture_output=True, timeout=300)
            if proc.returncode or not out_path.exists() or not out_path.stat().st_size:
                stderr = (proc.stderr or b'').decode('utf-8', errors='replace')[-1000:]
                logger.error('V19.5 reframe failed: %s', stderr)
                raise RuntimeError('9:16-Konvertierung fehlgeschlagen.')
            if out_path.stat().st_size > MAX_VIDEO:
                raise RuntimeError('Das erzeugte 9:16-Video ist größer als 100 MB.')

            base_stem = Path(source['original_name']).stem[:48]
            stamp = datetime.now(APP_TZ).strftime('%Y%m%d-%H%M')
            display_name = f'{base_stem}-{label}-{stamp}.mp4'
            with dbconn() as db:
                db.execute(
                    'INSERT INTO media(id,filename,original_name,mime,created_at,owner_id) VALUES(?,?,?,?,?,?)',
                    (out_id, out_path.name, display_name, 'video/mp4', now(), owner_id),
                )
            _update_job(
                job_id,
                status='done',
                progress=100,
                id=out_id,
                name=display_name,
                message=f'Fertig! 9:16-Video „{display_name}“ liegt in deiner Mediathek.',
            )
        except Exception as exc:
            out_path.unlink(missing_ok=True)
            logger.exception('V19.5 reframe failed')
            msg = str(exc) if isinstance(exc, RuntimeError) else '9:16-Formatwechsel fehlgeschlagen.'
            if isinstance(exc, subprocess.TimeoutExpired):
                msg = 'Der 9:16-Formatwechsel hat zu lange gedauert.'
            _update_job(job_id, status='error', message=msg)

    @router.post('/video/reframe', status_code=202)
    async def reframe_video(req: ReframeRequest, user: dict = Depends(current_user)):
        source = media_row(req.media_id, user['id'])
        if source['mime'] != 'video/mp4':
            raise HTTPException(400, 'Bitte ein MP4-Video für den 9:16-Formatwechsel auswählen.')
        if not (MEDIA / source['filename']).is_file():
            raise HTTPException(404, 'Videodatei nicht gefunden.')
        try:
            ffmpeg = _find_ffmpeg('Formatwechsel benötigt FFmpeg.')
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from None
        job_id = _register_bg_job(user['id'], '9:16-Formatwechsel gestartet …')
        task = asyncio.create_task(
            asyncio.to_thread(_reframe_worker, job_id, req, source, ffmpeg, user['id'])
        )
        _v183_tasks.add(task)
        task.add_done_callback(_v183_tasks.discard)
        return {'job_id': job_id}

    # ------------------------------------------------------------------
    # 7. V19.5: TikTok-Stil Untertitel (Optional Whisper API + ASS Einbrennen)
    # ------------------------------------------------------------------
    def _fmt_ass_time(sec: float) -> str:
        total_cs = max(0, int(round(sec * 100)))
        h = total_cs // 360000
        m = (total_cs % 360000) // 6000
        s = (total_cs % 6000) // 100
        cs = total_cs % 100
        return f'{h}:{m:02d}:{s:02d}.{cs:02d}'

    def _build_ass_content(cues: list[CaptionCue], style: str, position: str) -> str:
        # Alignment & MarginV kept strictly inside TikTok 9:16 Safe-Zone
        if position == 'center':
            align, margin_v = 5, 40
        elif position == 'upper':
            align, margin_v = 8, 190
        else:  # safe_lower (above TikTok caption bar)
            align, margin_v = 2, 310

        if style == 'tiktok_yellow':
            primary, back, border_style, outline, shadow = '&H0000E5FF', '&H80000000', 1, 5, 2
        elif style == 'clean_box':
            primary, back, border_style, outline, shadow = '&H00FFFFFF', '&HB0120B24', 3, 12, 0
        else:  # tiktok_white
            primary, back, border_style, outline, shadow = '&H00FFFFFF', '&H80000000', 1, 5, 2

        header = (
            '[Script Info]\n'
            'ScriptType: v4.00+\n'
            'PlayResX: 720\n'
            'PlayResY: 1280\n'
            'WrapStyle: 2\n'
            'ScaledBorderAndShadow: yes\n\n'
            '[V4+ Styles]\n'
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, '
            'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, '
            'Alignment, MarginL, MarginR, MarginV, Encoding\n'
            f'Style: TikTok,DejaVu Sans,52,{primary},&H00FFFFFF,&H00000000,{back},'
            f'-1,0,0,0,100,100,0,0,{border_style},{outline},{shadow},{align},54,110,{margin_v},1\n\n'
            '[Events]\n'
            'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
        )
        lines = [header]
        for c in cues:
            txt = c.text.replace('\\', '').replace('{', '(').replace('}', ')').replace('\n', '\\N').strip()
            if not txt:
                continue
            end_t = max(c.start + 0.15, c.end)
            lines.append(f'Dialogue: 0,{_fmt_ass_time(c.start)},{_fmt_ass_time(end_t)},TikTok,,0,0,0,,{txt}\n')
        return ''.join(lines)

    def _parse_srt_to_cues(srt_text: str) -> list[dict[str, Any]]:
        blocks = re.split(r'\r?\n\r?\n', srt_text.strip())
        result: list[dict[str, Any]] = []
        time_re = re.compile(r'(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)')
        for blk in blocks:
            m = time_re.search(blk)
            if not m:
                continue
            st = int(m.group(1))*3600 + int(m.group(2))*60 + int(m.group(3)) + int(m.group(4).ljust(3, '0')[:3])/1000.0
            en = int(m.group(5))*3600 + int(m.group(6))*60 + int(m.group(7)) + int(m.group(8).ljust(3, '0')[:3])/1000.0
            text_lines = [ln.strip() for ln in blk.splitlines() if ln.strip() and not ln.strip().isdigit() and '-->' not in ln]
            txt = ' '.join(text_lines).strip()
            if txt:
                result.append({'start': round(st, 2), 'end': round(max(st + 0.2, en), 2), 'text': txt[:220]})
        return result[:250]

    @router.post('/video/transcribe')
    async def transcribe_video_audio(req: TranscribeRequest, user: dict = Depends(current_user)):
        api_key = os.getenv('OPENAI_API_KEY', '').strip()
        if not api_key:
            raise HTTPException(
                400,
                'Für automatische Spracherkennung bitte OPENAI_API_KEY in Render → Environment hinterlegen – '
                'oder unten kostenlos Text / SRT einfügen und automatisch takten lassen.',
            )
        source = media_row(req.media_id, user['id'])
        if source['mime'] != 'video/mp4':
            raise HTTPException(400, 'Bitte ein MP4-Video auswählen.')
        src_path = MEDIA / source['filename']
        if not src_path.is_file():
            raise HTTPException(404, 'Videodatei nicht gefunden.')
        try:
            ffmpeg = _find_ffmpeg('Transkription benötigt FFmpeg.')
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from None

        with tempfile.TemporaryDirectory(prefix='sp_v195_asr_') as td:
            mp3_path = Path(td) / 'audio.mp3'
            proc = await asyncio.to_thread(
                _run_ffmpeg,
                [
                    ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                    '-i', str(src_path), '-vn', '-ar', '16000', '-ac', '1', '-b:a', '48k',
                    str(mp3_path),
                ],
                capture_output=True,
                timeout=120,
            )
            if proc.returncode or not mp3_path.exists() or not mp3_path.stat().st_size:
                raise HTTPException(400, 'Tonspur konnte nicht extrahiert werden (hat das Video Ton?).')
            if mp3_path.stat().st_size > 24 * 1024 * 1024:
                raise HTTPException(400, 'Audiospur ist größer als 24 MB (Whisper-Limit).')
            audio_bytes = mp3_path.read_bytes()

        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                'https://api.openai.com/v1/audio/transcriptions',
                headers={'Authorization': f'Bearer {api_key}'},
                data={'model': 'whisper-1', 'response_format': 'srt', 'language': req.language or 'de'},
                files={'file': ('audio.mp3', audio_bytes, 'audio/mpeg')},
            )
        if resp.status_code >= 400:
            raise HTTPException(502, f'Whisper-Transkription fehlgeschlagen (HTTP {resp.status_code}).')
        cues = _parse_srt_to_cues(resp.text)
        if not cues:
            raise HTTPException(400, 'Es wurde keine verständliche Sprache erkannt.')
        return {'cues': cues, 'count': len(cues)}

    def _burn_captions_worker(job_id: str, req: BurnCaptionsRequest, source: dict, ffmpeg: str, owner_id: str) -> None:
        out_id = uuid.uuid4().hex
        out_path = MEDIA / f'{out_id}.mp4'
        try:
            src_path = MEDIA / source['filename']
            _update_job(job_id, progress=15, message='TikTok-Untertitel werden vorbereitet …')
            ass_text = _build_ass_content(req.cues, req.style, req.position)
            with tempfile.TemporaryDirectory(prefix='sp_v195_cap_') as td:
                td_path = Path(td)
                ass_file = td_path / 'captions.ass'
                ass_file.write_text(ass_text, encoding='utf-8')
                _update_job(job_id, progress=35, message='Untertitel werden ins Video eingebrannt …')
                cmd = [
                    ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                    '-filter_threads', '1',
                    '-i', str(src_path.resolve()),
                    '-vf', 'ass=captions.ass',
                    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
                    '-threads', '1', '-pix_fmt', 'yuv420p',
                    '-c:a', 'copy',
                    '-movflags', '+faststart',
                    str(out_path.resolve()),
                ]
                proc = _run_ffmpeg(cmd, capture_output=True, timeout=300, cwd=str(td_path))
                if proc.returncode or not out_path.exists() or not out_path.stat().st_size:
                    stderr = (proc.stderr or b'').decode('utf-8', errors='replace')[-1000:]
                    logger.error('V19.5 burn captions failed: %s', stderr)
                    raise RuntimeError('Untertitel konnten nicht eingebrannt werden.')
                if out_path.stat().st_size > MAX_VIDEO:
                    raise RuntimeError('Erstelltes Video überschreitet 100 MB.')

            base_stem = Path(source['original_name']).stem[:48]
            stamp = datetime.now(APP_TZ).strftime('%Y%m%d-%H%M')
            display_name = f'{base_stem}-Untertitel-{stamp}.mp4'
            with dbconn() as db:
                db.execute(
                    'INSERT INTO media(id,filename,original_name,mime,created_at,owner_id) VALUES(?,?,?,?,?,?)',
                    (out_id, out_path.name, display_name, 'video/mp4', now(), owner_id),
                )
            _update_job(
                job_id,
                status='done',
                progress=100,
                id=out_id,
                name=display_name,
                message=f'Fertig! Video mit TikTok-Untertiteln „{display_name}“ liegt in der Mediathek.',
            )
        except Exception as exc:
            out_path.unlink(missing_ok=True)
            logger.exception('V19.5 burn captions failed')
            msg = str(exc) if isinstance(exc, RuntimeError) else 'Untertitel-Export fehlgeschlagen.'
            if isinstance(exc, subprocess.TimeoutExpired):
                msg = 'Das Einbrennen der Untertitel hat zu lange gedauert.'
            _update_job(job_id, status='error', message=msg)

    @router.post('/video/burn-captions', status_code=202)
    async def burn_captions(req: BurnCaptionsRequest, user: dict = Depends(current_user)):
        source = media_row(req.media_id, user['id'])
        if source['mime'] != 'video/mp4':
            raise HTTPException(400, 'Untertitel können nur in MP4-Videos eingebrannt werden.')
        if not (MEDIA / source['filename']).is_file():
            raise HTTPException(404, 'Videodatei nicht gefunden.')
        try:
            ffmpeg = _find_ffmpeg('Untertitel-Export benötigt FFmpeg.')
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from None
        job_id = _register_bg_job(user['id'], 'Untertitel-Rendering gestartet …')
        task = asyncio.create_task(
            asyncio.to_thread(_burn_captions_worker, job_id, req, source, ffmpeg, user['id'])
        )
        _v183_tasks.add(task)
        task.add_done_callback(_v183_tasks.discard)
        return {'job_id': job_id}

    return router
