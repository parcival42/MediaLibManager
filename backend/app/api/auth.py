"""Authentication and user-management endpoints.

Public endpoints: auth check, initial setup (only while no user exists), login,
logout. Everything else requires a valid session.
"""
import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from .. import auth, db

router = APIRouter(prefix="/api")


class Credentials(BaseModel):
    username: str
    password: str


def _user_count() -> int:
    con = db.connect()
    n = con.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
    con.close()
    return n


@router.get("/auth/check")
def auth_check(request: Request):
    user = auth.verify_token(request.cookies.get(auth.COOKIE_NAME))
    return {"authenticated": bool(user), "username": user, "needs_setup": _user_count() == 0}


@router.post("/auth/initial-setup")
def initial_setup(creds: Credentials, response: Response):
    if _user_count() > 0:
        raise HTTPException(status_code=409, detail="setup already completed")
    password_hash, salt = auth.hash_password(creds.password)
    con = db.connect()
    con.execute(
        "INSERT INTO users(username, password_hash, salt, created_at) VALUES(?, ?, ?, ?)",
        (creds.username, password_hash, salt, time.time()),
    )
    con.commit()
    con.close()
    auth.set_cookie(response, auth.make_token(creds.username))
    return {"ok": True, "username": creds.username}


@router.post("/login")
def login(creds: Credentials, response: Response):
    con = db.connect()
    row = con.execute("SELECT * FROM users WHERE username = ?", (creds.username,)).fetchone()
    con.close()
    if not row or not auth.verify_password(creds.password, row["password_hash"], row["salt"]):
        raise HTTPException(status_code=401, detail="invalid credentials")
    auth.set_cookie(response, auth.make_token(creds.username))
    return {"ok": True, "username": creds.username}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(auth.COOKIE_NAME)
    return {"ok": True}


@router.get("/users")
def list_users(_: str = Depends(auth.current_user)):
    con = db.connect()
    rows = con.execute("SELECT username, created_at FROM users ORDER BY created_at").fetchall()
    con.close()
    return [dict(r) for r in rows]


@router.post("/users")
def add_user(creds: Credentials, _: str = Depends(auth.current_user)):
    password_hash, salt = auth.hash_password(creds.password)
    con = db.connect()
    try:
        con.execute(
            "INSERT INTO users(username, password_hash, salt, created_at) VALUES(?, ?, ?, ?)",
            (creds.username, password_hash, salt, time.time()),
        )
        con.commit()
    except db.sqlite3.IntegrityError:
        con.close()
        raise HTTPException(status_code=409, detail="user already exists")
    con.close()
    return {"ok": True}


@router.delete("/users/{name}")
def delete_user(name: str, _: str = Depends(auth.current_user)):
    con = db.connect()
    if con.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"] <= 1:
        con.close()
        raise HTTPException(status_code=400, detail="cannot delete the last user")
    con.execute("DELETE FROM users WHERE username = ?", (name,))
    con.commit()
    con.close()
    return {"ok": True}
