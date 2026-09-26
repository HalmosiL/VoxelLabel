"""The first sign-in of an account an admin created (K3).

An account made on the Users page has a temporary password, so Keycloak
refuses a direct sign-in ("Account is not fully set up") until the person
picks their own. The admin-ui's sign-in page used to show that as
"Incorrect username or password"; now it asks for a new password and sends
it here, together with the temporary one. No login needed -- knowing the
temporary password is the proof -- but limited per address like the
registration form."""
import time
from collections import defaultdict, deque

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from shared_models.database import get_db
from sqlalchemy.orm import Session

from app.api import audit
from app.api.registration import _client_address
from app.keycloak_admin import find_user_by_username, finish_first_password, password_status

public_router = APIRouter(prefix="/public/account", tags=["public:account"])

MAX_ATTEMPTS_PER_HOUR = 10
MIN_PASSWORD_LENGTH = 8
_attempts_by_ip: dict[str, deque] = defaultdict(deque)


class InitialPasswordBody(BaseModel):
    username: str = Field(min_length=1, max_length=255)
    current_password: str = Field(min_length=1, max_length=512)
    new_password: str = Field(min_length=1, max_length=512)


def _check_rate(address: str) -> None:
    now = time.monotonic()
    recent = _attempts_by_ip[address]
    while recent and now - recent[0] > 3600:
        recent.popleft()
    if len(recent) >= MAX_ATTEMPTS_PER_HOUR:
        raise HTTPException(status_code=429, detail="Too many attempts from this address -- try again later")
    recent.append(now)


@public_router.post("/initial-password", status_code=204)
def set_initial_password(body: InitialPasswordBody, request: Request, db: Session = Depends(get_db)) -> Response:
    _check_rate(_client_address(request))
    if len(body.new_password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(status_code=422, detail=f"Choose a password of at least {MIN_PASSWORD_LENGTH} characters")
    if body.new_password == body.current_password:
        raise HTTPException(status_code=422, detail="Choose a new password, not the temporary one")
    username = body.username.strip()
    status = password_status(username, body.current_password)
    if status == "invalid":
        raise HTTPException(status_code=401, detail="Incorrect username or password.")
    if status == "ok":
        raise HTTPException(status_code=409, detail="Your password is already set -- sign in with it.")
    user = find_user_by_username(username)
    if user is None or "UPDATE_PASSWORD" not in (user.get("required_actions") or []):
        raise HTTPException(status_code=409, detail="This account needs an administrator to finish setting it up.")
    try:
        finish_first_password(user["id"], body.new_password)
    except httpx.HTTPStatusError as err:
        if err.response.status_code == 400:  # Keycloak's password policy said no
            raise HTTPException(status_code=422, detail="That password doesn't meet the password rules -- try a longer one") from None
        raise
    audit.record(db, _Actor(user["id"], user.get("email")), "user.initial_password", "user", user["id"], {"username": username})
    db.commit()
    return Response(status_code=204)


class _Actor:
    """The person themselves is the actor of this audit line."""

    def __init__(self, subject: str, email: str | None):
        self.subject, self.email, self.realm_roles = subject, email, []
