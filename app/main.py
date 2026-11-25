"""TimeSave Social by Solvetec – social media scheduler, studio & publisher.

No social-network passwords are collected. Official OAuth redirects are used.
Automated where authorized: Facebook/Instagram photos and stories, Telegram
channel posts, YouTube private videos, TikTok Direct Post photo/video (not Stories).
TikTok jobs remain awaiting_confirmation until TikTok confirms PUBLISH_COMPLETE.
"""
import asyncio
import hashlib
import logging
import hmac
import json
import zipfile
import threading
import time
from io import BytesIO
import shutil
import tempfile
import os
import secrets
import subprocess
import sqlite3
import uuid
from contextlib import asynccontextmanager, contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import re
from urllib.parse import urlencode, urlsplit
from zoneinfo import ZoneInfo

import httpx
from cryptography.fernet import Fernet
from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File, Form, Header, Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from PIL import Image, ImageOps, ImageDraw, ImageFont, ImageFilter, ImageEnhance
from pydantic import BaseModel, Field

from app.db import (
    DB_BACKEND,
    open_db as _open_db,
    add_column as _db_add_column,
    table_columns as _db_table_columns,
)

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / '.env')
# Do not log OAuth exchange URLs: some Meta endpoints carry app secrets in parameters.
logging.getLogger('httpx').setLevel(logging.WARNING)
logger = logging.getLogger('timesave')

def _ts_env(name: str, default: str = '') -> str:
    val = os.getenv(f'TIMESAVE_{name}')
    if val is not None and val != '':
        return val
    legacy = os.getenv(f'STORYPILOT_{name}')
    if legacy is not None and legacy != '':
        return legacy
    return default

DATA = Path(_ts_env('DATA_DIR') or str(ROOT / 'data')).resolve()
DATA.mkdir(parents=True, exist_ok=True)
MEDIA = DATA / 'media'
MEDIA.mkdir(parents=True, exist_ok=True)
TMP_DIR = DATA / '.tmp'
TMP_DIR.mkdir(parents=True, exist_ok=True)
DB = DATA / 'timesave.db'
APP_TZ = ZoneInfo(os.getenv('APP_TIMEZONE', 'Europe/Berlin'))
ADMIN_TOKEN = os.getenv('ADMIN_TOKEN', '')
CLOUD_MODE = _ts_env('CLOUD_MODE').lower() in ('1', 'true', 'yes')
# Free Render is a NON-PERSISTENT testing tier. It does not prohibit
# scheduling or sending. Allow testing the real planner/scheduler while the
# server is awake; make the limits clear in the UI. Never import a production
# migration archive into an ephemeral instance.
FREE_PREVIEW = _ts_env('FREE_PREVIEW').lower() in ('1', 'true', 'yes')
MIGRATION_ACTIVE = False
MIGRATION_LOCK = threading.RLock()
GRAPH = 'https://graph.facebook.com/v26.0'
IG_GRAPH = 'https://graph.instagram.com/v26.0'
IG_OAUTH = 'https://api.instagram.com/oauth/access_token'
MAX_IMAGE = 15 * 1024 * 1024
MAX_VIDEO = 100 * 1024 * 1024
# V17.6: uploads are streamed to a private temporary file; only the optimized MP4 is kept.
MAX_VIDEO_IMPORT = 1024 * 1024 * 1024  # 1 GiB incoming safety cap
VIDEO_TARGET_BYTES = 90 * 1024 * 1024  # buffer for 100 MiB publisher limit
KEY_FILE = DATA / '.secret.key'
ENV_ENC_KEY = _ts_env('ENCRYPTION_KEY').strip()
if CLOUD_MODE and (len(ADMIN_TOKEN) < 32 or ADMIN_TOKEN == 'change-this-to-a-long-random-secret'):
    raise RuntimeError('Cloud-Sicherheitsstopp: ADMIN_TOKEN muss mindestens 32 Zeichen haben.')
if ENV_ENC_KEY:
    try:
        KEY_BYTES = ENV_ENC_KEY.encode('ascii')
        CIPHER = Fernet(KEY_BYTES)
    except Exception as exc:
        raise RuntimeError('TIMESAVE_ENCRYPTION_KEY ist kein gültiger Fernet-Schlüssel.') from exc
else:
    if DB_BACKEND == 'sqlite' and DB.exists() and not KEY_FILE.exists():
        raise RuntimeError('Sicherheitsstopp: Datenbank vorhanden, aber .secret.key fehlt. Alte Datei wiederherstellen!')
    if not KEY_FILE.exists():
        KEY_FILE.write_bytes(Fernet.generate_key())
        try:
            os.chmod(KEY_FILE, 0o600)
        except OSError:
            pass
    KEY_BYTES = KEY_FILE.read_bytes()
    CIPHER = Fernet(KEY_BYTES)
_FFMPEG_SEM = threading.Semaphore(1 if CLOUD_MODE else 2)
_PROCESS_DUE_LOCK = asyncio.Lock()
_PUBLISH_WAKE = asyncio.Event()
_PUBLISH_PROGRESS = {}
_PUBLISH_PROGRESS_LOCK = threading.Lock()


def _parse_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
        return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def _find_ffmpeg(required_msg: str = 'Video-Optimierung benötigt FFmpeg.') -> str:
    exe = shutil.which('ffmpeg')
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, OSError, RuntimeError) as exc:
        raise RuntimeError(required_msg) from exc


def _ffmpeg_thread_args() -> list[str]:
    threads = _ts_env('FFMPEG_THREADS', '2' if CLOUD_MODE else '').strip()
    return ['-threads', threads] if threads.isdigit() and int(threads) > 0 else []


def _run_ffmpeg(cmd: list[str], *, timeout: int, **kwargs):
    # Cap concurrent FFmpeg invocations to avoid RAM exhaustion (especially on Render Free).
    with _FFMPEG_SEM:
        return subprocess.run(cmd, timeout=timeout, **kwargs)


def _iter_file_slice(path: Path, offset: int, length: int, chunk_size: int = 256 * 1024):
    with path.open('rb') as handle:
        if offset:
            handle.seek(offset)
        remaining = length
        while remaining > 0:
            data = handle.read(min(chunk_size, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


def _stream_binary_request(method: str, url: str, headers: dict, path: Path,
                           offset: int = 0, length: int | None = None,
                           timeout: float = 300.0):
    """Stream binary uploads from disk with explicit Content-Length and minimal RAM."""
    total_size = path.stat().st_size
    send_len = (total_size - offset) if length is None else length
    req_headers = {**headers, 'Content-Length': str(send_len)}
    with httpx.Client(timeout=httpx.Timeout(timeout, connect=30), follow_redirects=False) as client:
        if offset == 0 and send_len == total_size:
            with path.open('rb') as stream:
                return client.request(method, url, headers=req_headers, content=stream)
        return client.request(method, url, headers=req_headers,
                              content=_iter_file_slice(path, offset, send_len))


def _atomic_save_jpeg(image: Image.Image, dest: Path, **save_kwargs) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix='.img_', suffix='.jpg', dir=dest.parent, delete=False) as fh:
        tmp = Path(fh.name)
    try:
        image.save(tmp, format='JPEG', **save_kwargs)
        os.replace(tmp, dest)
    finally:
        tmp.unlink(missing_ok=True)


def _cleanup_stale_files() -> None:
    # Remove orphaned temporary exports and old Telegram transcode caches (>14 days).
    cutoff = datetime.now(timezone.utc).timestamp() - 14 * 86400
    if TMP_DIR.is_dir():
        for item in TMP_DIR.iterdir():
            try:
                if item.is_file():
                    item.unlink(missing_ok=True)
                elif item.is_dir():
                    shutil.rmtree(item, ignore_errors=True)
            except OSError:
                pass
    tg_cache = DATA / 'telegram-ready'
    if tg_cache.is_dir():
        for item in tg_cache.iterdir():
            try:
                if item.is_file() and item.stat().st_mtime < cutoff:
                    item.unlink(missing_ok=True)
            except OSError:
                pass
PROVIDERS = ['facebook','instagram','threads','linkedin','telegram','telegram_story','youtube','tiktok','whatsapp','whatsapp_channel']
FORMATS = ['story','post','reel','video']
SECRET_FIELDS = {'meta_app_secret','instagram_app_secret','threads_app_secret','linkedin_client_secret','google_client_secret','tiktok_client_secret'}
SETTINGS_ALLOWED = SECRET_FIELDS | {'meta_app_id','instagram_app_id','instagram_redirect_uri','threads_app_id','threads_redirect_uri','linkedin_client_id','linkedin_redirect_uri','google_client_id','tiktok_client_key','public_base_url','gcs_bucket_name','tiktok_redirect_uri','tiktok_verified_media_prefix','tiktok_verify_filename','tiktok_verify_content','instagram_unified_config_id'}


def now():
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def dbconn():
    with _open_db(DB) as conn:
        yield conn


def add_column(db, table, name, sql_type):
    _db_add_column(db, table, name, sql_type)


def init_db():
    with dbconn() as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA wal_autocheckpoint=1000')
        db.executescript('''
        CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, filename TEXT NOT NULL, original_name TEXT NOT NULL,
             mime TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, platform TEXT NOT NULL,
             due_at TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL,
             published_at TEXT, caption TEXT DEFAULT '');
        CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status,due_at);
        CREATE INDEX IF NOT EXISTS idx_storykit_due ON jobs(due_at);
        CREATE TABLE IF NOT EXISTS designs (id TEXT PRIMARY KEY,source_media_id TEXT NOT NULL,
             output_media_id TEXT NOT NULL,text TEXT NOT NULL,caption TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY,provider TEXT NOT NULL,label TEXT NOT NULL,
             external_id TEXT NOT NULL, access_enc TEXT NOT NULL, refresh_enc TEXT DEFAULT '', expires_at TEXT,
             metadata TEXT DEFAULT '{}', status TEXT NOT NULL, checked_at TEXT NOT NULL,
             owner_id TEXT NOT NULL DEFAULT 'owner',
             UNIQUE(owner_id,provider,external_id));
        CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY,provider TEXT NOT NULL,
             expires_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS storykit_done (item_key TEXT NOT NULL, channel TEXT NOT NULL, done_at TEXT NOT NULL,
             owner_id TEXT NOT NULL DEFAULT 'owner',
             PRIMARY KEY(owner_id,item_key,channel));
        CREATE TABLE IF NOT EXISTS meta_sessions (user_id TEXT NOT NULL, token_enc TEXT NOT NULL,
             expires_at TEXT, refreshed_at TEXT NOT NULL, status TEXT NOT NULL,
             last_error TEXT DEFAULT '', owner_id TEXT NOT NULL DEFAULT 'owner',
             PRIMARY KEY(owner_id, user_id));
        CREATE TABLE IF NOT EXISTS cloud_media (media_id TEXT PRIMARY KEY, remote_path TEXT,
             synced_at TEXT, failed_at TEXT, last_error TEXT DEFAULT '');
        CREATE TABLE IF NOT EXISTS cloud_control (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        ''')
        add_column(db,'jobs','caption',"TEXT DEFAULT ''")
        add_column(db,'jobs','format',"TEXT DEFAULT 'story'")
        add_column(db,'jobs','connection_id','TEXT DEFAULT NULL')
        add_column(db,'jobs','series_id','TEXT DEFAULT NULL')
        add_column(db,'jobs','position','INTEGER DEFAULT 1')
        add_column(db,'jobs','tiktok_privacy',"TEXT DEFAULT 'SELF_ONLY'")
        add_column(db,'jobs','tiktok_post_mode',"TEXT NOT NULL DEFAULT 'direct'")
        add_column(db,'jobs','youtube_privacy',"TEXT NOT NULL DEFAULT 'private'")
        add_column(db,'jobs','tiktok_approved','INTEGER DEFAULT 0')
        add_column(db,'jobs','tiktok_aigc','INTEGER DEFAULT 0')
        # V17.3: photo carousel metadata; existing V17.2 jobs retain defaults.
        add_column(db,'jobs','tiktok_photo_ids',"TEXT NOT NULL DEFAULT '[]'")
        add_column(db,'jobs','tiktok_photo_cover','INTEGER NOT NULL DEFAULT 0')
        add_column(db,'jobs','tiktok_photo_title',"TEXT NOT NULL DEFAULT ''")
        add_column(db,'jobs','tiktok_auto_music','INTEGER NOT NULL DEFAULT 0')
        add_column(db,'jobs','tiktok_brand_organic','INTEGER NOT NULL DEFAULT 0')
        add_column(db,'jobs','tiktok_brand_content','INTEGER NOT NULL DEFAULT 0')
        add_column(db,'jobs','tiktok_disable_comment','INTEGER NOT NULL DEFAULT 0')
        add_column(db,'jobs','tiktok_disable_duet','INTEGER NOT NULL DEFAULT 1')
        add_column(db,'jobs','tiktok_disable_stitch','INTEGER NOT NULL DEFAULT 1')
        add_column(db,'jobs','publish_id',"TEXT DEFAULT ''")
        add_column(db,'jobs','last_poll_at',"TEXT DEFAULT ''")
        # V17.11: a retry cursor separate from the original publication date.
        add_column(db,'jobs','retry_at', 'TEXT DEFAULT NULL')
        add_column(db,'jobs','retry_attempts', 'INTEGER NOT NULL DEFAULT 0')
        add_column(db,'oauth_states','pkce_verifier',"TEXT DEFAULT ''")
        add_column(db,'oauth_states','redirect_uri',"TEXT DEFAULT ''")
        db.execute('CREATE INDEX IF NOT EXISTS idx_jobs_sequence ON jobs(series_id,platform,connection_id,position,due_at)')
        # V17.19: Meta can confirm a valid token without a fixed expiration.
        if DB_BACKEND == 'sqlite':
            expiry_info = next((c for c in db.execute('PRAGMA table_info(meta_sessions)')
                               if c['name'] == 'expires_at'), None)
            if expiry_info is not None and expiry_info['notnull']:
                db.execute('''CREATE TABLE meta_sessions_v1719 (
                    user_id TEXT PRIMARY KEY, token_enc TEXT NOT NULL,
                    expires_at TEXT, refreshed_at TEXT NOT NULL, status TEXT NOT NULL,
                    last_error TEXT DEFAULT '')''')
                db.execute('''INSERT INTO meta_sessions_v1719
                    (user_id,token_enc,expires_at,refreshed_at,status,last_error)
                    SELECT user_id,token_enc,expires_at,refreshed_at,status,last_error
                    FROM meta_sessions''')
                db.execute('DROP TABLE meta_sessions')
                db.execute('ALTER TABLE meta_sessions_v1719 RENAME TO meta_sessions')
        # Do not automatically re-add Meta pages the user individually disconnected.
        db.execute("""CREATE TABLE IF NOT EXISTS meta_detached (
            provider TEXT NOT NULL, external_id TEXT NOT NULL,
            owner_id TEXT NOT NULL DEFAULT 'owner',
            PRIMARY KEY(owner_id,provider,external_id))""")
        # V17.23: Drafts and their referenced media.
        db.execute('''CREATE TABLE IF NOT EXISTS drafts (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, payload TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL)''')
        db.execute('''CREATE TABLE IF NOT EXISTS draft_media (
            draft_id TEXT NOT NULL, media_id TEXT NOT NULL,
            PRIMARY KEY(draft_id, media_id))''')
        db.execute('CREATE INDEX IF NOT EXISTS idx_draft_media_media ON draft_media(media_id)')
        # V18.0: Multi-user workspaces, sessions, invites and per-user preferences.
        db.executescript('''
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            last_login_at TEXT
        );
        CREATE TABLE IF NOT EXISTS user_sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
        CREATE TABLE IF NOT EXISTS invites (
            code TEXT PRIMARY KEY,
            role TEXT NOT NULL DEFAULT 'user',
            note TEXT DEFAULT '',
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            used_by TEXT,
            used_at TEXT
        );
        CREATE TABLE IF NOT EXISTS user_prefs (
            owner_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY(owner_id, key)
        );
        ''')
        for tbl in ('media', 'jobs', 'designs', 'connections', 'oauth_states',
                    'storykit_done', 'meta_sessions', 'meta_detached', 'drafts'):
            add_column(db, tbl, 'owner_id', "TEXT NOT NULL DEFAULT 'owner'")
        db.execute('CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_id, created_at)')
        db.execute('CREATE INDEX IF NOT EXISTS idx_jobs_owner_due ON jobs(owner_id, due_at)')
        db.execute('CREATE INDEX IF NOT EXISTS idx_connections_owner ON connections(owner_id, provider)')
        db.execute('CREATE INDEX IF NOT EXISTS idx_drafts_owner ON drafts(owner_id, updated_at)')
        # Optional bootstrap of admin email/password from environment for fresh cloud setups.
        boot_email = _ts_env('ADMIN_EMAIL').strip().lower()
        boot_pw = _ts_env('ADMIN_PASSWORD').strip()
        if boot_email and len(boot_pw) >= 8:
            existing_owner = db.execute("SELECT id FROM users WHERE id='owner' OR email=?", (boot_email,)).fetchone()
            if not existing_owner:
                db.execute(
                    'INSERT INTO users(id,email,display_name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?)',
                    ('owner', boot_email, _ts_env('BRAND_NAME', 'Solvetec Admin').strip() or 'Solvetec Admin',
                     _hash_password(boot_pw), 'admin', 1, now()),
                )


def encrypt(value):
    return CIPHER.encrypt(value.encode()).decode() if value else ''


def decrypt(value):
    return CIPHER.decrypt(value.encode()).decode() if value else ''


def setting(key):
    """Render ENV is authoritative in cloud mode; local encrypted values are fallbacks.

    Previously a blank/stale SQLite setting could silently hide a correct Render ENV
    value. It also made the GUI look like Render had not saved the credentials.
    """
    env_value = os.getenv(key.upper(), '').strip()
    if CLOUD_MODE and env_value:
        return env_value
    with dbconn() as db:
        r = db.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
    if r:
        stored = decrypt(r['value']).strip()
        if stored:
            return stored
    return env_value


def setting_source(key):
    """Expose only WHERE a value comes from, never a secret value."""
    env_value = os.getenv(key.upper(), '').strip()
    if CLOUD_MODE and env_value:
        return 'render_env'
    with dbconn() as db:
        r = db.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
    if r and decrypt(r['value']).strip():
        return 'local_database'
    return 'environment' if env_value else 'missing'


def save_setting(key, value):
    with dbconn() as db:
        db.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                   (key,encrypt(value.strip())))


def _hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode('utf-8'), salt=salt, n=16384, r=8, p=1, dklen=32)
    return 'scrypt$' + salt.hex() + '$' + dk.hex()


def _verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_hex, hash_hex = stored.split('$', 2)
        if scheme != 'scrypt':
            return False
        dk = hashlib.scrypt(password.encode('utf-8'), salt=bytes.fromhex(salt_hex), n=16384, r=8, p=1, dklen=32)
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


def _extract_auth_token(x_admin_token: str | None, authorization: str | None) -> str:
    if authorization and authorization.lower().startswith('bearer '):
        return authorization[7:].strip()
    return (x_admin_token or '').strip()


def _create_user_session(db, user_id: str, days: int = 14) -> str:
    raw = 'sp_' + secrets.token_urlsafe(36)
    token_hash = hashlib.sha256(raw.encode('utf-8')).hexdigest()
    expires = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()
    db.execute(
        'INSERT INTO user_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)',
        (token_hash, user_id, expires, now()),
    )
    return raw


def _admin_session_owner():
    return 'admin-key:' + hmac.new(ADMIN_TOKEN.encode(), b'timesave-remember-v1', hashlib.sha256).hexdigest()


def current_user(
    x_admin_token: str | None = Header(None),
    authorization: str | None = Header(None),
) -> dict:
    token = _extract_auth_token(x_admin_token, authorization)
    if not token:
        raise HTTPException(401, 'Bitte zuerst anmelden.')
    if ADMIN_TOKEN and ADMIN_TOKEN != 'change-this-to-a-long-random-secret' and secrets.compare_digest(token, ADMIN_TOKEN):
        return {
            'id': 'owner',
            'email': 'admin@local',
            'display_name': 'Administrator',
            'role': 'admin',
            'auth_type': 'admin_token',
            'token_hash': '',
        }
    token_hash = hashlib.sha256(token.encode('utf-8')).hexdigest()
    with dbconn() as db:
        if ADMIN_TOKEN:
            admin_session = db.execute('SELECT expires_at FROM user_sessions WHERE token_hash=? AND user_id=?', (token_hash, _admin_session_owner())).fetchone()
            if admin_session and (_parse_utc(admin_session['expires_at']) or datetime.min.replace(tzinfo=timezone.utc)) > datetime.now(timezone.utc):
                return {'id':'owner','email':'admin@local','display_name':'Administrator','role':'admin','auth_type':'admin_token','token_hash':token_hash}
        row = db.execute(
            '''SELECT u.id,u.email,u.display_name,u.role,u.active,s.expires_at
               FROM user_sessions s JOIN users u ON u.id=s.user_id
               WHERE s.token_hash=?''',
            (token_hash,),
        ).fetchone()
    if not row or not row['active']:
        raise HTTPException(401, 'Anmeldedaten ungültig oder Sitzung abgelaufen.')
    exp = _parse_utc(row['expires_at'])
    if exp is None or exp <= datetime.now(timezone.utc):
        with dbconn() as db:
            db.execute('DELETE FROM user_sessions WHERE token_hash=?', (token_hash,))
        raise HTTPException(401, 'Sitzung abgelaufen. Bitte erneut anmelden.')
    return {
        'id': row['id'],
        'email': row['email'],
        'display_name': row['display_name'],
        'role': row['role'],
        'auth_type': 'session',
        'token_hash': token_hash,
    }


def require_admin(user: dict = Depends(current_user)) -> dict:
    if user.get('role') != 'admin':
        raise HTTPException(403, 'Dieser Bereich ist nur für Administratoren verfügbar.')
    return user


# Backwards-compatible alias for any external reference
guard = current_user


def get_user_pref(owner_id: str, key: str) -> str:
    with dbconn() as db:
        r = db.execute('SELECT value FROM user_prefs WHERE owner_id=? AND key=?', (owner_id, key)).fetchone()
    if r:
        return decrypt(r['value']).strip()
    if owner_id == 'owner':
        return setting(key)
    return ''


def save_user_pref(owner_id: str, key: str, value: str) -> None:
    enc = encrypt(value.strip())
    with dbconn() as db:
        exists = db.execute('SELECT 1 FROM user_prefs WHERE owner_id=? AND key=?', (owner_id, key)).fetchone()
        if exists:
            db.execute('UPDATE user_prefs SET value=? WHERE owner_id=? AND key=?', (enc, owner_id, key))
        else:
            db.execute('INSERT INTO user_prefs(owner_id,key,value) VALUES(?,?,?)', (owner_id, key, enc))


def parse_local(value):
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=APP_TZ)
        return dt.astimezone(timezone.utc)
    except (ValueError, TypeError):
        raise HTTPException(400,'Datum ungültig.')


def public_base():
    if CLOUD_MODE:
        return (_ts_env('PUBLIC_URL') or os.getenv('RENDER_EXTERNAL_URL') or setting('public_base_url') or '').rstrip('/')
    return setting('public_base_url').rstrip('/')


def callback_url(provider):
    if provider == 'tiktok':
        # Desktop registration explicitly permits localhost; web hosting requires HTTPS.
        saved=setting('tiktok_redirect_uri')
        if CLOUD_MODE and (not saved or urlsplit(saved).hostname in ('localhost','127.0.0.1')):
            return public_base() + '/oauth/tiktok/callback'
        return saved or 'http://localhost:8000/oauth/tiktok/callback'
    if provider == 'instagram':
        return (setting('instagram_redirect_uri') or
                ((public_base() + '/oauth/instagram/callback') if public_base() else ''))
    if provider == 'instagram_unified':
        return ((public_base() + '/oauth/instagram_unified/callback') if public_base() else '')
    if provider == 'threads':
        saved = setting('threads_redirect_uri')
        if CLOUD_MODE and saved and urlsplit(saved).hostname in ('localhost', '127.0.0.1'):
            saved = ''
        return saved or ((public_base() or 'http://localhost:8000') + '/oauth/threads/callback')
    if provider == 'linkedin':
        saved = setting('linkedin_redirect_uri')
        if CLOUD_MODE and saved and urlsplit(saved).hostname in ('localhost', '127.0.0.1'):
            saved = ''
        return saved or ((public_base() or 'http://localhost:8000') + '/oauth/linkedin/callback')
    return (public_base() or 'http://localhost:8000') + '/oauth/' + provider + '/callback'


def tiktok_desktop_login():
    uri=urlsplit(callback_url('tiktok'))
    if uri.path!='/oauth/tiktok/callback' or uri.query or uri.fragment:
        raise RuntimeError('TikTok-Callback muss auf /oauth/tiktok/callback enden (ohne Parameter).')
    if uri.hostname in ('localhost','127.0.0.1') and uri.scheme in ('http','https') and uri.port == 8000:
        return True
    if uri.scheme=='https' and uri.hostname not in ('localhost','127.0.0.1'):
        return False
    raise RuntimeError('TikTok braucht Desktop-Callback http://localhost:8000/oauth/tiktok/callback oder registrierte Web-HTTPS-URL.')


def tiktok_response(response):
    # TikTok puts {error:{code:'ok'}} in successful 200 responses.
    try:
        body=response.json()
    except ValueError:
        raise RuntimeError('TikTok: API-Antwort ist kein JSON.') from None
    err=body.get('error') or {} if isinstance(body,dict) else {}
    if not isinstance(err,dict):
        err={'code':str(err)}
    code=err.get('code','ok')
    if response.status_code>=400 or code not in ('ok', '', None):
        if str(code) == 'app_version_check_failed':
            raise RuntimeError('MANUAL: TikTok meldet eine veraltete App-Version oder blockiert den Foto-Direct-Post vor dem App-Audit (app_version_check_failed). Bitte TikTok-App auf dem Smartphone aktualisieren oder ein MP4-Video bzw. den Entwurf-Modus (TikTok-Inbox) verwenden.')
        label=err.get('message') or code or 'Anfrage abgelehnt'
        raise RuntimeError(f'TikTok API HTTP {response.status_code}: {str(label)[:240]} ({str(code)[:80]})')
    return body



def upsert_account(provider, label, external_id, access, refresh='', expires_at=None, metadata=None, owner_id='owner'):
    metadata = metadata or {}
    with dbconn() as db:
        existing = db.execute(
            'SELECT id,refresh_enc FROM connections WHERE owner_id=? AND provider=? AND external_id=?',
            (owner_id, provider, str(external_id)),
        ).fetchone()
        ident = existing['id'] if existing else uuid.uuid4().hex
        refresh_enc = existing['refresh_enc'] if (not refresh and existing) else encrypt(refresh)
        if existing:
            db.execute(
                '''UPDATE connections SET label=?,access_enc=?,refresh_enc=?,expires_at=?,metadata=?,status=?,checked_at=?
                   WHERE id=?''',
                (label, encrypt(access), refresh_enc, expires_at, json.dumps(metadata), 'connected', now(), ident),
            )
        else:
            db.execute(
                '''INSERT INTO connections(id,provider,label,external_id,access_enc,refresh_enc,expires_at,metadata,status,checked_at,owner_id)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
                (ident, provider, label, str(external_id), encrypt(access), refresh_enc, expires_at,
                 json.dumps(metadata), 'connected', now(), owner_id),
            )
    return ident


def instagram_unified_account(acc):
    """An Instagram asset authorized with Meta Unified Login (Graph Facebook host)."""
    try:
        return (acc.get('provider') == 'instagram' and
                json.loads(acc.get('metadata') or '{}').get('login_method') == 'unified')
    except (ValueError, TypeError, AttributeError):
        return False


def instagram_direct_account(acc):
    """Do not confuse Instagram-only tokens with Facebook Page access tokens."""
    try:
        return (acc.get('provider') == 'instagram' and
                json.loads(acc.get('metadata') or '{}').get('login_method') == 'instagram')
    except (ValueError, TypeError, AttributeError):
        return False


def get_account(ident, owner_id=None):
    with dbconn() as db:
        if owner_id is not None:
            r = db.execute('SELECT * FROM connections WHERE id=? AND owner_id=?', (ident, owner_id)).fetchone()
        else:
            r = db.execute('SELECT * FROM connections WHERE id=?', (ident,)).fetchone()
    if not r:
        raise RuntimeError('Konto nicht mehr verbunden')
    return dict(r)


def redact_error(r):
    # Provider error messages only; never persist raw Authorization headers or HTTP URL with tokens.
    try:
        obj = r.json()
        error = obj.get('error') or {}
        if isinstance(error, dict):
            msg = error.get('message') or error.get('description') or 'API-Antwort nicht erfolgreich'
        else:
            msg = str(error)
    except ValueError:
        msg = 'API-Antwort nicht lesbar'
    return f'API HTTP {r.status_code}: {msg[:450]}'


def require_ok(r):
    if r.status_code >= 400:
        raise RuntimeError(redact_error(r))
    try:
        obj = r.json()
    except ValueError:
        raise RuntimeError('Ungültige JSON-Antwort der Plattform')
    if isinstance(obj, dict) and obj.get('error'):
        raise RuntimeError(redact_error(r))
    return obj


# Google Cloud Storage stays PRIVATE. We sign individual URLs only when needed.
# No service-account JSON key is required. Windows ADC uses gcloud's impersonated account.
def gcs_bucket_name():
    return setting('gcs_bucket_name').strip()


def media_cloud_enabled():
    """Legacy optional Google Storage (kept for existing Instagram media URLs)."""
    return bool(gcs_bucket_name())


def gcs_client():
    try:
        from google.cloud import storage
    except ImportError as exc:
        raise RuntimeError('Google Cloud Storage Python-Paket fehlt: python -m pip install google-cloud-storage') from exc
    return storage.Client()  # Application Default Credentials / service-account impersonation


# V17.20: Image conversion for Instagram happens in TimeSave Social itself.
# Originals stay unchanged, so Facebook, Telegram, the media library and the
# Kreativstudio continue using the same source. The approved JPEG derivatives
# can be served directly over a signed HTTPS URL; Google Cloud is OPTIONAL.
def instagram_ready_jpeg(media: dict, instagram_format: str) -> Path:
    """Return cached Instagram JPEG; story=9:16, post=Instagram-safe ratio.

    Keeps ALL visible source content, including captions/logos near the edge.
    PNG alpha is flattened against white, EXIF orientation applied, and
    metadata removed by writing a new JPEG. Never replace the original file.
    """
    if instagram_format not in ('story','post'):
        raise ValueError('Instagram-JPG ist nur für Story oder Beitrag verfügbar.')
    if media['mime'] not in ('image/jpeg', 'image/png'):
        raise ValueError('Nur JPG- und PNG-Bilder lassen sich konvertieren.')
    dest = MEDIA / (media['id'] + '.instagram-' + instagram_format + '.jpg')
    if dest.is_file() and dest.stat().st_size > 0:
        return dest
    source = MEDIA / media['filename']
    if not source.is_file():
        raise RuntimeError('Instagram: Das Originalbild fehlt. Bitte Bild erneut hochladen.')
    try:
        with Image.open(source) as opened:
            if opened.format not in ('PNG','JPEG') or opened.width * opened.height > 50_000_000:
                raise ValueError('Nicht unterstütztes Bild oder Auflösung zu groß')
            # Resize the opened image first to limit RAM before EXIF-transpose
            # creates another copy (especially important on Render Free).
            opened.thumbnail((2160,3840), Image.Resampling.LANCZOS)
            photo = ImageOps.exif_transpose(opened)
            photo.thumbnail((2160,3840), Image.Resampling.LANCZOS)
            if photo.mode in ('RGBA','LA') or (photo.mode=='P' and 'transparency' in photo.info):
                rgba = photo.convert('RGBA')
                white = Image.new('RGB', rgba.size, (255,255,255))
                white.paste(rgba, mask=rgba.getchannel('A'))
                photo = white
            else:
                photo = photo.convert('RGB')
            aspect = photo.width / photo.height
            if instagram_format == 'story':
                size = (1080,1920)
                # Fill the extra space from a blurred copy instead of cropping
                # a square poster with important wording along its edges.
                backdrop = ImageOps.fit(photo,size,method=Image.Resampling.LANCZOS)
                backdrop = backdrop.filter(ImageFilter.GaussianBlur(38))
                canvas = ImageEnhance.Brightness(backdrop).enhance(0.72)
                full = ImageOps.contain(photo,size,method=Image.Resampling.LANCZOS)
                canvas.paste(full,((size[0]-full.width)//2,(size[1]-full.height)//2))
            elif 0.8 <= aspect <= 1.91:
                new_width = 1080
                canvas = photo.resize((new_width,round(new_width/aspect)),Image.Resampling.LANCZOS)
            else:
                size=(1080,1350) if aspect<0.8 else (1080,1080)
                backdrop=ImageOps.fit(photo,size,method=Image.Resampling.LANCZOS)
                canvas=ImageEnhance.Brightness(backdrop.filter(ImageFilter.GaussianBlur(30))).enhance(0.72)
                full=ImageOps.contain(photo,size,method=Image.Resampling.LANCZOS)
                canvas.paste(full,((size[0]-full.width)//2,(size[1]-full.height)//2))
        # Atomic save, so a failed encode never becomes a broken public JPEG.
        with tempfile.NamedTemporaryFile(prefix='.ig_jpg_',suffix='.jpg',dir=MEDIA,delete=False) as f:
            tmp=Path(f.name)
        try:
            for quality in (89,83,76):
                canvas.save(tmp,format='JPEG',quality=quality,optimize=True,subsampling=0)
                if tmp.stat().st_size <= MAX_IMAGE:
                    break
            if tmp.stat().st_size>MAX_IMAGE:
                raise ValueError('JPEG ist größer als 15 MB')
            os.replace(tmp,dest)
        finally:
            tmp.unlink(missing_ok=True)
        return dest
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        raise RuntimeError('Instagram: Bild konnte nicht automatisch als JPG vorbereitet werden. '
                           'Bitte Bilddatei prüfen.') from exc


def gcs_blob_for(client, media, instagram_format=None):
    suffix = ('-' + instagram_format) if instagram_format else ''
    name = 'timesave/instagram/' + media['id'] + suffix + '.jpg'
    return client.bucket(gcs_bucket_name()).blob(name)


def gcs_upload_media(media, instagram_format=None):
    if not gcs_bucket_name():
        raise RuntimeError('Bitte zuerst unter Einstellungen den Google-Cloud-Bucket-Namen eintragen.')
    if media['mime'] not in ('image/jpeg', 'image/png'):
        raise RuntimeError('Nur Bilder werden in den Instagram-Bildspeicher kopiert.')
    client = gcs_client()
    blob = gcs_blob_for(client, media, instagram_format=instagram_format)
    # Each story/post gets its own JPEG object, never reuse an old PNG blob.
    if not blob.exists(client=client):
        if instagram_format in ('story','post'):
            path = instagram_ready_jpeg(media, instagram_format)
            blob.upload_from_filename(str(path), content_type='image/jpeg', if_generation_match=0)
        else:
            # Backwards compatible legacy image-sync route.
            path = MEDIA / media['filename']
            if media['mime'] == 'image/png':
                with Image.open(path) as picture:
                    image = ImageOps.exif_transpose(picture).convert('RGB')
                    buffer = BytesIO()
                    image.save(buffer,format='JPEG',quality=90,optimize=True)
                blob.upload_from_string(buffer.getvalue(),content_type='image/jpeg',if_generation_match=0)
            else:
                blob.upload_from_filename(str(path),content_type='image/jpeg',if_generation_match=0)
    return blob


def gcs_signed_media_url(media, minutes=360, instagram_format=None):
    blob = gcs_upload_media(media, instagram_format=instagram_format)
    try:
        url = blob.generate_signed_url(version='v4', expiration=timedelta(minutes=minutes), method='GET')
    except Exception as exc:
        raise RuntimeError('Google Cloud kann keinen signierten HTTPS-Link erstellen. Prüfe Dienstkonto-Impersonation, Token-Creator-Rolle und Service Account Credentials API. ('+type(exc).__name__+')') from exc
    if not url.startswith('https://'):
        raise RuntimeError('Google Cloud hat keine gültige HTTPS-URL erzeugt.')
    return url



def gcs_signed_video_url(media, minutes=360):
    """Upload MP4 to the already configured GCS bucket, sign for Meta fetch.

    Stored under a new video prefix; original image conversion path is unaffected.
    """
    if media['mime'] != 'video/mp4':
        raise RuntimeError('Für die Instagram-Videoveröffentlichung ist MP4 erforderlich.')
    if not gcs_bucket_name():
        raise RuntimeError('Google Cloud Storage ist für Instagram-Videos nicht eingerichtet.')
    client = gcs_client()
    blob = client.bucket(gcs_bucket_name()).blob('timesave/instagram-videos/' + media['id'] + '.mp4')
    if not blob.exists(client=client):
        blob.upload_from_filename(str(MEDIA / media['filename']), content_type='video/mp4', if_generation_match=0)
    try:
        url = blob.generate_signed_url(version='v4', expiration=timedelta(minutes=minutes), method='GET')
    except Exception as exc:
        raise RuntimeError('Google Cloud kann keinen signierten Video-Link erzeugen (' + type(exc).__name__ + ').') from exc
    if not url.startswith('https://'):
        raise RuntimeError('Google Cloud hat keinen HTTPS-Link für das Video erzeugt.')
    return url


def gcs_diagnostic():
    name = gcs_bucket_name()
    if not name:
        return {'ok':False,'message':'Bitte zunächst den Bucket-Namen speichern.'}
    try:
        client = gcs_client()
        # list() forces a real network request, thus tests the permissions too.
        count = len(list(client.list_blobs(name, max_results=1)))
        signed = client.bucket(name).blob('timesave/probe.jpg').generate_signed_url(
            version='v4', expiration=timedelta(minutes=5), method='GET')
        if not signed.startswith('https://'):
            raise RuntimeError('Signierter Link ist ungültig.')
        return {'ok':True,'message':'Bucket erreichbar, Dateien lesbar und HTTPS-Signatur technisch möglich. Der tatsächliche Abruf eines Bildes wird im nächsten Schritt geprüft.', 'sample_found':bool(count)}
    except Exception as exc:
        # Never print ADC or signed URLs. The cloud check displays only a safe error class.
        msg = str(exc).lower()
        if 'storage.objects.list' in msg or '403' in msg or 'forbidden' in msg:
            detail = '403: Dem aktiven Dienstkonto fehlt eine Bucket-Berechtigung oder sie ist noch nicht wirksam.'
        elif 'signblob' in msg or 'serviceaccounts' in msg or 'refresherror' in msg:
            detail = 'Die Google-Dienstkonto-Impersonation oder die Signaturberechtigung ist nicht verfügbar.'
        else:
            detail = 'Verbindung fehlgeschlagen (' + type(exc).__name__ + ').'
        return {'ok':False,'message':detail}


def secure_media_url(media_id, minutes=60, instagram_format=None):
    base = public_base()
    if not base.startswith('https://'):
        raise RuntimeError('Instagram benötigt eine öffentlich erreichbare HTTPS-Adresse (Cloud-Betrieb oder veröffentlichte URL).')
    if instagram_format not in (None, 'story','post'):
        raise ValueError('Ungültiges Instagram-Bildformat.')
    expiry = str(int(datetime.now(timezone.utc).timestamp()) + 60 * minutes)
    payload = f'{media_id}:{expiry}' + (f':instagram-{instagram_format}' if instagram_format else '')
    sig = hmac.new(KEY_BYTES, payload.encode(), hashlib.sha256).hexdigest()
    variant = f'&ig={instagram_format}' if instagram_format else ''
    return f'{base}/public/media/{media_id}?exp={expiry}{variant}&sig={sig}'


def media_row(ident, owner_id=None):
    with dbconn() as db:
        if owner_id is not None:
            row = db.execute('SELECT * FROM media WHERE id=? AND owner_id=?', (ident, owner_id)).fetchone()
        else:
            row = db.execute('SELECT * FROM media WHERE id=?', (ident,)).fetchone()
    if not row:
        raise HTTPException(404, 'Mediendatei fehlt')
    return dict(row)


# V17.11: Automatic retries ONLY for known-unsent Telegram requests.
# Telegram API can return a 429 with retry_after, while an interrupted multipart
# upload may ALREADY have created a post. Never replay an ambiguous upload.
class TelegramRetryLater(RuntimeError):
    def __init__(self, message, delay=30):
        super().__init__(message)
        self.delay = max(5, min(300, int(delay)))


def telegram_response_detail(response, token):
    try:
        body = response.json()
        if not isinstance(body, dict):
            body = {}
    except (ValueError, TypeError):
        body = {}
    description = str(body.get('description') or f'HTTP {response.status_code}')
    # Never include Bot token (including token embedded in any response detail).
    return body, description[:260].replace(token, '[TOKEN]')


def telegram_retry_delay(body):
    try:
        return max(1, min(300, int((body.get('parameters') or {}).get('retry_after') or 30)))
    except (ValueError, TypeError, AttributeError):
        return 30


async def telegram_get_stable(client, token, method, params=None):
    # Read-only checks may be retried safely. Avoid showing transient outages
    # as revoked accounts; don't send a Telegram post during these checks.
    url = 'https://api.telegram.org/bot' + token + '/' + method
    for attempt in range(3):
        try:
            response = await client.get(url, params=params or {})
        except (httpx.TimeoutException, httpx.TransportError):
            if attempt < 2:
                await asyncio.sleep(0.35 * (attempt + 1))
                continue
            raise TelegramRetryLater('Telegram ist vorübergehend nicht erreichbar. Die gespeicherte Verbindung bleibt erhalten.', 30) from None
        body, message = telegram_response_detail(response, token)
        if response.status_code == 429 or body.get('error_code') == 429:
            delay = telegram_retry_delay(body)
            if attempt < 2 and delay <= 2:
                await asyncio.sleep(delay)
                continue
            raise TelegramRetryLater('Telegram begrenzt gerade Anfragen (429). Bitte später erneut prüfen.', delay)
        if response.status_code in (500, 502, 503, 504):
            if attempt < 2:
                await asyncio.sleep(0.35 * (attempt + 1))
                continue
            raise TelegramRetryLater('Telegram-Server vorübergehend nicht erreichbar. Verbindung wurde nicht getrennt.', 30)
        if response.status_code >= 400 or not body.get('ok'):
            raise RuntimeError('Telegram ' + method + ': ' + message)
        return body['result']
    raise TelegramRetryLater('Telegram-Verbindungsprüfung vorübergehend fehlgeschlagen.', 30)


async def telegram_channel_health(client, token, channel):
    me = await telegram_get_stable(client, token, 'getMe')
    if not me.get('is_bot') or not me.get('id'):
        raise RuntimeError('Telegram: Der Token gehört keinem gültigen Bot.')
    chat = await telegram_get_stable(client, token, 'getChat', {'chat_id': channel})
    if chat.get('type') != 'channel':
        raise RuntimeError('Telegram: Bitte einen Kanal auswählen, keine Gruppe oder Privatchat.')
    member = await telegram_get_stable(client, token, 'getChatMember',
        {'chat_id':chat['id'], 'user_id':me['id']})
    rights_ok = member.get('status') == 'creator' or (
        member.get('status') == 'administrator' and member.get('can_post_messages') is True)
    if not rights_ok:
        raise RuntimeError('Telegram: Bot braucht Administratorrechte mit „Nachrichten posten“ im Kanal.')
    return me, chat


# Telegram Cloud Bot API accepts max 50 MB via multipart. Leave safety room.
TELEGRAM_UPLOAD_LIMIT = 47_000_000
TELEGRAM_TARGET_BYTES = 43_000_000


def telegram_ready_video(media):
    """Return local MP4 <= Telegram's limit without changing the original.

    Cached exports live in data/telegram-ready and are reused for recurring posts.
    FFmpeg's 2-pass-like bitrate budget keeps the complete duration and original
    audio; errors are actionable instead of silently retrying an oversize upload.
    """
    source = MEDIA / media['filename']
    if not source.is_file():
        raise RuntimeError('Telegram: Videodatei fehlt in der Mediathek.')
    if source.stat().st_size <= TELEGRAM_UPLOAD_LIMIT:
        return source
    cache = DATA / 'telegram-ready'
    cache.mkdir(parents=True, exist_ok=True)
    fingerprint = hashlib.sha256((media['id'] + ':' + str(source.stat().st_size)
         + ':' + str(source.stat().st_mtime_ns)).encode()).hexdigest()[:18]
    target = cache / (fingerprint + '.mp4')
    if target.is_file() and 100 < target.stat().st_size <= TELEGRAM_UPLOAD_LIMIT:
        return target
    with tempfile.TemporaryDirectory(prefix='tg-', dir=cache) as directory:
        provisional = Path(directory) / 'prepared.mp4'
        try:
            _compress_import_video(source, provisional, limit=TELEGRAM_UPLOAD_LIMIT,
                                   target=TELEGRAM_TARGET_BYTES)
        except HTTPException as exc:
            raise RuntimeError('Telegram: Video ist zu groß. Die automatische '
                 'Optimierung auf unter 47 MB ist fehlgeschlagen: '+str(exc.detail)) from None
        if not provisional.is_file() or provisional.stat().st_size > TELEGRAM_UPLOAD_LIMIT:
            raise RuntimeError('Telegram: Video konnte nicht unter die Upload-Grenze gebracht werden.')
        os.replace(provisional, target)
    return target


async def publish_telegram(job, media, acc):
    if job['format'] != 'post':
        raise RuntimeError('MANUAL: Telegram-Kanal-Bots können keine Kanal-Stories/Reels posten.')
    if media['mime'] not in ('video/mp4','image/jpeg','image/png'):
        raise RuntimeError('Telegram: Nur JPG, PNG oder MP4 werden unterstützt.')
    token = decrypt(acc['access_enc'])
    if not token:
        raise RuntimeError('Telegram: Bot-Token fehlt. Bitte Verbindung prüfen.')
    if media['mime'] == 'video/mp4':
        # Compression is CPU-bound; do not block the 12-second scheduler loop.
        path = await asyncio.to_thread(telegram_ready_video, media)
        method, field, mimetype = 'sendVideo', 'video', 'video/mp4'
        name = Path(media['original_name']).stem[:90] + '.mp4'
    else:
        path = MEDIA / media['filename']
        method, field, mimetype = 'sendPhoto', 'photo', media['mime']
        name = Path(media['original_name']).name
    if not path.is_file():
        raise RuntimeError('Telegram: Datei fehlt in der Mediathek.')
    endpoint = f'https://api.telegram.org/bot{token}/{method}'
    # Send again only when Telegram confirms a 429 rejection, or when an HTTP
    # connection could not be established BEFORE the body was sent. Read/write
    # timeout and HTTP 5xx are ambiguous: DO NOT retry (duplicate-post risk).
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(300,connect=30),follow_redirects=False) as client:
                with path.open('rb') as source:
                    response = await client.post(endpoint,
                        data={'chat_id':acc['external_id'], 'caption':(job['caption'] or '')[:1024],
                              **({'supports_streaming':'true'} if method=='sendVideo' else {})},
                        files={field:(name,source,mimetype)})
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
            if attempt == 0:
                await asyncio.sleep(0.8)
                continue
            raise TelegramRetryLater('Telegram konnte vor dem Upload nicht erreicht werden; sicherer Wiederholungsversuch geplant.', 30) from None
        except (httpx.HTTPError, OSError) as exc:
            raise RuntimeError('Telegram: Versandstatus unklar (' + type(exc).__name__ +
                '). Bitte zuerst im Kanal prüfen! Kein automatischer Zweitversand wegen Doppelpost-Gefahr.') from None
        body, detail = telegram_response_detail(response, token)
        if response.status_code == 429 or body.get('error_code') == 429:
            delay = telegram_retry_delay(body)
            if attempt == 0 and delay <= 3:
                await asyncio.sleep(delay)
                continue
            raise TelegramRetryLater('Telegram-Limit 429: Beitrag wurde abgelehnt; sicherer neuer Versuch folgt.', delay)
        if response.status_code >= 500:
            raise RuntimeError('Telegram: Serverfehler HTTP ' + str(response.status_code) +
                '. Versandstatus unklar – bitte im Kanal prüfen, bevor du erneut sendest.')
        if response.status_code >= 400 or not body.get('ok'):
            raise RuntimeError('Telegram: ' + detail)
        message = body.get('result') or {}
        if not isinstance(message, dict) or not message.get('message_id'):
            raise RuntimeError('Telegram: Versandantwort ohne message_id. Bitte zuerst im Kanal prüfen, bevor du erneut sendest.')
        return 'Telegram-Kanalbeitrag #' + str(message['message_id'])
    raise TelegramRetryLater('Telegram konnte noch nicht senden.', 30)

# TimeSave Social: Telegram PROFILE Stories, via OFFICIAL Business Bot API.
# Unlike Telegram channel posts, this needs business_connection_id + can_manage_stories.
# No user-session login, no Telegram passwords or unofficial Telegram client APIs.
TELEGRAM_BOT_API = 'https://api.telegram.org/bot'


def telegram_story_photo(path):
    """Encode an 1080x1920 JPEG (< 10MB) while keeping whole source visible."""
    with Image.open(path) as opened:
        opened = ImageOps.exif_transpose(opened)
        img = opened.convert('RGB')
    bounds = (1080, 1920)
    bg = ImageOps.fit(img, bounds, method=Image.Resampling.LANCZOS)
    bg = bg.filter(ImageFilter.GaussianBlur(38))
    bg = Image.blend(bg, Image.new('RGB', bounds, (18, 12, 34)), 0.24)
    inset = img.copy()
    inset.thumbnail(bounds, Image.Resampling.LANCZOS)
    bg.paste(inset, ((1080-inset.width)//2, (1920-inset.height)//2))
    buf=BytesIO()
    for quality in (90, 80, 70):
        buf.seek(0); buf.truncate()
        bg.save(buf, 'JPEG', quality=quality, optimize=True)
        if buf.tell() <= 10*1024*1024:
            return buf.getvalue()
    raise RuntimeError('Telegram-Story-Bild ist auch nach der Umwandlung zu groß (>10 MB).')


def telegram_story_probe(path):
    exe=shutil.which('ffprobe')
    if not exe:
        return {}
    try:
        cp=subprocess.run([exe,'-v','error','-show_streams','-show_format','-of','json',str(path)],capture_output=True,timeout=20,check=True)
        return json.loads(cp.stdout)
    except (OSError,subprocess.SubprocessError,ValueError):
        return {}


def telegram_story_video(path, progress=lambda pct,msg: None):
    """Prepare a bounded HEVC story; never modify or remove the source."""
    ffmpeg=_find_ffmpeg('Telegram-Story benötigt FFmpeg mit H.265.')
    info=telegram_story_probe(path)
    streams=info.get('streams',[])
    video=next((x for x in streams if x.get('codec_type')=='video'),{})
    duration=float(info.get('format',{}).get('duration') or 0) if info else 0
    if not duration:
        duration=_video_duration_seconds(path,ffmpeg)
    if not duration or duration <= 0:
        raise RuntimeError('Telegram-Story: Videodauer konnte nicht bestimmt werden.')
    if duration > 60.05:
        raise RuntimeError('Telegram-Story: maximal 60 Sekunden. Bitte Video im Studio kürzen.')
    TMP_DIR.mkdir(parents=True,exist_ok=True)
    fd,dest=tempfile.mkstemp(prefix='timesave_tg_story_',suffix='.mp4',dir=TMP_DIR)
    os.close(fd)
    try:
        # Reuse HEVC only when the actual keyframe intervals also match.
        compatible=False
        if video.get('codec_name')=='hevc' and (video.get('width'),video.get('height'))==(720,1280) and video.get('pix_fmt')=='yuv420p' and path.stat().st_size<29_000_000 and shutil.which('ffprobe'):
            try:
                cp=subprocess.run(['ffprobe','-v','error','-select_streams','v:0','-skip_frame','nokey','-show_entries','frame=best_effort_timestamp_time','-of','json',str(path)],capture_output=True,timeout=25,check=True)
                keys=[float(f['best_effort_timestamp_time']) for f in json.loads(cp.stdout)['frames']]
                compatible=bool(keys) and abs(keys[0])<.08 and all(.90<=y-x<=1.08 for x,y in zip(keys,keys[1:])) and duration-keys[-1]<=1.08 and all(x.get('codec_name')=='aac' for x in streams if x.get('codec_type')=='audio')
            except (OSError,subprocess.SubprocessError,ValueError,KeyError):
                pass
        base=[ffmpeg,'-nostdin','-y','-hide_banner','-loglevel','error','-threads','1','-filter_threads','1','-i',str(path),'-map','0:v:0','-map','0:a:0?','-t','60']
        if compatible:
            cmd=base+['-c','copy','-tag:v','hvc1','-movflags','+faststart',dest]
        else:
            vf='scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30'
            bitrate=min(3000,max(300,int(26_000_000*8/max(duration,1)/1000)-128))
            cmd=base+['-vf',vf,'-c:v','libx265','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p','-crf','27','-maxrate',f'{bitrate}k','-bufsize',f'{bitrate*2}k','-x265-params','pools=none:frame-threads=1:wpp=0:lookahead-slices=0:rc-lookahead=0:bframes=0:keyint=30:min-keyint=30:scenecut=0:log-level=error','-tag:v','hvc1','-c:a','aac','-b:a','96k','-movflags','+faststart',dest]
        cp=_v184_ffmpeg_progress(cmd,600,duration,lambda pct,msg:progress(10+int(pct*.70),'Telegram: '+msg))
        if cp.returncode:
            detail=cp.stderr.decode(errors='replace').strip().splitlines()[-3:]
            raise RuntimeError('Telegram H.265: FFmpeg '+str(cp.returncode)+' · '+' / '.join(detail)[-350:])
        if not 0<os.path.getsize(dest)<=30_000_000:
            raise RuntimeError('Telegram-Story: Export leer oder über 30 MB.')
        return dest
    except subprocess.TimeoutExpired:
        Path(dest).unlink(missing_ok=True)
        raise RuntimeError('Telegram: H.265-Umwandlung nach 10 Minuten abgebrochen.') from None
    except BaseException:
        Path(dest).unlink(missing_ok=True)
        raise


def _publish_progress(job_id,pct,msg):
    with _PUBLISH_PROGRESS_LOCK:
        _PUBLISH_PROGRESS[job_id]={'progress':pct,'message':msg}


def telegram_story_rights(business):
    return bool(business.get('is_enabled') and (business.get('rights') or {}).get('can_manage_stories'))


async def telegram_bot_get(token, method, params=None):
    """Only official HTTPS Bot API. Token must never enter error/status logs."""
    try:
        async with httpx.AsyncClient(timeout=25) as client:
            r=await client.get(TELEGRAM_BOT_API+token+'/'+method,params=params or {})
        body=require_ok(r)
        if not body.get('ok'):
            raise RuntimeError(str(body.get('description','Telegram hat die Anfrage abgelehnt'))[:240])
        return body['result']
    except httpx.HTTPError:
        raise RuntimeError('Telegram ist gerade nicht erreichbar. Verbindung später erneut prüfen.') from None


async def telegram_story_get_business(token, business_id):
    info=await telegram_bot_get(token, 'getBusinessConnection', {'business_connection_id':business_id})
    if not telegram_story_rights(info):
        raise RuntimeError('Telegram-Profil ist getrennt oder die Berechtigung „Stories verwalten“ fehlt. In Telegram Business beim Bot aktivieren.')
    return info


async def publish_telegram_story(job, media, account):
    if job['format']!='story':
        raise RuntimeError('Telegram-Stories benötigen das Format Story.')
    token=decrypt(account['access_enc'])
    business_id=account['external_id']
    progress=lambda pct,msg:_publish_progress(job['id'],pct,msg)
    progress(5,'Telegram: Kontozugriff wird geprüft …')
    await telegram_story_get_business(token,business_id)
    path=MEDIA/media['filename']
    if media['mime'] in ('image/jpeg','image/png'):
        blob=await asyncio.to_thread(telegram_story_photo,path)
        content={'type':'photo','photo':'attach://storyfile'}
        attachment=('story.jpg',blob,'image/jpeg')
        temp=None
    elif media['mime']=='video/mp4':
        temp=await asyncio.to_thread(telegram_story_video,path,progress)
        content={'type':'video','video':'attach://storyfile'}
        attachment=('story.mp4',None,'video/mp4')
    else:
        raise RuntimeError('Telegram-Stories unterstützen JPG, PNG oder MP4.')
    try:
        if temp:
            file=open(temp,'rb')
            attachment=('story.mp4',file,'video/mp4')
        else:
            file=None
        try:
            progress(85,'Telegram: Upload läuft, Bestätigung steht aus …')
            async with httpx.AsyncClient(timeout=httpx.Timeout(180,connect=30)) as client:
                response=await client.post(TELEGRAM_BOT_API+token+'/postStory',
                    data={'business_connection_id':business_id,'content':json.dumps(content),
                          'active_period':'86400','caption':(job.get('caption') or '')[:2048]},
                    files={'storyfile':attachment})
            try:
                result=response.json()
            except ValueError:
                raise RuntimeError(f'Telegram HTTP {response.status_code}: Antwort unklar. Profil vor erneutem Senden prüfen.') from None
            if not isinstance(result,dict):
                raise RuntimeError('Telegram: Antwort unklar. Profil vor erneutem Senden prüfen.')
            if response.status_code==429 and result.get('ok') is False:
                raise TelegramRetryLater('Telegram-Story: Ratenlimit.',telegram_retry_delay(result))
            if response.status_code>=400 or not result.get('ok'):
                raise RuntimeError('Telegram HTTP '+str(response.status_code)+': '+telegram_response_detail(response,token)[1])
            story_id=result.get('result',{}).get('id')
            if story_id is None:
                raise RuntimeError('Telegram nahm die Story an, lieferte aber keine Story-ID. Bitte im Profil nachsehen, bevor du erneut sendest.')
            return 'Telegram-Profil-Story veröffentlicht · Story-ID '+str(story_id)
        finally:
            if file: file.close()
    except httpx.HTTPError:
        # Network interruption can occur after the server accepted the post!
        raise RuntimeError('Telegram-Story: Verbindungsproblem. Vor erneutem Senden bitte im Telegram-Profil nachsehen (Doppelpost vermeiden).') from None
    finally:
        if temp:
            try: os.unlink(temp)
            except OSError: pass


async def publish_facebook_video(job, media, acc):
    """Facebook Page MP4 feed videos, video stories and reels via official Meta endpoints."""
    token = decrypt(acc['access_enc'])
    page = acc['external_id']
    path = MEDIA / media['filename']
    video_format = job['format']
    if video_format in {'post','video'}:
        # Feed video: official Page video edge on graph-video.
        async with httpx.AsyncClient(timeout=300) as client:
            with path.open('rb') as file:
                response = await client.post(f'https://graph-video.facebook.com/v26.0/{page}/videos',
                    headers={'Authorization':'Bearer '+token},
                    data={'description':job['caption'] or '', 'published':'true'},
                    files={'source':(media['original_name'],file,'video/mp4')})
            obj = require_ok(response)
            if not obj.get('id'):
                raise RuntimeError('Facebook hat keine Video-ID geliefert; vor Wiederholung bei Facebook prüfen.')
            return {'status':'awaiting_confirmation','publish_id':str(obj['id']),'message':'Facebook-Videoupload angenommen. Meta verarbeitet das Video noch.'}
    if video_format not in {'story','reel'}:
        raise RuntimeError('MANUAL: Dieses Facebook-Videoformat ist nicht verfügbar.')
    endpoint = 'video_stories' if video_format=='story' else 'video_reels'
    # The start response supplies a dedicated upload host. Never send the Page token to other hosts.
    async with httpx.AsyncClient(timeout=300) as client:
        init = require_ok(await client.post(f'{GRAPH}/{page}/{endpoint}',
            headers={'Authorization':'Bearer '+token},data={'upload_phase':'start'}))
        upload_url = init.get('upload_url','')
        video_id = init.get('video_id','')
        parsed = urlsplit(upload_url)
        if not video_id or parsed.scheme != 'https' or parsed.hostname != 'rupload.facebook.com':
            raise RuntimeError('Facebook hat keine gültige Video-Uploadadresse geliefert.')
        uploaded = require_ok(await asyncio.to_thread(
            _stream_binary_request, 'POST', upload_url,
            {'Authorization':'OAuth '+token,'offset':'0',
             'file_size':str(path.stat().st_size),
             'Content-Type':'application/octet-stream'},
            path, 0, None, 300.0))
        if uploaded.get('success') not in (True, 'true', 1):
            raise RuntimeError('Facebook hat den Video-Upload nicht bestätigt; Video vor erneutem Versuch prüfen.')
        finish = {'upload_phase':'finish','video_id':video_id}
        if video_format=='reel':
            finish.update({'video_state':'PUBLISHED','description':job['caption'] or ''})
        obj = require_ok(await client.post(f'{GRAPH}/{page}/{endpoint}',
            headers={'Authorization':'Bearer '+token},data=finish))
        if obj.get('success') not in (True, 'true', 1) and not obj.get('post_id'):
            raise RuntimeError('Facebook hat die Videoveröffentlichung nicht eindeutig bestätigt; bitte Meta prüfen.')
    return {'status':'awaiting_confirmation','publish_id':str(video_id),'message':('Facebook-Video-Story' if video_format=='story' else 'Facebook-Reel') + ' angenommen. Meta verarbeitet das Video noch.'}


async def publish_facebook(job, media, acc):
    if media['mime']=='video/mp4':
        return await publish_facebook_video(job,media,acc)
    if media['mime'] not in {'image/jpeg','image/png'}:
        raise RuntimeError('MANUAL: Facebook erwartet ein JPG/PNG-Bild oder MP4-Video.')
    if job['format'] not in {'post','story'}:
        raise RuntimeError('MANUAL: Ein Facebook-Reel benötigt ein MP4-Video.')
    token = decrypt(acc['access_enc'])
    page = acc['external_id']
    path = MEDIA / media['filename']
    async with httpx.AsyncClient(timeout=70) as client:
        with path.open('rb') as file:
            params = {'published':'false' if job['format']=='story' else 'true'}
            if job['format']=='post':
                params['caption'] = job['caption'] or ''
            r = await client.post(f'{GRAPH}/{page}/photos',
                headers={'Authorization':'Bearer '+token},data=params,
                files={'source':(media['original_name'],file,media['mime'])})
        image = require_ok(r)
        image_id = image.get('id')
        if not image_id:
            raise RuntimeError('Facebook hat keine Foto-ID zurückgegeben – bitte manuell prüfen.')
        if job['format']=='post':
            return 'Facebook-Beitrag, Foto-ID '+str(image_id)
        r = await client.post(f'{GRAPH}/{page}/photo_stories',
                headers={'Authorization':'Bearer '+token},data={'photo_id':image_id})
        obj = require_ok(r)
        if not obj.get('post_id') and not obj.get('id'):
            raise RuntimeError('Facebook-Story-Freigabe unklar, vor erneutem Senden prüfen.')
        return 'Facebook-Seiten-Story #'+str(obj.get('post_id') or obj.get('id'))


def instagram_safe_detail(value) -> str:
    """Remove URLs and bearer-like tokens before storing remote error messages."""
    raw = str(value)
    raw = re.sub(r'https?://[^\s\"<>]+', '[URL ausgeblendet]', raw, flags=re.IGNORECASE)
    raw = re.sub(r'(?i)(access_token|app_secret|client_secret|signature|x-goog-signature)\s*[=:]\s*[^&\s\"<>]+', r'\1=[ausgeblendet]', raw)
    return raw[:230]


def instagram_api_error(response, phase: str) -> RuntimeError:
    """Safely surface official Meta errors without storing tokens/URLs or HTML.
    Meta sometimes sends a non-standard response with just a numeric HTTP code.
    """
    parts=[]
    try:
        payload=response.json()
        if isinstance(payload,dict):
            err=payload.get('error') or payload
            if isinstance(err,dict):
                for label,key in [('Meta','message'),('Hinweis','error_user_msg'),('Typ','type'),
                                  ('Code','code'),('Untercode','error_subcode')]:
                    value=err.get(key)
                    if value is not None and str(value).strip():
                        parts.append(f'{label}: {instagram_safe_detail(value)}')
                if err.get('error_user_title'):
                    parts.append('Grund: '+instagram_safe_detail(err['error_user_title'])[:120])
            debug=payload.get('debug_info')
            if isinstance(debug,dict):
                if debug.get('type'):
                    parts.append('Meta-Debugtyp: '+instagram_safe_detail(debug['type']))
                if debug.get('message'):
                    parts.append('Meta-Debuginfo: '+instagram_safe_detail(debug['message']))
    except (ValueError,TypeError):
        pass
    trace=response.headers.get('x-fb-trace-id','')
    if trace and all(c.isalnum() or c in '-_' for c in trace):
        parts.append('Meta Trace-ID: '+trace[:90])
    if not parts:
        length = len(response.content)
        media_type = response.headers.get('content-type', '').split(';')[0][:45]
        parts.append('Keine API-Fehlerdetails (Antwort: '+str(length)+' Bytes'+
                     (', '+media_type if media_type else '')+').')
    details=' · '.join(parts)
    return RuntimeError(f'Instagram {phase}: HTTP {response.status_code} – {details}')


def instagram_require_ok(response, phase: str):
    if response.status_code >= 400:
        raise instagram_api_error(response,phase)
    try:
        result=response.json()
    except ValueError:
        raise RuntimeError(f'Instagram {phase}: Meta hat keine gültige JSON-Antwort geliefert.') from None
    if not isinstance(result,dict) or result.get('error'):
        raise instagram_api_error(response,phase)
    return result


def instagram_upload_uri(container: dict, ident: str) -> str:
    """Accept only official Meta resumable upload URL, never an API-supplied host."""
    uri = container.get('uri') or f"https://rupload.facebook.com/ig-api-upload/{GRAPH.rsplit('/', 1)[-1]}/{ident}"
    target = urlsplit(uri)
    if target.scheme != 'https' or target.hostname != 'rupload.facebook.com' or target.port not in (None,443) \
            or not target.path.startswith('/ig-api-upload/') or target.username or target.password:
        raise RuntimeError('Instagram: Unsichere Upload-Adresse von Meta erhalten; abgebrochen.')
    return uri


class InstagramTransferRejected(RuntimeError):
    """Rupload rejected raw file bytes. Do not retry an ambiguous accepted upload."""
    def __init__(self, response):
        super().__init__(str(instagram_api_error(response, 'Dateiübertragung')))
        self.status_code = response.status_code


def instagram_binary_upload(uri: str, token: str, source: Path):
    """Use a single known-length binary request; never multipart or chunked encoding.

    httpx async generators can be used with a Content-Length header, but Meta's
    upload frontends sometimes reject requests if framing differs from the exact
    binary-body example. A synchronous file stream in a worker thread avoids
    Transfer-Encoding: chunked and keeps RAM usage bounded on Windows.
    """
    size = source.stat().st_size
    headers = {'Authorization': 'OAuth ' + token,
               'offset': '0', 'file_size': str(size),
               'Content-Length': str(size),
               'Content-Type': 'application/octet-stream'}
    with httpx.Client(timeout=httpx.Timeout(300, connect=30), follow_redirects=False) as client:
        with source.open('rb') as stream:
            return client.post(uri, headers=headers, content=stream)


async def instagram_upload_file(client: httpx.AsyncClient, token: str, uri: str, source: Path):
    """Transfer MP4 bytes directly. A failed upload is never treated as published."""
    size = source.stat().st_size
    if size < 1 or size > MAX_VIDEO:
        raise RuntimeError('Instagram: MP4 muss vor dem Versand unter 100 MB optimiert werden.')
    try:
        response = await asyncio.to_thread(instagram_binary_upload, uri, token, source)
    except (httpx.HTTPError, OSError) as exc:
        raise RuntimeError('Instagram: Direkter Videoupload zu Meta fehlgeschlagen ('+
                           type(exc).__name__+'). Bitte Verbindung prüfen.') from None
    if response.status_code >= 400:
        raise InstagramTransferRejected(response)
    body = instagram_require_ok(response, 'Dateiübertragung')
    if body.get('success') not in (True, 1, 'true'):
        raise RuntimeError('Instagram: Meta hat den direkten Videoupload nicht bestätigt.')


async def instagram_unified_exchange_code(client, code: str, redirect: str):
    """Meta Unified Login code exchange with the Meta APP credentials, not IG product credentials.

    No fb_exchange_token request: a system-user token must not be re-exchanged as a user token.
    """
    response = await client.get(f'{GRAPH}/oauth/access_token', params={
        'client_id': setting('meta_app_id'),
        'client_secret': setting('meta_app_secret'),
        'code': code, 'redirect_uri': redirect,
    })
    payload = require_ok(response)
    token = payload.get('access_token') if isinstance(payload,dict) else None
    if not isinstance(token,str) or not token:
        raise RuntimeError('Meta Unified Login hat keinen Zugriffstoken geliefert.')
    # No expires_in is not a guarantee of infinite validity: store no asserted expiry.
    try:
        seconds = int(payload.get('expires_in') or 0)
    except (ValueError, TypeError):
        seconds=0
    expires=(datetime.now(timezone.utc)+timedelta(seconds=seconds)).isoformat() if seconds>0 else None
    return token, expires


async def instagram_unified_discover(client, token: str):
    """Discover authorized IG profiles using only the new Unified Login token."""
    warnings=[]
    candidates={}
    async def edge(path, fields, label):
        try:
            return await meta_edge(client,token,path,fields)
        except (RuntimeError,httpx.HTTPError):
            warnings.append(label+' nicht abrufbar')
            return []
    def add(row):
        if isinstance(row,dict):
            ident=str(row.get('id') or '')
            if re.fullmatch(r'[0-9]{6,30}',ident):
                candidates.setdefault(ident,row)
    for row in await edge('me/assigned_instagram_accounts','id,username','Zugewiesene Instagram-Konten'):
        add(row)
    businesses=await edge('me/businesses','id,name','Business-Portfolios')
    for business in businesses:
        bid=str(business.get('id') or '') if isinstance(business,dict) else ''
        if not bid.isdigit():
            continue
        for kind in ('owned_instagram_accounts','client_instagram_accounts'):
            for row in await edge(f'{bid}/{kind}','id,username',f'Portfolio {bid}: {kind}'):
                add(row)
        for kind in ('owned_pages','client_pages'):
            for page in await edge(f'{bid}/{kind}','id,instagram_business_account{id,username}',f'Portfolio {bid}: {kind}'):
                if isinstance(page,dict):
                    add(page.get('instagram_business_account'))
    for page in await edge('me/accounts','id,instagram_business_account{id,username}','Facebook-Verknüpfungen'):
        if isinstance(page,dict):
            add(page.get('instagram_business_account'))
    result=[]
    # Visibility in a portfolio alone is not enough. Verify the actual profile
    # with the same Unified credential, never a Page token or a browser ID.
    for ident,row in candidates.items():
        try:
            detail=require_ok(await client.get(f'{GRAPH}/{ident}',headers={'Authorization':'Bearer '+token},params={'fields':'id,username'}))
            if str(detail.get('id')) != ident or not isinstance(detail.get('username'),str) or not detail['username']:
                raise RuntimeError('Ungültiges Instagram-Profil')
            result.append({'id':ident,'username':detail['username']})
        except (RuntimeError,httpx.HTTPError):
            warnings.append(f'Instagram-Konto {ident}: kein bestätigter Profilzugriff')
    if not result:
        diagnostic=' · '.join(dict.fromkeys(warnings))[:650]
        raise RuntimeError('Kein Instagram-Profil mit Unified-Login-Zugriff gefunden. '
            'Instagram-Unternehmensressource, Systemnutzer-Zuweisung und Berechtigungen '
            'instagram_basic / instagram_content_publish in der Login-Konfiguration prüfen. '
            + (diagnostic or 'Meta hat keine Konten zurückgegeben.'))
    return result


async def instagram_exchange_code(client, code: str, redirect: str):
    """Instagram Business Login (not Facebook OAuth) code + long-lived exchange."""
    short = instagram_require_ok(await client.post(IG_OAUTH, data={
        'client_id': setting('instagram_app_id'),
        'client_secret': setting('instagram_app_secret'),
        'grant_type': 'authorization_code', 'redirect_uri': redirect, 'code': code,
    }), 'Anmeldung')
    if isinstance(short.get('data'), list) and len(short['data']) == 1 and not short.get('access_token'):
        short = short['data'][0]
    short_token = short.get('access_token')
    if not short_token:
        raise RuntimeError('Instagram-Anmeldung hat keinen Access-Token geliefert.')
    long = instagram_require_ok(await client.get('https://graph.instagram.com/access_token', params={
        'grant_type': 'ig_exchange_token', 'client_secret': setting('instagram_app_secret'),
        'access_token': short_token,
    }), 'Langfristigen Zugang erstellen')
    long_token = long.get('access_token')
    lifetime = int(long.get('expires_in') or 0)
    if not long_token or lifetime <= 0:
        raise RuntimeError('Instagram hat keinen gültigen langfristigen Token geliefert. Verbindung nicht gespeichert.')
    info = instagram_require_ok(await client.get(f'{IG_GRAPH}/me',
        headers={'Authorization': 'Bearer ' + long_token},
        params={'fields': 'id,username,account_type'}), 'Profil abrufen')
    if not info.get('id') or not info.get('username'):
        raise RuntimeError('Instagram: Profil-ID oder Benutzername fehlt.')
    return info, long_token, lifetime


async def instagram_direct_token(acc: dict, force: bool = False):
    """Refresh only an Instagram Login credential; never touch Facebook sessions."""
    if not instagram_direct_account(acc):
        return decrypt(acc['access_enc'])
    token = decrypt(acc['access_enc'])
    if not token:
        raise RuntimeError('Instagram-Token fehlt. Bitte Instagram neu verbinden.')
    expires = acc.get('expires_at')
    if expires:
        try:
            expiry = datetime.fromisoformat(expires)
            if expiry <= datetime.now(timezone.utc):
                raise RuntimeError('Instagram-Token abgelaufen. Bitte Instagram neu verbinden.')
            if not force and expiry > datetime.now(timezone.utc) + timedelta(days=7):
                return token
        except ValueError:
            raise RuntimeError('Instagram-Token-Ablaufdatum ungültig; bitte erneut anmelden.') from None
    else:
        # Legacy/direct accounts with no expiry require reauthorization, not a blind guess.
        raise RuntimeError('Instagram-Token ohne Ablaufdatum: bitte Instagram neu verbinden.')
    metadata = json.loads(acc.get('metadata') or '{}')
    try:
        issued = datetime.fromisoformat(metadata.get('token_updated_at') or '')
    except ValueError:
        issued = datetime.now(timezone.utc)
    # Tokens cannot be refreshed within their first 24 hours.
    if datetime.now(timezone.utc) - issued < timedelta(hours=24):
        return token
    async with httpx.AsyncClient(timeout=30) as client:
        result = instagram_require_ok(await client.get('https://graph.instagram.com/refresh_access_token',
            params={'grant_type': 'ig_refresh_token', 'access_token': token}), 'Token erneuern')
    new_token = result.get('access_token')
    lifetime = int(result.get('expires_in') or 0)
    if not new_token or lifetime <= 0:
        raise RuntimeError('Instagram hat keinen erneuerten Token geliefert. Bitte erneut anmelden.')
    new_expiry = (datetime.now(timezone.utc) + timedelta(seconds=lifetime)).isoformat()
    metadata['token_updated_at'] = now()
    # Guard against races with re-login/disconnect: only update if the same token is stored.
    with dbconn() as db:
        changed = db.execute("UPDATE connections SET access_enc=?,expires_at=?,metadata=?,checked_at=? "
             "WHERE id=? AND access_enc=?", (encrypt(new_token),new_expiry,json.dumps(metadata),now(),
             acc['id'],acc['access_enc']))
        if not changed.rowcount:
            raise RuntimeError('Instagram-Konto wurde zwischenzeitlich geändert. Bitte neu prüfen.')
    return new_token


async def refresh_instagram_direct_accounts_auto():
    """Never affect other Instagram connections or the Facebook OAuth session."""
    with dbconn() as db:
        rows = [dict(x) for x in db.execute("SELECT * FROM connections WHERE provider='instagram'")]
    for acc in rows:
        if instagram_direct_account(acc):
            try:
                await instagram_direct_token(acc)
            except Exception:
                # Mark status, retain encrypted token, let user reauthorize.
                with dbconn() as db:
                    db.execute("UPDATE connections SET status='error',checked_at=? WHERE id=?", (now(),acc['id']))


async def publish_instagram(job, media, acc):
    is_video = media['mime']=='video/mp4'
    if media['mime'] not in {'image/jpeg','image/png','video/mp4'}:
        raise RuntimeError('MANUAL: Instagram erwartet JPG/PNG oder MP4.')
    if is_video:
        if job['format'] not in {'story','reel'}:
            raise RuntimeError('MANUAL: Instagram-Videos als Story oder Reel planen.')
    elif job['format'] not in {'post','story'}:
        raise RuntimeError('MANUAL: Instagram-Reels benötigen MP4.')
    ig_id = acc['external_id']
    is_direct = instagram_direct_account(acc)
    endpoint = IG_GRAPH if is_direct else GRAPH
    token = await instagram_direct_token(acc) if is_direct else decrypt(acc['access_enc'])
    if instagram_unified_account(acc) and acc.get('expires_at'):
        ig_expiry = _parse_utc(acc.get('expires_at'))
        if ig_expiry is not None and ig_expiry <= datetime.now(timezone.utc):
            raise RuntimeError('Meta Unified Login Token abgelaufen. Instagram erneut verbinden.')
    if is_video:
        video_path = MEDIA / media['filename']
        if not video_path.is_file() or video_path.stat().st_size == 0:
            raise RuntimeError('Instagram: Die MP4-Datei fehlt oder ist leer.')
        if video_path.stat().st_size > MAX_VIDEO:
            raise RuntimeError('Instagram: MP4 ist noch zu groß. Bitte im Kreativstudio optimieren.')
    if is_video:
        # Facebook Login for Business supports upload_type=resumable. No public
        # media URL or separate hosting package required for Reels/video Stories.
        data = {'media_type':'STORIES' if job['format']=='story' else 'REELS',
                'upload_type':'resumable'}
        if job['format']!='story':
            data['caption']=job['caption'] or ''
    else:
        # Automatically create the correct 9:16 story or supported feed JPEG.
        # The original PNG/JPEG stays intact. No Cloud Bucket is needed.
        await asyncio.to_thread(instagram_ready_jpeg, media, job['format'])
        url = (await asyncio.to_thread(gcs_signed_media_url,media,360,job['format'])
               if media_cloud_enabled() and not CLOUD_MODE
               else secure_media_url(media['id'], minutes=360,
                                     instagram_format=job['format']))
        data = {'image_url':url}
        if job['format']=='story':
            data['media_type']='STORIES'
        else:
            data['caption'] = job['caption'] or ''
    async with httpx.AsyncClient(timeout=httpx.Timeout(300,connect=30),follow_redirects=False) as client:
        try:
            c = instagram_require_ok(await client.post(f'{endpoint}/{ig_id}/media',
                headers={'Authorization':'Bearer '+token},data=data), 'Container erstellen')
        except RuntimeError as exc:
            if is_video:
                raise RuntimeError('Instagram: Video-Container nicht erstellt. '
                    'Bitte Meta-Login, Instagram-Professional-Konto und Publishing-Berechtigung prüfen. '
                    +str(exc)[:650]) from None
            raise
        mid = c.get('id')
        if not mid:
            raise RuntimeError('Instagram: Kein Mediencontainer erzeugt.')
        if is_video:
            upload_uri=instagram_upload_uri(c,mid)
            try:
                await instagram_upload_file(client,token,upload_uri,MEDIA / media['filename'])
            except InstagramTransferRejected as upload_error:
                # Do not blindly retry ambiguous requests. Only an explicitly
                # rejected 4xx upload may switch to a *new* container, and only
                # if the existing cloud media storage is configured.
                if upload_error.status_code != 400 or not media_cloud_enabled():
                    raise RuntimeError(str(upload_error)+
                        ' Der Mediencontainer wurde erstellt, aber Meta hat die Binärdatei abgelehnt. '
                        'Prüfe MP4/H.264/AAC; falls vorhanden, kann '
                        'der vorhandene Google-Cloud-Speicher als alternativer Übertragungsweg genutzt werden.') from None
                try:
                    video_url=await asyncio.to_thread(gcs_signed_video_url,media)
                    fallback_data={'media_type':data['media_type'],'video_url':video_url}
                    if job['format']!='story':
                        fallback_data['caption']=job['caption'] or ''
                    fallback=instagram_require_ok(await client.post(f'{endpoint}/{ig_id}/media',
                        headers={'Authorization':'Bearer '+token},data=fallback_data),
                        'Alternativer Video-Container')
                    if not fallback.get('id'):
                        raise RuntimeError('Kein alternativer Mediencontainer zurückgegeben.')
                    mid=fallback['id']
                    # Signed URL is sent only to Meta, never to app responses/logs.
                except Exception as fallback_exc:
                    raise RuntimeError(str(upload_error)+' Alternative Übertragung über '
                        'den eingerichteten Cloudspeicher ebenfalls fehlgeschlagen '
                        '('+type(fallback_exc).__name__+'). Keine automatische '
                        'Wiederholung eingeplant; bitte Fehler prüfen.') from None
        # The container may take several minutes to process. Do not publish early.
        for poll_idx in range(33):
            q = instagram_require_ok(await client.get(f'{endpoint}/{mid}',headers={'Authorization':'Bearer '+token},
                params={'fields':'status_code,status'}), 'Videoverarbeitung')
            if q.get('status_code')=='FINISHED':
                break
            if q.get('status_code') in ('ERROR','EXPIRED'):
                raise RuntimeError('Instagram: Medienverarbeitung fehlgeschlagen ('+
                      str(q.get('status') or q['status_code'])[:190]+').')
            if q.get('status_code')=='PUBLISHED':
                raise RuntimeError('Instagram: Beitrag scheint bereits veröffentlicht. '
                                   'Vor Wiederholung im Instagram-Konto prüfen.')
            await asyncio.sleep(3 if poll_idx < 3 else 10)
        else:
            raise RuntimeError('Instagram: Video/Story verarbeitet noch. '
                               'Vor erneutem Versuch bei Instagram prüfen (Duplikat-Schutz).')
        pub = instagram_require_ok(await client.post(f'{endpoint}/{ig_id}/media_publish',
            headers={'Authorization':'Bearer '+token},data={'creation_id':mid}), 'Veröffentlichen')
        if not pub.get('id'):
            raise RuntimeError('Instagram: Veröffentlichung unklar; vor erneutem Senden prüfen.')
        mode = 'Story' if job['format']=='story' else ('Reel' if is_video else 'Beitrag')
        return 'Instagram-'+mode+' #'+str(pub['id'])


async def refresh_google(acc):
    if not acc.get('refresh_enc'):
        return decrypt(acc['access_enc'])
    exp = acc.get('expires_at')
    exp_dt = _parse_utc(exp)
    if exp_dt and exp_dt > datetime.now(timezone.utc)+timedelta(minutes=3):
        return decrypt(acc['access_enc'])
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post('https://oauth2.googleapis.com/token', data={
            'client_id':setting('google_client_id'),'client_secret':setting('google_client_secret'),
            'refresh_token':decrypt(acc['refresh_enc']),'grant_type':'refresh_token'})
    obj = require_ok(resp)
    token=obj['access_token']
    exp=(datetime.now(timezone.utc)+timedelta(seconds=obj.get('expires_in',3600))).isoformat()
    with dbconn() as db:
        db.execute('UPDATE connections SET access_enc=?, expires_at=?,checked_at=? WHERE id=?',
                   (encrypt(token),exp,now(),acc['id']))
    return token


async def publish_youtube(job, media, acc):
    if job['format']!='video' or media['mime']!='video/mp4':
        raise RuntimeError('MANUAL: YouTube unterstützt hier nur MP4-Videos, keine Bild-Stories.')
    privacy = job.get('youtube_privacy') or 'private'
    if privacy not in {'private', 'unlisted', 'public'}:
        raise RuntimeError('YouTube: Ungültige Sichtbarkeit. Veröffentlichung abgebrochen.')
    token = await refresh_google(acc)
    path = MEDIA / media['filename']
    size = path.stat().st_size
    async with httpx.AsyncClient(timeout=300,follow_redirects=False) as client:
        r = await client.post('https://www.googleapis.com/upload/youtube/v3/videos',
            params={'uploadType':'resumable','part':'snippet,status'},
            headers={'Authorization':'Bearer '+token,'X-Upload-Content-Length':str(size),
                     'X-Upload-Content-Type':'video/mp4','Content-Type':'application/json'},
            json={'snippet':{'title':(job['caption'] or media['original_name'])[:95],
                             'description':job['caption'] or ''},
                  'status':{'privacyStatus':privacy}})
        if r.status_code >= 400:
            raise RuntimeError(redact_error(r))
        location = r.headers.get('Location','')
        if not location.startswith('https://www.googleapis.com/'):
            raise RuntimeError('YouTube Upload-URL fehlt oder ist ungewöhnlich')
        r = await asyncio.to_thread(
            _stream_binary_request, 'PUT', location,
            {'Content-Type':'video/mp4'}, path, 0, size, 300.0)
        obj = require_ok(r)
        if not obj.get('id'):
            raise RuntimeError('YouTube-Uploadergebnis unklar, Video prüfen')
        visibility_label={'private':'privat','unlisted':'nicht gelistet','public':'öffentlich'}[privacy]
        reported=(obj.get('status') or {}).get('privacyStatus')
        if reported and reported!=privacy:
            return ('YouTube-Video hochgeladen: '+obj['id']+' – ACHTUNG: YouTube meldet Sichtbarkeit '
                    +reported+' statt '+visibility_label+'. Bitte in YouTube Studio prüfen.')
        return ('YouTube-Video hochgeladen; gewünschte Sichtbarkeit: '+visibility_label
                +'. In YouTube Studio prüfen: '+obj['id'])



# TikTok: official Login Kit and Content Posting API only. Stories are NOT supported.
async def refresh_tiktok(acc):
    expires=acc.get('expires_at')
    exp_dt = _parse_utc(expires)
    if exp_dt and exp_dt>datetime.now(timezone.utc)+timedelta(minutes=5):
        return decrypt(acc['access_enc'])
    refresh=decrypt(acc.get('refresh_enc',''))
    if not refresh:
        raise RuntimeError('TikTok-Sitzung abgelaufen. Bitte erneut mit TikTok anmelden.')
    async with httpx.AsyncClient(timeout=30) as client:
        data=tiktok_response(await client.post('https://open.tiktokapis.com/v2/oauth/token/',data={
            'client_key':setting('tiktok_client_key'),'client_secret':setting('tiktok_client_secret'),
            'grant_type':'refresh_token','refresh_token':refresh}))
    token=data['access_token']
    new_refresh=data.get('refresh_token')
    if not new_refresh:
        raise RuntimeError('TikTok hat keinen gültigen neuen Refresh-Token geliefert.')
    expiry=(datetime.now(timezone.utc)+timedelta(seconds=int(data.get('expires_in',7200)))).isoformat()
    with dbconn() as db:
        db.execute('UPDATE connections SET access_enc=?,refresh_enc=?,expires_at=?,checked_at=?,status=? WHERE id=?',
                   (encrypt(token),encrypt(new_refresh),expiry,now(),'connected',acc['id']))
    return token


async def tiktok_creator_info(acc):
    token=await refresh_tiktok(acc)
    async with httpx.AsyncClient(timeout=30) as client:
        response=await client.post('https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
            headers={'Authorization':'Bearer '+token})
    info=tiktok_response(response).get('data',{})
    return {'creator_username':info.get('creator_username',''),
            'creator_nickname':info.get('creator_nickname',''),
            'privacy_level_options':info.get('privacy_level_options',[]),
            'comment_disabled':bool(info.get('comment_disabled',False)),
            'duet_disabled':bool(info.get('duet_disabled',False)),
            'stitch_disabled':bool(info.get('stitch_disabled',False)),
            'max_video_post_duration_sec':info.get('max_video_post_duration_sec')}


def tiktok_photo_url(media):
    # Cloud Storage signed googleapis.com URLs are NOT verified TikTok URL properties.
    # TikTok accepts only a verified host/prefix, owned by this developer app.
    prefix=setting('tiktok_verified_media_prefix').strip()
    if not prefix or not prefix.startswith('https://') or not prefix.endswith('/'):
        raise RuntimeError('MANUAL: TikTok-Fotos brauchen ein bei TikTok verifiziertes HTTPS-URL-Präfix, das mit / endet. Google-Storage-Links allein reichen dafür nicht.')
    if not public_base().startswith('https://'):
        raise RuntimeError('MANUAL: TikTok-Foto benötigt einen öffentlich erreichbaren HTTPS-TimeSave-Social-Server oder eine verifizierte Medien-Domain.')
    result=secure_media_url(media['id'],minutes=240)
    if not result.startswith(prefix):
        raise RuntimeError('MANUAL: Die TimeSave-Social-Medienadresse passt nicht zum verifizierten TikTok-URL-Präfix.')
    if media['mime']!='image/jpeg':
        raise RuntimeError('MANUAL: TikTok-Photo Direct Post erwartet JPG. Nutze „Fotos vorbereiten“ für PNGs.')
    path=MEDIA/media['filename']
    if not path.is_file() or not 0<path.stat().st_size<=20*1024*1024:
        raise RuntimeError('MANUAL: TikTok-Bild ist nicht vorhanden oder über 20 MB groß.')
    return result


def checked_tiktok_upload_url(url):
    # Upload URL includes a secret upload token in query params; do not log it.
    parsed=urlsplit(url)
    if parsed.scheme!='https' or not parsed.hostname or not (parsed.hostname.endswith('.tiktokapis.com') or parsed.hostname=='tiktokapis.com'):
        raise RuntimeError('TikTok hat eine ungültige Upload-Adresse geliefert.')
    return url


async def tiktok_publish_status(acc,publish_id):
    token=await refresh_tiktok(acc)
    async with httpx.AsyncClient(timeout=30) as client:
        result=tiktok_response(await client.post('https://open.tiktokapis.com/v2/post/publish/status/fetch/',
            headers={'Authorization':'Bearer '+token},json={'publish_id':publish_id}))
    info=result.get('data',{})
    return info.get('status','UNKNOWN'),info.get('fail_reason','')


def tiktok_photo_items(job, primary):
    """Ordered list; V17.2 jobs with no photo list remain single-image posts."""
    try: identifiers=json.loads(job.get('tiktok_photo_ids') or '[]')
    except (TypeError,ValueError): raise RuntimeError('MANUAL: Ungültige TikTok-Fotoliste.') from None
    if not identifiers: identifiers=[primary['id']]
    if not isinstance(identifiers,list) or not 1<=len(identifiers)<=35 or len(set(identifiers))!=len(identifiers):
        raise RuntimeError('MANUAL: TikTok-Bilderreihe benötigt 1 bis 35 unterschiedliche Fotos.')
    result=[]
    for ident in identifiers:
        photo=media_row(ident)
        if photo['mime']!='image/jpeg':
            raise RuntimeError('MANUAL: TikTok-Fotos brauchen JPEG. PNG bitte vorher als JPG exportieren.')
        result.append(photo)
    cover=int(job.get('tiktok_photo_cover') or 0)
    if not 0<=cover<len(result):
        raise RuntimeError('MANUAL: TikTok-Titelbild liegt außerhalb der Bilderreihe.')
    return result,cover


def truncate_utf16(value,limit):
    """TikTok specifies length in UTF-16 code units, including emoji."""
    units=0
    for i,char in enumerate(value):
        units+=2 if ord(char)>0xffff else 1
        if units>limit:return value[:i]
    return value


async def publish_tiktok(job,media,acc):
    if job['format']=='story':
        raise RuntimeError('MANUAL: TikTok-Stories werden von der offiziellen Posting-API nicht unterstützt.')
    if not job.get('tiktok_approved'):
        raise RuntimeError('MANUAL: Für diesen TikTok-Beitrag fehlt die ausdrückliche Veröffentlichungsfreigabe.')
    if job['format'] not in {'post','video'}:
        raise RuntimeError('MANUAL: TikTok-Reels/Stories sind nicht als API-Format verfügbar; Beitragsformat oder Video wählen.')
    if job['format']=='post' and media['mime'] not in ('image/jpeg', 'image/png'):
        raise RuntimeError('MANUAL: TikTok-Fotobeitrag braucht JPG/PNG.')
    if job['format']=='video' and media['mime']!='video/mp4':
        raise RuntimeError('MANUAL: TikTok-Video braucht eine MP4-Datei.')
    is_inbox = (job.get('tiktok_post_mode') or 'direct') == 'inbox'
    creator=await tiktok_creator_info(acc)
    privacy=job.get('tiktok_privacy') or 'SELF_ONLY'
    if not is_inbox and privacy not in creator['privacy_level_options']:
        raise RuntimeError('MANUAL: Gewählte TikTok-Sichtbarkeit wird für dieses Konto nicht angeboten. Bitte erneut bestätigen.')
    token=await refresh_tiktok(acc)
    heads={'Authorization':'Bearer '+token,'Content-Type':'application/json; charset=UTF-8'}
    title=(job.get('caption') or media['original_name'])[:2200]
    post_info={'privacy_level':privacy,'disable_comment':bool(creator['comment_disabled'] or job.get('tiktok_disable_comment'))}
    if job['format']=='post':
        photos,cover=tiktok_photo_items(job,media)
        urls=[tiktok_photo_url(photo) for photo in photos]
        headline=job.get('tiktok_photo_title') or (title.splitlines()[0] if title.splitlines() else media['original_name'])
        post_info.update(title=truncate_utf16(headline,90),description=truncate_utf16(title,4000),
                         auto_add_music=bool(job.get('tiktok_auto_music')),
                         brand_organic_toggle=bool(job.get('tiktok_brand_organic')),
                         brand_content_toggle=bool(job.get('tiktok_brand_content')))
        request={'post_mode':'MEDIA_UPLOAD' if is_inbox else 'DIRECT_POST','media_type':'PHOTO',
                 'source_info':{'source':'PULL_FROM_URL','photo_cover_index':cover,'photo_images':urls}}
        if is_inbox:
            request['post_info']={'title':truncate_utf16(headline,90),'description':truncate_utf16(title,4000)}
        else:
            request['post_info']=post_info
            request['is_aigc']=bool(job.get('tiktok_aigc'))
        async with httpx.AsyncClient(timeout=35) as client:
            data=tiktok_response(await client.post('https://open.tiktokapis.com/v2/post/publish/content/init/',
                headers=heads,json=request))
        pid=data.get('data',{}).get('publish_id')
    else:
        path=MEDIA/media['filename']
        size=path.stat().st_size
        if size<1 or size>100*1024*1024:
            raise RuntimeError('MANUAL: TikTok-Videodatei muss zwischen 1 Byte und 100 MB groß sein.')
        chunk=size if size<=64*1024*1024 else size//2
        chunk_count=size//chunk
        if is_inbox:
            request={'source_info':{'source':'FILE_UPLOAD',
                'video_size':size,'chunk_size':chunk,'total_chunk_count':chunk_count}}
            init_url='https://open.tiktokapis.com/v2/post/publish/inbox/video/init/'
        else:
            post_info.update(
                title=title,
                disable_duet=bool(creator['duet_disabled'] or job.get('tiktok_disable_duet')),
                disable_stitch=bool(creator['stitch_disabled'] or job.get('tiktok_disable_stitch')),
                brand_organic_toggle=bool(job.get('tiktok_brand_organic')),
                brand_content_toggle=bool(job.get('tiktok_brand_content')),
                is_aigc=bool(job.get('tiktok_aigc')),
            )
            request={'post_info':post_info,'source_info':{'source':'FILE_UPLOAD',
                'video_size':size,'chunk_size':chunk,'total_chunk_count':chunk_count}}
            init_url='https://open.tiktokapis.com/v2/post/publish/video/init/'
        async with httpx.AsyncClient(timeout=40) as client:
            data=tiktok_response(await client.post(init_url,headers=heads,json=request))
        info=data.get('data',{})
        pid=info.get('publish_id')
        if not pid or not info.get('upload_url'):
            raise RuntimeError('TikTok: Video-Upload nicht initialisiert, bitte prüfen.')
        upload_url=checked_tiktok_upload_url(info['upload_url'])
        for index in range(chunk_count):
            start=index*chunk
            length=chunk if index<chunk_count-1 else size-start
            try:
                r=await asyncio.to_thread(
                    _stream_binary_request, 'PUT', upload_url,
                    {'Content-Type':'video/mp4',
                     'Content-Range':f'bytes {start}-{start+length-1}/{size}'},
                    path, start, length, 150.0)
            except (httpx.HTTPError, OSError):
                # Upload URLs contain one-time secret query parameters: never log exceptions.
                raise RuntimeError('TikTok-Video-Upload: Netzwerkfehler. Status prüfen, bevor erneut gesendet wird.') from None
            if r.status_code not in (201,206):
                raise RuntimeError(f'TikTok Video-Upload HTTP {r.status_code}. Vor erneutem Senden erst TikTok-Status prüfen.')
    if not pid:
        raise RuntimeError('TikTok: Keine publish_id in der API-Antwort, bitte Veröffentlichung prüfen.')
    done_msg = (
        'Als Entwurf an deine TikTok-Inbox gesendet (in der TikTok-App Trend-Sound & Feinschliff ergänzen).'
        if is_inbox else
        'TikTok-Upload eingereicht; Bestätigung der Veröffentlichung steht noch aus.'
    )
    return {'status':'awaiting_confirmation','publish_id':pid,'message':done_msg}


async def poll_tiktok_pending():
    threshold=(datetime.now(timezone.utc)-timedelta(seconds=12)).isoformat()
    with dbconn() as db:
        pending=[dict(r) for r in db.execute("SELECT * FROM jobs WHERE platform='tiktok' AND status='awaiting_confirmation' AND (last_poll_at='' OR last_poll_at<?) ORDER BY due_at LIMIT 40",(threshold,))]
    for job in pending:
        try:
            if not job['publish_id'] or not job['connection_id']:
                raise RuntimeError('TikTok Status-ID oder Konto fehlt')
            acc=get_account(job['connection_id'])
            state,reason=await tiktok_publish_status(acc,job['publish_id'])
            norm_state=(state or '').strip().upper()
            if norm_state=='PUBLISH_COMPLETE':
                status='published';message='TikTok hat Veröffentlichung bestätigt ('+norm_state+'): '+job['publish_id']
            elif norm_state=='SEND_TO_USER_INBOX':
                status='published';message='TikTok hat Entwurf an Inbox übergeben ('+norm_state+'): '+job['publish_id']
            elif norm_state=='FAILED':
                status='needs_review';message='TikTok-Veröffentlichung fehlgeschlagen: '+(reason or norm_state)[:180]
            else:
                state_label = norm_state or 'PROCESSING'
                status='awaiting_confirmation'
                message=f'TikTok verarbeitet noch ({state_label}) – erst bei endgültiger TikTok-Bestätigung wird auf Veröffentlicht gesetzt.'
        except Exception as exc:
            # Never mark as published while TikTok status is pending or uncertain.
            status='awaiting_confirmation'
            message='TikTok verarbeitet noch / Statusabfrage läuft weiter ('+type(exc).__name__+').'
        with dbconn() as db:
            db.execute("UPDATE jobs SET status=?,result=?,published_at=?,last_poll_at=? WHERE id=? AND status='awaiting_confirmation'",
                (status,message,now() if status=='published' else None,now(),job['id']))


async def poll_facebook_video_pending():
    """Do not label an accepted video upload as finished before Meta processed it."""
    threshold=(datetime.now(timezone.utc)-timedelta(seconds=90)).isoformat()
    with dbconn() as db:
        pending=[dict(r) for r in db.execute(
            "SELECT * FROM jobs WHERE platform='facebook' AND status='awaiting_confirmation' AND publish_id != '' AND (last_poll_at='' OR last_poll_at<?) ORDER BY due_at LIMIT 30",(threshold,))]
    for job in pending:
        status='awaiting_confirmation'
        message='Meta verarbeitet das Video.'
        try:
            acc=get_account(job['connection_id'])
            token=decrypt(acc['access_enc'])
            async with httpx.AsyncClient(timeout=40) as client:
                response=require_ok(await client.get(f"{GRAPH}/{job['publish_id']}",
                    headers={'Authorization':'Bearer '+token},params={'fields':'status'}))
            state=response.get('status',{}) or {}
            video_status=(state.get('video_status') or '').lower()
            publish_phase=(state.get('publishing_phase') or {}).get('status','').lower()
            if video_status in ('ready','published') or publish_phase=='complete':
                status='published'
                message='Facebook-Video ist nach Meta-Status verarbeitet. Video-ID '+str(job['publish_id'])
            elif video_status in ('error','expired','upload_failed'):
                status='needs_review'
                message='Facebook-Videotranscodierung fehlgeschlagen: '+video_status
            else:
                message='Facebook-Video in Verarbeitung: '+(video_status or 'Status ausstehend')[:80]
                due_dt = _parse_utc(job.get('due_at'))
                if due_dt and due_dt < datetime.now(timezone.utc)-timedelta(hours=2):
                    status='needs_review'
                    message='Facebook-Verarbeitung länger als 2 Stunden unbestätigt; vor Wiederholung direkt bei Facebook prüfen.'
        except Exception as exc:
            message='Facebook-Video-Status nicht abrufbar ('+type(exc).__name__+'); direkt bei Facebook prüfen.'
        with dbconn() as db:
            db.execute("UPDATE jobs SET status=?,result=?,published_at=?,last_poll_at=? WHERE id=? AND status='awaiting_confirmation'",
                (status,message,now() if status=='published' else None,now(),job['id']))




THREADS_GRAPH = 'https://graph.threads.net/v1.0'
THREADS_OAUTH_TOKEN = 'https://graph.threads.net/oauth/access_token'
THREADS_LONG_TOKEN = 'https://graph.threads.net/access_token'
THREADS_REFRESH_TOKEN = 'https://graph.threads.net/refresh_access_token'


def _threads_app_credentials():
    app_id = (setting('threads_app_id') or setting('meta_app_id') or '').strip()
    app_secret = (setting('threads_app_secret') or setting('meta_app_secret') or '').strip()
    return app_id, app_secret


async def threads_exchange_code(client: httpx.AsyncClient, code: str, redirect: str):
    app_id, app_secret = _threads_app_credentials()
    if not app_id or not app_secret:
        raise RuntimeError('Threads App-ID oder App Secret fehlt.')
    short_resp = await client.post(THREADS_OAUTH_TOKEN, data={
        'client_id': app_id,
        'client_secret': app_secret,
        'grant_type': 'authorization_code',
        'redirect_uri': redirect,
        'code': code,
    })
    short_data = require_ok(short_resp)
    if isinstance(short_data.get('data'), list) and short_data['data'] and not short_data.get('access_token'):
        short_data = short_data['data'][0]
    short_token = short_data.get('access_token')
    if not short_token:
        raise RuntimeError('Threads hat keinen Kurzzeit-Access-Token geliefert.')
    long_resp = await client.get(THREADS_LONG_TOKEN, params={
        'grant_type': 'th_exchange_token',
        'client_secret': app_secret,
        'access_token': short_token,
    })
    long_data = require_ok(long_resp)
    long_token = long_data.get('access_token') or short_token
    lifetime = int(long_data.get('expires_in') or 5184000)
    me_resp = await client.get(f'{THREADS_GRAPH}/me',
        headers={'Authorization': 'Bearer ' + long_token},
        params={'fields': 'id,username,name'})
    info = require_ok(me_resp)
    if not info.get('id'):
        raise RuntimeError('Threads: Profil-ID konnte nicht geladen werden.')
    return info, long_token, lifetime


async def refresh_threads(acc: dict, force: bool = False) -> str:
    token = decrypt(acc['access_enc'])
    if not token:
        raise RuntimeError('Threads-Token fehlt. Bitte Threads neu verbinden.')
    expires = acc.get('expires_at')
    if expires:
        exp_dt = _parse_utc(expires)
        if exp_dt is not None:
            if exp_dt <= datetime.now(timezone.utc):
                raise RuntimeError('Threads-Token ist abgelaufen. Bitte Threads neu verbinden.')
            if not force and exp_dt > datetime.now(timezone.utc) + timedelta(days=7):
                return token
    metadata = json.loads(acc.get('metadata') or '{}')
    issued_dt = _parse_utc(metadata.get('token_updated_at')) or datetime.now(timezone.utc)
    if not force and datetime.now(timezone.utc) - issued_dt < timedelta(hours=24):
        return token
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(THREADS_REFRESH_TOKEN, params={
            'grant_type': 'th_refresh_token',
            'access_token': token,
        })
        data = require_ok(resp)
    new_token = data.get('access_token')
    lifetime = int(data.get('expires_in') or 0)
    if not new_token or lifetime <= 0:
        return token
    new_expiry = (datetime.now(timezone.utc) + timedelta(seconds=lifetime)).isoformat()
    metadata['token_updated_at'] = now()
    with dbconn() as db:
        db.execute(
            'UPDATE connections SET access_enc=?,expires_at=?,metadata=?,checked_at=?,status=? WHERE id=?',
            (encrypt(new_token), new_expiry, json.dumps(metadata), now(), 'connected', acc['id']),
        )
    return new_token


async def refresh_threads_accounts_auto():
    with dbconn() as db:
        rows = [dict(x) for x in db.execute("SELECT * FROM connections WHERE provider='threads'")]
    for acc in rows:
        try:
            await refresh_threads(acc)
        except Exception:
            with dbconn() as db:
                db.execute("UPDATE connections SET status='error',checked_at=? WHERE id=?", (now(), acc['id']))


async def publish_threads(job, media, acc):
    if job['format'] not in {'post', 'reel', 'video'}:
        raise RuntimeError('MANUAL: Threads unterstützt Beiträge sowie 9:16-Videos/Reels (keine 24h-Stories).')
    is_video = media['mime'] == 'video/mp4'
    if media['mime'] not in {'image/jpeg', 'image/png', 'video/mp4'}:
        raise RuntimeError('MANUAL: Threads erwartet JPG/PNG oder MP4.')
    token = await refresh_threads(acc)
    th_user_id = acc['external_id']
    caption = (job.get('caption') or '')[:500]
    if is_video:
        video_path = MEDIA / media['filename']
        if not video_path.is_file() or video_path.stat().st_size == 0:
            raise RuntimeError('Threads: Die MP4-Datei fehlt oder ist leer.')
        media_url = (
            await asyncio.to_thread(gcs_signed_video_url, media)
            if media_cloud_enabled() and not CLOUD_MODE
            else secure_media_url(media['id'], minutes=360)
        )
        payload = {'media_type': 'VIDEO', 'video_url': media_url}
    else:
        await asyncio.to_thread(instagram_ready_jpeg, media, 'post')
        media_url = (
            await asyncio.to_thread(gcs_signed_media_url, media, 360, 'post')
            if media_cloud_enabled() and not CLOUD_MODE
            else secure_media_url(media['id'], minutes=360, instagram_format='post')
        )
        payload = {'media_type': 'IMAGE', 'image_url': media_url}
    if caption:
        payload['text'] = caption
    async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=30), follow_redirects=False) as client:
        create_resp = await client.post(
            f'{THREADS_GRAPH}/{th_user_id}/threads',
            headers={'Authorization': 'Bearer ' + token},
            data=payload,
        )
        container = require_ok(create_resp)
        cid = container.get('id')
        if not cid:
            raise RuntimeError('Threads: Kein Mediencontainer erstellt.')
        for poll_idx in range(30):
            status_resp = await client.get(
                f'{THREADS_GRAPH}/{cid}',
                headers={'Authorization': 'Bearer ' + token},
                params={'fields': 'status,error_message'},
            )
            st_obj = require_ok(status_resp)
            st_code = (st_obj.get('status') or '').upper()
            if st_code == 'FINISHED':
                break
            if st_code in ('ERROR', 'EXPIRED'):
                err_msg = st_obj.get('error_message') or st_code
                raise RuntimeError(f'Threads: Medienverarbeitung fehlgeschlagen ({str(err_msg)[:200]}).')
            if st_code == 'PUBLISHED':
                return 'Threads-Beitrag #' + str(cid)
            await asyncio.sleep(3 if poll_idx < 4 else 8)
        else:
            raise RuntimeError('Threads: Video/Bild verarbeitet noch. Vor erneutem Senden im Threads-Profil prüfen.')
        pub_resp = await client.post(
            f'{THREADS_GRAPH}/{th_user_id}/threads_publish',
            headers={'Authorization': 'Bearer ' + token},
            data={'creation_id': cid},
        )
        pub_obj = require_ok(pub_resp)
        pub_id = pub_obj.get('id') or cid
        kind_label = 'Video' if is_video else 'Beitrag'
        return f'Threads-{kind_label} #{pub_id}'


async def publish_linkedin(job, media, acc):
    if job['format'] not in {'post', 'reel', 'video'}:
        raise RuntimeError('MANUAL: LinkedIn unterstützt Feed-Beiträge sowie 9:16-/16:9-Videos (keine Stories).')
    is_video = media['mime'] == 'video/mp4'
    if media['mime'] not in {'image/jpeg', 'image/png', 'video/mp4'}:
        raise RuntimeError('MANUAL: LinkedIn erwartet JPG/PNG oder MP4.')
    token = decrypt(acc['access_enc'])
    if not token:
        raise RuntimeError('LinkedIn-Token fehlt. Bitte LinkedIn neu verbinden.')
    if acc.get('expires_at'):
        exp_dt = _parse_utc(acc.get('expires_at'))
        if exp_dt is not None and exp_dt <= datetime.now(timezone.utc):
            raise RuntimeError('LinkedIn-Token abgelaufen. Bitte LinkedIn erneut verbinden.')
    ext_id = str(acc['external_id'])
    author_urn = ext_id if ext_id.startswith('urn:li:') else f'urn:li:person:{ext_id}'
    path = MEDIA / media['filename']
    if not path.is_file() or path.stat().st_size == 0:
        raise RuntimeError('LinkedIn: Mediendatei fehlt oder ist leer.')
    size = path.stat().st_size
    recipe = 'urn:li:digitalmediaRecipe:feedshare-video' if is_video else 'urn:li:digitalmediaRecipe:feedshare-image'
    media_category = 'VIDEO' if is_video else 'IMAGE'
    li_headers = {
        'Authorization': 'Bearer ' + token,
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
    }
    register_body = {
        'registerUploadRequest': {
            'recipes': [recipe],
            'owner': author_urn,
            'serviceRelationships': [
                {'relationshipType': 'OWNER', 'identifier': 'urn:li:userGeneratedContent'}
            ],
        }
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=30), follow_redirects=False) as client:
        reg_resp = await client.post(
            'https://api.linkedin.com/v2/assets?action=registerUpload',
            headers=li_headers,
            json=register_body,
        )
        reg_data = require_ok(reg_resp)
        val = reg_data.get('value') or {}
        asset_urn = val.get('asset')
        upload_mech = (val.get('uploadMechanism') or {}).get(
            'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'
        ) or {}
        upload_url = upload_mech.get('uploadUrl')
        if not asset_urn or not upload_url:
            raise RuntimeError('LinkedIn: Upload-Registrierung unvollständig.')
        put_headers = {
            'Authorization': 'Bearer ' + token,
            'Content-Type': media['mime'],
        }
        for hk, hv in (upload_mech.get('headers') or {}).items():
            put_headers[hk] = hv
        up_resp = await asyncio.to_thread(
            _stream_binary_request, 'PUT', upload_url, put_headers, path, 0, size, 300.0
        )
        if up_resp.status_code >= 400:
            raise RuntimeError(f'LinkedIn Medien-Upload fehlgeschlagen (HTTP {up_resp.status_code}).')
        caption = (job.get('caption') or '').strip()[:3000]
        ugc_body = {
            'author': author_urn,
            'lifecycleState': 'PUBLISHED',
            'specificContent': {
                'com.linkedin.ugc.ShareContent': {
                    'shareCommentary': {'text': caption},
                    'shareMediaCategory': media_category,
                    'media': [
                        {
                            'status': 'READY',
                            'media': asset_urn,
                            'title': {'text': (media.get('original_name') or 'TimeSave Social')[:180]},
                        }
                    ],
                }
            },
            'visibility': {'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'},
        }
        post_resp = await client.post(
            'https://api.linkedin.com/v2/ugcPosts',
            headers=li_headers,
            json=ugc_body,
        )
        post_data = require_ok(post_resp)
        post_id = post_data.get('id') or post_resp.headers.get('x-restli-id') or asset_urn
        kind_label = 'Video' if is_video else 'Beitrag'
        return f'LinkedIn-{kind_label} veröffentlicht ({post_id})'


async def dispatch(job,media):
    if not job.get('connection_id'):
        raise RuntimeError('MANUAL: Kein verbundenes Zielkonto ausgewählt.')
    account = get_account(job['connection_id'])
    if account['provider'] != job['platform']:
        raise RuntimeError('Konto gehört nicht zu dieser Plattform')
    if account['provider']=='telegram':
        return await publish_telegram(job,media,account)
    if account['provider']=='telegram_story':
        return await publish_telegram_story(job,media,account)
    if account['provider']=='facebook':
        return await publish_facebook(job,media,account)
    if account['provider']=='instagram':
        return await publish_instagram(job,media,account)
    if account['provider']=='youtube':
        return await publish_youtube(job,media,account)
    if account['provider']=='threads':
        return await publish_threads(job,media,account)
    if account['provider']=='linkedin':
        return await publish_linkedin(job,media,account)
    if account['provider']=='tiktok':
        return await publish_tiktok(job,media,account)
    raise RuntimeError('MANUAL: Für '+job['platform']+' ist diese Veröffentlichungsart nicht offiziell automatisiert.')


def previous_story_status(db, job):
    """For a numbered four-part series, block part N until N-1 is confirmed.

    Existing V6 records are supported, including series repeated on multiple days.
    Matching is limited to the same platform and connected account, and the
    most recently due predecessor, so platforms don't block each other.
    """
    if not job['series_id'] or job['position'] <= 1:
        return None
    return db.execute('SELECT id,status,position FROM jobs WHERE series_id=? AND platform=? AND connection_id IS ? AND position=? AND due_at <= ? ORDER BY due_at DESC LIMIT 1',
        (job['series_id'], job['platform'], job['connection_id'],
         job['position']-1, job['due_at'])).fetchone()


async def process_due():
    if CLOUD_MODE and (MIGRATION_ACTIVE or not cloud_publishing_enabled()):
        return
    async with _PROCESS_DUE_LOCK:
        await _process_due_unlocked()


async def _process_due_unlocked():
    if CLOUD_MODE and (MIGRATION_ACTIVE or not cloud_publishing_enabled()):
        return
    # Claim each job immediately before sending. Never pre-claim all four steps:
    # doing so could send Card 2 even if Card 1 fails or is still processing.
    # This also preserves ordering when a whole sequence is already overdue.
    with dbconn() as db:
        due_ids = [r['id'] for r in db.execute(
            "SELECT id FROM jobs WHERE status='scheduled' AND due_at<=? AND (retry_at IS NULL OR retry_at<=?) ORDER BY due_at,position,id LIMIT 100",
            (now(),now()))]
    for ident in due_ids:
        with dbconn() as db:
            jobrow=db.execute('SELECT * FROM jobs WHERE id=?',(ident,)).fetchone()
            if not jobrow or jobrow['status']!='scheduled':
                continue
            previous=previous_story_status(db, jobrow)
            if previous and previous['status'] not in ('published','published_manual'):
                continue
            claimed=db.execute("UPDATE jobs SET status='processing' WHERE id=? AND status='scheduled'",(ident,))
            if not claimed.rowcount:
                continue
        job=dict(jobrow)
        pid=''
        next_retry_at=None
        attempts=int(job.get('retry_attempts') or 0)
        _publish_progress(ident,3,'Veröffentlichung wird vorbereitet …')
        try:
            result=await dispatch(job,media_row(job['media_id']))
            status='awaiting_confirmation' if isinstance(result,dict) and result.get('status')=='awaiting_confirmation' else 'published'
            pid=result.get('publish_id','') if isinstance(result,dict) else ''
            if isinstance(result,dict): result=result.get('message','')
        except TelegramRetryLater as exc:
            attempts += 1
            if job['platform'] in ('telegram','telegram_story') and attempts <= 3:
                status='scheduled'
                delay=min(300, exc.delay * (2 ** (attempts-1)))
                next_retry_at=(datetime.now(timezone.utc)+timedelta(seconds=delay)).isoformat()
                result=f'{str(exc)} Automatischer Versuch {attempts}/3 in etwa {delay} Sekunden.'
            else:
                status='needs_review'
                result='Telegram: Nach 3 sicheren Wiederholungen weiterhin nicht erreichbar. Bitte Verbindung prüfen.'
        except Exception as exc:
            msg=str(exc)
            status='manual' if msg.startswith('MANUAL:') else 'needs_review'
            result=msg[:650]
        with dbconn() as db:
            db.execute("UPDATE jobs SET status=?,result=?,published_at=?,publish_id=?,retry_at=?,retry_attempts=? WHERE id=? AND status='processing'",
                       (status,result,now() if status=='published' else None,pid,next_retry_at,attempts,ident))
        with _PUBLISH_PROGRESS_LOCK:
            _PUBLISH_PROGRESS.pop(ident,None)


async def scheduler_loop():
    last_meta_check = 0.0
    loop = asyncio.get_running_loop()
    while True:
        try:
            if not CLOUD_MODE or (not MIGRATION_ACTIVE and cloud_publishing_enabled()):
                await process_due()
                await poll_tiktok_pending()
                await poll_facebook_video_pending()
            if loop.time()-last_meta_check >= 24*60*60 and not MIGRATION_ACTIVE and (not CLOUD_MODE or cloud_publishing_enabled()):
                last_meta_check=loop.time()
                await refresh_meta_sessions_auto()
                await refresh_instagram_direct_accounts_auto()
                await refresh_threads_accounts_auto()
                with dbconn() as db:
                    db.execute('DELETE FROM oauth_states WHERE expires_at < ?', (now(),))
                    db.execute('DELETE FROM user_sessions WHERE expires_at < ?', (now(),))
                await asyncio.to_thread(_cleanup_stale_files)
        except Exception as exc:
            # No sensitive data in scheduler logs.
            logger.warning('TimeSave Social scheduler exception: %s', type(exc).__name__)
        try:
            await asyncio.wait_for(_PUBLISH_WAKE.wait(),timeout=12)
        except asyncio.TimeoutError:
            pass
        _PUBLISH_WAKE.clear()



def cloud_publishing_enabled():
    if not CLOUD_MODE:
        return True
    with dbconn() as db:
        row = db.execute("SELECT value FROM cloud_control WHERE key='publishing_enabled'").fetchone()
    # In the Free testing tier, publishing is allowed by default; the user may
    # still pause it with the existing cloud control endpoint. A service spin-
    # down stops the in-process scheduler and the ephemeral DB can disappear.
    if FREE_PREVIEW:
        return row is None or row['value']=='1'
    return bool(row and row['value']=='1')


def cloud_set_publishing(enabled: bool):
    with dbconn() as db:
        db.execute("""INSERT INTO cloud_control(key,value) VALUES('publishing_enabled',?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value""", ('1' if enabled else '0',))


def cloud_runtime_status(owner_id: str | None = None):
    with dbconn() as db:
        if owner_id:
            counts = {key: db.execute('SELECT COUNT(*) FROM ' + key + ' WHERE owner_id=?', (owner_id,)).fetchone()[0]
                      for key in ('jobs', 'connections', 'media')}
        else:
            counts = {key: db.execute('SELECT COUNT(*) FROM ' + key).fetchone()[0]
                      for key in ('jobs', 'connections', 'media')}
    return {'cloud_mode': CLOUD_MODE,
            'free_preview': FREE_PREVIEW,
            'db_backend': DB_BACKEND,
            'persistent_storage_configured': bool((_ts_env('PERSISTENT_STORAGE') == '1' and not FREE_PREVIEW) or DB_BACKEND == 'postgres'),
            'publishing_enabled': cloud_publishing_enabled(),
            'url': public_base() if CLOUD_MODE else 'http://localhost:8000',
            'counts': counts,
            'migration_active': MIGRATION_ACTIVE,
            'runtime_warning': ('Free-Instanz kann nach 15 Minuten ohne eingehende Requests einschlafen; '
              'geplante Jobs laufen nur solange der Prozess aktiv ist. Daten/Medien können bei Neustart verloren gehen.'
              if FREE_PREVIEW else '')}


def cloud_export_archive_bytes(include_media=False):
    """Consistent SQLite snapshot + encryption key and media (NOT the .env)."""
    output=BytesIO()
    with tempfile.TemporaryDirectory(prefix='timesave_export_') as td:
        dst=Path(td)/'timesave.db'
        with sqlite3.connect(DB) as source, sqlite3.connect(dst) as target:
            source.backup(target)
        with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=3) as zf:
            zf.write(dst,'data/timesave.db')
            zf.writestr('data/.secret.key', KEY_BYTES)
            if include_media:
                for p in MEDIA.iterdir():
                    if p.is_file() and not p.name.startswith('.'):
                        zf.write(p,'data/media/'+p.name)
    return output.getvalue()


def cloud_import_archive(source: Path):
    """First-time migration into an EMPTY cloud database, with publishers PAUSED.

    Safety: only a single running uvicorn worker; only allowed ZIP paths; no
    symlinks; validated old key and SQLite integrity BEFORE modifying cloud state.
    """
    global CIPHER, KEY_BYTES, MIGRATION_ACTIVE
    if not CLOUD_MODE:
        raise RuntimeError('Import nur auf einer Cloud-Installation erlaubt.')
    if DB_BACKEND == 'postgres':
        raise RuntimeError('ZIP-Migration ist nur für SQLite-Instanzen gedacht. PostgreSQL-Datenbanken werden direkt über deinen Datenbankanbieter gesichert und wiederhergestellt.')
    with MIGRATION_LOCK:
        MIGRATION_ACTIVE=True
        try:
            if cloud_publishing_enabled():
                raise RuntimeError('Cloud-Veröffentlichungen zuerst pausieren!')
            with dbconn() as db:
                if any(db.execute('SELECT COUNT(*) FROM '+name).fetchone()[0]
                       for name in ('media','jobs','connections','meta_sessions')):
                    raise RuntimeError('Cloud-Import nur in eine frische, leere Installation möglich.')
            with tempfile.TemporaryDirectory(prefix='timesave_migration_') as tmp:
                temp=Path(tmp)
                allowed={'data/timesave.db','data/storypilot.db','data/.secret.key'}
                max_files=30000
                total_bytes=0
                with zipfile.ZipFile(source) as zf:
                    members=zf.infolist()
                    if len(members)>max_files:
                        raise RuntimeError('Zu viele Dateien im Migrationspaket.')
                    names=set()
                    for member in members:
                        path=member.filename
                        if member.is_dir():
                            continue
                        if path == 'BACKUP_HINWEIS.txt':
                            continue
                        if path not in allowed and not (path.startswith('data/media/') and
                           re.fullmatch(r'[0-9a-f]{32}\.(jpg|png|mp4)',path.removeprefix('data/media/'))):
                            raise RuntimeError('Migrationspaket enthält nicht erlaubte Dateien.')
                        # Block links, unusual file types and duplicate paths.
                        if (member.external_attr >> 16 & 0o170000) not in (0, 0o100000):
                            raise RuntimeError('Symlinks im Migrationspaket sind nicht zulässig.')
                        if path in names:
                            raise RuntimeError('Doppelte Dateien im Migrationspaket.')
                        names.add(path)
                        total_bytes+=member.file_size
                        if total_bytes>3*1024**3 or member.file_size>1024**3:
                            raise RuntimeError('Migrationspaket überschreitet die maximale Größe.')
                    if not allowed.issubset(names):
                        raise RuntimeError('Es fehlen timesave.db oder .secret.key.')
                    zf.extractall(temp)
                old_key=(temp/'data/.secret.key').read_bytes()
                tested=Fernet(old_key)
                candidate=(temp/'data/timesave.db') if (temp/'data/timesave.db').exists() else (temp/'data/storypilot.db')
                with sqlite3.connect('file:'+str(candidate)+'?mode=ro',uri=True) as test_db:
                    integrity=test_db.execute('PRAGMA integrity_check').fetchone()[0]
                    if integrity!='ok':
                        raise RuntimeError('Die SQLite-Datenbank ist beschädigt.')
                    test_db.row_factory=sqlite3.Row
                    cols={r['name'] for r in test_db.execute('PRAGMA table_info(connections)')}
                    if not {'access_enc','provider'}.issubset(cols):
                        raise RuntimeError('Ungültige TimeSave-Social-Datenbank.')
                    sample=test_db.execute('SELECT access_enc FROM connections WHERE access_enc IS NOT NULL AND access_enc!=\'\' LIMIT 1').fetchone()
                    if sample:
                        tested.decrypt(sample['access_enc'].encode())
                    expected={r[0] for r in test_db.execute('SELECT filename FROM media')}
                available={x.name for x in (temp/'data/media').glob('*')} if (temp/'data/media').exists() else set()
                if expected - available:
                    raise RuntimeError('Migrationspaket fehlen Medien für die Datenbank.')
                for item in (temp/'data/media').glob('*'):
                    shutil.copy2(item,MEDIA/item.name)
                with sqlite3.connect(candidate) as src, sqlite3.connect(DB) as dst:
                    src.backup(dst)
                KEY_FILE.write_bytes(old_key)
                try:
                    os.chmod(KEY_FILE,0o600)
                except OSError:
                    pass
                KEY_BYTES=old_key
                CIPHER=tested
                init_db()
                cloud_set_publishing(False)
            return cloud_runtime_status()
        finally:
            MIGRATION_ACTIVE=False



@asynccontextmanager
async def lifespan(app):
    init_db()
    _cleanup_stale_files()
    with dbconn() as db:
        db.execute("UPDATE jobs SET status='needs_review',result='Neustart während der Veröffentlichung; Zielplattform vor erneutem Versuch prüfen' WHERE status='processing'")
        db.execute('DELETE FROM oauth_states WHERE expires_at < ?', (now(),))
        db.execute('DELETE FROM user_sessions WHERE expires_at < ?', (now(),))
    task = asyncio.create_task(scheduler_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

app=FastAPI(title='TimeSave Social by Solvetec · V20.9',lifespan=lifespan)


@app.middleware('http')
async def security_headers_middleware(request, call_next):
    response = await call_next(request)
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('Referrer-Policy', 'no-referrer')
    response.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
    if request.url.path.startswith('/api/'):
        response.headers.setdefault('Cache-Control', 'no-store')
    return response
app.mount('/static',StaticFiles(directory=ROOT/'static'),name='static')

@app.get('/')
async def home():
    return FileResponse(ROOT/'static'/'index.html')

@app.get('/api/config', dependencies=[Depends(require_admin)])
def get_config():
    return {key:{'configured':bool(setting(key)),
                 'value':'' if key in SECRET_FIELDS else setting(key),
                 'source':setting_source(key)}
            for key in sorted(SETTINGS_ALLOWED)}

class SaveConfig(BaseModel):
    values: dict[str,str]

@app.post('/api/config',dependencies=[Depends(require_admin)])
def put_config(req:SaveConfig):
    for key,value in req.values.items():
        if key not in SETTINGS_ALLOWED:
            raise HTTPException(400,'Unbekanntes Feld')
        if len(value)>1000:
            raise HTTPException(400,'Wert ist zu lang')
        if key=='gcs_bucket_name' and value and (not re.fullmatch(r'[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]',value) or value.startswith('gs://')):
            raise HTTPException(400,'Bitte nur den Bucket-Namen ohne gs:// eingeben.')
        if key in ('tiktok_redirect_uri','tiktok_verified_media_prefix') and value and (not value.startswith('https://') and not (key=='tiktok_redirect_uri' and value.startswith('http://localhost:8000/'))):
            raise HTTPException(400,'TikTok-URL muss HTTPS sein; Desktop-Callback darf http://localhost:8000/... verwenden.')
        if key=='tiktok_verify_filename' and value and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{3,120}', value):
            raise HTTPException(400,'TikTok-Verifizierungsdatei: Bitte nur den reinen Dateinamen ohne Pfad/Schrägstrich eingeben (mit oder ohne .txt).')
        if key=='instagram_redirect_uri' and value:
            uri=urlsplit(value)
            if uri.scheme!='https' or not uri.hostname or uri.username or uri.password or uri.query or uri.fragment or uri.path!='/oauth/instagram/callback':
                raise HTTPException(400,'Instagram benötigt eine registrierte HTTPS-Callback-URL mit /oauth/instagram/callback.')
        if key in ('threads_redirect_uri','linkedin_redirect_uri') and value:
            uri=urlsplit(value)
            if uri.scheme not in ('https','http') or not uri.hostname or uri.query or uri.fragment:
                raise HTTPException(400,'Callback-URL für Threads/LinkedIn muss eine gültige URL ohne Query-Parameter sein.')
        if key=='public_base_url' and value and not (value.startswith('https://') and '?' not in value and '#' not in value):
            raise HTTPException(400,'Öffentliche URL muss HTTPS sein; für lokale Meta-Tests leer lassen.')
        if key in SECRET_FIELDS and not value:
            continue  # Don't accidentally delete existing secrets from a blank masked input
        save_setting(key,value)
    return {'ok':True}

@app.post('/api/cloud/check',dependencies=[Depends(require_admin)])
async def cloud_check():
    return await asyncio.to_thread(gcs_diagnostic)


@app.post('/api/cloud/media/{ident}/prepare',dependencies=[Depends(require_admin)])
async def cloud_media_prepare(ident:str):
    media = media_row(ident)
    if media['mime'] not in ('image/jpeg', 'image/png'):
        raise HTTPException(400, 'Bitte ein JPG- oder PNG-Bild auswählen.')
    try:
        url = await asyncio.to_thread(gcs_signed_media_url, media)
    except Exception as exc:
        raise HTTPException(400, str(exc)[:500])
    return {'ok':True, 'url':url, 'expires_in_minutes':360}


# WhatsApp is manual: the phone number identifies the intended account locally,
# never signs in and never authorizes automatic Status or Channel publishing.
class WhatsAppDisplayPreferences(BaseModel):
    phone: str = Field('', max_length=30)


@app.get('/api/whatsapp/preferences')
def whatsapp_preferences(user: dict = Depends(current_user)):
    return {'phone': get_user_pref(user['id'], 'whatsapp_display_phone'),
            'connected': False, 'publication': 'manual'}


@app.post('/api/whatsapp/preferences')
def save_whatsapp_preferences(req: WhatsAppDisplayPreferences, user: dict = Depends(current_user)):
    phone = re.sub(r'[\s().-]', '', req.phone.strip())
    if phone and not re.fullmatch(r'\+[1-9][0-9]{6,14}', phone):
        raise HTTPException(400, 'Bitte internationale Nummer eingeben, z. B. +491701234567, oder das Feld leeren.')
    save_user_pref(user['id'], 'whatsapp_display_phone', phone)
    return {'ok': True, 'phone': phone, 'connected': False,
            'message': 'Nummer als Bezeichnung gespeichert. WhatsApp wird separat per QR-Code angemeldet.'}


@app.get('/api/connections')
def connections(user: dict = Depends(current_user)):
    with dbconn() as db:
        rows=db.execute("SELECT id,provider,label,external_id,status,checked_at,expires_at,metadata FROM connections WHERE owner_id=? AND provider != 'whatsapp_business' ORDER BY provider,label", (user['id'],)).fetchall()
    result=[]
    for row in rows:
        item=dict(row)
        if item['provider']=='instagram':
            item['login_method']='unified' if instagram_unified_account(item) else ('instagram' if instagram_direct_account(item) else 'facebook')
        item.pop('metadata', None)
        result.append(item)
    return result

async def remote_revoke_account(account, shared_youtube=False):
    """Revoke official OAuth grants where safe, never expose an access token in an error.

    Meta Page/Instagram tokens are shared across assets: per-account disconnect is
    local only. Telegram token revocation is a BotFather operation, not Bot API.
    """
    provider=account['provider']
    if provider not in ('tiktok','youtube'):
        return 'local', 'Diese Verbindung wurde lokal entfernt. Ein eventuell gemeinsamer Meta-/Telegram-Zugriff bleibt beim Anbieter bestehen.'
    if provider=='youtube' and shared_youtube:
        return 'local', 'Nur lokal getrennt, damit andere YouTube-Kanäle nicht ihre Google-Berechtigung verlieren.'
    token=decrypt(account['access_enc'])
    if provider=='youtube':
        token=decrypt(account['refresh_enc']) or token
    if not token:
        return 'local', 'Lokal getrennt; beim Anbieter war kein Token zum Widerrufen vorhanden.'
    try:
        async with httpx.AsyncClient(timeout=20,follow_redirects=False) as client:
            if provider=='tiktok':
                r=await client.post('https://open.tiktokapis.com/v2/oauth/revoke/',data={
                    'client_key':setting('tiktok_client_key'),
                    'client_secret':setting('tiktok_client_secret'),'token':token})
                if r.status_code!=200:
                    raise RuntimeError('TikTok hat den Widerruf nicht bestätigt.')
                if r.content:
                    payload=r.json()
                    if isinstance(payload,dict):
                        err=payload.get('error') or {}
                        if isinstance(err,dict) and err.get('code') not in (None,'','ok'):
                            raise RuntimeError('TikTok hat den Widerruf nicht bestätigt.')
            else:
                r=await client.post('https://oauth2.googleapis.com/revoke',data={'token':token})
                if r.status_code!=200:
                    raise RuntimeError('Google hat den Widerruf nicht bestätigt.')
        return 'revoked', 'Zugriff beim Anbieter widerrufen und lokal getrennt.'
    except (httpx.HTTPError,ValueError,RuntimeError):
        return 'failed', 'Lokal getrennt. Der externe Widerruf konnte nicht bestätigt werden. Bitte die App-Berechtigungen bei '+('TikTok' if provider=='tiktok' else 'Google')+' kontrollieren.'


def mark_jobs_for_disconnection(db, ids):
    for ident in ids:
        db.execute("""UPDATE jobs SET status='cancelled',
            result='Konto getrennt: geplanter Versand wurde storniert.'
            WHERE connection_id=? AND status='scheduled'""",(ident,))
        db.execute("""UPDATE jobs SET status='needs_review',
            result='Konto während Versand/Verarbeitung getrennt. Direkt beim Anbieter prüfen, ob der Beitrag bereits veröffentlicht wurde.'
            WHERE connection_id=? AND status IN ('processing','awaiting_confirmation')""",(ident,))


@app.delete('/api/connections/{ident}')
async def disconnect(ident:str, user: dict = Depends(current_user)):
    owner_id = user['id']
    with dbconn() as db:
        row=db.execute('SELECT * FROM connections WHERE id=? AND owner_id=?',(ident, owner_id)).fetchone()
        if not row: raise HTTPException(404,'Verbindung fehlt')
        account=dict(row)
        dependent=[]
        if account['provider']=='telegram':
            for item in db.execute("SELECT * FROM connections WHERE owner_id=? AND provider='telegram_story'", (owner_id,)):
                try:
                    if json.loads(item['metadata'] or '{}').get('source_channel_connection_id')==ident:
                        dependent.append(item['id'])
                except (ValueError,TypeError): pass
        other_google=db.execute("SELECT * FROM connections WHERE owner_id=? AND provider='youtube' AND id!=?",(owner_id, ident)).fetchall()
        shared_youtube=bool(other_google)
        mark_jobs_for_disconnection(db,[ident]+dependent)
    remote,notice=await remote_revoke_account(account,shared_youtube=bool(shared_youtube))
    removed_ids=[ident]+dependent
    with dbconn() as db:
        mark_jobs_for_disconnection(db,removed_ids)
        if account['provider'] in ('facebook','instagram'):
            if not db.execute('SELECT 1 FROM meta_detached WHERE owner_id=? AND provider=? AND external_id=?',
                              (owner_id, account['provider'], account['external_id'])).fetchone():
                db.execute('INSERT INTO meta_detached(owner_id,provider,external_id) VALUES(?,?,?)',
                           (owner_id, account['provider'], account['external_id']))
        for key in removed_ids:
            db.execute('DELETE FROM connections WHERE id=? AND owner_id=?',(key, owner_id))
        if account['provider'] in ('facebook','instagram'):
            try: user_id=json.loads(account['metadata'] or '{}').get('meta_user_id')
            except (ValueError,TypeError): user_id=None
            if user_id:
                remaining=False
                for r in db.execute("SELECT metadata FROM connections WHERE owner_id=? AND provider IN ('facebook','instagram')", (owner_id,)):
                    try:
                        if json.loads(r['metadata'] or '{}').get('meta_user_id')==user_id:remaining=True;break
                    except (ValueError,TypeError):pass
                if not remaining: db.execute('DELETE FROM meta_sessions WHERE owner_id=? AND user_id=?',(owner_id, user_id))
    if dependent:
        notice+=' Zugehörige Telegram-Profil-Story ebenfalls getrennt.'
    return {'ok':True,'remote_revocation':remote,'removed_count':len(removed_ids),
            'message':notice+' Geplante Aufträge dieser Konten sind storniert.'}

@app.get('/api/tiktok/creator/{account_id}')
async def tiktok_creator(account_id:str, user: dict = Depends(current_user)):
    acc=get_account(account_id, user['id'])
    if acc['provider']!='tiktok':raise HTTPException(400,'Kein TikTok-Konto.')
    try:
        return await tiktok_creator_info(acc)
    except RuntimeError as exc:
        raise HTTPException(400,str(exc)) from None


@app.get('/api/providers',dependencies=[Depends(guard)])
def provider_info():
    return {
        'facebook':{'name':'Facebook-Seite','login':'meta','support':'Bildbeitrag und Foto-Story automatisch (Meta-Berechtigungen erforderlich)'},
        'instagram':{'name':'Instagram Business / Creator','login':'instagram_unified','support':'Video-Reels und Video-Stories direkt zu Meta hochladen; Bilder benötigen öffentliche HTTPS-URL.'},
        'threads':{'name':'Threads','login':'threads','support':'Direkte Bildbeiträge und 9:16-Videos über die offizielle Meta Threads API (60-Tage-Token mit Auto-Refresh).'},
        'linkedin':{'name':'LinkedIn','login':'linkedin','support':'Direkter Upload von 9:16-Videos und Bildbeiträgen in deinen LinkedIn-Feed per OpenID Connect & Share on LinkedIn.'},
        'tiktok':{'name':'TikTok','login':'tiktok','support':'Derzeit nur MP4-Videos per Direct Post. Bilder und Bilderreihen im Kreativstudio als MP4 erstellen; Foto-Direct-Post und TikTok-Stories pausiert.'},
        'whatsapp':{'name':'WhatsApp-Status','login':'manual','support':'Keine allgemeine offizielle Status-Veröffentlichungs-API; vorbereiteter Export'},
        'whatsapp_channel':{'name':'WhatsApp-Kanal','login':'manual','support':'Keine allgemeine offizielle Kanal-Publishing-API; vorbereiteter Export'},
                'telegram':{'name':'Telegram-Kanal','login':'telegram','support':'Bot und Administratorrecht werden geprüft. Bei Telegram-Limit 429 automatisch sicher nachsenden; unbestätigte Uploads nicht doppelt versenden.'},
        'telegram_story':{'name':'Telegram-Profil-Story','login':'telegram_business','support':'Profil-Stories automatisch über verbundenen Telegram-Business-Bot mit Berechtigung can_manage_stories; Bild oder H.265-Video.'},
        'youtube':{'name':'YouTube','login':'google','support':'Google-Anmeldung; MP4-Video privat, nicht gelistet oder öffentlich hochladen (YouTube API seit 02.11.2026)'},
    }

# Durable Meta credentials are stored encrypted, separately from Page tokens.
# A valid user token is exchanged *before* /me/accounts. Existing V4 Page tokens
# cannot be exchanged as if they were user tokens: user must authorize again.
META_REFRESH_BEFORE = timedelta(days=7)


async def inspect_meta_token_expiry(client, token, app_id, secret):
    """Ask Meta about a token without exposing its secret in a URL or logs.

    `expires_at == 0` means Meta reports no fixed expiration, *not* that
    the token is irrevocable. We still check it via /me and /me/accounts.
    """
    response = await client.get(f'{GRAPH}/debug_token',
        params={'input_token': token},
        headers={'Authorization': 'Bearer ' + app_id + '|' + secret})
    obj = require_ok(response)
    data = obj.get('data') if isinstance(obj, dict) else None
    if not isinstance(data, dict):
        raise RuntimeError('Meta-Tokenprüfung lieferte keine gültigen Prüfdaten.')
    if data.get('is_valid') is not True:
        raise RuntimeError('Meta meldet das Facebook-Token als ungültig. Bitte erneut anmelden.')
    if str(data.get('app_id') or '') != app_id:
        raise RuntimeError('Facebook-Token wurde für eine andere Meta-App ausgestellt.')
    # A Facebook account can be authorized by a user or a business system user.
    # Never invent an expiry from token category or from a missing field.
    try:
        unix_expiry = int(data['expires_at'])
    except (KeyError, TypeError, ValueError):
        raise RuntimeError('Meta bestätigt das Token, liefert aber kein prüfbares Ablaufdatum. '
                           'Die Verbindung wurde vorsorglich nicht gespeichert.') from None
    if unix_expiry == 0:
        return None  # explicitly no fixed expiry according to Meta
    if unix_expiry < 0:
        raise RuntimeError('Meta meldet eine ungültige Token-Ablaufzeit.')
    expires = datetime.fromtimestamp(unix_expiry, timezone.utc)
    if expires <= datetime.now(timezone.utc):
        raise RuntimeError('Facebook-Token ist bereits abgelaufen. Bitte neu anmelden.')
    return expires.isoformat()


async def exchange_meta_user_token(client, token):
    app_id, secret = setting('meta_app_id'), setting('meta_app_secret')
    if not app_id or not secret:
        raise RuntimeError('Zuerst unter API-Einstellungen die Meta App-ID und das App Secret speichern.')
    response = await client.get(f'{GRAPH}/oauth/access_token', params={
        'grant_type':'fb_exchange_token','client_id':app_id,
        'client_secret':secret,'fb_exchange_token':token})
    data = require_ok(response)
    access_token = data.get('access_token') if isinstance(data, dict) else None
    if not isinstance(access_token, str) or not access_token:
        raise RuntimeError('Meta hat beim Facebook-Tokenaustausch kein Zugriffstoken geliefert.')
    try:
        lifetime = int(data.get('expires_in') or 0)
    except (ValueError, TypeError):
        lifetime = 0
    if lifetime > 0:
        expiry = (datetime.now(timezone.utc)+timedelta(seconds=lifetime)).isoformat()
    else:
        # Some valid tokens have no `expires_in`. Check Meta's authoritative
        # debug endpoint instead of rejecting or guessing a 60-day lifetime.
        expiry = await inspect_meta_token_expiry(client, access_token, app_id, secret)
    return access_token, expiry


async def meta_edge(client, token, edge, fields):
    # Never follow arbitrary paging URLs or forward a token to another host.
    params={'fields':fields,'limit':100}
    items=[]
    seen=set()
    while True:
        body=require_ok(await client.get(f'{GRAPH}/{edge}', headers={'Authorization':'Bearer '+token},params=params))
        items.extend(body.get('data') or [])
        paging=body.get('paging') or {}
        if not paging.get('next'):
            return items
        cursor=(paging.get('cursors') or {}).get('after')
        if not cursor or cursor in seen:
            raise RuntimeError('Meta-Paginierung unvollständig.')
        seen.add(cursor)
        params={**params,'after':cursor}


async def discover_meta_pages(client, token):
    fields='id,name,tasks,access_token,instagram_business_account{id,username}'
    found={}
    warnings=[]
    async def edge(path, fields, label):
        try:
            return await meta_edge(client,token,path,fields)
        except (RuntimeError,httpx.HTTPError):
            warnings.append(label+' nicht abrufbar; Freigaben und Business-Zugriff prüfen.')
            return []
    for page in await edge('me/accounts',fields,'Facebook-Seiten'):
        if page.get('id'):
            found[str(page['id'])]=page
    businesses=await edge('me/businesses','id,name','Business-Portfolios (business_management)')
    for business in businesses:
        bid=str(business.get('id') or '')
        if not bid.isdigit():
            continue
        for kind in ('owned_pages','client_pages'):
            for page in await edge(f'{bid}/{kind}','id,name',f'Portfolio {bid}: {kind}'):
                pid=str(page.get('id') or '')
                if not pid.isdigit() or (pid in found and found[pid].get('access_token')):
                    continue
                try:
                    detail=require_ok(await client.get(f'{GRAPH}/{pid}',headers={'Authorization':'Bearer '+token},params={'fields':fields}))
                    if detail.get('access_token'):
                        found[pid]={**page,**detail,'id':pid}
                        continue
                except (RuntimeError,httpx.HTTPError):
                    pass
                msg=f"Seite {page.get('name') or pid} ({pid}): kein Seitenzugriffstoken; Seitenfreigabe prüfen."
                if msg not in warnings:
                    warnings.append(msg)
    for pid,page in found.items():
        if not page.get('access_token'):
            warnings.append(f"Seite {page.get('name') or pid} ({pid}): kein Seitenzugriffstoken.")
    return list(found.values()),warnings


async def sync_meta_accounts(client, token, expires_at, restore_detached=False, owner_id='owner'):
    info=require_ok(await client.get(f'{GRAPH}/me',
        headers={'Authorization':'Bearer '+token},params={'fields':'id,name'}))
    userid=str(info.get('id') or '')
    if not userid:
        raise RuntimeError('Meta hat keine gültige Benutzerkennung zurückgegeben.')
    pages, warnings = await discover_meta_pages(client, token)
    good=[page for page in pages if page.get('id') and page.get('access_token')]
    if not good:
        raise RuntimeError('Keine Facebook-Seite mit Zugriffstoken gefunden. '+(' · '.join(warnings) or 'Seitenzugriff und pages_show_list prüfen.'))
    warning = ' · '.join(warnings)[:1000]
    with dbconn() as db:
        exists=db.execute('SELECT 1 FROM meta_sessions WHERE owner_id=? AND user_id=?', (owner_id, userid)).fetchone()
        if exists:
            db.execute('UPDATE meta_sessions SET token_enc=?,expires_at=?,refreshed_at=?,status=?,last_error=? WHERE owner_id=? AND user_id=?',
                       (encrypt(token), expires_at, now(), 'active', warning, owner_id, userid))
        else:
            db.execute('INSERT INTO meta_sessions(user_id,token_enc,expires_at,refreshed_at,status,last_error,owner_id) VALUES(?,?,?,?,?,?,?)',
                       (userid, encrypt(token), expires_at, now(), 'active', warning, owner_id))
    with dbconn() as db:
        if restore_detached:
            for page in good:
                db.execute('DELETE FROM meta_detached WHERE owner_id=? AND provider=? AND external_id=?',(owner_id,'facebook',str(page['id'])))
                ig_obj=page.get('instagram_business_account') or {}
                if ig_obj.get('id'):
                    db.execute('DELETE FROM meta_detached WHERE owner_id=? AND provider=? AND external_id=?',(owner_id,'instagram',str(ig_obj['id'])))
        hidden={tuple(x) for x in db.execute('SELECT provider,external_id FROM meta_detached WHERE owner_id=?', (owner_id,))}
    count=0
    for page in good:
        meta={'tasks':page.get('tasks',[]),'meta_auth':'long_lived_page',
              'meta_user_id':userid,'meta_user_expires_at':expires_at}
        if ('facebook',str(page['id'])) not in hidden:
            upsert_account('facebook',page.get('name','Facebook-Seite'),page['id'],page['access_token'],metadata=meta,owner_id=owner_id)
            count+=1
        ig=page.get('instagram_business_account') or {}
        if ig.get('id') and ('instagram',str(ig['id'])) not in hidden:
            with dbconn() as db:
                previous=db.execute("SELECT * FROM connections WHERE owner_id=? AND provider='instagram' AND external_id=?",
                    (owner_id, str(ig['id']))).fetchone()
            if previous and (instagram_direct_account(dict(previous)) or instagram_unified_account(dict(previous))):
                continue
            upsert_account('instagram','Instagram @'+ig.get('username','')+' · '+page.get('name',''),
                ig['id'],page['access_token'],metadata={**meta,'page_id':page['id']},owner_id=owner_id)
            count+=1
    return count,userid


async def meta_refresh_one(userid, force=False, owner_id='owner'):
    with dbconn() as db:
        row=db.execute('SELECT * FROM meta_sessions WHERE owner_id=? AND user_id=?',(owner_id, userid)).fetchone()
    if not row:
        raise RuntimeError('Keine langfristige Meta-Sitzung gespeichert. Bitte neu verbinden.')
    expires = _parse_utc(row['expires_at'])
    if expires is not None and expires <= datetime.now(timezone.utc):
        with dbconn() as db:
            db.execute("UPDATE meta_sessions SET status='reauthorize',last_error=? WHERE owner_id=? AND user_id=?",
                ('Meta-Benutzertoken abgelaufen. Erneut anmelden.', owner_id, userid))
        raise RuntimeError('Meta-Zugriff abgelaufen: Bitte erneut bei Meta anmelden.')
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            token=decrypt(row['token_enc'])
            expiry=row['expires_at']
            if expires is None:
                if force:
                    expiry = await inspect_meta_token_expiry(client, token,
                        setting('meta_app_id'), setting('meta_app_secret'))
            elif force or expires <= datetime.now(timezone.utc)+META_REFRESH_BEFORE:
                token,expiry=await exchange_meta_user_token(client,token)
            count,_=await sync_meta_accounts(client,token,expiry,owner_id=owner_id)
        return {'ok':True,'count':count,'expires_at':expiry}
    except Exception as exc:
        message = str(exc)[:250] if isinstance(exc,RuntimeError) else type(exc).__name__
        with dbconn() as db:
            db.execute("UPDATE meta_sessions SET status='attention',last_error=? WHERE owner_id=? AND user_id=?",
                (message, owner_id, userid))
        raise RuntimeError(message) from None


async def refresh_meta_sessions_auto():
    with dbconn() as db:
        sessions=[dict(r) for r in db.execute('SELECT owner_id,user_id,expires_at,status FROM meta_sessions')]
    for session in sessions:
        if session['status']=='reauthorize':
            continue
        try:
            await meta_refresh_one(session['user_id'], owner_id=session['owner_id'])
        except Exception:
            pass


@app.get('/api/meta/status')
def meta_status(user: dict = Depends(current_user)):
    with dbconn() as db:
        sessions=[dict(r) for r in db.execute("""SELECT user_id,expires_at,refreshed_at,status,last_error
            FROM meta_sessions WHERE owner_id=? ORDER BY refreshed_at DESC""", (user['id'],))]
        accounts=[dict(r) for r in db.execute("SELECT provider,metadata,status FROM connections WHERE owner_id=? AND provider IN ('facebook','instagram')", (user['id'],))]
    for a in accounts:
        try: a['meta_auth'] = json.loads(a['metadata']).get('meta_auth','legacy_unverified')
        except (ValueError,TypeError): a['meta_auth']='legacy_unverified'
        del a['metadata']
    return {'configured': bool(setting('meta_app_id') and setting('meta_app_secret')),
            'instagram_direct_configured':bool(setting('instagram_app_id') and setting('instagram_app_secret') and callback_url('instagram')),
            'instagram_unified_configured':bool(setting('meta_app_id') and setting('meta_app_secret') and setting('instagram_unified_config_id') and callback_url('instagram_unified').startswith('https://')),
            'sessions':sessions, 'accounts':accounts}


@app.get('/api/instagram/unified/setup',dependencies=[Depends(guard)])
def instagram_unified_setup():
    uri=callback_url('instagram_unified')
    required = {
        'META_APP_ID': 'meta_app_id',
        'META_APP_SECRET': 'meta_app_secret',
        'INSTAGRAM_UNIFIED_CONFIG_ID': 'instagram_unified_config_id',
    }
    checks = {name: {'configured': bool(setting(key)), 'source': setting_source(key)}
              for name, key in required.items()}
    checks['HTTPS_CALLBACK'] = {'configured': uri.startswith('https://'),
                                'source': 'render_url' if uri.startswith('https://') else 'missing'}
    missing = [name for name, info in checks.items() if not info['configured']]
    return {
        'configured': not missing,
        'checks': checks,
        'missing': missing,
        'callback': uri,
        'preview': FREE_PREVIEW,
        'message': 'Render Free: Testanmeldungen sind flüchtig, nach Neustart kann das gespeicherte Konto verschwinden.' if FREE_PREVIEW else 'Meta-Weiterleitungsadresse genau so registrieren.',
    }


class MetaTokenInput(BaseModel):
    user_token: str = Field(min_length=15,max_length=4096)


@app.post('/api/connect/meta-token')
async def connect_meta_token(req:MetaTokenInput, user: dict = Depends(current_user)):
    """Upgrade a *user* token, then retrieve Page tokens (never store the short token)."""
    if not setting('meta_app_id') or not setting('meta_app_secret'):
        raise HTTPException(400,'Für eine dauerhafte Meta-Verbindung zuerst App-ID und App Secret speichern.')
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            user_token,expiry=await exchange_meta_user_token(client,req.user_token.strip())
            count,_=await sync_meta_accounts(client,user_token,expiry,restore_detached=True,owner_id=user['id'])
    except Exception as exc:
        msg=str(exc) if isinstance(exc,RuntimeError) else type(exc).__name__
        raise HTTPException(400,msg[:350]) from None
    return {'ok':True,'count':count,'expires_at':expiry,
        'message':f'{count} Meta-Zielkonten verbunden. Token-Gültigkeit wurde anhand der Meta-Antwort bestimmt; Verbindungen können widerrufen werden.'}


@app.post('/api/meta/refresh')
async def meta_refresh_now(user: dict = Depends(current_user)):
    with dbconn() as db:
        ids=[r['user_id'] for r in db.execute('SELECT user_id FROM meta_sessions WHERE owner_id=?', (user['id'],))]
    if not ids:
        raise HTTPException(400,'Noch keine langfristige Meta-Verbindung. Bitte mit einem neuen Benutzer-Token verbinden.')
    results=[]
    for userid in ids:
        try:
            result=await meta_refresh_one(userid,force=True,owner_id=user['id'])
            results.append({'ok':True,'count':result['count']})
        except RuntimeError as exc:
            results.append({'ok':False,'message':str(exc)[:180]})
    return {'ok':all(r['ok'] for r in results),'results':results}

@app.post('/api/connections/{ident}/check')
async def check_connection(ident:str, user: dict = Depends(current_user)):
    acc=get_account(ident, user['id'])
    prov=acc['provider']
    token=decrypt(acc['access_enc'])
    try:
        async with httpx.AsyncClient(timeout=22) as client:
            if prov in {'facebook','instagram'}:
                fields='id,name' if prov=='facebook' else 'id,username'
                if prov=='instagram' and instagram_direct_account(acc):
                    token=await instagram_direct_token(acc)
                    response=await client.get(f'{IG_GRAPH}/me',
                        headers={'Authorization':'Bearer '+token},params={'fields':'id,username'})
                    result=instagram_require_ok(response, 'Konto prüfen')
                    if str(result.get('id'))!=acc['external_id']:
                        raise RuntimeError('Instagram: Die Anmeldung gehört zu einem anderen Konto.')
                else:
                    ig_exp=_parse_utc(acc.get('expires_at'))
                    if prov=='instagram' and instagram_unified_account(acc) and ig_exp and ig_exp<=datetime.now(timezone.utc):
                        raise RuntimeError('Meta Unified Login: Zugriffstoken abgelaufen, bitte erneut verbinden.')
                    r=await client.get(f'{GRAPH}/{acc["external_id"]}',
                        headers={'Authorization':'Bearer '+token},params={'fields':fields})
                    require_ok(r)
            elif prov=='telegram_story':
                await telegram_story_get_business(token,acc['external_id'])
            elif prov=='telegram':
                await telegram_channel_health(client, token, acc['external_id'])
            elif prov=='youtube':
                token=await refresh_google(acc)
                r=await client.get('https://www.googleapis.com/youtube/v3/channels',
                    headers={'Authorization':'Bearer '+token},params={'part':'id','mine':'true'})
                require_ok(r)
            elif prov=='tiktok':
                token=await refresh_tiktok(acc)
                r=await client.get('https://open.tiktokapis.com/v2/user/info/',
                    headers={'Authorization':'Bearer '+token},params={'fields':'open_id'})
                tiktok_response(r)
            elif prov=='threads':
                token=await refresh_threads(acc)
                r=await client.get(f'{THREADS_GRAPH}/me',
                    headers={'Authorization':'Bearer '+token},params={'fields':'id,username'})
                require_ok(r)
            elif prov=='linkedin':
                r=await client.get('https://api.linkedin.com/v2/userinfo',
                    headers={'Authorization':'Bearer '+token})
                require_ok(r)
            else:
                raise RuntimeError('Keine Prüfung für diese Plattform')
        status='connected'
        message='Telegram: Bot, Kanal und Veröffentlichungsrechte bestätigt.' if prov=='telegram' else 'API-Antwort erfolgreich'
    except TelegramRetryLater as exc:
        # Temporary outage must not turn a previously connected account red.
        return {'ok':False, 'temporary':True, 'message':str(exc)}
    except Exception as exc:
        status='error'
        message=str(exc)[:240] if isinstance(exc,RuntimeError) else type(exc).__name__
    with dbconn() as db:
        db.execute('UPDATE connections SET status=?,checked_at=? WHERE id=?',(status,now(),ident))
    return {'ok':status=='connected','message':message}


# V17.12: Dedicated read-only Telegram diagnostics, visible in Konten & Plattformen.
# Each saved account is checked against the actual Bot API. No message is sent.
@app.post('/api/telegram/health')
async def telegram_health(user: dict = Depends(current_user)):
    with dbconn() as db:
        rows=[dict(row) for row in db.execute(
            "SELECT * FROM connections WHERE owner_id=? AND provider IN ('telegram','telegram_story') ORDER BY provider,label", (user['id'],))]
    if not rows:
        return {'ok':False,'connected':False,'accounts':[],
            'message':'Noch kein Telegram-Kanal oder -Profil verbunden. Bitte zuerst unten deinen Bot verbinden.'}
    results=[]
    async with httpx.AsyncClient(timeout=22,follow_redirects=False) as client:
        for acc in rows:
            is_story=acc['provider']=='telegram_story'
            label=acc['label']
            result={'id':acc['id'],'provider':acc['provider'],'label':label,'ok':False,
                    'temporary':False,'message':'Noch nicht geprüft'}
            try:
                token=decrypt(acc['access_enc'])
                if not token:
                    raise RuntimeError('Telegram-Zugang fehlt. Bitte Verbindung neu einrichten.')
                if is_story:
                    profile=await telegram_story_get_business(token,acc['external_id'])
                    person=profile.get('user') or {}
                    username=person.get('username')
                    result['message']='Telegram-Profil-Story: Business-Bot verbunden und Stories verwalten erlaubt.'
                    if username: result['account']='@'+str(username)
                else:
                    bot,chat=await telegram_channel_health(client,token,acc['external_id'])
                    result['bot']='@'+str(bot['username']) if bot.get('username') else 'Telegram-Bot'
                    result['channel']=str(chat.get('title') or label)
                    result['message']='Bot erreichbar · Kanal gefunden · Administratorrecht zum Veröffentlichen bestätigt.'
                result['ok']=True
                with dbconn() as db:
                    db.execute('UPDATE connections SET status=?,checked_at=? WHERE id=?',('connected',now(),acc['id']))
            except TelegramRetryLater as exc:
                result['temporary']=True
                result['message']=str(exc)[:240]
            except (RuntimeError,httpx.HTTPError) as exc:
                result['message']=str(exc)[:240]
                with dbconn() as db:
                    db.execute('UPDATE connections SET status=?,checked_at=? WHERE id=?',('error',now(),acc['id']))
            results.append(result)
    return {'ok':all(r['ok'] for r in results),'connected':True,'accounts':results,
        'message':f"{sum(r['ok'] for r in results)} von {len(results)} Telegram-Verbindungen erfolgreich geprüft."}




# V17.22: Optional read-only Render configuration for an existing Telegram bot.
# Never return TELEGRAM_BOT_TOKEN to the browser or put it into a public URL.
@app.get('/api/telegram/env/status')
def telegram_env_status(user: dict = Depends(current_user)):
    if user.get('role') != 'admin':
        return {'ready': False, 'bot_configured': False, 'channel_configured': False, 'business_configured': False, 'message': ''}
    token=os.getenv('TELEGRAM_BOT_TOKEN','').strip()
    channel=os.getenv('TELEGRAM_CHANNEL_ID','').strip()
    business=os.getenv('TELEGRAM_BUSINESS_CONNECTION_ID','').strip()
    return {'ready':bool(token and channel), 'bot_configured':bool(token),
            'channel_configured':bool(channel), 'business_configured':bool(business),
            'message':('Telegram-Zugang in Render bereit: Mit einem Klick verbinden.' if token and channel
                       else 'In Render Environment TELEGRAM_BOT_TOKEN und TELEGRAM_CHANNEL_ID hinterlegen.')}


@app.post('/api/telegram/env/connect')
async def telegram_env_connect(user: dict = Depends(require_admin)):
    """Re-create channel and optional Business profile from environment secrets.

    Validates ALL configured destinations before any database write so a wrong
    Business ID cannot partially overwrite an existing, working connection.
    """
    token=os.getenv('TELEGRAM_BOT_TOKEN','').strip()
    channel=os.getenv('TELEGRAM_CHANNEL_ID','').strip()
    business_id=os.getenv('TELEGRAM_BUSINESS_CONNECTION_ID','').strip()
    if not token or not channel:
        raise HTTPException(400, 'In Render fehlen TELEGRAM_BOT_TOKEN oder TELEGRAM_CHANNEL_ID. Bitte beide als Environment-Variablen eintragen.')
    try:
        async with httpx.AsyncClient(timeout=22, follow_redirects=False) as client:
            bot,chat=await telegram_channel_health(client,token,channel)
        business=await telegram_story_get_business(token,business_id) if business_id else None
    except TelegramRetryLater as exc:
        raise HTTPException(503,str(exc)) from None
    except (RuntimeError, httpx.HTTPError) as exc:
        # Keep the previously linked accounts untouched when the API rejects
        # the token, target, or Business-Story permission.
        raise HTTPException(400,str(exc)[:240] if isinstance(exc,RuntimeError)
                            else 'Telegram ist vorübergehend nicht erreichbar.') from None
    channel_name=chat.get('title') or channel
    channel_ident=upsert_account('telegram',channel_name,str(chat['id']),token,
                                 metadata={'bot_name':bot.get('username',''), 'source':'render_env'}, owner_id=user['id'])
    story_connected=False
    if business:
        tg_user=business.get('user') or {}
        label=(tg_user.get('first_name') or 'Telegram-Profil')+(' @'+tg_user['username'] if tg_user.get('username') else '')
        upsert_account('telegram_story',label,str(business['id']),token,
                       metadata={'telegram_user_id':tg_user.get('id'),
                                 'source_channel_connection_id':channel_ident,'source':'render_env'}, owner_id=user['id'])
        story_connected=True
    return {'ok':True, 'channel_connected':True, 'story_connected':story_connected,
            'message':('Telegram-Kanal und Profil-Stories über Render verbunden.' if story_connected else
                       'Telegram-Kanal über Render verbunden. Für Profil-Stories optional TELEGRAM_BUSINESS_CONNECTION_ID in Render ergänzen.')}

class TelegramConfig(BaseModel):
    bot_token: str = Field(min_length=10)
    channel: str = Field(min_length=2)

@app.post('/api/connect/telegram')
async def connect_telegram(req:TelegramConfig, user: dict = Depends(current_user)):
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            bot, chat = await telegram_channel_health(client,req.bot_token,req.channel)
    except TelegramRetryLater as exc:
        raise HTTPException(503,str(exc)) from None
    except RuntimeError as exc:
        raise HTTPException(400,str(exc)) from None
    name=chat.get('title') or req.channel
    upsert_account('telegram',name,str(chat['id']),req.bot_token,metadata={'bot_name':bot.get('username','')},owner_id=user['id'])
    return {'ok':True,'message':'Telegram-Kanal verbunden: Bot ist Administrator und darf Beiträge veröffentlichen.'}

class TelegramStoryDiscover(BaseModel):
    channel_connection_id: str

class TelegramStoryConnect(BaseModel):
    channel_connection_id: str
    business_connection_id: str = Field(min_length=4, max_length=255)


def telegram_story_channel_bot(ident, owner_id=None):
    acc=get_account(ident, owner_id)
    if acc['provider']!='telegram':
        raise HTTPException(400,'Bitte einen bereits verbundenen Telegram-Kanal-Bot auswählen.')
    return decrypt(acc['access_enc'])


@app.post('/api/telegram/story/discover')
async def discover_telegram_story(req:TelegramStoryDiscover, user: dict = Depends(current_user)):
    """Read pending business_connection updates; no arbitrary channel or story is posted."""
    token=telegram_story_channel_bot(req.channel_connection_id, user['id'])
    try:
        webhook=await telegram_bot_get(token,'getWebhookInfo')
        if webhook.get('url'):
            raise HTTPException(409,'Dieser Bot verwendet bereits einen Webhook. Bitte dafür einen eigenen Story-Bot verwenden, damit keine Telegram-Updates anderer Anwendungen verloren gehen.')
        updates=await telegram_bot_get(token,'getUpdates',
            {'limit':100,'timeout':0,'allowed_updates':json.dumps(['business_connection'])})
    except RuntimeError as exc:
        raise HTTPException(400,str(exc)) from None
    options={}
    for update in updates:
        business=update.get('business_connection') or {}
        if not business.get('id') or not isinstance(business.get('user'),dict):
            continue
        user=business['user']
        options[str(user['id'])]={
            'business_connection_id':business['id'],
            'name':(user.get('first_name') or 'Profil')+' '+(user.get('last_name') or ''),
            'username':user.get('username') or '',
            'is_enabled':bool(business.get('is_enabled')),
            'can_manage_stories':bool((business.get('rights') or {}).get('can_manage_stories')),
        }
    return {'options':[x for x in options.values() if x['is_enabled'] and x['can_manage_stories']],
        'message':'Wenn noch kein Profil erscheint: Telegram → Einstellungen → Telegram Business → Chatbots, Bot verbinden und „Stories verwalten“ erlauben. Danach erneut prüfen. Änderungen an einer alten Verbindung ggf. einmal neu bestätigen.'}


@app.post('/api/telegram/story/connect')
async def connect_telegram_story(req:TelegramStoryConnect, user: dict = Depends(current_user)):
    token=telegram_story_channel_bot(req.channel_connection_id, user['id'])
    try:
        account=await telegram_story_get_business(token,req.business_connection_id)
    except RuntimeError as exc:
        raise HTTPException(400,str(exc)) from None
    tg_user=account.get('user') or {}
    display=(tg_user.get('first_name') or 'Telegram-Profil')+(' @'+tg_user['username'] if tg_user.get('username') else '')
    ident=upsert_account('telegram_story',display,str(account['id']),token,metadata={
        'telegram_user_id':tg_user.get('id'),'source_channel_connection_id':req.channel_connection_id}, owner_id=user['id'])
    return {'ok':True,'id':ident,'label':display,'message':'Telegram-Profil-Story automatisch bereit. Als ersten Test ein Bild wählen.'}


def new_oauth_state(provider, verifier='', redirect_uri='', owner_id='owner'):
    state=secrets.token_urlsafe(35)
    with dbconn() as db:
        db.execute('INSERT INTO oauth_states (state,provider,expires_at,pkce_verifier,redirect_uri,owner_id) VALUES(?,?,?,?,?,?)',
                   (state,provider,(datetime.now(timezone.utc)+timedelta(minutes=10)).isoformat(),verifier,redirect_uri,owner_id))
    return state


def consume_state(provider,state):
    with dbconn() as db:
        r=db.execute('SELECT * FROM oauth_states WHERE state=? AND provider=?',(state,provider)).fetchone()
        if r: db.execute('DELETE FROM oauth_states WHERE state=?',(state,))
    return dict(r) if r and r['expires_at']>now() else None

@app.post('/api/oauth/{provider}/start')
def oauth_start(provider:str, user: dict = Depends(current_user)):
    owner_id = user['id']
    if provider == 'instagram':
        raise HTTPException(410, 'Der alte Instagram-Direktlogin wurde eingestellt. Bitte Meta Unified Login verwenden.')
    state=None if provider in ('tiktok','instagram_unified') else new_oauth_state(provider, redirect_uri=callback_url(provider), owner_id=owner_id)
    if provider=='instagram_unified':
        if not (setting('meta_app_id') and setting('meta_app_secret') and setting('instagram_unified_config_id')):
            raise HTTPException(400,'Meta App-ID, App Secret und Unified-Login-Konfigurations-ID fehlen. Bitte unter Einstellungen speichern oder als Render-Umgebungsvariablen setzen.')
        redirect=callback_url('instagram_unified')
        parsed=urlsplit(redirect)
        if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path!='/oauth/instagram_unified/callback':
            raise HTTPException(400,'Die öffentliche Render-HTTPS-Adresse für /oauth/instagram_unified/callback fehlt oder ist ungültig.')
        state=new_oauth_state('instagram_unified', redirect_uri=redirect, owner_id=owner_id)
        url='https://www.facebook.com/v26.0/dialog/oauth?'+urlencode({
            'client_id':setting('meta_app_id'),
            'config_id':setting('instagram_unified_config_id'),
            'redirect_uri':redirect,
            'response_type':'code',
            'override_default_response_type':'true',
            'state':state,
        })
    elif provider=='meta':
        if not setting('meta_app_id') or not setting('meta_app_secret'):
            raise HTTPException(400,'Bitte zuerst Meta-App-ID und App Secret speichern.')
        scopes='pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish,business_management'
        url='https://www.facebook.com/v26.0/dialog/oauth?'+urlencode({
            'client_id':setting('meta_app_id'),'redirect_uri':callback_url('meta'),
            'scope':scopes,'state':state,'response_type':'code','auth_type':'rerequest'})
    elif provider=='google':
        if not setting('google_client_id') or not setting('google_client_secret'):
            raise HTTPException(400,'Google Client ID und Secret fehlen.')
        url='https://accounts.google.com/o/oauth2/v2/auth?'+urlencode({
            'client_id':setting('google_client_id'),'redirect_uri':callback_url('google'),
            'response_type':'code','scope':'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload',
            'access_type':'offline','prompt':'consent','state':state})
    elif provider=='tiktok':
        if not setting('tiktok_client_key') or not setting('tiktok_client_secret'):
            raise HTTPException(400,'TikTok Client Key und Secret fehlen. Bitte zuerst in Einstellungen speichern.')
        try:
            desktop=tiktok_desktop_login()
        except RuntimeError as ex:
            raise HTTPException(400,str(ex)) from None
        verifier=secrets.token_urlsafe(48) if desktop else ''
        state=new_oauth_state('tiktok',verifier,callback_url('tiktok'),owner_id=owner_id)
        values={'client_key':setting('tiktok_client_key'),'redirect_uri':callback_url('tiktok'),
            'response_type':'code','scope':'user.info.basic,video.publish,video.upload','state':state}
        if desktop:
            values.update(code_challenge=hashlib.sha256(verifier.encode('ascii')).hexdigest(),
                          code_challenge_method='S256')
        url='https://www.tiktok.com/v2/auth/authorize/?'+urlencode(values)
    elif provider=='threads':
        app_id, app_secret = _threads_app_credentials()
        if not app_id or not app_secret:
            raise HTTPException(400,'Threads App-ID und App Secret fehlen. Bitte in Render (THREADS_APP_ID / THREADS_APP_SECRET) oder unter Einstellungen speichern.')
        redirect = callback_url('threads')
        url = 'https://threads.net/oauth/authorize?' + urlencode({
            'client_id': app_id,
            'redirect_uri': redirect,
            'scope': 'threads_basic,threads_content_publish',
            'response_type': 'code',
            'state': state,
        })
    elif provider=='linkedin':
        li_id = setting('linkedin_client_id')
        li_secret = setting('linkedin_client_secret')
        if not li_id or not li_secret:
            raise HTTPException(400,'LinkedIn Client ID und Client Secret fehlen. Bitte in Render (LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET) oder unter Einstellungen speichern.')
        redirect = callback_url('linkedin')
        url = 'https://www.linkedin.com/oauth/v2/authorization?' + urlencode({
            'response_type': 'code',
            'client_id': li_id,
            'redirect_uri': redirect,
            'state': state,
            'scope': 'openid profile email w_member_social',
        })
    else:
        raise HTTPException(400,'OAuth-Anbieter unbekannt')
    return {'url':url,'callback':callback_url(provider)}


def callback_page(success,detail):
    import html
    return HTMLResponse('<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui;max-width:720px;margin:10vh auto;background:#f7f2ff;padding:25px}h1{color:#6541a0}</style>'
       +'<h1>'+('✅ Verbindung abgeschlossen' if success else '⚠️ Verbindung nicht abgeschlossen')+'</h1>'
       +'<p>'+html.escape(detail)+'</p><p>Du kannst dieses Fenster schließen. TimeSave Social aktualisiert den Kontostatus anschließend automatisch.</p>')

@app.get('/oauth/{provider}/callback')
@app.get('/api/{provider}/callback')
async def oauth_callback(provider:str,state:str='',code:str='',error:str=''):
    oauth_session=consume_state(provider,state)
    if not oauth_session:
        return callback_page(False,'Die Sicherheitsprüfung ist fehlgeschlagen oder abgelaufen.')
    if error or not code:
        return callback_page(False,'Die Anmeldung wurde abgebrochen oder nicht erlaubt.')
    owner_id = oauth_session.get('owner_id') or 'owner'
    try:
        if provider=='instagram':
            return callback_page(False, 'Der alte Instagram-Direktlogin wurde eingestellt. Bitte Meta Unified Login verwenden.')
        if provider=='instagram_unified':
            redirect=oauth_session['redirect_uri'] or callback_url('instagram_unified')
            async with httpx.AsyncClient(timeout=30,follow_redirects=False) as client:
                token,expires=await instagram_unified_exchange_code(client,code,redirect)
                granted=await instagram_unified_discover(client,token)
            for account in granted:
                upsert_account('instagram','Instagram @'+account['username']+' · Unified Login',
                    account['id'],token,expires_at=expires, metadata={
                        'login_method':'unified',
                        'meta_auth':'unified_business_system_user',
                        'token_updated_at':now(),
                    }, owner_id=owner_id)
            with dbconn() as db:
                for account in granted:
                    db.execute('DELETE FROM meta_detached WHERE owner_id=? AND provider=? AND external_id=?',
                               (owner_id, 'instagram', account['id']))
            # A system-user credential does not alter any Facebook session or Page credential.
            note=' (Render Free: Verbindung ist nur vorübergehend gespeichert.)' if FREE_PREVIEW else ''
            return callback_page(True,str(len(granted))+' Instagram-Konto/Konten über Unified Login verbunden. Facebook bleibt unverändert.'+note)
        if provider=='meta':
            async with httpx.AsyncClient(timeout=30) as client:
                r=await client.get(f'{GRAPH}/oauth/access_token',params={
                    'client_id':setting('meta_app_id'),'client_secret':setting('meta_app_secret'),
                    'redirect_uri':callback_url('meta'),'code':code})
                obj=require_ok(r)
                token=obj['access_token']
                # Always exchange user token BEFORE retrieving Page/IG tokens.
                token,expiry=await exchange_meta_user_token(client,token)
                total,_=await sync_meta_accounts(client,token,expiry,restore_detached=True,owner_id=owner_id)
            return callback_page(True,f'Meta-Anmeldung erfolgreich: {total} Zielkonten langfristig verbunden. Bitte den Status regelmäßig prüfen.')
        if provider=='google':
            async with httpx.AsyncClient(timeout=30) as client:
                tok=require_ok(await client.post('https://oauth2.googleapis.com/token',data={
                    'code':code,'client_id':setting('google_client_id'),
                    'client_secret':setting('google_client_secret'),'redirect_uri':callback_url('google'),
                    'grant_type':'authorization_code'}))
                ch=require_ok(await client.get('https://www.googleapis.com/youtube/v3/channels',
                    params={'part':'snippet','mine':'true'},headers={'Authorization':'Bearer '+tok['access_token']}))
            items=ch.get('items',[])
            if not items:
                return callback_page(False,'Google verbunden, aber kein YouTube-Kanal gefunden.')
            exp=(datetime.now(timezone.utc)+timedelta(seconds=tok.get('expires_in',3600))).isoformat()
            for item in items:
                upsert_account('youtube',item.get('snippet',{}).get('title','YouTube-Kanal'),item['id'],
                    tok['access_token'],tok.get('refresh_token',''),exp,owner_id=owner_id)
            return callback_page(True,'YouTube-Kanal verbunden. Sichtbarkeit (privat, nicht gelistet oder öffentlich) wird bei jedem Veröffentlichungsauftrag ausgewählt.')
        if provider=='tiktok':
            form={'client_key':setting('tiktok_client_key'),'client_secret':setting('tiktok_client_secret'),
                  'code':code,'grant_type':'authorization_code','redirect_uri':oauth_session['redirect_uri']}
            if oauth_session['pkce_verifier']:
                form['code_verifier']=oauth_session['pkce_verifier']
            async with httpx.AsyncClient(timeout=30) as client:
                tok=tiktok_response(await client.post('https://open.tiktokapis.com/v2/oauth/token/',data=form))
                user=tiktok_response(await client.get('https://open.tiktokapis.com/v2/user/info/',
                    params={'fields':'open_id,display_name'},headers={'Authorization':'Bearer '+tok['access_token']}))
            info=user.get('data',{}).get('user',{})
            if not info.get('open_id'):
                return callback_page(False,'TikTok-Anmeldung erfolgreich, aber keine Konto-ID erhalten.')
            exp=(datetime.now(timezone.utc)+timedelta(seconds=int(tok.get('expires_in',7200)))).isoformat()
            upsert_account('tiktok',info.get('display_name','TikTok'),info['open_id'],
                tok['access_token'],tok.get('refresh_token',''),exp,
                metadata={'scopes':tok.get('scope',''),'refresh_expires_in':tok.get('refresh_expires_in',0)}, owner_id=owner_id)
            return callback_page(True,'TikTok-Konto erfolgreich verbunden (video.publish & video.upload). Du kannst jetzt Videos sowie Foto-/Karussell-Beiträge direkt oder als Entwurf in deine TikTok-Inbox senden.')
        if provider=='threads':
            redirect = oauth_session.get('redirect_uri') or callback_url('threads')
            async with httpx.AsyncClient(timeout=30) as client:
                info, long_token, lifetime = await threads_exchange_code(client, code, redirect)
            exp = (datetime.now(timezone.utc) + timedelta(seconds=lifetime)).isoformat()
            uname = info.get('username') or info.get('name') or str(info['id'])
            label = f'Threads @{uname}' if info.get('username') else f'Threads · {uname}'
            upsert_account(
                'threads', label, str(info['id']), long_token, '', exp,
                metadata={'username': info.get('username', ''), 'token_updated_at': now()},
                owner_id=owner_id,
            )
            return callback_page(True, f'Threads-Konto ({label}) erfolgreich mit 60-Tage-Token verbunden. Du kannst jetzt Beiträge und 9:16-Videos direkt veröffentlichen.')
        if provider=='linkedin':
            redirect = oauth_session.get('redirect_uri') or callback_url('linkedin')
            async with httpx.AsyncClient(timeout=30) as client:
                tok_resp = await client.post(
                    'https://www.linkedin.com/oauth/v2/accessToken',
                    data={
                        'grant_type': 'authorization_code',
                        'code': code,
                        'redirect_uri': redirect,
                        'client_id': setting('linkedin_client_id'),
                        'client_secret': setting('linkedin_client_secret'),
                    },
                    headers={'Content-Type': 'application/x-www-form-urlencoded'},
                )
                tok = require_ok(tok_resp)
                access_token = tok.get('access_token')
                if not access_token:
                    raise RuntimeError('LinkedIn hat keinen Access-Token geliefert.')
                u_resp = await client.get(
                    'https://api.linkedin.com/v2/userinfo',
                    headers={'Authorization': 'Bearer ' + access_token},
                )
                u_info = require_ok(u_resp)
            sub = str(u_info.get('sub') or '').strip()
            if not sub:
                return callback_page(False, 'LinkedIn-Anmeldung erfolgreich, aber keine OpenID-Sub-Kennung erhalten.')
            exp = (datetime.now(timezone.utc) + timedelta(seconds=int(tok.get('expires_in', 5184000)))).isoformat()
            display_name = u_info.get('name') or u_info.get('email') or sub
            label = f'LinkedIn · {display_name}'
            upsert_account(
                'linkedin', label, sub, access_token, tok.get('refresh_token', ''), exp,
                metadata={'email': u_info.get('email', ''), 'author_urn': f'urn:li:person:{sub}'},
                owner_id=owner_id,
            )
            return callback_page(True, f'{label} erfolgreich verbunden. Du kannst jetzt 9:16-Videos und Bildbeiträge direkt auf LinkedIn posten.')
    except Exception as exc:
        return callback_page(False,'API-Verbindung fehlgeschlagen: '+(str(exc)[:220] if isinstance(exc,RuntimeError) else type(exc).__name__))
    return callback_page(False,'Anbieter nicht unterstützt')

@app.get('/api/media')
def list_media(user: dict = Depends(current_user)):
    with dbconn() as db:
        items=[dict(x) for x in db.execute('SELECT * FROM media WHERE owner_id=? ORDER BY created_at DESC', (user['id'],))]
    # Original database records are preserved, including if a free instance has
    # lost its files. Surface missing files instead of pretending uploads exist.
    for item in items:
        path = MEDIA / item['filename']
        try:
            st = path.stat()
            item['missing'] = False
            item['bytes'] = st.st_size
        except OSError:
            item['missing'] = True
            item['bytes'] = 0
    return items


class RenameMedia(BaseModel):
    name: str = Field(min_length=1, max_length=180)


@app.patch('/api/media/{ident}')
def rename_media(ident: str, req: RenameMedia, user: dict = Depends(current_user)):
    name = Path(req.name.replace('\\', '/')).name.strip()
    if not name or name in ('.', '..') or any(ord(c) < 32 for c in name):
        raise HTTPException(400, 'Bitte einen gültigen Dateinamen eingeben.')
    with dbconn() as db:
        cur = db.execute('UPDATE media SET original_name=? WHERE id=? AND owner_id=?', (name, ident, user['id']))
        if not cur.rowcount:
            raise HTTPException(404, 'Mediendatei nicht gefunden.')
    return {'ok': True, 'name': name}


@app.delete('/api/media/{ident}')
def delete_unused_media(ident: str, user: dict = Depends(current_user)):
    # A post, design or draft might need this original even years later.
    # Never remove files still referenced by a published/scheduled job.
    with dbconn() as db:
        row = db.execute('SELECT * FROM media WHERE id=? AND owner_id=?', (ident, user['id'])).fetchone()
        if not row:
            raise HTTPException(404, 'Mediendatei nicht gefunden.')
        if db.execute('SELECT 1 FROM jobs WHERE media_id=? LIMIT 1', (ident,)).fetchone():
            raise HTTPException(409, 'Diese Datei wird in der Veröffentlichungsplanung oder im Archiv verwendet.')
        if db.execute('SELECT 1 FROM designs WHERE source_media_id=? OR output_media_id=? LIMIT 1', (ident,ident)).fetchone():
            raise HTTPException(409, 'Diese Datei gehört zu einem gespeicherten Bilddesign.')
        if db.execute('SELECT 1 FROM draft_media WHERE media_id=? LIMIT 1', (ident,)).fetchone():
            raise HTTPException(409, 'Diese Datei wird von einem Entwurf verwendet. Bitte zuerst den Entwurf ändern.')
        # Older TikTok photo rows may refer to additional images in JSON.
        for job in db.execute("SELECT tiktok_photo_ids FROM jobs WHERE tiktok_photo_ids != '[]'"):
            try:
                if ident in json.loads(job['tiktok_photo_ids'] or '[]'):
                    raise HTTPException(409, 'Diese Datei wird von einer TikTok-Bilderreihe verwendet.')
            except (TypeError, ValueError):
                raise HTTPException(409, 'Ein älterer TikTok-Auftrag muss vor dem Löschen geprüft werden.')
        db.execute('DELETE FROM cloud_media WHERE media_id=?', (ident,))
        db.execute('DELETE FROM media WHERE id=?', (ident,))
    # Delete only server-managed UUID files, never arbitrary paths.
    name = row['filename']
    if re.fullmatch(r'[0-9a-f]{32}\.(jpg|png|mp4)', name):
        (MEDIA/name).unlink(missing_ok=True)
        for derivative in MEDIA.glob(ident+'.instagram-*.jpg'):
            derivative.unlink(missing_ok=True)
        (DATA/'thumbs'/(ident+'.jpg')).unlink(missing_ok=True)
    return {'ok': True}


# V17.23: Drafts are not publication jobs: saving must NEVER post or schedule.
# Store only editor data; tokens, secrets and consent must never be serialized.
_ALLOWED_DRAFT_FIELDS = frozenset({
    'caption','due_at','send_now','targets','default_image','default_video',
    'tiktok_privacy','youtube_privacy','tiktok_aigc'
})
_ALLOWED_DRAFT_TARGET_FIELDS = frozenset({
    'provider','format','kind','connectionId','mediaId','mediaIds',
    'coverIndex','tiktokTitle','autoMusic','brandOrganic','brandContent',
    'disableComment','captionOverride','manual'
})

class DraftWrite(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    payload: dict = Field(default_factory=dict)


def validated_draft(data: dict):
    if set(data) - _ALLOWED_DRAFT_FIELDS:
        raise HTTPException(400, 'Entwurf enthält unerlaubte Felder.')
    if (not isinstance(data.get('caption',''),str) or len(data.get('caption',''))>2200 or
        not isinstance(data.get('due_at',''),str) or len(data.get('due_at',''))>60):
        raise HTTPException(400, 'Ungültiger Text oder Zeitpunkt im Entwurf.')
    targets = data.get('targets', [])
    if not isinstance(targets, list) or len(targets) > 16:
        raise HTTPException(400, 'Ein Entwurf darf maximal 16 Veröffentlichungsziele enthalten.')
    raw = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    if len(raw.encode('utf-8')) > 80_000:
        raise HTTPException(413, 'Der Entwurf ist zu groß.')
    referenced = set()
    for key in ('default_image','default_video'):
        mid = data.get(key)
        if mid:
            if not isinstance(mid,str):
                raise HTTPException(400, 'Ungültige Mediendaten im Entwurf.')
            referenced.add(mid)
    for target in targets:
        if not isinstance(target, dict) or target.get('provider') not in PROVIDERS:
            raise HTTPException(400, 'Ungültiges Veröffentlichungsziel im Entwurf.')
        if target.get('format') not in FORMATS or set(target) - _ALLOWED_DRAFT_TARGET_FIELDS:
            raise HTTPException(400, 'Ungültiges Zielformat oder unerlaubte Zieldaten im Entwurf.')
        if target.get('mediaId'):
            if not isinstance(target['mediaId'],str):
                raise HTTPException(400, 'Ungültige Hauptmedien-ID.')
            referenced.add(target['mediaId'])
        if target.get('captionOverride') is not None and (
            not isinstance(target['captionOverride'],str) or len(target['captionOverride'])>2200
        ):
            raise HTTPException(400, 'Ein individueller Beitragstext ist ungültig.')
        ids = target.get('mediaIds', [])
        if not isinstance(ids, list) or len(ids) > 35 or any(not isinstance(x,str) for x in ids):
            raise HTTPException(400, 'Ungültige Bilderreihe im Entwurf.')
        referenced.update(ids)
    if any(not isinstance(x,str) or not re.fullmatch(r'[0-9a-f]{32}',x) for x in referenced):
        raise HTTPException(400, 'Ungültige Medien-ID im Entwurf.')
    return raw, referenced


def save_draft_row(db, ident, title, payload, owner_id='owner'):
    if not title.strip():
        raise HTTPException(400, 'Bitte einen Entwurfsnamen vergeben.')
    raw, references = validated_draft(payload)
    if references:
        placeholders=','.join('?' for _ in references)
        existing={x['id'] for x in db.execute('SELECT id FROM media WHERE owner_id=? AND id IN ('+placeholders+')',(owner_id, *references))}
        if existing!=references:
            raise HTTPException(400, 'Eine Datei des Entwurfs ist nicht mehr in der Mediathek.')
    stamp=now()
    exists=db.execute('SELECT 1 FROM drafts WHERE id=? AND owner_id=?', (ident, owner_id)).fetchone()
    if exists:
        db.execute('UPDATE drafts SET title=?,payload=?,updated_at=? WHERE id=? AND owner_id=?',
                   (title.strip(), raw, stamp, ident, owner_id))
    else:
        db.execute('INSERT INTO drafts(id,title,payload,created_at,updated_at,owner_id) VALUES(?,?,?,?,?,?)',
                   (ident, title.strip(), raw, stamp, stamp, owner_id))
    db.execute('DELETE FROM draft_media WHERE draft_id=?',(ident,))
    if references:
        db.executemany('INSERT INTO draft_media(draft_id,media_id) VALUES(?,?)',
                       [(ident,mid) for mid in sorted(references)])
    return {'id':ident,'title':title.strip(),'updated_at':stamp}


@app.get('/api/drafts')
def list_drafts(user: dict = Depends(current_user)):
    with dbconn() as db:
        result=[dict(row) for row in db.execute('''SELECT d.id,d.title,d.created_at,d.updated_at,
            (SELECT COUNT(*) FROM draft_media dm WHERE dm.draft_id=d.id) AS media_count
            FROM drafts d WHERE d.owner_id=? ORDER BY d.updated_at DESC''', (user['id'],))]
    return result


@app.post('/api/drafts')
def create_draft(req: DraftWrite, user: dict = Depends(current_user)):
    with dbconn() as db:
        return save_draft_row(db, uuid.uuid4().hex, req.title, req.payload, owner_id=user['id'])


@app.get('/api/drafts/{ident}')
def get_draft(ident: str, user: dict = Depends(current_user)):
    with dbconn() as db:
        row=db.execute('SELECT * FROM drafts WHERE id=? AND owner_id=?',(ident, user['id'])).fetchone()
    if not row:
        raise HTTPException(404,'Entwurf nicht gefunden.')
    result=dict(row)
    result['payload']=json.loads(result['payload'])
    return result


@app.put('/api/drafts/{ident}')
def update_draft(ident: str, req: DraftWrite, user: dict = Depends(current_user)):
    with dbconn() as db:
        if not db.execute('SELECT 1 FROM drafts WHERE id=? AND owner_id=?',(ident, user['id'])).fetchone():
            raise HTTPException(404,'Entwurf nicht gefunden.')
        return save_draft_row(db,ident,req.title,req.payload,owner_id=user['id'])


@app.delete('/api/drafts/{ident}')
def delete_draft(ident: str, user: dict = Depends(current_user)):
    with dbconn() as db:
        if not db.execute('DELETE FROM drafts WHERE id=? AND owner_id=?',(ident, user['id'])).rowcount:
            raise HTTPException(404,'Entwurf nicht gefunden.')
        db.execute('DELETE FROM draft_media WHERE draft_id=?',(ident,))
    return {'ok': True}


@app.get('/api/storage/status')
def storage_status(user: dict = Depends(current_user)):
    uid = user['id']
    with dbconn() as db:
        count_media=db.execute('SELECT COUNT(*) FROM media WHERE owner_id=?', (uid,)).fetchone()[0]
        count_drafts=db.execute('SELECT COUNT(*) FROM drafts WHERE owner_id=?', (uid,)).fetchone()[0]
        count_jobs=db.execute('SELECT COUNT(*) FROM jobs WHERE owner_id=?', (uid,)).fetchone()[0]
        files=[MEDIA/x['filename'] for x in db.execute('SELECT filename FROM media WHERE owner_id=?', (uid,))]
    files_present=0
    used=0
    for x in files:
        try:
            used += x.stat().st_size
            files_present += 1
        except OSError:
            pass
    persistent = not CLOUD_MODE or (_ts_env('PERSISTENT_STORAGE')=='1' and not FREE_PREVIEW)
    return {'persisted':persistent,'free_preview':FREE_PREVIEW,'db_backend':DB_BACKEND,
            'media_count':count_media,'media_present':files_present,
            'missing_count':count_media-files_present,'draft_count':count_drafts,
            'job_count':count_jobs,'media_bytes':used,
            'message':('⚠ Render Free: Uploads können bei Neustart/Deploy verloren gehen. Für dauerhaften Betrieb Persistent Disk (+ optional PostgreSQL) aktivieren.'
                       if not persistent else f'Datenbank: {DB_BACKEND.upper()} · Medien werden im dauerhaften Datenordner gespeichert.')}


def _export_postgres_to_sqlite(snapshot: Path) -> None:
    """Export all PostgreSQL tables into a portable SQLite snapshot."""
    tables = (
        'media', 'jobs', 'designs', 'settings', 'connections', 'oauth_states',
        'storykit_done', 'meta_sessions', 'meta_detached', 'cloud_media',
        'cloud_control', 'drafts', 'draft_media', 'users', 'user_sessions',
        'invites', 'user_prefs',
    )
    with sqlite3.connect(snapshot) as dst:
        dst.execute('PRAGMA journal_mode=DELETE')
        with dbconn() as src:
            for tbl in tables:
                cols = sorted(_db_table_columns(src, tbl))
                if not cols:
                    continue
                col_defs = ', '.join(f'"{c}" TEXT' for c in cols)
                dst.execute(f'CREATE TABLE IF NOT EXISTS "{tbl}" ({col_defs})')
                col_list = ', '.join(f'"{c}"' for c in cols)
                rows = src.execute(f'SELECT {col_list} FROM {tbl}').fetchall()
                if rows:
                    placeholders = ', '.join('?' for _ in cols)
                    dst.executemany(
                        f'INSERT INTO "{tbl}" ({col_list}) VALUES ({placeholders})',
                        [tuple(r[c] for c in cols) for r in rows],
                    )
        dst.commit()


def build_full_backup(destination: Path):
    """Create a complete, portable backup ZIP (DB snapshot + active key + media).

    Works with both SQLite and PostgreSQL, and with either .secret.key or
    TIMESAVE_ENCRYPTION_KEY from the environment. Uses ZIP_STORED for already-
    compressed media to stay fast and memory-safe on Render Starter.
    """
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='timesave_snapshot_', dir=TMP_DIR) as scratch:
        snapshot = Path(scratch) / 'timesave.db'
        if DB_BACKEND == 'postgres':
            _export_postgres_to_sqlite(snapshot)
        else:
            if not DB.is_file():
                init_db()
            with sqlite3.connect(DB, timeout=25) as source, sqlite3.connect(snapshot) as target:
                source.backup(target)
        with sqlite3.connect(snapshot) as db:
            names = [row[0] for row in db.execute('SELECT filename FROM media')]
        present = []
        missing = []
        for filename in names:
            if not re.fullmatch(r'[0-9a-f]{32}\.(jpg|png|mp4)', filename):
                continue
            path = MEDIA / filename
            if path.is_file():
                present.append((filename, path))
            else:
                missing.append(filename)
        total_bytes = snapshot.stat().st_size + sum(p.stat().st_size for _, p in present)
        if len(present) > 29_998 or total_bytes > 3 * 1024**3:
            raise RuntimeError('Mehr als 3 GB / 30.000 Dateien: bitte Archive in kleineren Abschnitten extern sichern.')
        with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED,
                             compresslevel=3, allowZip64=True) as z:
            z.write(snapshot, 'data/timesave.db', compress_type=zipfile.ZIP_DEFLATED)
            # Always serialize the active in-memory KEY_BYTES (works even when TIMESAVE_ENCRYPTION_KEY is used without .secret.key)
            z.writestr('data/.secret.key', KEY_BYTES, compress_type=zipfile.ZIP_DEFLATED)
            for filename, path in present:
                # Images & MP4 are already compressed; ZIP_STORED avoids CPU/RAM spikes on Render.
                z.write(path, 'data/media/' + filename, compress_type=zipfile.ZIP_STORED)
            if missing:
                note = (
                    'Hinweis zum TimeSave-Social-Backup:\n'
                    f'{len(missing)} ältere Mediendatei(en) waren auf dem Datenträger nicht mehr vorhanden und wurden übersprungen:\n'
                    + '\n'.join(missing) + '\n'
                )
                z.writestr('BACKUP_HINWEIS.txt', note.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)
    return destination, len(missing)


@app.get('/api/storage/backup', dependencies=[Depends(require_admin)])
async def download_full_backup():
    # Download contains the encrypted credentials PLUS their decryption key:
    # secret archive, NO CDN caching and never public. Streaming from disk.
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='timesave_backup_', suffix='.zip', dir=TMP_DIR)
    os.close(fd)
    outfile = Path(name)
    try:
        _, missing_count = await asyncio.to_thread(build_full_backup, outfile)
    except Exception as exc:
        outfile.unlink(missing_ok=True)
        if isinstance(exc, RuntimeError):
            raise HTTPException(409, str(exc)) from None
        logger.warning('Backup creation failed: %s', type(exc).__name__)
        raise HTTPException(500, 'Backup konnte nicht erstellt werden: ' + type(exc).__name__) from None
    brand = re.sub(r'[^a-zA-Z0-9_-]+', '_', (_ts_env('BRAND_NAME') or 'TimeSave_Social').strip()).strip('_') or 'TimeSave_Social'
    filename = f'{brand}_Backup_' + datetime.now(APP_TZ).strftime('%Y-%m-%d_%H-%M') + '.zip'
    headers = {
        'Cache-Control': 'no-store, private',
        'X-Content-Type-Options': 'nosniff',
        'X-Backup-Missing-Count': str(missing_count),
    }
    return FileResponse(
        outfile,
        media_type='application/zip',
        filename=filename,
        headers=headers,
        background=BackgroundTask(lambda: outfile.unlink(missing_ok=True)),
    )

@app.get('/api/media/{ident}/thumbnail')
def media_thumbnail(ident:str, user: dict = Depends(current_user)):
    item=media_row(ident, user['id'])
    thumb_dir=DATA/'thumbs'
    thumb_dir.mkdir(exist_ok=True)
    thumbnail=thumb_dir/(item['id']+'.jpg')
    if not thumbnail.exists():
        source_path = MEDIA / item['filename']
        if not source_path.is_file():
            raise HTTPException(404,'Mediendatei fehlt auf dem Datenträger.')
        try:
            if item['mime'] in ('image/png','image/jpeg'):
                with Image.open(source_path) as picture:
                    picture.thumbnail((520,700), Image.Resampling.LANCZOS)
                    frame=ImageOps.exif_transpose(picture)
                    frame.thumbnail((260,350), Image.Resampling.LANCZOS)
                    preview=frame.convert('RGB')
                    _atomic_save_jpeg(preview, thumbnail, quality=74, optimize=True)
            elif item['mime']=='video/mp4':
                ffmpeg=_find_ffmpeg('FFmpeg für Video-Vorschau fehlt.')
                output=_run_ffmpeg([
                    ffmpeg,'-nostdin','-hide_banner','-loglevel','error',
                    *_ffmpeg_thread_args(),'-ss','0.2',
                    '-i',str(source_path),'-frames:v','1',
                    '-vf','scale=260:350:force_original_aspect_ratio=decrease',
                    '-f','image2pipe','-vcodec','mjpeg','pipe:1'],
                    capture_output=True,timeout=18,check=True)
                with Image.open(BytesIO(output.stdout)) as frame:
                    _atomic_save_jpeg(frame.convert('RGB'), thumbnail, quality=75, optimize=True)
            else:
                raise HTTPException(400,'Dateityp wird nicht unterstützt.')
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(400,'Vorschaubild konnte nicht erstellt werden.')
    return FileResponse(thumbnail,media_type='image/jpeg',headers={'Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff'})


def _video_duration_seconds(source: Path, ffmpeg: str) -> float:
    """Read local duration via the bundled ffmpeg (ffprobe is not required on Windows)."""
    try:
        proc = subprocess.run([ffmpeg, '-nostdin', '-hide_banner', '-i', str(source)],
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                              timeout=25)
    except (OSError, subprocess.TimeoutExpired):
        raise HTTPException(400, 'Videodauer konnte nicht gelesen werden.') from None
    details = proc.stderr.decode('utf-8', errors='replace')
    match = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', details)
    if not match or 'Video:' not in details:
        raise HTTPException(400, 'MP4 konnte nicht gelesen werden. Bitte eine gültige Videodatei wählen.')
    seconds = int(match.group(1))*3600 + int(match.group(2))*60 + float(match.group(3))
    if not 0.2 < seconds <= 4 * 3600:
        raise HTTPException(400, 'Videodauer ist nicht geeignet (maximal 4 Stunden).')
    return seconds


def _compress_import_video(source: Path, destination: Path, limit: int = MAX_VIDEO,
                           target: int = VIDEO_TARGET_BYTES) -> None:
    """Compress local MP4 with FFmpeg; never save a truncated or oversized result.

    Uses a duration-derived average bitrate, 1080p/30fps cap and up to three
    retries if variable bitrate or container overhead exceed the target.
    The original is left untouched; caller removes the import staging file.
    """
    try:
        ffmpeg = _find_ffmpeg('Video-Optimierung benötigt FFmpeg. Bitte requirements.txt installieren.')
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from None
    duration = _video_duration_seconds(source, ffmpeg)
    budget = min(target, int(limit * 0.90))
    kbps = int((budget * 8 / duration / 1000) * 0.92 - 128)
    if kbps < 180:
        raise HTTPException(413, 'Video ist für eine gute Qualität unter 100 MB zu lang. Bitte kürzen.')
    # bitrate on short movies must not exceed a useful 1080p AVC bitrate
    bitrate = min(kbps, 14_000)
    for attempt in range(3):
        destination.unlink(missing_ok=True)
        width_cap = 720 if bitrate < 3000 else 1080
        height_cap = 1280 if bitrate < 3000 else 1920
        vf = (f"scale=w='min(iw,{width_cap})':h='min(ih,{height_cap})':"
              'force_original_aspect_ratio=decrease:force_divisible_by=2,'
              'fps=30,setsar=1')
        cmd = [ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
               *_ffmpeg_thread_args(),
               '-i', str(source), '-map', '0:v:0', '-map', '0:a:0?',
               '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast',
               '-b:v', f'{bitrate}k', '-maxrate', f'{int(bitrate * 1.2)}k',
               '-bufsize', f'{bitrate * 2}k', '-pix_fmt', 'yuv420p',
               '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
               str(destination)]
        try:
            result = _run_ffmpeg(cmd, capture_output=True,
                                 timeout=max(180, min(1800, int(duration * 7 + 60))))
        except subprocess.TimeoutExpired:
            destination.unlink(missing_ok=True)
            raise HTTPException(408, 'Video-Optimierung dauerte zu lange. Bitte Video kürzen.') from None
        if result.returncode or not destination.is_file() or destination.stat().st_size < 100:
            destination.unlink(missing_ok=True)
            raise HTTPException(400, 'MP4 konnte nicht optimiert werden. Bitte Videodatei prüfen.')
        if destination.stat().st_size <= budget:
            return
        bitrate = max(180, int(bitrate * (budget / destination.stat().st_size) * 0.87))
    destination.unlink(missing_ok=True)
    raise HTTPException(413, 'Video konnte nicht zuverlässig unter 100 MB verkleinert werden.')


@app.post('/api/media')
async def upload_media(file: UploadFile = File(...),
                       optimize_video: bool = Form(True),
                       user: dict = Depends(current_user)):
    """Stream imports; videos over 100 MiB are automatically encoded before saving.

    Only the compressed MP4 enters the existing media table. This keeps the
    publisher, planning, story reminders and encrypted user data unchanged.
    """
    raw_ct = (file.content_type or '').split(';', 1)[0].strip().lower()
    raw_ext = Path(file.filename or '').suffix.lower()
    if raw_ct in ('image/jpg', 'image/jpeg') or raw_ext in ('.jpg', '.jpeg'):
        mime = 'image/jpeg'
    elif raw_ct == 'image/png' or raw_ext == '.png':
        mime = 'image/png'
    elif raw_ct == 'image/webp' or raw_ext == '.webp':
        mime = 'image/webp'
    elif raw_ct == 'video/mp4' or raw_ext == '.mp4':
        mime = 'video/mp4'
    elif raw_ct in ('video/webm', 'video/quicktime', 'video/x-matroska') or raw_ext in ('.webm', '.mov', '.mkv'):
        mime = 'video/webm'
    else:
        raise HTTPException(400, 'Nur JPG, PNG, WebP, MP4, WebM oder MOV erlaubt')
    is_image = mime in ('image/png', 'image/jpeg', 'image/webp')
    upper_bound = MAX_IMAGE if is_image else MAX_VIDEO_IMPORT
    total = 0
    ident = uuid.uuid4().hex
    target_mime = 'image/jpeg' if mime == 'image/webp' else ('video/mp4' if mime == 'video/webm' else mime)
    ext = {'image/png':'.png', 'image/jpeg':'.jpg', 'video/mp4':'.mp4'}[target_mime]
    in_ext = {'image/png':'.png', 'image/jpeg':'.jpg', 'image/webp':'.webp', 'video/mp4':'.mp4', 'video/webm':'.webm'}[mime]
    final_path = MEDIA / (ident + ext)
    optimized = False
    with tempfile.TemporaryDirectory(prefix='.import_', dir=MEDIA) as temp:
        staged = Path(temp) / ('eingang' + in_ext)
        # Never buffer the entire incoming video in Python memory.
        with staged.open('wb') as output:
            while block := await file.read(4 * 1024 * 1024):
                total += len(block)
                if total > upper_bound:
                    raise HTTPException(413, 'Videos beim Import maximal 1 GB; Bilder maximal 15 MB.')
                output.write(block)
        if not total:
            raise HTTPException(400, 'Leere Datei')
        if is_image:
            try:
                with Image.open(staged) as pic:
                    pic.verify()
                with Image.open(staged) as pic:
                    if pic.width * pic.height > 50_000_000:
                        raise ValueError('Bildauflösung zu groß')
                    if mime == 'image/webp':
                        jpg_path = Path(temp) / 'eingang.jpg'
                        pic.convert('RGB').save(jpg_path, format='JPEG', quality=92, optimize=True)
                        staged = jpg_path
                    elif pic.format != ('JPEG' if target_mime == 'image/jpeg' else 'PNG'):
                        raise ValueError('Bildformat stimmt nicht')
            except Exception:
                raise HTTPException(400, 'Beschädigte oder ungültige Bilddatei') from None
        elif mime == 'video/webm':
            exe = _find_ffmpeg('Kamera-Video-Konvertierung (WebM/MOV -> MP4) benötigt FFmpeg.')
            mp4_path = Path(temp) / 'kamera.mp4'
            cmd = [
                exe, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                *_ffmpeg_thread_args(), '-i', str(staged),
                '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
                '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
                str(mp4_path)
            ]
            res = await asyncio.to_thread(_run_ffmpeg, cmd, timeout=240, capture_output=True, text=True)
            if res.returncode != 0 or not mp4_path.is_file() or mp4_path.stat().st_size == 0:
                raise HTTPException(400, 'Kamera-Video konnte nicht in MP4 umgewandelt werden.')
            staged = mp4_path
            optimized = True
            if staged.stat().st_size > MAX_VIDEO:
                optimized_path = Path(temp) / 'optimiert.mp4'
                await asyncio.to_thread(_compress_import_video, staged, optimized_path,
                                        MAX_VIDEO, min(VIDEO_TARGET_BYTES, int(MAX_VIDEO * 0.90)))
                staged = optimized_path
        else:
            with staged.open('rb') as stream:
                if b'ftyp' not in stream.read(32):
                    raise HTTPException(400, 'Keine gültige MP4-Signatur')
            if total > MAX_VIDEO:
                if not optimize_video:
                    raise HTTPException(413, 'Video über 100 MB. Automatische Optimierung aktivieren.')
                optimized_path = Path(temp) / 'optimiert.mp4'
                await asyncio.to_thread(_compress_import_video, staged, optimized_path,
                                        MAX_VIDEO, min(VIDEO_TARGET_BYTES, int(MAX_VIDEO * 0.90)))
                staged = optimized_path
                optimized = True
        mime = target_mime
        stored_size = staged.stat().st_size
        if stored_size > (MAX_VIDEO if mime == 'video/mp4' else MAX_IMAGE):
            raise HTTPException(413, 'Die Datei überschreitet das Veröffentlichungs-Limit.')
        # Atomic within one volume; aborted imports never leave media DB rows.
        os.replace(staged, final_path)
    try:
        with dbconn() as db:
            db.execute('INSERT INTO media(id,filename,original_name,mime,created_at,owner_id) VALUES(?,?,?,?,?,?)',
                       (ident, final_path.name, (Path(file.filename or 'Medien').stem + ext)[:180], mime, now(), user['id']))
    except Exception:
        final_path.unlink(missing_ok=True)
        raise
    cloud = 'not_configured'
    if media_cloud_enabled() and mime in ('image/jpeg', 'image/png'):
        try:
            await asyncio.to_thread(gcs_upload_media, {'id':ident,'filename':final_path.name,'mime':mime})
            cloud = 'uploaded'
        except Exception:
            cloud = 'pending'
    return {'id': ident, 'cloud': cloud, 'optimized': optimized,
            'original_bytes': total, 'stored_bytes': stored_size}

# V17.4 – dedicated TikTok photo preparation, without changing existing originals.
# TikTok requires photo URLs (not FILE_UPLOAD); preparing a photo does not post it.
def _tiktok_photo_jpeg(raw: bytes) -> bytes:
    if not raw or len(raw) > MAX_IMAGE:
        raise HTTPException(413, 'TikTok-Foto darf höchstens 15 MB groß sein.')
    try:
        with Image.open(BytesIO(raw)) as im:
            if im.format not in {'JPEG', 'PNG'} or im.width * im.height > 50_000_000:
                raise ValueError('Ungültiges Bildformat oder zu hohe Auflösung')
            im.load()
            im = ImageOps.exif_transpose(im)
            # Transparente PNGs erhalten einen weißen Hintergrund; EXIF is removed.
            if im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info):
                rgba = im.convert('RGBA')
                white = Image.new('RGB', rgba.size, (255, 255, 255))
                white.paste(rgba, mask=rgba.getchannel('A'))
                im = white
            else:
                im = im.convert('RGB')
            # Keep the full image without cropping; optimized for TikTok portrait photos.
            im.thumbnail((1080, 1920), Image.Resampling.LANCZOS)
            output = BytesIO()
            im.save(output, 'JPEG', quality=90, optimize=True, progressive=True)
            result = output.getvalue()
            if len(result) > MAX_IMAGE:
                raise ValueError('JPEG zu groß')
            return result
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        raise HTTPException(400, 'Das Foto lässt sich nicht als TikTok-JPG vorbereiten.') from exc


def _save_tiktok_photo_jpeg(raw, original_name, owner_id='owner'):
    ident = uuid.uuid4().hex
    target = MEDIA / (ident + '.jpg')
    jpeg_bytes = _tiktok_photo_jpeg(raw)
    with tempfile.NamedTemporaryFile(prefix='.tt_', suffix='.jpg', dir=MEDIA, delete=False) as fh:
        tmp = Path(fh.name)
    try:
        tmp.write_bytes(jpeg_bytes)
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)
    filename = 'TikTok - ' + Path(original_name or 'Foto').stem[:151] + '.jpg'
    try:
        with dbconn() as db:
            db.execute('INSERT INTO media(id,filename,original_name,mime,created_at,owner_id) VALUES(?,?,?,?,?,?)',
                       (ident, target.name, filename, 'image/jpeg', now(), owner_id))
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return {'id': ident, 'mime': 'image/jpeg', 'filename': filename}


@app.post('/api/tiktok/photos/import')
async def import_tiktok_photo(file: UploadFile = File(...), user: dict = Depends(current_user)):
    if file.content_type not in {'image/jpeg', 'image/jpg', 'image/png'}:
        raise HTTPException(400, 'Für die TikTok-Bilderreihe nur JPG oder PNG auswählen.')
    raw = await file.read(MAX_IMAGE + 1)
    return _save_tiktok_photo_jpeg(raw, file.filename, owner_id=user['id'])


@app.post('/api/tiktok/photos/prepare/{ident}')
def prepare_tiktok_existing_photo(ident: str, user: dict = Depends(current_user)):
    source = media_row(ident, user['id'])
    if source['mime'] not in {'image/jpeg', 'image/png'}:
        raise HTTPException(400, 'Nur JPG/PNG-Fotos können vorbereitet werden.')
    path = MEDIA / source['filename']
    if not path.is_file() or path.stat().st_size > MAX_IMAGE:
        raise HTTPException(400, 'Foto fehlt oder ist zu groß.')
    return _save_tiktok_photo_jpeg(path.read_bytes(), source['original_name'], owner_id=user['id'])


@app.get('/api/tiktok/photos/readiness', dependencies=[Depends(guard)])
def tiktok_photo_readiness():
    """Configuration-only readiness. Domain verification and external reachability
    can only be confirmed with TikTok and a real public HTTPS fetch."""
    base = public_base()
    prefix = setting('tiktok_verified_media_prefix').strip()
    parsed_base = urlsplit(base)
    parsed_prefix = urlsplit(prefix)
    base_ok = bool(parsed_base.scheme == 'https' and parsed_base.netloc and not parsed_base.username
                   and not parsed_base.query and not parsed_base.fragment)
    prefix_ok = bool(parsed_prefix.scheme == 'https' and parsed_prefix.netloc and not parsed_prefix.username
                     and prefix.endswith('/') and not parsed_prefix.query and not parsed_prefix.fragment)
    expected = base.rstrip('/') + '/public/media/'
    matches = base_ok and prefix_ok and expected.startswith(prefix)
    problems = []
    if not base_ok:
        problems.append('Öffentliche URL muss auf den von außen erreichbaren HTTPS-TimeSave-Social-Server zeigen.')
    if not prefix_ok:
        problems.append('Das bei TikTok verifizierte URL-Präfix muss eine gültige HTTPS-Adresse sein und mit / enden.')
    elif base_ok and not matches:
        problems.append('Das bei TikTok eingetragene Präfix muss die TimeSave-Social-Bildlinks abdecken: ' + expected)
    return {'configured': bool(matches), 'public_base_configured': base_ok,
            'prefix_configured': prefix_ok, 'url_matches_prefix': bool(matches),
            'problems': problems, 'verification': 'not_checked',
            'note': 'Die Prüfung bestätigt nur deine Einstellungen. Ob die Domain bei TikTok verifiziert und von TikTok erreichbar ist, muss extern getestet werden.'}


class TikTokVideoConvert(BaseModel):
    seconds:int=Field(5,ge=3,le=15)


@app.post('/api/media/{ident}/make-video')
async def make_tiktok_video(ident:str,req:TikTokVideoConvert, user: dict = Depends(current_user)):
    media=media_row(ident, user['id'])
    if media['mime'] not in ('image/jpeg','image/png'):
        raise HTTPException(400,'Bitte ein JPG-/PNG-Bild auswählen.')
    try:
        exe=_find_ffmpeg('Video-Encoder fehlt: python -m pip install imageio-ffmpeg')
    except RuntimeError as exc:
        raise HTTPException(503,str(exc)) from None
    new_id=uuid.uuid4().hex
    output=MEDIA/(new_id+'.mp4')
    vf='scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25,format=yuv420p'
    cmd=[exe,'-nostdin','-hide_banner','-loglevel','error','-y',*_ffmpeg_thread_args(),'-loop','1',
         '-framerate','25','-i',str(MEDIA/media['filename']),'-t',str(req.seconds),
         '-vf',vf,'-c:v','libx264','-preset','fast','-crf','23',
         '-pix_fmt','yuv420p','-movflags','+faststart',str(output)]
    try:
        proc=await asyncio.to_thread(_run_ffmpeg,cmd,capture_output=True,timeout=120)
        if proc.returncode!=0 or not output.exists() or not output.stat().st_size:
            raise RuntimeError('ffmpeg konnte das MP4 nicht erstellen')
        if output.stat().st_size>MAX_VIDEO:
            raise RuntimeError('Das MP4 überschreitet das Upload-Limit')
        with dbconn() as db:
            db.execute('INSERT INTO media(id,filename,original_name,mime,created_at,owner_id) VALUES(?,?,?,?,?,?)',
                (new_id,output.name,'TikTok-Video '+media['original_name'][:150]+'.mp4','video/mp4',now(),user['id']))
        return {'id':new_id,'message':'MP4-Video erstellt; es ist ein Video-Beitrag, keine Story.'}
    except (RuntimeError,subprocess.TimeoutExpired):
        output.unlink(missing_ok=True)
        raise HTTPException(400,'Video konnte nicht erstellt werden. Bitte Video-Encoder prüfen.') from None



# V9: media editing pipeline. Creates NEW MP4 assets only; never changes originals.
# The same media table is used by Facebook, Instagram, Telegram and TikTok planners.
# V17.7: Video length and text visibility are two independent timelines.
# An omitted `seconds` now means: KEEP THE ENTIRE ORIGINAL MP4.
# Existing V9 requests with an explicit seconds value remain compatible.
class VideoTextLayer(BaseModel):
    title: str = Field('', max_length=2000)
    subtitle: str = Field('', max_length=2000)
    badge: str = Field('', max_length=32)
    title_color: str = Field('#ffffff', pattern=r'^#[0-9a-fA-F]{6}$')
    position: str = Field('center', pattern='^(top|center|bottom)$')
    x_pct: float = Field(50,ge=5,le=95)
    y_pct: float | None = Field(None,ge=5,le=95)
    box_opacity: int = Field(72,ge=0,le=100)
    text_scale: int = Field(100,ge=60,le=160)
    start_seconds: float = Field(0, ge=0, le=14400)
    end_seconds: float | None = Field(None, ge=0, le=14400)


class VideoStudioRequest(BaseModel):
    media_id: str
    # Null/omitted = source video in its entirety; for still images default 8 seconds.
    seconds: float | None = Field(None, ge=1, le=14400)
    start_seconds: float = Field(0, ge=0, le=14400)
    format: str = Field('story', pattern='^(story|portrait|square|landscape)$')
    motion: str = Field('static', pattern='^(static|zoom)$')
    filter: str = Field('normal', pattern='^(normal|warm|cool|vivid|mono)$')
    background_mode: str = Field('cover', pattern='^(cover|blur|solid)$')
    background_color: str = Field('#221828', pattern=r'^#[0-9a-fA-F]{6}$')
    title: str = Field('', max_length=2000)
    subtitle: str = Field('', max_length=2000)
    badge: str = Field('', max_length=32)
    title_color: str = Field('#ffffff', pattern=r'^#[0-9a-fA-F]{6}$')
    position: str = Field('center', pattern='^(top|center|bottom)$')
    fade: bool = False
    # V17.24: editing options; defaults preserve all previous renders.
    playback_speed: float = Field(1.0, ge=0.5, le=2.0)
    audio_volume: int = Field(100, ge=0, le=200)  # 0 = mute; images never have audio
    rotation: int = Field(0)  # validated to a safe, discrete set in endpoint
    mirror: bool = False
    # Each layer has its own independently timed display interval.
    text_layers: list[VideoTextLayer] = Field(default_factory=list, max_length=50)


def _video_studio_overlay(req, size, out_path):
    from PIL import Image, ImageDraw, ImageFont
    w,h=size
    image=Image.new('RGBA',(w,h),(0,0,0,0))
    draw=ImageDraw.Draw(image)
    def font(size,bold=False):
        roots=[
          ('C:/Windows/Fonts/arialbd.ttf' if bold else 'C:/Windows/Fonts/arial.ttf'),
          ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]
        for path in roots:
            try:return ImageFont.truetype(path,size)
            except OSError:pass
        return ImageFont.load_default()
    def wrap(text,max_width,fnt,max_lines):
        lines=[]
        for paragraph in text.splitlines():
            current=''
            for word in paragraph.split():
                test=(current+' '+word).strip()
                if current and draw.textbbox((0,0),test,font=fnt)[2]>max_width:
                    lines.append(current);current=word
                else:current=test
            if current:lines.append(current)
        return lines[:max_lines]
    if req.title.strip() or req.subtitle.strip():
        title_font=font(round(w*0.063*req.text_scale/100),True)
        sub_font=font(round(w*0.037*req.text_scale/100))
        titles=wrap(req.title.strip(),w*.78,title_font,4)
        subs=wrap(req.subtitle.strip(),w*.78,sub_font,4)
        tline=round(w*.087*req.text_scale/100);sline=round(w*.060*req.text_scale/100)
        total=max(100,len(titles)*tline+len(subs)*sline+round(w*.090))
        cx=round(w*req.x_pct/100)
        cy=round(h*(req.y_pct if req.y_pct is not None else {'top':24,'center':50,'bottom':76}[req.position])/100)
        box_width=round(w*.86)
        left=max(round(w*.03),min(round(w*.97)-box_width,cx-box_width//2))
        right=left+box_width
        y=max(round(h*.04),min(round(h*.96)-total,cy-total//2))
        opacity=round(255*req.box_opacity/100)
        if opacity:
            draw.rounded_rectangle((left,y,right,y+total),radius=round(w*.033),fill=(22,15,44,opacity))
        ty=y+round(w*.045)
        rgb=tuple(int(req.title_color[i:i+2],16) for i in (1,3,5))
        for line in titles:
            draw.text(((left+right)/2,ty),line,font=title_font,anchor='mt',fill=rgb+(255,),stroke_width=1,stroke_fill=(0,0,0,90))
            ty+=tline
        if titles and subs: ty+=round(w*.010)
        for line in subs:
            draw.text(((left+right)/2,ty),line,font=sub_font,anchor='mt',fill=(249,244,255,255))
            ty+=sline
    if req.badge.strip():
        fnt=font(round(w*.03),True)
        txt=req.badge.strip()[:32]
        tw=draw.textbbox((0,0),txt,font=fnt)[2]
        px=round(w*.045);py=round(w*.021)
        left=round(w*.06);top=round(h*.085)
        draw.rounded_rectangle((left,top,left+tw+2*px,top+round(w*.09)),radius=round(w*.04),fill=(150,94,210,225))
        draw.text((left+px,top+py),txt,font=fnt,fill=(255,255,255,255))
    image.save(out_path)


@app.post('/api/media/render-video')
async def render_video_studio(req: VideoStudioRequest, user: dict = Depends(current_user)):
    return await _render_video_studio(req, user, lambda pct, msg: None)


async def _render_video_studio(req, user, progress):
    progress(3, 'Original wird geprüft …')
    source = media_row(req.media_id, user['id'])
    if source['mime'] not in ('image/jpeg','image/png','video/mp4'):
        raise HTTPException(400, 'Bitte ein Bild oder MP4 auswählen.')
    try:
        exe = _find_ffmpeg('Videobearbeitung benötigt FFmpeg oder imageio-ffmpeg.')
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from None
    source_path = MEDIA / source['filename']
    is_video = source['mime'] == 'video/mp4'
    if is_video:
        source_seconds = await asyncio.to_thread(_video_duration_seconds, source_path, exe)
        if req.start_seconds >= source_seconds:
            raise HTTPException(400, 'Der Startpunkt liegt hinter dem Videoende.')
        available = source_seconds - req.start_seconds
        if req.seconds is not None and req.seconds > available + 0.30:
            raise HTTPException(400, 'Die gewählte Clipdauer reicht über das Originalvideo hinaus.')
        # None is NEVER a hidden 10- or 30-second limit.
        duration = available if req.seconds is None else min(req.seconds, available)
    else:
        if req.start_seconds != 0:
            raise HTTPException(400, 'Bei Fotos kann kein Video-Startpunkt festgelegt werden.')
        duration = req.seconds if req.seconds is not None else 8.0
    if duration < 1:
        raise HTTPException(400, 'Das Video muss mindestens eine Sekunde lang sein.')
    if req.rotation not in (0, 90, 180, 270):
        raise HTTPException(400, 'Drehung muss 0°, 90°, 180° oder 270° betragen.')
    if not is_video and req.playback_speed != 1:
        raise HTTPException(400, 'Geschwindigkeit lässt sich nur bei MP4 verändern.')
    output_seconds = duration / req.playback_speed
    if output_seconds > 4 * 3600:
        raise HTTPException(400, 'Das exportierte Video darf maximal 4 Stunden lang sein.')

    if req.text_layers:
        layers = req.text_layers
    elif req.title.strip() or req.subtitle.strip() or req.badge.strip():
        layers = [VideoTextLayer(title=req.title, subtitle=req.subtitle,
                                 badge=req.badge, title_color=req.title_color,
                                 position=req.position)]
    else:
        layers = []
    for idx, layer in enumerate(layers):
        if layer.end_seconds is not None and layer.end_seconds <= layer.start_seconds:
            raise HTTPException(400, f'Texteinblendung {idx+1}: Ende muss nach dem Start liegen.')
        if layer.start_seconds >= duration or (layer.end_seconds is not None and layer.end_seconds > duration + 0.3):
            raise HTTPException(400, f'Texteinblendung {idx+1} liegt außerhalb der Videolänge.')

    w, h = {'story': (720, 1280), 'portrait': (720, 900),
            'square': (720, 720), 'landscape': (1280, 720)}[req.format]
    filters = {
        'normal': 'eq=saturation=1.0:brightness=0.0',
        'warm': 'eq=saturation=1.1:brightness=0.025:gamma_r=1.07:gamma_b=0.92',
        'cool': 'eq=saturation=1.1:brightness=0.01:gamma_r=0.92:gamma_b=1.09',
        'vivid': 'eq=saturation=1.35:brightness=0.015:contrast=1.08',
        'mono': 'hue=s=0',
    }
    # Transform the source BEFORE fitting to the canvas; text overlays stay upright.
    transform = {0: '', 90: 'transpose=1,', 180: 'hflip,vflip,',
                 270: 'transpose=2,'}[req.rotation]
    if req.mirror:
        transform += 'hflip,'
    # Match export and preview by fitting to the selected canvas.
    if req.background_mode == 'solid':
        c=req.background_color.lstrip('#')
        base = (f'{transform}scale={w}:{h}:force_original_aspect_ratio=decrease,'
                f'pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=0x{c},setsar=1,{filters[req.filter]}')
    elif req.background_mode == 'blur':
        # Two input streams: a blurred full-bleed copy behind the sharp, uncropped video.
        # The optional soundtrack is still mapped directly from the original file.
        base = (f'{transform}split=2[blur_src][front_src];'
                f'[blur_src]scale={w}:{h}:force_original_aspect_ratio=increase,'
                f'crop={w}:{h},boxblur=16:2[blurred];'
                f'[front_src]scale={w}:{h}:force_original_aspect_ratio=decrease[sharp];'
                f'[blurred][sharp]overlay=(W-w)/2:(H-h)/2,setsar=1,{filters[req.filter]}')
    else:
        base = f'{transform}scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,{filters[req.filter]}'
    if req.motion == 'zoom' and not is_video and req.background_mode == 'cover':
        zw, zh = int(w*1.15), int(h*1.15)
        base = (f'{transform}scale={zw}:{zh}:force_original_aspect_ratio=increase,'
                f'crop={zw}:{zh},setsar=1,'
                f"zoompan=z='min(zoom+0.0007,1.12)':d=1:s={w}x{h}:fps=25,{filters[req.filter]}")
    base += ',fps=25,format=yuv420p,setpts=PTS-STARTPTS'
    if req.fade:
        base += f',fade=t=in:st=0:d=0.35,fade=t=out:st={max(0.,duration-.50):.3f}:d=0.45'

    progress(8, 'Video und Texte werden vorbereitet …')
    ident = uuid.uuid4().hex
    output = MEDIA / (ident + '.mp4')
    try:
        with tempfile.TemporaryDirectory(prefix='timesave_video177_') as temp_dir:
            cmd = [exe, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-filter_threads','1','-filter_complex_threads','1']
            if not is_video:
                cmd += ['-threads','1','-loop','1','-framerate','25','-i',str(source_path)]
            else:
                if req.start_seconds:
                    cmd += ['-ss',str(req.start_seconds)]
                cmd += ['-threads','1','-i',str(source_path)]
            for index, layer in enumerate(layers):
                overlay_path = Path(temp_dir)/f'overlay_{index}.png'
                await asyncio.to_thread(_video_studio_overlay, layer, (w,h), overlay_path)
                cmd += ['-threads','1','-framerate','25','-i',str(overlay_path)]
            chain = [f'[0:v]{base}[v0]']
            head = 'v0'
            for index, layer in enumerate(layers):
                end_seconds = min(duration, layer.end_seconds if layer.end_seconds is not None else duration)
                # Quote and escape the expression for FFmpeg; no shell involved.
                time_enable = f'between(t\\,{layer.start_seconds:.3f}\\,{end_seconds:.3f})'
                next_name = f'v{index+1}'
                chain.append(f'[{head}][{index+1}:v]overlay=0:0:format=yuv420:'
                             f"shortest=0:eof_action=repeat:repeatlast=1:enable='{time_enable}'[{next_name}]")
                head = next_name
            # Apply the speed change after all text timelines, so text times in the
            # editor always refer to the ORIGINAL clip: no unexpected shifts.
            if req.playback_speed != 1:
                chain.append(f'[{head}]setpts=(PTS-STARTPTS)/{req.playback_speed:.4f},fps=25[sped]')
                head = 'sped'
            cmd += ['-filter_complex',';'.join(chain),'-map',f'[{head}]']
            if is_video and req.audio_volume:
                cmd += ['-map','0:a?','-c:a','aac','-b:a','128k']
                # FFmpeg atempo accepts 0.5..2.0; match the changed video speed.
                audio_effects = []
                if req.playback_speed != 1:
                    audio_effects.append(f'atempo={req.playback_speed:.4f}')
                if req.audio_volume != 100:
                    audio_effects.append(f'volume={req.audio_volume / 100:.2f}')
                if audio_effects:
                    cmd += ['-af', ','.join(audio_effects)]
            # Bound all outputs, including full-length edits, to the measured clip.
            cmd += ['-t',f'{output_seconds:.3f}']
            cmd += ['-c:v','libx264','-threads','1','-preset','veryfast','-tune','zerolatency','-crf','25',
                    '-pix_fmt','yuv420p','-movflags','+faststart',str(output)]
            timeout = min(7200, max(240, int(output_seconds*9+90)))
            try:
                proc = await asyncio.to_thread(_v184_ffmpeg_progress, cmd, timeout, output_seconds, progress)
            except subprocess.TimeoutExpired:
                raise HTTPException(408, 'Das Rendern dauerte zu lange. Das Original ist unverändert.') from None
            if proc.returncode or not output.is_file() or output.stat().st_size < 100:
                logger.error('Studio FFmpeg exit=%s: %s', proc.returncode, proc.stderr[-3000:].decode('utf-8',errors='replace'))
                if proc.returncode in (-9, 137):
                    raise HTTPException(503, 'Videoencoder wurde beendet (möglicherweise zu wenig Arbeitsspeicher). Original unverändert.')
                raise HTTPException(400, f'MP4 konnte nicht erstellt werden (Encoder-Code {proc.returncode}). Details stehen im Render-Log.')
            optimized = False
            if output.stat().st_size > MAX_VIDEO:
                progress(94, 'Dateigröße wird optimiert …')
                compressed = Path(temp_dir)/'komprimiert.mp4'
                await asyncio.to_thread(_compress_import_video, output, compressed,
                                        MAX_VIDEO, VIDEO_TARGET_BYTES)
                os.replace(compressed, output)
                optimized = True
        progress(98, 'Video wird in der Mediathek gespeichert …')
        with dbconn() as db:
            db.execute('INSERT INTO media(id,filename,original_name,mime,created_at,owner_id) VALUES(?,?,?,?,?,?)',
                       (ident,output.name,
                        ('Studio-Video '+Path(source['original_name']).stem)[:176]+'.mp4',
                        'video/mp4',now(),user['id']))
        return {'id':ident, 'message':'Video gestaltet und als neues MP4 gespeichert. Original unverändert.',
                'seconds':round(output_seconds,2),'source_seconds':round(duration,2),
                'playback_speed':req.playback_speed,'format':req.format,
                'full_length':is_video and req.seconds is None and req.start_seconds == 0,
                'text_layers':len(layers), 'optimized':optimized}
    except Exception:
        output.unlink(missing_ok=True)
        raise

@app.get('/api/media/{ident}')
def fetch_media(ident:str, user: dict = Depends(current_user)):
    media=media_row(ident, user['id'])
    path=MEDIA/media['filename']
    if not path.is_file():
        raise HTTPException(404,'Mediendatei fehlt auf dem Datenträger.')
    return FileResponse(path,media_type=media['mime'])

@app.get('/api/media/{ident}/instagram-jpg')
def download_instagram_ready_jpg(ident:str,format:str='story', user: dict = Depends(current_user)):
    if format not in ('story','post'):
        raise HTTPException(400,'Bitte Story oder Beitrag wählen.')
    media=media_row(ident, user['id'])
    if media['mime'] not in ('image/png','image/jpeg'):
        raise HTTPException(400,'Instagram-JPG ist nur für Bilder verfügbar.')
    try:
        path=instagram_ready_jpeg(media,format)
    except RuntimeError:
        raise HTTPException(422,'Instagram-JPG konnte nicht erstellt werden.') from None
    return FileResponse(path,media_type='image/jpeg',filename=f'TimeSave_Social_Instagram_{format}.jpg')


@app.get('/api/media/{ident}/download')
def download_media(ident:str, user: dict = Depends(current_user)):
    media=media_row(ident, user['id'])
    path=MEDIA/media['filename']
    if not path.is_file():
        raise HTTPException(404,'Mediendatei fehlt auf dem Datenträger.')
    return FileResponse(path,media_type=media['mime'],
        filename=media['original_name'])

def whatsapp_mobile_link(media, minutes=20):
    """Short-lived, read-only HTTPS media link to scan with the phone.

    Does NOT connect to WhatsApp or publish a Status. The QR contains a bearer
    capability URL for this single media object until expiry; keep it private.
    """
    if media['mime'] not in {'image/jpeg','image/png','video/mp4'}:
        raise HTTPException(400, 'Nur JPG, PNG und MP4 können an das Handy übergeben werden.')
    if media_cloud_enabled():
        if media['mime']=='video/mp4':
            return gcs_signed_video_url(media,minutes=minutes)
        return gcs_signed_media_url(media,minutes=minutes)
    try:
        return secure_media_url(media['id'], minutes=minutes)
    except RuntimeError as exc:
        raise HTTPException(409, 'Handy-QR benötigt einen konfigurierten Cloud-Medienbucket oder einen erreichbaren HTTPS-Server. Du kannst die Datei weiterhin direkt herunterladen.') from exc


@app.get('/api/whatsapp/mobile-qr/{ident}')
def whatsapp_mobile_qr(ident: str, user: dict = Depends(current_user)):
    media=media_row(ident, user['id'])
    try:
        import qrcode
    except ImportError:
        raise HTTPException(503, 'QR-Komponente fehlt. Bitte requirements.txt installieren (qrcode[pil]).') from None
    url=whatsapp_mobile_link(media,minutes=20)
    qr=qrcode.QRCode(version=None,error_correction=qrcode.constants.ERROR_CORRECT_M,
                     box_size=5,border=4)
    qr.add_data(url)
    qr.make(fit=True)
    output=BytesIO()
    qr.make_image(fill_color='black',back_color='white').save(output,format='PNG')
    return Response(content=output.getvalue(),media_type='image/png',
                    headers={'Cache-Control':'no-store, private', 'X-Content-Type-Options':'nosniff'})


def _tiktok_verify_matches(filename: str, cfg_name: str) -> bool:
    if not filename or not cfg_name:
        return False
    # Accept exact match as well as optional .txt suffix tolerance
    candidates = {cfg_name}
    if cfg_name.endswith('.txt'):
        candidates.add(cfg_name[:-4])
    else:
        candidates.add(cfg_name + '.txt')
    return any(secrets.compare_digest(filename, c) for c in candidates)


def _tiktok_verify_response(filename: str, head_only: bool = False):
    cfg_name = (os.getenv('TIKTOK_VERIFY_FILENAME') or setting('tiktok_verify_filename') or '').strip().lstrip('/')
    cfg_body = (os.getenv('TIKTOK_VERIFY_CONTENT') or setting('tiktok_verify_content') or '').strip()
    if cfg_name and cfg_body and _tiktok_verify_matches(filename, cfg_name):
        headers = {
            'Cache-Control': 'public, max-age=300',
            'X-Content-Type-Options': 'nosniff',
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Length': str(len(cfg_body.encode('utf-8'))),
        }
        if head_only:
            return Response(content=b'', status_code=200, headers=headers)
        return PlainTextResponse(cfg_body, headers=headers)
    return None


@app.api_route('/public/media/{ident}', methods=['GET', 'HEAD'])
def public_media(request: Request, ident:str,exp:str='',sig:str='',ig:str=''):
    vresp = _tiktok_verify_response(ident, head_only=(request.method == 'HEAD'))
    if vresp is not None:
        return vresp
    try:
        if ig not in ('','story','post') or not exp.isdigit() or int(exp)<int(datetime.now(timezone.utc).timestamp()):
            raise ValueError
        payload=f'{ident}:{exp}' + (f':instagram-{ig}' if ig else '')
        expected=hmac.new(KEY_BYTES,payload.encode(),hashlib.sha256).hexdigest()
        if not secrets.compare_digest(sig,expected):
            raise ValueError
    except (ValueError,OverflowError):
        raise HTTPException(403,'Link abgelaufen oder ungültig')
    media=media_row(ident)
    if ig:
        try:
            jpeg = instagram_ready_jpeg(media,ig)
        except RuntimeError:
            raise HTTPException(422,'Instagram-JPG konnte nicht erstellt werden.') from None
        return FileResponse(jpeg,media_type='image/jpeg',headers={'Cache-Control':'private, max-age=300',
            'X-Content-Type-Options':'nosniff'})
    path=MEDIA/media['filename']
    if not path.is_file():
        raise HTTPException(404,'Mediendatei fehlt auf dem Datenträger.')
    return FileResponse(path,media_type=media['mime'])

class DesignRequest(BaseModel):
    media_id:str
    overlay_text:str=Field('',max_length=600)

@app.post('/api/designs')
def design_image(req:DesignRequest, user: dict = Depends(current_user)):
    source=media_row(req.media_id, user['id'])
    if not source['mime'].startswith('image/'):
        raise HTTPException(400,'Story-Designer benötigt ein Bild')
    src_path=MEDIA/source['filename']
    if not src_path.is_file():
        raise HTTPException(404,'Originalbild fehlt auf dem Datenträger.')
    with Image.open(src_path) as image:
        image=ImageOps.fit(ImageOps.exif_transpose(image).convert('RGB'),(1080,1920),Image.Resampling.LANCZOS)
    if req.overlay_text.strip():
        draw=ImageDraw.Draw(image,'RGBA')
        try: font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',58)
        except OSError:
            try: font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',58)
            except OSError: font=ImageFont.load_default()
        lines=[]
        for paragraph in req.overlay_text.splitlines():
            line=''
            for word in paragraph.split():
                alt=(line+' '+word).strip()
                if line and draw.textbbox((0,0),alt,font=font)[2]>925:
                    lines.append(line);line=word
                else:line=alt
            lines.append(line)
        lines=lines[:15]
        height=min(1570,max(180,100+len(lines)*78))
        top=(1920-height)//2
        draw.rounded_rectangle((40,top,1040,top+height),radius=28,fill=(16,13,35,208))
        for i,line in enumerate(lines):
            draw.text((540,top+60+i*78),line,font=font,anchor='mt',fill=(255,255,255,255))
    ident=uuid.uuid4().hex
    fn=ident+'.jpg'
    _atomic_save_jpeg(image, MEDIA/fn, quality=92, optimize=True)
    with dbconn() as db:
        db.execute('INSERT INTO media(id,filename,original_name,mime,created_at,owner_id) VALUES(?,?,?,?,?,?)',
            (ident,fn,'Story - '+source['original_name'][:165], 'image/jpeg',now(),user['id']))
    return {'id':ident}

class Target(BaseModel):
    provider:str
    connection_id:str | None = None
    format:str = 'story'
    media_id:str | None = None   # Per-target media; if absent, backward-compatible shared media
    media_ids:list[str] = Field(default_factory=list, max_length=35) # TikTok PHOTO carousel only
    photo_cover_index:int = Field(0, ge=0, le=34)
    tiktok_photo_title:str = Field('', max_length=90)
    tiktok_auto_add_music:bool = False
    tiktok_brand_organic:bool = False
    tiktok_brand_content:bool = False
    tiktok_disable_comment:bool = True
    tiktok_disable_duet:bool = True
    tiktok_disable_stitch:bool = True
    caption:str | None = Field(None, max_length=2200) # individual caption overrides shared text

class Plan(BaseModel):
    media_id:str
    caption:str=Field('',max_length=2200)
    due_at:str
    targets:list[Target]=Field(min_length=1,max_length=16)
    series_id:str | None = None
    position:int=Field(1,ge=1,le=200)
    tiktok_privacy:str='SELF_ONLY'
    tiktok_post_mode:str='direct'
    tiktok_consent:bool=False
    tiktok_aigc:bool=False
    youtube_privacy:str='private'

@app.post('/api/plan')
def plan(req:Plan, user: dict = Depends(current_user)):
    return _plan_for_owner(req, user['id'])


def _plan_for_owner(req:Plan, owner_id: str = 'owner'):
    media_row(req.media_id, owner_id)
    due=parse_local(req.due_at)
    if due<=datetime.now(timezone.utc):
        raise HTTPException(400,'Termin liegt in der Vergangenheit')
    # Every platform can select its own file; do not silently turn video into a photo.
    allowed = {
        'facebook':{'image':{'story','post'},'video':{'story','post','video','reel'}},
        'instagram':{'image':{'story','post'},'video':{'story','reel'}},
        'threads':{'image':{'post'},'video':{'post','video','reel'}},
        'linkedin':{'image':{'post'},'video':{'post','video','reel'}},
        'telegram':{'image':{'post'},'video':{'post'}},
        'telegram_story':{'image':{'story'},'video':{'story'}},
        'tiktok':{'image':{'post'},'video':{'video'}},
        'youtube':{'image':set(),'video':{'video'}},
        'whatsapp':{'image':{'story'},'video':{'story'}},
        'whatsapp_channel':{'image':{'post'},'video':{'post'}},
    }
    selected_media = {}
    for t in req.targets:
        if t.provider not in allowed or t.format not in FORMATS:
            raise HTTPException(400,'Unbekannte Plattform oder Format')
        selected = media_row(t.media_id or req.media_id, owner_id)
        kind = 'video' if selected['mime']=='video/mp4' else 'image'
        if t.format not in allowed[t.provider][kind]:
            raise HTTPException(400,f'{t.provider}: Das Format {t.format} unterstützt kein {"MP4-Video" if kind=="video" else "Bild"}. Bitte Format oder Datei ändern.')
        if t.media_ids:
            if t.provider!='tiktok' or t.format!='post':
                raise HTTPException(400,'Bilderreihen stehen hier nur für TikTok-Fotobeiträge zur Verfügung.')
            if len(t.media_ids)>35 or len(set(t.media_ids))!=len(t.media_ids):
                raise HTTPException(400,'TikTok: 1 bis 35 verschiedene Bilder auswählen.')
            if t.photo_cover_index>=len(t.media_ids):
                raise HTTPException(400,'TikTok: Titelbildposition ungültig.')
            if (t.media_id or req.media_id)!=t.media_ids[0]:
                raise HTTPException(400,'TikTok: Das erste Bild muss auch als Hauptmedium ausgewählt sein.')
            for mid in t.media_ids:
                pic=media_row(mid, owner_id)
                if pic['mime']!='image/jpeg':
                    raise HTTPException(400,'TikTok unterstützt hier nur JPG-Fotos; bitte PNG als JPG speichern.')
        if t.provider=='telegram_story':
            if not t.connection_id:
                raise HTTPException(400,'Telegram-Story: Bitte zuerst dein persönliches Telegram-Profil unter „Kanäle verbinden“ mit dem Business-Bot verbinden.')
            if selected['mime']=='video/mp4':
                try:
                    _find_ffmpeg('Telegram-Story-Video braucht FFmpeg mit H.265-Unterstützung.')
                except RuntimeError:
                    raise HTTPException(400,'Telegram-Story-Video braucht FFmpeg mit H.265-Unterstützung. Bitte FFmpeg installieren, sonst erst ein Bild testen.') from None
        selected_media[id(t)] = selected['id']
    if req.youtube_privacy not in {'private','unlisted','public'}:
        raise HTTPException(400,'YouTube: Bitte privat, nicht gelistet oder öffentlich auswählen.')
    if len({(x.provider,x.connection_id,x.format) for x in req.targets}) != len(req.targets):
        raise HTTPException(400,'Doppelte Ziele')
    if any(t.provider=='tiktok' for t in req.targets):
        for target in (t for t in req.targets if t.provider=='tiktok'):
            if target.format=='post' and media_row(target.media_id or req.media_id, owner_id)['mime']!='image/jpeg':
                raise HTTPException(400,'TikTok-Fotobeiträge benötigen hier JPG. Bitte im Bildstudio als JPG speichern oder MP4 als Video auswählen.')
            if target.format=='post':
                readiness=tiktok_photo_readiness()
                if not readiness['configured']:
                    raise HTTPException(400,'TikTok-Fotos: '+ ' '.join(readiness['problems']))
        if not req.tiktok_consent:
            raise HTTPException(400,'TikTok: Bitte nach Prüfung von Konto, Inhalt und Sichtbarkeit die Veröffentlichung ausdrücklich bestätigen.')
        if req.tiktok_privacy not in {'PUBLIC_TO_EVERYONE','MUTUAL_FOLLOW_FRIENDS','FOLLOWER_OF_CREATOR','SELF_ONLY'}:
            raise HTTPException(400,'Ungültige TikTok-Privatsphäre.')
        if req.tiktok_post_mode not in {'direct','inbox'}:
            raise HTTPException(400,'Ungültiger TikTok-Modus (direct oder inbox).')
        for target in (t for t in req.targets if t.provider=='tiktok'):
            if req.tiktok_post_mode=='direct' and target.tiktok_brand_content and req.tiktok_privacy=='SELF_ONLY':
                raise HTTPException(400,'TikTok: Bezahlte Partnerschaft (Branded Content) darf laut TikTok-Richtlinien nicht als „Nur ich“ (privat) gepostet werden.')
    with dbconn() as db:
        for t in req.targets:
            if t.provider not in PROVIDERS or t.format not in FORMATS:
                raise HTTPException(400,'Unbekannte Plattform oder Format')
            if t.connection_id:
                r=db.execute('SELECT provider,status FROM connections WHERE id=? AND owner_id=?',(t.connection_id, owner_id)).fetchone()
                if not r or r['provider']!=t.provider:
                    raise HTTPException(400,'Verbindung passt nicht zur Plattform')
        ids=[]
        for t in req.targets:
            ident=uuid.uuid4().hex
            db.execute('''INSERT INTO jobs(id,media_id,platform,due_at,status,result,created_at,published_at,
                         caption,format,connection_id,series_id,position,owner_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                (ident,selected_media[id(t)],t.provider,due.isoformat(),'scheduled',None,now(),None,req.caption,
                 t.format,t.connection_id,req.series_id,req.position,owner_id))
            if t.provider=='youtube':
                db.execute('UPDATE jobs SET youtube_privacy=? WHERE id=?', (req.youtube_privacy,ident))
            # Per-target captions are stored independently; legacy text remains the default.
            if t.caption is not None:
                db.execute('UPDATE jobs SET caption=? WHERE id=?',(t.caption,ident))
            if t.provider=='tiktok':
                db.execute("""UPDATE jobs SET tiktok_approved=1,tiktok_privacy=?,tiktok_post_mode=?,tiktok_aigc=?,
                    tiktok_photo_ids=?,tiktok_photo_cover=?,tiktok_photo_title=?,tiktok_auto_music=?,
                    tiktok_brand_organic=?,tiktok_brand_content=?,tiktok_disable_comment=?,
                    tiktok_disable_duet=?,tiktok_disable_stitch=? WHERE id=?""",
                    (req.tiktok_privacy,req.tiktok_post_mode,int(req.tiktok_aigc),json.dumps(t.media_ids),
                     t.photo_cover_index,t.tiktok_photo_title,int(t.tiktok_auto_add_music),
                     int(t.tiktok_brand_organic),int(t.tiktok_brand_content),int(t.tiktok_disable_comment),
                     int(t.tiktok_disable_duet),int(t.tiktok_disable_stitch),ident))
            ids.append(ident)
    return {'ids':ids,'count':len(ids)}

class FourPlan(BaseModel):
    media_ids:list[str]=Field(min_length=4,max_length=4)
    captions:list[str] = Field(default_factory=list)
    targets:list[Target]=Field(min_length=1,max_length=16)
    start_at:str
    gap_minutes:int=Field(1,ge=1,le=60)
    days:int=Field(1,ge=1,le=60)

@app.post('/api/plan/now')
def plan_now(req:Plan, user: dict = Depends(current_user)):
    near_future=(datetime.now(APP_TZ)+timedelta(minutes=2)).strftime('%Y-%m-%dT%H:%M')
    validated=req.model_copy(update={'due_at':near_future})
    result=_plan_for_owner(validated, user['id'])
    with dbconn() as db:
        for ident in result['ids']:
            db.execute('UPDATE jobs SET due_at=? WHERE id=? AND status=?', (now(),ident,'scheduled'))
    # Scheduler picks up these jobs on its next pass.
    return {**result,'mode':'now','message':'Aufträge zum Versand bei nächstem Scheduler-Durchlauf bereit.'}


@app.post('/api/plan/four')
def plan_four(req:FourPlan, user: dict = Depends(current_user)):
    owner_id = user['id']
    start=parse_local(req.start_at)
    if start<=datetime.now(timezone.utc):raise HTTPException(400,'Start liegt in der Vergangenheit')
    if len(set(req.media_ids)) != 4:raise HTTPException(400,'Vier verschiedene Bilder auswählen')
    if req.captions and len(req.captions)!=4:raise HTTPException(400,'Vier Bildtexte erforderlich')
    for mid in req.media_ids:media_row(mid, owner_id)
    if req.days * 4 * len(req.targets) > 2500:
        raise HTTPException(400,'Zu viele Aufgaben; bitte weniger Zielkonten wählen')
    if any(t.provider=='tiktok' for t in req.targets):
        raise HTTPException(400,'TikTok-Serien benötigen individuelle Freigabe pro Beitrag. Bitte viermal über „Post & Story“ planen.')
    series=uuid.uuid4().hex
    count=0
    local_start=start.astimezone(APP_TZ).replace(tzinfo=None)
    for day in range(req.days):
        for pos,mid in enumerate(req.media_ids):
            local_due=(local_start+timedelta(days=day,minutes=pos*req.gap_minutes)).replace(tzinfo=APP_TZ)
            request=Plan(media_id=mid,caption=req.captions[pos] if req.captions else '',
                 due_at=local_due.isoformat(),targets=req.targets,series_id=series,position=pos+1)
            count+=_plan_for_owner(request, owner_id)['count']
    return {'count':count,'series_id':series}

class CalendarDay(BaseModel):
    media_ids:list[str]=Field(min_length=4,max_length=4)
    captions:list[str]=Field(default_factory=list)

class CalendarPlan(BaseModel):
    start_at:str
    gap_minutes:int=Field(1,ge=1,le=60)
    days:list[CalendarDay]=Field(min_length=1,max_length=60)
    targets:list[Target]=Field(min_length=1,max_length=16)


@app.post('/api/plan/calendar')
def plan_calendar(req:CalendarPlan, user: dict = Depends(current_user)):
    owner_id = user['id']
    start=parse_local(req.start_at)
    if start<=datetime.now(timezone.utc):
        raise HTTPException(400,'Der Starttermin liegt in der Vergangenheit.')
    if len(req.days)*4*len(req.targets)>3500:
        raise HTTPException(400,'Zu viele Veröffentlichungen auf einmal.')
    if any(t.provider=='tiktok' for t in req.targets):
        raise HTTPException(400,'TikTok-Kalender benötigt individuelle Zustimmung/Sichtbarkeit je Beitrag. Bitte einzeln planen.')
    if len({(x.provider,x.connection_id,x.format) for x in req.targets}) != len(req.targets):
        raise HTTPException(400,'Doppelte Plattform-Ziele.')
    ids=[mid for day in req.days for mid in day.media_ids]
    if len(set(ids))!=len(ids):
        raise HTTPException(400,'Bitte für jeden Tag vier unterschiedliche Bilder verwenden – keine Bild-ID mehrfach vergeben.')
    for day in req.days:
        if day.captions and len(day.captions)!=4:
            raise HTTPException(400,'Pro Tag genau vier Begleittexte angeben.')
        if any(len(x)>2200 for x in day.captions):
            raise HTTPException(400,'Begleittext zu lang.')
    local_start=start.astimezone(APP_TZ).replace(tzinfo=None)
    with dbconn() as db:
        found={r['id']:r['mime'] for r in db.execute(
            'SELECT id,mime FROM media WHERE owner_id=? AND id IN ('+','.join('?' for _ in ids)+')',(owner_id, *ids))}
        if len(found)!=len(ids) or any(not found[mid].startswith('image/') for mid in ids):
            raise HTTPException(400,'Bitte 4 gültige Bilder pro Tag auswählen, keine Videos.')
        for t in req.targets:
            if t.provider not in PROVIDERS or t.format not in FORMATS:
                raise HTTPException(400,'Unbekannte Plattform oder Format.')
            if t.connection_id:
                account=db.execute('SELECT provider FROM connections WHERE id=? AND owner_id=?',(t.connection_id, owner_id)).fetchone()
                if not account or account['provider']!=t.provider:
                    raise HTTPException(400,'Die ausgewählte Verbindung passt nicht zur Plattform.')
        identifiers=[]; series=[]
        for day_num,day in enumerate(req.days):
            seq=uuid.uuid4().hex
            series.append(seq)
            for pos,mid in enumerate(day.media_ids):
                local_time=(local_start+timedelta(days=day_num,minutes=pos*req.gap_minutes)).replace(tzinfo=APP_TZ)
                dt=local_time.astimezone(timezone.utc)
                if dt<=datetime.now(timezone.utc):
                    raise HTTPException(400,'Mindestens eine Kartenzeit liegt in der Vergangenheit.')
                for target in req.targets:
                    job_id=uuid.uuid4().hex
                    db.execute('INSERT INTO jobs(id,media_id,platform,due_at,status,result,created_at,published_at,caption,format,connection_id,series_id,position,owner_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           (job_id,mid,target.provider,dt.isoformat(),'scheduled',None,now(),None,
                            day.captions[pos] if day.captions else '',target.format,
                            target.connection_id,seq,pos+1,owner_id))
                    identifiers.append(job_id)
    return {'count':len(identifiers),'series_ids':series,'days':len(req.days)}


# V17.5 · Tagesmappen: local-first manual story companions.
# We intentionally derive them from scheduled *real* jobs, so all existing
# /api/plan, four-card and calendar flows automatically appear without changing
# or duplicating the trusted publication scheduler.
STORY_CHANNELS = {'whatsapp_status', 'tiktok_story'}


def storykit_day(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except (ValueError, TypeError):
        raise HTTPException(400, 'Bitte ein gültiges Datum (JJJJ-MM-TT) auswählen.') from None


def storykit_collect(start: date, days: int = 7, owner_id: str = 'owner'):
    if not 1 <= days <= 60:
        raise HTTPException(400, 'Zeitraum muss zwischen 1 und 60 Tagen liegen.')
    try:
        end = start + timedelta(days=days)
    except OverflowError:
        raise HTTPException(400, 'Datum liegt außerhalb des gültigen Bereichs.') from None
    lo = datetime.combine(start, datetime.min.time(), APP_TZ).astimezone(timezone.utc).isoformat()
    hi = datetime.combine(end, datetime.min.time(), APP_TZ).astimezone(timezone.utc).isoformat()
    with dbconn() as db:
        records = [dict(r) for r in db.execute("""SELECT j.id,j.media_id,j.platform,j.format,j.due_at,j.status,
                     j.caption,m.original_name,m.mime FROM jobs j JOIN media m ON m.id=j.media_id
                     WHERE j.owner_id=? AND j.status!='cancelled' AND j.due_at>=? AND j.due_at<?
                     ORDER BY j.due_at,j.position,j.id""", (owner_id, lo, hi))]
        done = {(r['item_key'],r['channel']):r['done_at'] for r in db.execute('SELECT * FROM storykit_done WHERE owner_id=?', (owner_id,))}
    groups = {}
    for r in records:
        dt=datetime.fromisoformat(r['due_at'])
        if dt.tzinfo is None:
            dt=dt.replace(tzinfo=timezone.utc)
        local=dt.astimezone(APP_TZ)
        day=local.date().isoformat()
        caption=(r['caption'] or '').strip()
        # Same asset + same text on multiple target platforms is ONE share kit.
        key=hashlib.sha256(json.dumps([day,r['media_id'],caption],ensure_ascii=False).encode()).hexdigest()[:32]
        current=groups.get(key)
        if not current:
            current={'key':key, 'date':day, 'media_id':r['media_id'],
                'mime':r['mime'], 'filename':r['original_name'], 'caption':caption,
                'time':local.strftime('%H:%M'), 'platforms':[], 'source_jobs':[],
                'channels':{ch:bool(done.get((key,ch))) for ch in STORY_CHANNELS},
                'done_at':{ch:done.get((key,ch)) for ch in STORY_CHANNELS}}
            groups[key]=current
        if r['platform'] not in current['platforms']:
            current['platforms'].append(r['platform'])
        current['source_jobs'].append({'id':r['id'], 'platform':r['platform'], 'status':r['status']})
    by_day={ (start+timedelta(days=i)).isoformat():[] for i in range(days)}
    for item in groups.values():
        by_day[item['date']].append(item)
    result=[]
    for day,items in by_day.items():
        items.sort(key=lambda i:(i['time'],i['filename']))
        result.append({'date':day,'items':items,'total':len(items),
            'whatsapp_open':sum(not e['channels']['whatsapp_status'] for e in items),
            'tiktok_open':sum(not e['channels']['tiktok_story'] for e in items)})
    return result


@app.get('/api/storykit')
def storykit_index(start: str = '', days: int = 7, user: dict = Depends(current_user)):
    day=storykit_day(start) if start else datetime.now(APP_TZ).date()
    rows=storykit_collect(day,days,owner_id=user['id'])
    return {'days':rows,'total':sum(d['total'] for d in rows),
        'whatsapp_open':sum(d['whatsapp_open'] for d in rows),
        'tiktok_open':sum(d['tiktok_open'] for d in rows)}


class StorykitComplete(BaseModel):
    date: str
    channel: str
    done: bool


@app.post('/api/storykit/{item_key}/complete')
def storykit_complete(item_key: str, request: StorykitComplete, user: dict = Depends(current_user)):
    owner_id = user['id']
    if request.channel not in STORY_CHANNELS:
        raise HTTPException(400,'Unbekannte Story-Plattform.')
    selected=storykit_collect(storykit_day(request.date),1,owner_id=owner_id)[0]['items']
    if not any(item['key']==item_key for item in selected):
        raise HTTPException(404,'Der Beitrag gehört nicht zu diesem Tag oder wurde storniert.')
    with dbconn() as db:
        if request.done:
            exists=db.execute('SELECT 1 FROM storykit_done WHERE owner_id=? AND item_key=? AND channel=?',
                              (owner_id, item_key, request.channel)).fetchone()
            if exists:
                db.execute('UPDATE storykit_done SET done_at=? WHERE owner_id=? AND item_key=? AND channel=?',
                           (now(), owner_id, item_key, request.channel))
            else:
                db.execute('INSERT INTO storykit_done(owner_id,item_key,channel,done_at) VALUES(?,?,?,?)',
                           (owner_id, item_key, request.channel, now()))
        else:
            db.execute('DELETE FROM storykit_done WHERE owner_id=? AND item_key=? AND channel=?',
                       (owner_id, item_key, request.channel))
    return {'ok':True,'done':request.done}


@app.get('/api/storykit/{day}/zip')
def storykit_download(day: str, user: dict = Depends(current_user)):
    selected=storykit_collect(storykit_day(day),1,owner_id=user['id'])[0]['items']
    if not selected:
        raise HTTPException(404,'Für diesen Tag sind keine Beiträge vorhanden.')
    if len(selected)>120:
        raise HTTPException(413,'Zu viele Dateien für ein Tagespaket. Bitte einzeln herunterladen.')
    with dbconn() as db:
        files={r['id']:dict(r) for r in db.execute('SELECT * FROM media WHERE id IN ('+
            ','.join('?' for _ in selected)+')',[x['media_id'] for x in selected])}
    total=0
    for item in selected:
        record=files.get(item['media_id'])
        if not record:
            raise HTTPException(404,'Eine geplante Mediendatei ist nicht mehr vorhanden.')
        path=MEDIA/record['filename']
        if not path.is_file():
            raise HTTPException(404,'Mediendatei fehlt im data/media-Ordner.')
        total+=path.stat().st_size
    if total>1024*1024*1024:
        raise HTTPException(413,'Mehr als 1 GB – bitte Mediendateien einzeln herunterladen.')
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    fd, temp_path=tempfile.mkstemp(prefix='timesave-tag-',suffix='.zip',dir=TMP_DIR)
    os.close(fd)
    try:
        lines=['TIMESAVE SOCIAL BY SOLVETEC · TAGESMAPPE '+day,'',
           'Dateien fuer WhatsApp-Status und TikTok-Stories (MANUELL).',
           'Die automatische Veroeffentlichung anderer Plattformen bleibt unveraendert.','']
        with zipfile.ZipFile(temp_path,'w',compression=zipfile.ZIP_STORED,allowZip64=True) as z:
            for i,item in enumerate(selected,1):
                record=files[item['media_id']]
                clean=re.sub(r'[^\w .()-]', '_',Path(record['original_name']).name,flags=re.UNICODE).strip(' .')
                name=f'{i:02d}_{clean or item["media_id"]}'
                z.write(MEDIA/record['filename'],arcname=name)
                lines.append(f'{i:02d} | {item["time"]} | {name} | '+', '.join(item['platforms']))
                if item['caption']:
                    lines.append('BEGLEITTEXT:\n'+item['caption'])
                lines.append('')
            z.writestr('00_TEXTE_UND_PLAN.txt','\n'.join(lines))
    except Exception:
        Path(temp_path).unlink(missing_ok=True)
        raise
    return FileResponse(temp_path, filename=f'TimeSave_Social_Storys_{day}.zip', media_type='application/zip',
        background=BackgroundTask(lambda:Path(temp_path).unlink(missing_ok=True)))


class JobEdit(BaseModel):
    media_id:str
    caption:str=Field('',max_length=2200)
    due_at:str
    format:str='story'


@app.patch('/api/jobs/{ident}')
def edit_job(ident:str, req:JobEdit, user: dict = Depends(current_user)):
    owner_id = user['id']
    if req.format not in FORMATS:
        raise HTTPException(400,'Ungültiges Format')
    media_row(req.media_id, owner_id)
    due=parse_local(req.due_at)
    if due<=datetime.now(timezone.utc):
        raise HTTPException(400,'Bitte einen Termin in der Zukunft wählen.')
    with dbconn() as db:
        previous=db.execute('SELECT * FROM jobs WHERE id=? AND owner_id=?',(ident, owner_id)).fetchone()
        if not previous:
            raise HTTPException(404,'Geplante Veröffentlichung nicht gefunden')
        if previous['status']!='scheduled':
            raise HTTPException(409,'Nur noch nicht gestartete Veröffentlichungen sind bearbeitbar.')
        if previous['platform']=='tiktok':
            raise HTTPException(409,'TikTok: Für Änderungen an Bild, Text oder Termin bitte die alte Planung stornieren und den geänderten Beitrag neu freigeben.')
        prev_due=_parse_utc(previous['due_at'])
        if previous['series_id'] and prev_due and abs((due-prev_due).total_seconds())>1:
            raise HTTPException(409,'Für eine Vierer-Reihe bleibt der Termin gesperrt, damit die Kartenreihenfolge erhalten bleibt. Bild und Text kannst du bearbeiten.')
        db.execute("UPDATE jobs SET media_id=?,caption=?,due_at=?,format=? WHERE id=? AND owner_id=? AND status='scheduled'",
                   (req.media_id,req.caption,due.isoformat(),req.format,ident,owner_id))
    return {'ok':True,'message':'Geplante Veröffentlichung aktualisiert.'}


@app.get('/api/jobs')
def list_jobs(user: dict = Depends(current_user)):
    owner_id = user['id']
    with dbconn() as db:
        items=[dict(x) for x in db.execute('''SELECT j.*,m.original_name FROM jobs j JOIN media m
            ON j.media_id=m.id WHERE j.owner_id=? ORDER BY j.due_at DESC,j.position DESC LIMIT 3500''', (owner_id,))]
        series_ids={j['series_id'] for j in items if j['status']=='scheduled' and j['series_id'] and j['position']>1}
        series_lookup={}
        if series_ids:
            placeholders=','.join('?' for _ in series_ids)
            for row in db.execute(
                f'SELECT series_id,platform,connection_id,position,due_at,status FROM jobs WHERE owner_id=? AND series_id IN ({placeholders}) ORDER BY due_at DESC',
                (owner_id, *series_ids)):
                key=(row['series_id'],row['platform'],row['connection_id'],row['position'])
                series_lookup.setdefault(key,[]).append((row['due_at'],row['status']))
        for job in items:
            waiting=None
            if job['status']=='scheduled' and job['series_id'] and job['position']>1:
                candidates=series_lookup.get((job['series_id'],job['platform'],job['connection_id'],job['position']-1),())
                for cand_due,cand_status in candidates:
                    if cand_due <= job['due_at']:
                        if cand_status not in ('published','published_manual'):
                            waiting=job['position']-1
                        break
            job['waiting_for']=waiting
            if job['status']=='processing':
                with _PUBLISH_PROGRESS_LOCK:
                    job['publication_progress']=_PUBLISH_PROGRESS.get(job['id'],{}).copy()
        return items

@app.post('/api/jobs/{ident}/cancel')
def cancel_job(ident:str, user: dict = Depends(current_user)):
    with dbconn() as db:
        r=db.execute("UPDATE jobs SET status='cancelled' WHERE id=? AND owner_id=? AND status='scheduled'",(ident, user['id']))
    if not r.rowcount:raise HTTPException(409,'Nur geplante Veröffentlichungen können storniert werden')
    return {'ok':True}

@app.post('/api/jobs/{ident}/retry')
def retry_job(ident:str, user: dict = Depends(current_user)):
    with dbconn() as db:
        r=db.execute("UPDATE jobs SET status='scheduled',due_at=?,retry_at=NULL,retry_attempts=0,result=NULL WHERE id=? AND owner_id=? AND status='needs_review'",
                     (now(),ident,user['id']))
    if not r.rowcount:raise HTTPException(409,'Nur zu prüfende Veröffentlichungen erneut senden')
    return {'ok':True,'warning':'Vor erneuter Veröffentlichung prüfen, ob der vorherige Versuch doch erfolgreich war.'}

@app.delete('/api/jobs/{ident}')
def delete_job(ident:str, user: dict = Depends(current_user)):
    with dbconn() as db:
        r=db.execute(
            "DELETE FROM jobs WHERE id=? AND owner_id=? AND status IN ('needs_review','cancelled','published','published_manual','manual')",
            (ident,user['id'])
        )
    if not r.rowcount:
        raise HTTPException(409,'Laufende oder geplante Veröffentlichungen bitte zuerst stornieren.')
    return {'ok':True}

@app.post('/api/jobs/{ident}/mark-published')
def mark_job(ident:str, user: dict = Depends(current_user)):
    with dbconn() as db:
        r=db.execute("UPDATE jobs SET status='published_manual',published_at=?,result='Manuell bestätigt' WHERE id=? AND owner_id=? AND status='manual'",(now(),ident,user['id']))
    if not r.rowcount:raise HTTPException(409,'Nur manuelle Aufgaben können bestätigt werden')
    return {'ok':True}

@app.post('/api/jobs/run-now',dependencies=[Depends(guard)])
async def run_now():
    _PUBLISH_WAKE.set()
    return {'ok':True,'queued':True}



# V17.17: ONE-SHOT Instagram Reel testing in ephemeral Render Free.
# This path does NOT enable the scheduler and does NOT process other jobs.
# Explicit user confirmation is required. Never auto-retry an ambiguous upload.
class PreviewInstagramReel(BaseModel):
    plan: Plan
    confirmation: str


_preview_reel_tasks = set()


async def _one_shot_instagram_reel(job_id: str):
    try:
        with dbconn() as db:
            jobrow = db.execute('SELECT * FROM jobs WHERE id=? AND status=?',
                                (job_id, 'processing')).fetchone()
        if not jobrow:
            return
        job = dict(jobrow)
        result = await dispatch(job, media_row(job['media_id']))
        # No automatic retry, no other platform, no background scheduler.
        if isinstance(result, dict):
            # Should not occur for Instagram; if it does, preserve uncertainty.
            status = 'needs_review'
            message = 'Instagram-Antwort ohne eindeutige Abschlussbestätigung. Bitte direkt bei Instagram nachsehen.'
        else:
            status = 'published'
            message = str(result)[:650]
    except Exception as exc:
        status = 'needs_review'
        message = ('Instagram-Test nicht bestätigt: ' + str(exc))[:650]
    with dbconn() as db:
        db.execute("""UPDATE jobs SET status=?, result=?, published_at=?
                      WHERE id=? AND status='processing' """,
                   (status, message, now() if status=='published' else None, job_id))


@app.post('/api/preview/instagram-reel')
async def preview_instagram_reel(req: PreviewInstagramReel, user: dict = Depends(current_user)):
    if not (CLOUD_MODE and FREE_PREVIEW):
        raise HTTPException(409, 'Dieser einmalige Test ist nur für Render Free vorgesehen.')
    if req.confirmation != 'INSTAGRAM_REEL_JETZT_TESTEN':
        raise HTTPException(400, 'Bitte den echten Instagram-Reel-Test ausdrücklich bestätigen.')
    if len(req.plan.targets) != 1:
        raise HTTPException(400, 'Render-Free-Test: Genau EIN Instagram-Reel und EIN Konto wählen.')
    target = req.plan.targets[0]
    if target.provider != 'instagram' or target.format != 'reel' or not target.connection_id:
        raise HTTPException(400, 'Render-Free-Test: Nur Instagram-Reels (MP4) mit verbundenem Instagram-Konto.')
    if (target.media_id or req.plan.media_id) != req.plan.media_id:
        raise HTTPException(400, 'Render-Free-Test: Videoauswahl stimmt nicht überein.')
    selected = media_row(req.plan.media_id, user['id'])
    if selected['mime'] != 'video/mp4':
        raise HTTPException(400, 'Instagram-Reel-Test benötigt eine MP4-Datei.')
    path = MEDIA / selected['filename']
    if not path.is_file() or path.stat().st_size == 0:
        raise HTTPException(400, 'MP4-Datei fehlt oder ist leer; bitte erneut hochladen.')
    if path.stat().st_size > 30 * 1024 * 1024:
        raise HTTPException(413, 'Render-Free-Test: Bitte ein kurzes MP4 unter 30 MB verwenden.')
    account = get_account(target.connection_id, user['id'])
    if account['provider'] != 'instagram' or account['status'] != 'connected':
        raise HTTPException(409, 'Instagram-Konto ist nicht aktiv verbunden.')
    # Single active upload at a time; the test can publish REAL content.
    with dbconn() as db:
        existing = db.execute("SELECT id FROM jobs WHERE platform='instagram' AND status='processing' LIMIT 1").fetchone()
        if existing:
            raise HTTPException(409, 'Ein Instagram-Upload läuft bereits. Bitte Planung & Archiv prüfen.')
    # Reuse standard planner validation; preview's ordinary scheduler remains OFF.
    safe_future = (datetime.now(APP_TZ) + timedelta(minutes=3)).strftime('%Y-%m-%dT%H:%M:%S')
    validated = req.plan.model_copy(update={'due_at':safe_future})
    saved = _plan_for_owner(validated, user['id'])
    job_id = saved['ids'][0]
    with dbconn() as db:
        claimed = db.execute("UPDATE jobs SET status='processing', due_at=?, result=? WHERE id=? AND status='scheduled'",
                             (now(), 'Einmaliger Instagram-Reel-Test gestartet.', job_id))
        if not claimed.rowcount:
            raise HTTPException(409, 'Test konnte nicht sicher gestartet werden.')
    task = asyncio.create_task(_one_shot_instagram_reel(job_id))
    _preview_reel_tasks.add(task)
    task.add_done_callback(_preview_reel_tasks.discard)
    return {'ok': True, 'count': 1, 'job_id': job_id,
            'message': 'Instagram-Reel-Test gestartet. Das ist eine ECHTE Veröffentlichung. Status in Planung & Archiv prüfen.'}


class CloudPublishSetting(BaseModel):
    enabled: bool
    confirmation: str = ''


@app.get('/api/cloud/runtime')
def api_cloud_runtime(user: dict = Depends(current_user)):
    return cloud_runtime_status(owner_id=None if user.get('role') == 'admin' else user['id'])


@app.post('/api/cloud/publishing',dependencies=[Depends(require_admin)])
def api_cloud_publishing(req:CloudPublishSetting):
    if not CLOUD_MODE:
        raise HTTPException(409,'Nur im Cloud-Betrieb verfügbar.')
    if req.enabled and FREE_PREVIEW and req.confirmation!='TESTAUTOMATIK_BESTAETIGT':
        raise HTTPException(400,'Zum Teststart den Hinweis auf echte Veröffentlichungen und Free-Tier-Grenzen bestätigen.')
    if req.enabled and not FREE_PREVIEW and req.confirmation!='LOKALE APP GESTOPPT':
        raise HTTPException(400,'Zum Aktivieren bitte ausdrücklich bestätigen, dass der lokale Scheduler gestoppt ist.')
    if req.enabled and not public_base().startswith('https://'):
        raise HTTPException(409,'Zuerst eine gültige HTTPS-Basisadresse konfigurieren.')
    cloud_set_publishing(req.enabled)
    return cloud_runtime_status()


@app.post('/api/cloud/migrate',dependencies=[Depends(require_admin)])
async def api_cloud_migrate(file:UploadFile=File(...)):
    if FREE_PREVIEW:
        raise HTTPException(409,'Keine Datenübernahme auf Render Free: Dateien und SQLite gehen nach Neustarts verloren.')
    if not CLOUD_MODE:
        raise HTTPException(409,'Migrationsimport nur in der neuen Cloud-Installation.')
    if cloud_publishing_enabled():
        raise HTTPException(409,'Veröffentlichung muss vor der Migration pausiert sein.')
    with tempfile.TemporaryDirectory(prefix='timesave_up_',dir=DATA) as td:
        incoming=Path(td)/'migration.zip'
        size=0
        with incoming.open('wb') as handle:
            while chunk:=await file.read(4*1024*1024):
                size+=len(chunk)
                if size>3*1024**3:
                    raise HTTPException(413,'Migrationsdatei ist zu groß (maximal 3 GB).')
                handle.write(chunk)
        try:
            result=await asyncio.to_thread(cloud_import_archive,incoming)
        except Exception as exc:
            # Never log old account tokens or the encrypted database contents.
            raise HTTPException(409,str(exc)[:240] if isinstance(exc,(RuntimeError,ValueError,zipfile.BadZipFile)) else type(exc).__name__) from None
    return {'ok':True,'message':'Daten übernommen. Automatische Veröffentlichung bleibt aus Sicherheitsgründen PAUSIERT.', 'status':result}

@app.get('/api/health')
def health():
    return {'status':'ok','now':now()}


@app.get('/api/branding')
def branding():
    with dbconn() as db:
        has_users = db.execute('SELECT COUNT(*) FROM users').fetchone()[0] > 0
    return {
        'brand_name': (_ts_env('BRAND_NAME') or 'TimeSave Social').strip()[:48],
        'brand_subtitle': (_ts_env('BRAND_SUBTITLE') or 'BY SOLVETEC · V20.9').strip()[:64],
        'version': '20.9',
        'db_backend': DB_BACKEND,
        'multi_user': True,
        'has_users': has_users,
        'open_signup': _ts_env('OPEN_SIGNUP').lower() in ('1', 'true', 'yes'),
    }


# --- V18.0 Multi-User Auth, Admin User Management & Legal Review Pages ---
class AuthLoginRequest(BaseModel):
    remember: bool = False
    email: str = Field(min_length=3, max_length=160)
    password: str = Field(min_length=1, max_length=200)


class AuthRegisterRequest(BaseModel):
    email: str = Field(min_length=3, max_length=160)
    display_name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=200)
    invite_code: str = Field('', max_length=64)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


class AdminCreateUser(BaseModel):
    email: str = Field(min_length=3, max_length=160)
    display_name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=200)
    role: str = Field('user', pattern='^(user|admin)$')
    claim_owner: bool = False


class AdminUpdateUser(BaseModel):
    display_name: str | None = Field(None, min_length=1, max_length=80)
    role: str | None = Field(None, pattern='^(user|admin)$')
    active: bool | None = None
    password: str | None = Field(None, min_length=8, max_length=200)


class AdminCreateInvite(BaseModel):
    role: str = Field('user', pattern='^(user|admin)$')
    note: str = Field('', max_length=120)
    days: int = Field(7, ge=1, le=30)


def _clean_email(value: str) -> str:
    email = value.strip().lower()
    if not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', email):
        raise HTTPException(400, 'Bitte eine gültige E-Mail-Adresse eingeben.')
    return email


REMEMBER_COOKIE = 'sp_remember'


def _remember_cookie(response, token=None):
    response.headers['Cache-Control']='no-store'
    if token:
        response.set_cookie(REMEMBER_COOKIE,token,max_age=14*86400,httponly=True,secure=True,samesite='strict',path='/api/auth')
    else:
        response.delete_cookie(REMEMBER_COOKIE,path='/api/auth',secure=True,httponly=True,samesite='strict')


@app.post('/api/auth/forget')
def auth_forget(response: Response, user: dict = Depends(current_user)):
    _remember_cookie(response)
    return {'ok':True}


@app.post('/api/auth/remember-admin')
def auth_remember_admin(response: Response, user: dict = Depends(current_user)):
    if user['auth_type']!='admin_token':
        raise HTTPException(403,'Nur für Admin-Key-Anmeldung.')
    with dbconn() as db:
        token=_create_user_session(db,_admin_session_owner())
    _remember_cookie(response,token)
    return {'token':token}


@app.post('/api/auth/resume')
def auth_resume(request: Request, response: Response):
    token=request.cookies.get(REMEMBER_COOKIE,'')
    if not token:
        raise HTTPException(401,'Keine gespeicherte Anmeldung.')
    try:
        current_user(token,None)
    except HTTPException:
        _remember_cookie(response)
        response.status_code=401
        return {'detail':'Gespeicherte Anmeldung abgelaufen.'}
    response.headers['Cache-Control']='no-store'
    return {'token':token}


@app.post('/api/auth/login')
def auth_login(req: AuthLoginRequest, response: Response):
    email = _clean_email(req.email)
    with dbconn() as db:
        row = db.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
        if not row or not row['active'] or not _verify_password(req.password, row['password_hash']):
            raise HTTPException(401, 'E-Mail oder Passwort ist falsch (oder Konto deaktiviert).')
        token = _create_user_session(db, row['id'])
        db.execute('UPDATE users SET last_login_at=? WHERE id=?', (now(), row['id']))
    _remember_cookie(response, token if req.remember else None)
    return {
        'token': token,
        'user': {
            'id': row['id'],
            'email': row['email'],
            'display_name': row['display_name'],
            'role': row['role'],
            'auth_type': 'session',
        },
    }


@app.post('/api/auth/register')
def auth_register(req: AuthRegisterRequest, response: Response):
    email = _clean_email(req.email)
    open_signup = _ts_env('OPEN_SIGNUP').lower() in ('1', 'true', 'yes')
    code = req.invite_code.strip().upper()
    if not open_signup and not code:
        raise HTTPException(400, 'Für die Registrierung wird ein Einladungscode benötigt.')
    with dbconn() as db:
        if db.execute('SELECT 1 FROM users WHERE email=?', (email,)).fetchone():
            raise HTTPException(409, 'Diese E-Mail-Adresse ist bereits registriert.')
        role = 'user'
        if code:
            inv = db.execute('SELECT * FROM invites WHERE code=?', (code,)).fetchone()
            exp = _parse_utc(inv['expires_at']) if inv else None
            if not inv or inv['used_by'] or exp is None or exp <= datetime.now(timezone.utc):
                raise HTTPException(400, 'Einladungscode ist ungültig, bereits genutzt oder abgelaufen.')
            role = inv['role']
        uid = uuid.uuid4().hex
        db.execute(
            'INSERT INTO users(id,email,display_name,password_hash,role,active,created_at,last_login_at) VALUES(?,?,?,?,?,?,?,?)',
            (uid, email, req.display_name.strip(), _hash_password(req.password), role, 1, now(), now()),
        )
        if code:
            db.execute('UPDATE invites SET used_by=?,used_at=? WHERE code=?', (uid, now(), code))
        token = _create_user_session(db, uid)
    _remember_cookie(response)
    return {
        'token': token,
        'user': {
            'id': uid,
            'email': email,
            'display_name': req.display_name.strip(),
            'role': role,
            'auth_type': 'session',
        },
    }


@app.get('/api/auth/me')
def auth_me(user: dict = Depends(current_user)):
    return {
        'id': user['id'],
        'email': user['email'],
        'display_name': user['display_name'],
        'role': user['role'],
        'auth_type': user['auth_type'],
        'db_backend': DB_BACKEND,
    }


@app.post('/api/auth/logout')
def auth_logout(response: Response, request: Request, user: dict = Depends(current_user)):
    _remember_cookie(response)
    cookie=request.cookies.get(REMEMBER_COOKIE)
    if cookie:
        with dbconn() as db:
            db.execute('DELETE FROM user_sessions WHERE token_hash=?',(hashlib.sha256(cookie.encode()).hexdigest(),))
    if user.get('token_hash'):
        with dbconn() as db:
            db.execute('DELETE FROM user_sessions WHERE token_hash=?', (user['token_hash'],))
    return {'ok': True}


@app.post('/api/auth/password')
def auth_change_password(req: ChangePasswordRequest, user: dict = Depends(current_user)):
    if user.get('auth_type') != 'session':
        raise HTTPException(400, 'Beim Login per ADMIN_TOKEN wird das Passwort über Render → Environment verwaltet.')
    with dbconn() as db:
        row = db.execute('SELECT password_hash FROM users WHERE id=?', (user['id'],)).fetchone()
        if not row or not _verify_password(req.current_password, row['password_hash']):
            raise HTTPException(400, 'Aktuelles Passwort stimmt nicht.')
        db.execute('UPDATE users SET password_hash=? WHERE id=?', (_hash_password(req.new_password), user['id']))
    return {'ok': True, 'message': 'Passwort erfolgreich geändert.'}


@app.get('/api/admin/users')
def admin_list_users(user: dict = Depends(require_admin)):
    with dbconn() as db:
        users = [dict(r) for r in db.execute(
            '''SELECT u.id,u.email,u.display_name,u.role,u.active,u.created_at,u.last_login_at,
               (SELECT COUNT(*) FROM media m WHERE m.owner_id=u.id) AS media_count,
               (SELECT COUNT(*) FROM connections c WHERE c.owner_id=u.id) AS connection_count,
               (SELECT COUNT(*) FROM jobs j WHERE j.owner_id=u.id AND j.status='scheduled') AS scheduled_count
               FROM users u ORDER BY u.created_at ASC'''
        )]
        invites = [dict(r) for r in db.execute(
            'SELECT code,role,note,created_at,expires_at,used_by,used_at FROM invites ORDER BY created_at DESC LIMIT 40'
        )]
        owner_claimed = any(u['id'] == 'owner' for u in users)
    return {
        'users': users,
        'invites': invites,
        'owner_claimed': owner_claimed,
        'db_backend': DB_BACKEND,
    }


@app.post('/api/admin/users')
def admin_create_user(req: AdminCreateUser, admin: dict = Depends(require_admin)):
    email = _clean_email(req.email)
    with dbconn() as db:
        if db.execute('SELECT 1 FROM users WHERE email=?', (email,)).fetchone():
            raise HTTPException(409, 'Ein Konto mit dieser E-Mail existiert bereits.')
        if req.claim_owner:
            if db.execute("SELECT 1 FROM users WHERE id='owner'").fetchone():
                raise HTTPException(409, 'Das Hauptkonto (owner) hat bereits ein E-Mail-Login.')
            uid = 'owner'
            role = 'admin'
        else:
            uid = uuid.uuid4().hex
            role = req.role
        db.execute(
            'INSERT INTO users(id,email,display_name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?)',
            (uid, email, req.display_name.strip(), _hash_password(req.password), role, 1, now()),
        )
    return {'ok': True, 'id': uid, 'email': email, 'role': role, 'message': 'Benutzerkonto erstellt.'}


@app.patch('/api/admin/users/{uid}')
def admin_update_user(uid: str, req: AdminUpdateUser, admin: dict = Depends(require_admin)):
    with dbconn() as db:
        row = db.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
        if not row:
            raise HTTPException(404, 'Benutzer nicht gefunden.')
        if req.active is False and uid in ('owner', admin['id']):
            raise HTTPException(400, 'Das eigene oder das Haupt-Admin-Konto kann nicht deaktiviert werden.')
        if req.display_name is not None:
            db.execute('UPDATE users SET display_name=? WHERE id=?', (req.display_name.strip(), uid))
        if req.role is not None and uid != 'owner':
            db.execute('UPDATE users SET role=? WHERE id=?', (req.role, uid))
        if req.active is not None:
            db.execute('UPDATE users SET active=? WHERE id=?', (1 if req.active else 0, uid))
            if not req.active:
                db.execute('DELETE FROM user_sessions WHERE user_id=?', (uid,))
        if req.password is not None:
            db.execute('UPDATE users SET password_hash=? WHERE id=?', (_hash_password(req.password), uid))
            db.execute('DELETE FROM user_sessions WHERE user_id=?', (uid,))
    return {'ok': True, 'message': 'Benutzer aktualisiert.'}


@app.post('/api/admin/invites')
def admin_create_invite(req: AdminCreateInvite, admin: dict = Depends(require_admin)):
    code = ('SP-' + secrets.token_hex(4)).upper()
    exp = (datetime.now(timezone.utc) + timedelta(days=req.days)).isoformat()
    with dbconn() as db:
        db.execute(
            'INSERT INTO invites(code,role,note,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?)',
            (code, req.role, req.note.strip(), admin['id'], now(), exp),
        )
    base = public_base()
    invite_url = (base + '/?invite=' + code) if base else ('/?invite=' + code)
    return {'ok': True, 'code': code, 'expires_at': exp, 'invite_url': invite_url}


@app.delete('/api/admin/invites/{code}')
def admin_delete_invite(code: str, admin: dict = Depends(require_admin)):
    with dbconn() as db:
        db.execute('DELETE FROM invites WHERE code=? AND used_by IS NULL', (code.strip().upper(),))
    return {'ok': True}


def _legal_shell(title: str, body_html: str) -> HTMLResponse:
    import html as _h
    brand = _h.escape((_ts_env('BRAND_NAME') or 'TimeSave Social').strip())
    return HTMLResponse(
        f'''<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>{_h.escape(title)} · {brand}</title>
        <style>body{{font-family:Inter,system-ui,-apple-system,sans-serif;max-width:780px;margin:6vh auto;padding:24px;color:#231b38;background:#f7f5fb;line-height:1.7}}
        .card{{background:#fff;border:1px solid #e7dff2;border-radius:20px;padding:32px;box-shadow:0 12px 36px rgba(32,18,64,.06)}}
        h1{{margin-top:0;color:#2c1c4e}}h2{{margin-top:24px;font-size:18px;color:#4a3178}}a{{color:#6842c2}}</style>
        </head><body><div class="card"><h1>{_h.escape(title)}</h1>{body_html}<hr style="border:0;border-top:1px solid #ece4f5;margin:24px 0"><p><a href="/">← Zurück zu {brand}</a></p></div></body></html>'''
    )


@app.get('/legal/privacy')
def legal_privacy():
    import html as _h
    op = _h.escape(_ts_env('OPERATOR_NAME') or 'Solvetec')
    mail = _h.escape(_ts_env('CONTACT_EMAIL') or 'support@rm-solvetec.de')
    return _legal_shell('Datenschutzerklärung', f'''
        <p><strong>Verantwortlicher:</strong> {op}<br><strong>Kontakt:</strong> {mail}</p>
        <h2>1. Zweck der Verarbeitung</h2>
        <p>Diese Anwendung dient der Erstellung, Planung und Veröffentlichung von Social-Media-Beiträgen über offizielle OAuth-Schnittstellen (Meta/Instagram/Facebook, Google/YouTube, TikTok, Telegram Bot API). Es werden niemals persönliche Social-Media-Passwörter gespeichert.</p>
        <h2>2. Gespeicherte Daten</h2>
        <p>Gespeichert werden dein Benutzerkonto (Name, E-Mail, gesalzener Passwort-Hash), hochgeladene Medien, Entwürfe, geplante Beiträge sowie verschlüsselte OAuth-Zugriffstokens. Jeder Benutzer sieht ausschließlich seinen eigenen Arbeitsbereich.</p>
        <h2>3. Widerruf &amp; Löschung</h2>
        <p>Verbundene Social-Media-Konten können jederzeit in der App unter „Konten &amp; Plattformen“ getrennt werden. Informationen zur vollständigen Kontolöschung findest du unter <a href="/legal/data-deletion">Datenlöschung</a>.</p>
    ''')


@app.get('/legal/terms')
def legal_terms():
    import html as _h
    brand = _h.escape((_ts_env('BRAND_NAME') or 'TimeSave Social').strip())
    op = _h.escape(_ts_env('OPERATOR_NAME') or 'Solvetec')
    return _legal_shell('Nutzungsbedingungen', f'''
        <p>Mit der Nutzung von {brand} (by {op}) bestätigst du, dass du für alle hochgeladenen Inhalte, Texte und Medien die erforderlichen Rechte besitzt und die jeweiligen Richtlinien von Meta, Google/YouTube, TikTok und Telegram einhältst.</p>
        <h2>Verantwortung für Veröffentlichungen</h2>
        <p>Veröffentlichungen erfolgen erst nach deiner ausdrücklichen Planung oder Bestätigung. Bei Netzwerk- oder Plattformstörungen sind geplante Beiträge vor einem erneuten Versand direkt auf der Zielplattform zu prüfen.</p>
    ''')


@app.get('/legal/data-deletion')
def legal_data_deletion():
    import html as _h
    mail = _h.escape(_ts_env('CONTACT_EMAIL') or 'support@rm-solvetec.de')
    return _legal_shell('Anleitung zur Datenlöschung', f'''
        <p>Du kannst deine verbundenen Social-Media-Konten, Entwürfe und nicht verwendete Mediendateien jederzeit direkt innerhalb der Anwendung entfernen.</p>
        <h2>Vollständige Kontolöschung anfordern</h2>
        <p>Wenn dein gesamtes Benutzerkonto samt gespeicherten Medien, Planungen und verschlüsselten Tokens gelöscht werden soll, sende bitte eine kurze Nachricht an <strong>{mail}</strong> mit deiner registrierten E-Mail-Adresse. Zusätzlich kannst du App-Berechtigungen jederzeit direkt in deinen Meta-, Google- oder TikTok-Kontoeinstellungen widerrufen.</p>
    ''')

# TimeSave Social · genuine image-to-video sequence editor.
# This intentionally uses the existing encrypted local library and the same
# authenticated media endpoint as the other editors; no new platform auth.
class V17Scene(BaseModel):
    media_id: str
    seconds: float = Field(4.0, ge=2, le=12)
    text: str = Field('', max_length=180)


class V17Slideshow(BaseModel):
    scenes: list[V17Scene] = Field(min_length=2, max_length=12)
    aspect: str = Field('story', pattern='^(story|square)$')
    transition: str = Field('fade', pattern='^(fade|cut)$')
    color: str = Field('natural', pattern='^(natural|warm|cool|mono)$')


def v17_slide_frame(path, dims, text, color):
    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened).convert('RGB')
    image = ImageOps.fit(image, dims, method=Image.Resampling.LANCZOS, centering=(.5,.5))
    if color == 'warm':
        image = ImageEnhance.Color(image).enhance(1.13)
        image = ImageEnhance.Contrast(image).enhance(1.06)
    elif color == 'cool':
        image = ImageEnhance.Color(image).enhance(.92)
        image = ImageEnhance.Contrast(image).enhance(1.08)
    elif color == 'mono':
        image = ImageEnhance.Color(image).enhance(0)
    if text.strip():
        w,h = dims
        draw = ImageDraw.Draw(image, 'RGBA')
        try:
            font = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', max(20, w//23))
        except OSError:
            try: font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', max(20, w//23))
            except OSError: font = ImageFont.load_default()
        max_width = int(w*.82)
        lines=[];current=''
        for word in text.strip().split():
            candidate=(current+' '+word).strip()
            if current and draw.textbbox((0,0),candidate,font=font)[2] > max_width:
                lines.append(current); current=word
            else: current=candidate
        if current: lines.append(current)
        lines=lines[:5]
        lineh=max(30,w//14)
        boxh=(len(lines)+1)*lineh
        top=int(h*.77)-boxh//2
        draw.rounded_rectangle((w*.07,top,w*.93,top+boxh),radius=22,fill=(8,8,12,195))
        for i,line in enumerate(lines):
            draw.text((w/2,top+(i+1)*lineh-lineh//3),line,anchor='mm',font=font,
                      fill=(255,243,216,255),stroke_width=2,stroke_fill=(0,0,0,160))
    return image


# One montage per process, with owner-scoped status and bounded retained history.
_v183_jobs = {}
_v183_lock = threading.Lock()
_v183_tasks = set()


def _v183_encode(req, sources, ffmpeg, out, progress):
    dims = (720,1280) if req.aspect == 'story' else (720,720)
    frames = [round(x.seconds*25) for x in req.scenes]
    fade = 12 if req.transition == 'fade' else 0
    total = sum(frames)-fade*(len(frames)-1)
    with tempfile.TemporaryDirectory(prefix='sp_v183_') as temp:
        temp = Path(temp)
        images = []
        for i,(src,scene) in enumerate(zip(sources,req.scenes)):
            path = temp/f'image{i}.jpg'
            v17_slide_frame(MEDIA/src['filename'],dims,scene.text,req.color).save(path,quality=94)
            images.append(path)
            progress(5+int(15*(i+1)/len(sources)),f'Bild {i+1}/{len(sources)} vorbereitet')
        segments=[]; done=0
        def encode(inputs, count, transition=False):
            nonlocal done
            target=temp/f'part{len(segments):03d}.mp4'
            cmd=[ffmpeg,'-nostdin','-hide_banner','-loglevel','error','-y','-filter_threads','1','-filter_complex_threads','1']
            for path in inputs:
                cmd += ['-threads','1','-loop','1','-framerate','25','-i',str(path)]
            if transition:
                cmd += ['-filter_complex',f"[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]blend=all_expr=A*(1-(N-1)/{max(1,count-1)})+B*(N-1)/{max(1,count-1)}[v]",'-map','[v]']
            else:
                cmd += ['-vf','format=yuv420p']
            cmd += ['-frames:v',str(count),'-an','-c:v','libx264','-threads','1','-preset','ultrafast','-crf','23','-pix_fmt','yuv420p','-r','25','-video_track_timescale','12800',str(target)]
            proc=_run_ffmpeg(cmd,capture_output=True,timeout=120)
            if proc.returncode:
                logger.error('Montage FFmpeg: %s',proc.stderr[-2000:])
                raise RuntimeError('Video-Encoder konnte eine Szene nicht verarbeiten.')
            segments.append(target); done+=count
            progress(20+int(72*done/total),f'Video gerendert: {done/25:.1f} / {total/25:.1f} Sek.')
        for i,path in enumerate(images):
            encode([path],frames[i]-fade*(int(i>0)+int(i<len(images)-1)))
            if fade and i<len(images)-1:
                encode([path,images[i+1]],fade,True)
        listing=temp/'concat.txt'
        listing.write_text(''.join(f"file '{x.name}'\n" for x in segments),encoding='utf-8')
        progress(95,'Videosequenzen werden zusammengefügt …')
        proc=_run_ffmpeg([ffmpeg,'-nostdin','-hide_banner','-loglevel','error','-y','-f','concat','-safe','1','-i',str(listing),'-c','copy','-movflags','+faststart',str(out)],capture_output=True,timeout=120)
        if proc.returncode or not out.exists() or not out.stat().st_size:
            logger.error('Montage concat: %s',proc.stderr[-2000:])
            raise RuntimeError('Videosequenzen konnten nicht zusammengefügt werden.')
        if out.stat().st_size>MAX_VIDEO:
            raise RuntimeError('Das Video ist größer als 100 MB. Bitte die Dauer reduzieren.')
    return total/25


def _v183_worker(job, req, sources, ffmpeg, owner):
    out=MEDIA/(job+'.mp4')
    def update(**values):
        with _v183_lock:
            _v183_jobs[job].update(values)
    try:
        duration=_v183_encode(req,sources,ffmpeg,out,lambda pct,msg:update(progress=pct,message=msg))
        name='TimeSave-Social-Montage-'+datetime.now(APP_TZ).strftime('%Y%m%d-%H%M')+'.mp4'
        with dbconn() as db:
            db.execute('INSERT INTO media(id,filename,original_name,mime,created_at,owner_id) VALUES(?,?,?,?,?,?)',
                       (job,out.name,name,'video/mp4',now(),owner))
        update(status='done',progress=100,message='Dein Video ist fertig und in der Mediathek gespeichert.',id=job,duration=duration)
    except Exception as exc:
        out.unlink(missing_ok=True)
        logger.exception('Montage fehlgeschlagen')
        msg=str(exc) if isinstance(exc,RuntimeError) else 'Videoerstellung fehlgeschlagen. Bitte Render-Logs prüfen.'
        if isinstance(exc,subprocess.TimeoutExpired): msg='Eine Videosequenz hat zu lange gedauert.'
        update(status='error',message=msg)


@app.post('/api/studio/slideshow',status_code=202)
async def v17_render_slideshow(req: V17Slideshow, user: dict = Depends(current_user)):
    if sum(x.seconds for x in req.scenes)>90:
        raise HTTPException(400,'Die Gesamtlänge darf 90 Sekunden nicht überschreiten.')
    sources=[media_row(x.media_id,user['id']) for x in req.scenes]
    if any(m['mime'] not in ('image/jpeg','image/png') for m in sources):
        raise HTTPException(400,'Bitte nur JPG- oder PNG-Bilder auswählen.')
    if any(not (MEDIA/m['filename']).is_file() for m in sources):
        raise HTTPException(404,'Mindestens ein ausgewähltes Bild fehlt.')
    try: ffmpeg=_find_ffmpeg()
    except RuntimeError as exc: raise HTTPException(503,str(exc)) from None
    job=uuid.uuid4().hex
    with _v183_lock:
        if any(x['status']=='running' for x in _v183_jobs.values()):
            raise HTTPException(409,'Es wird bereits ein Video erstellt. Bitte warte, bis es fertig ist.')
        while len(_v183_jobs)>=40: _v183_jobs.pop(next(iter(_v183_jobs)))
        _v183_jobs[job]={'owner':user['id'],'status':'running','progress':1,'message':'Videoerstellung gestartet …'}
    task=asyncio.create_task(asyncio.to_thread(_v183_worker,job,req,sources,ffmpeg,user['id']))
    _v183_tasks.add(task); task.add_done_callback(_v183_tasks.discard)
    return {'job_id':job}


@app.get('/api/studio/slideshow/{job}')
def v183_slideshow_status(job: str,user: dict=Depends(current_user)):
    with _v183_lock:
        entry=_v183_jobs.get(job)
        if not entry or entry['owner']!=user['id']:
            raise HTTPException(404,'Videoauftrag nicht gefunden. Der Server wurde möglicherweise neu gestartet.')
        return {k:v for k,v in entry.items() if k!='owner'}


# V18.4: actual FFmpeg timestamps; no simulated render percentage.
def _v184_ffmpeg_progress(cmd, timeout, duration, progress):
    with tempfile.TemporaryDirectory(prefix='sp_progress_') as td:
        log = Path(td)/'progress.txt'
        with tempfile.TemporaryFile() as errors, _FFMPEG_SEM:
            args = [cmd[0], '-progress', str(log), '-nostats', *cmd[1:]]
            with subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=errors) as proc:
                deadline = time.monotonic()+timeout
                pct = 10
                progress(pct, 'Video wird gerendert …')
                try:
                    while proc.poll() is None:
                        if time.monotonic() >= deadline:
                            raise subprocess.TimeoutExpired(args, timeout)
                        if log.exists():
                            with log.open('rb') as stream:
                                stream.seek(max(0, log.stat().st_size-8192))
                                matches = re.findall(rb'out_time_us=(\d+)', stream.read())
                            if matches:
                                seconds = min(duration, int(matches[-1])/1_000_000)
                                new = min(91, 10+int(81*seconds/duration))
                                if new > pct:
                                    pct = new
                                    progress(pct, f'Video gerendert: {seconds:.1f} / {duration:.1f} Sek.')
                        time.sleep(.4)
                finally:
                    if proc.poll() is None:
                        proc.kill()
                        proc.wait()
                errors.seek(0)
                return subprocess.CompletedProcess(args, proc.returncode, stderr=errors.read())


async def _v184_edit_worker(job, req, user):
    def update(**values):
        with _v183_lock:
            _v183_jobs[job].update(values)
    try:
        # Dedicated thread so CPU/file operations do not block status polling.
        result = await asyncio.to_thread(lambda: asyncio.run(_render_video_studio(
            req, user, lambda pct,msg: update(progress=pct,message=msg))))
        update(**result, status='done', progress=100)
    except HTTPException as exc:
        update(status='error', message=str(exc.detail))
    except Exception:
        logger.exception('Videoexport fehlgeschlagen')
        update(status='error', message='Videoexport fehlgeschlagen. Bitte Render-Logs prüfen.')


@app.post('/api/studio/video-export', status_code=202)
async def v184_start_video_export(req: VideoStudioRequest, user: dict = Depends(current_user)):
    media_row(req.media_id, user['id'])
    job = uuid.uuid4().hex
    with _v183_lock:
        if any(x['status']=='running' for x in _v183_jobs.values()):
            raise HTTPException(409, 'Es läuft bereits ein Videoexport. Bitte warte, bis er fertig ist.')
        while len(_v183_jobs)>=40:
            _v183_jobs.pop(next(iter(_v183_jobs)))
        _v183_jobs[job] = {'owner':user['id'], 'status':'running', 'progress':1, 'message':'Videoexport gestartet …'}
    task = asyncio.create_task(_v184_edit_worker(job, req, user))
    _v183_tasks.add(task)
    task.add_done_callback(_v183_tasks.discard)
    return {'job_id':job}

# V19.0: Modular router (WhatsApp Status optimizer/splitter, Auto-Jump-Cut silence removal, Studio presets)
from app.v19_routes import create_v19_router as _create_v19_router

app.include_router(_create_v19_router({
    'current_user': current_user,
    'media_row': media_row,
    'dbconn': dbconn,
    'now': now,
    'APP_TZ': APP_TZ,
    'MEDIA': MEDIA,
    'MAX_VIDEO': MAX_VIDEO,
    '_find_ffmpeg': _find_ffmpeg,
    '_run_ffmpeg': _run_ffmpeg,
    '_video_duration_seconds': _video_duration_seconds,
    '_v183_jobs': _v183_jobs,
    '_v183_lock': _v183_lock,
    '_v183_tasks': _v183_tasks,
    'get_user_pref': get_user_pref,
    'save_user_pref': save_user_pref,
    'setting': setting,
    'public_base': public_base,
    'secure_media_url': secure_media_url,
    'tiktok_photo_readiness': tiktok_photo_readiness,
    'DB_BACKEND': DB_BACKEND,
    'DATA_DIR': DATA,
    'logger': logger,
}))


@app.get('/manifest.webmanifest')
def pwa_manifest():
    return FileResponse(
        ROOT / 'static' / 'manifest.webmanifest',
        media_type='application/manifest+json',
        headers={'Cache-Control': 'public, max-age=3600'},
    )


@app.get('/sw.js')
def pwa_service_worker():
    return FileResponse(
        ROOT / 'static' / 'sw.js',
        media_type='application/javascript',
        headers={'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/'},
    )


@app.get('/apple-touch-icon.png')
def pwa_apple_touch_icon():
    return FileResponse(
        ROOT / 'static' / 'icons' / 'apple-touch-icon.png',
        media_type='image/png',
        headers={'Cache-Control': 'public, max-age=86400'},
    )


@app.api_route('/public/{filename}', methods=['GET', 'HEAD'])
def tiktok_public_verify_file(request: Request, filename: str):
    vresp = _tiktok_verify_response(filename, head_only=(request.method == 'HEAD'))
    if vresp is not None:
        return vresp
    raise HTTPException(404, 'Not Found')


@app.api_route('/{filename}', methods=['GET', 'HEAD'])
def tiktok_root_verify_file(request: Request, filename: str):
    vresp = _tiktok_verify_response(filename, head_only=(request.method == 'HEAD'))
    if vresp is not None:
        return vresp
    raise HTTPException(404, 'Not Found')
