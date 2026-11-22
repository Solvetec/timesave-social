"""Dual-backend database compatibility layer for TimeSave Social by Solvetec.

Uses PostgreSQL automatically when DATABASE_URL is set (postgres:// or postgresql://),
and falls back seamlessly to local SQLite when DATABASE_URL is empty.
All SQLite/PostgreSQL syntax differences (?, IS ?, PRAGMA table_info, row access)
are handled transparently so the application works identically on both backends.
"""
from __future__ import annotations

import os
import queue
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any

DATABASE_URL = os.getenv('DATABASE_URL', '').strip()
if DATABASE_URL.startswith('postgres://'):
    DATABASE_URL = 'postgresql://' + DATABASE_URL[len('postgres://'):]

DB_BACKEND = 'postgres' if DATABASE_URL.startswith('postgresql://') else 'sqlite'

_PG_POOL: queue.LifoQueue | None = queue.LifoQueue(maxsize=8) if DB_BACKEND == 'postgres' else None


class CompatRow:
    """sqlite3.Row-compatible wrapper for PostgreSQL rows.

    Supports row['col'], row[0], dict(row), tuple(row), len(row), and 'col' in row.
    """
    __slots__ = ('_keys', '_values', '_map')

    def __init__(self, keys: tuple[str, ...], values: tuple[Any, ...]):
        self._keys = keys
        self._values = values
        self._map = dict(zip(keys, values))

    def keys(self):
        return self._keys

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        return self._map[key]

    def get(self, key, default=None):
        return self._map.get(key, default)

    def __contains__(self, key):
        return key in self._map

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)

    def __repr__(self):
        return f'CompatRow({self._map!r})'


def _translate_sql_for_postgres(sql: str) -> str:
    """Convert SQLite-style '?' placeholders and 'IS ?' to PostgreSQL syntax safely."""
    out: list[str] = []
    i = 0
    n = len(sql)
    in_single = False
    while i < n:
        ch = sql[i]
        if in_single:
            out.append('%%' if ch == '%' else ch)
            if ch == "'":
                if i + 1 < n and sql[i + 1] == "'":
                    out.append("'")
                    i += 2
                    continue
                in_single = False
            i += 1
            continue
        if ch == "'":
            in_single = True
            out.append(ch)
            i += 1
            continue
        if ch == '%':
            out.append('%%')
            i += 1
            continue
        if ch == '?':
            # Convert "IS ?" into PostgreSQL's NULL-safe "IS NOT DISTINCT FROM %s"
            joined = ''.join(out)
            m = re.search(r'(\bIS\s+)$', joined, flags=re.IGNORECASE)
            if m:
                out = [joined[:m.start(1)], 'IS NOT DISTINCT FROM %s']
            else:
                out.append('%s')
            i += 1
            continue
        out.append(ch)
        i += 1
    return ''.join(out)


def _split_sql_script(script: str) -> list[str]:
    stmts: list[str] = []
    buf: list[str] = []
    in_single = False
    i = 0
    n = len(script)
    while i < n:
        ch = script[i]
        if in_single:
            buf.append(ch)
            if ch == "'":
                if i + 1 < n and script[i + 1] == "'":
                    buf.append("'")
                    i += 2
                    continue
                in_single = False
            i += 1
            continue
        if ch == "'":
            in_single = True
            buf.append(ch)
            i += 1
            continue
        if ch == ';':
            stmt = ''.join(buf).strip()
            if stmt:
                stmts.append(stmt)
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    tail = ''.join(buf).strip()
    if tail:
        stmts.append(tail)
    return stmts


class _PGCursorProxy:
    def __init__(self, cursor):
        self._cur = cursor
        self._keys = tuple(desc[0] for desc in (cursor.description or ()))

    @property
    def rowcount(self) -> int:
        return self._cur.rowcount

    def _wrap(self, row):
        return CompatRow(self._keys, tuple(row)) if row is not None else None

    def fetchone(self):
        return self._wrap(self._cur.fetchone())

    def fetchall(self):
        return [CompatRow(self._keys, tuple(r)) for r in self._cur.fetchall()]

    def __iter__(self):
        for row in self._cur:
            yield CompatRow(self._keys, tuple(row))


class _PGConnectionProxy:
    def __init__(self, raw_conn):
        self._conn = raw_conn

    def execute(self, sql: str, params=()):
        stripped = sql.strip()
        if stripped.upper().startswith('PRAGMA '):
            return _PGCursorProxy(_DummyCursor())
        pg_sql = _translate_sql_for_postgres(sql)
        cur = self._conn.cursor()
        if params:
            cur.execute(pg_sql, tuple(params))
        else:
            cur.execute(pg_sql)
        return _PGCursorProxy(cur)

    def executemany(self, sql: str, seq_of_params):
        pg_sql = _translate_sql_for_postgres(sql)
        cur = self._conn.cursor()
        cur.executemany(pg_sql, [tuple(p) for p in seq_of_params])
        return _PGCursorProxy(cur)

    def executescript(self, script: str):
        for stmt in _split_sql_script(script):
            self.execute(stmt)

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()


class _DummyCursor:
    description = ()
    rowcount = 0

    def fetchone(self):
        return None

    def fetchall(self):
        return []

    def __iter__(self):
        return iter(())


def _borrow_pg_conn():
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError(
            'DATABASE_URL ist auf PostgreSQL gesetzt, aber psycopg fehlt: pip install "psycopg[binary]"'
        ) from exc
    if _PG_POOL is not None:
        while True:
            try:
                conn = _PG_POOL.get_nowait()
            except queue.Empty:
                break
            try:
                if getattr(conn, 'closed', False):
                    continue
                with conn.cursor() as cur:
                    cur.execute('SELECT 1')
                conn.rollback()
                return conn
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass
    return psycopg.connect(DATABASE_URL, connect_timeout=15, autocommit=False)


def _return_pg_conn(conn):
    if _PG_POOL is not None and not getattr(conn, 'closed', False):
        try:
            _PG_POOL.put_nowait(conn)
            return
        except queue.Full:
            pass
    try:
        conn.close()
    except Exception:
        pass


@contextmanager
def open_db(sqlite_path: Path):
    if DB_BACKEND == 'postgres':
        raw = _borrow_pg_conn()
        proxy = _PGConnectionProxy(raw)
        broken = False
        try:
            yield proxy
            proxy.commit()
        except Exception:
            try:
                proxy.rollback()
            except Exception:
                broken = True
            raise
        finally:
            if broken:
                try:
                    raw.close()
                except Exception:
                    pass
            else:
                _return_pg_conn(raw)
    else:
        conn = sqlite3.connect(sqlite_path, timeout=25)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA busy_timeout=25000')
        conn.execute('PRAGMA synchronous=NORMAL')
        conn.execute('PRAGMA temp_store=MEMORY')
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def table_columns(db, table: str) -> set[str]:
    if not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_]*', table):
        raise ValueError(f'Invalid table name: {table}')
    if DB_BACKEND == 'postgres':
        rows = db.execute(
            'SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=?',
            (table,),
        ).fetchall()
        return {r['column_name'] for r in rows}
    return {x['name'] for x in db.execute(f'PRAGMA table_info({table})')}


def add_column(db, table: str, name: str, sql_type: str) -> None:
    if not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_]*', name):
        raise ValueError(f'Invalid column name: {name}')
    if name not in table_columns(db, table):
        db.execute(f'ALTER TABLE {table} ADD COLUMN {name} {sql_type}')
