"""K3: an account created on the Users page gets a temporary password, and
the admin-ui's sign-in page answered "Incorrect username or password" --
Keycloak refuses a direct sign-in while "update password" is pending. The
sign-in page now asks for a new password and sets it through
/public/account/initial-password, which needs the current (temporary) one."""


def _new_colleague(client, keycloak):
    r = client.post("/admin/users", json={"username": "new.colleague", "email": "nc@example.test", "first_name": "New", "last_name": "Colleague", "password": "Temp-12345", "is_admin": False})
    assert r.status_code == 200, r.text
    keycloak.passwords["new.colleague"] = "Temp-12345"
    return r.json()["id"]


def _set(client, current, new, username="new.colleague"):
    return client.post("/public/account/initial-password", json={"username": username, "current_password": current, "new_password": new})


def test_a_new_colleague_sets_their_own_password_with_the_temporary_one(client, keycloak):
    from app.api import account

    account._attempts_by_ip.clear()
    uid = _new_colleague(client, keycloak)
    assert keycloak.password_status("new.colleague", "Temp-12345") == "setup_required"
    assert _set(client, "wrong", "Chosen-password-1").status_code == 401
    assert _set(client, "Temp-12345", "short").status_code == 422
    assert _set(client, "Temp-12345", "Temp-12345").status_code == 422  # must be a new one
    assert _set(client, "Temp-12345", "Chosen-password-1").status_code == 204
    assert ("finish_first_password", uid) in keycloak.calls
    assert keycloak.password_status("new.colleague", "Chosen-password-1") == "ok"
    # done once: the temporary password can't be used again, and a set-up account is told to sign in
    assert _set(client, "Temp-12345", "Another-password-2").status_code == 401
    assert _set(client, "Chosen-password-1", "Another-password-2").status_code == 409


def test_it_is_rate_limited_per_address(client, keycloak):
    from app.api import account

    account._attempts_by_ip.clear()  # the counter lives in the process, like the registration form's
    _new_colleague(client, keycloak)
    codes = [_set(client, "wrong", "Chosen-password-1").status_code for _ in range(12)]
    assert codes[:10] == [401] * 10 and codes[10:] == [429, 429]
