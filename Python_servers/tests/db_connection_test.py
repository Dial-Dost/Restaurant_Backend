import os

from dotenv import load_dotenv

try:
    import psycopg
except ModuleNotFoundError as exc:
    raise RuntimeError(
        "psycopg is required for Supabase/Postgres tests. Install with: pip install 'psycopg[binary]'"
    ) from exc

load_dotenv()


def _connection_string() -> str:
    value = (
        os.environ.get("SUPABASE_DIRECT_URL")
        or os.environ.get("DATABASE_URL")
        or os.environ.get("DIRECT_URL")
    )
    if not value:
        raise RuntimeError(
            "Missing SUPABASE_DIRECT_URL (or DATABASE_URL / DIRECT_URL) in environment"
        )
    return value


def test_supabase_connection():
    conn = psycopg.connect(_connection_string())
    try:
        with conn.cursor() as cur:
            cur.execute("select 1 as ok")
            row = cur.fetchone()
            assert row is not None
            assert int(row[0]) == 1
    finally:
        conn.close()
