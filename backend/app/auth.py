"""Authentication: HMAC-signed session cookies + PBKDF2 passwords.

AUTH_SECRET should be provided as an environment variable so that sessions
survive a restart.
"""
import hashlib
import hmac
import os
import secrets
import time

from fastapi import HTTPException, Request, Response

from . import db

SECRET = os.environ.get("AUTH_SECRET") or secrets.token_hex(32)
SESSION_DAYS = 30
PBKDF2_ROUNDS = 200_000
COOKIE_NAME = "vlm_session"


def hash_password(password: str) -> tuple[str, str]:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), PBKDF2_ROUNDS)
    return digest.hex(), salt


def verify_password(password: str, hash_hex: str, salt_hex: str) -> bool:
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), PBKDF2_ROUNDS)
    return hmac.compare_digest(digest.hex(), hash_hex)


def make_token(username: str) -> str:
    ts = str(int(time.time()))
    msg = f"{username}:{ts}"
    sig = hmac.new(SECRET.encode(), msg.encode(), hashlib.sha256).hexdigest()
    return f"{msg}:{sig}"


def verify_token(token: str | None) -> str | None:
    if not token:
        return None
    try:
        username, ts, sig = token.rsplit(":", 2)
    except ValueError:
        return None
    expected = hmac.new(SECRET.encode(), f"{username}:{ts}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return None
    if int(time.time()) - int(ts) > SESSION_DAYS * 86400:
        return None
    return username


def set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME, token,
        max_age=SESSION_DAYS * 86400,
        httponly=True, samesite="lax",
    )


def user_exists(username: str) -> bool:
    """Whether the username still backs a real account in the DB."""
    con = db.connect()
    row = con.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
    con.close()
    return row is not None


def current_user(request: Request) -> str:
    """FastAPI dependency: returns the username or raises 401.

    A token can be cryptographically valid yet name a user that no longer
    exists (e.g. the DB was wiped while a signed cookie is still held). Such
    orphaned sessions must be rejected, so existence is checked here.
    """
    user = verify_token(request.cookies.get(COOKIE_NAME))
    if not user or not user_exists(user):
        raise HTTPException(status_code=401, detail="not authenticated")
    return user
