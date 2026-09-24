"""B-10: the de-identification rule API refuses rules that couldn't be
applied at import (bad tag, missing or invalid value, conflicting rule)
instead of letting one typo fail every import of every study using the
profile, and rules and profiles can be deleted. The meaning of a rule is
shared_models.deid_rules; its own cases are tested there."""
from shared_models.models import DeidentificationAction, DeidentificationRule

from .conftest import ANNOTATOR_SUBJECT, make_study

BASE = "/admin/deidentification-profiles"


def _profile(client, name="P"):
    r = client.post(BASE, params={"name": name})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _rule(client, pid, tag, action, value=None):
    params = {"dicom_tag": tag, "action": action}
    if value is not None:
        params["replacement_value"] = value
    return client.post(f"{BASE}/{pid}/rules", params=params)


def test_rules_are_checked_and_stored_by_tag_number(client):
    pid = _profile(client)
    r = _rule(client, pid, "PatientName", "hash")
    assert r.status_code == 200 and r.json()["dicom_tag"] == "(0010,0010)"
    for tag, action, value in [("(zzzz,0010)", "remove", None), ("", "remove", None), ("(0010,0020)", "replace_fixed", None),
                               ("(0020,000D)", "replace_fixed", "1.2.3"), ("(0020,0013)", "replace_fixed", "abc"), ("(0008,0020)", "hash", None)]:
        r = _rule(client, pid, tag, action, value)
        assert r.status_code == 422, (tag, action, r.text)
    # a second rule for the same tag, however it is written
    r = _rule(client, pid, "(0010,0010)", "remove")
    assert r.status_code == 409 and "already has a rule" in r.json()["detail"]


def test_rules_and_unused_profiles_can_be_deleted(client, db):
    pid = _profile(client)
    rule_id = _rule(client, pid, "PatientName", "remove").json()["id"]
    assert client.delete(f"{BASE}/{pid}/rules/{rule_id}").status_code == 204
    assert client.get(BASE).json()[0]["rules"] == []
    sid = make_study(client)
    assert client.patch(f"/admin/studies/{sid}", params={"deidentification_profile_id": pid}).status_code == 200
    r = client.delete(f"{BASE}/{pid}")
    assert r.status_code == 409 and "Study A" in r.json()["detail"]
    assert client.patch(f"/admin/studies/{sid}", params={"deidentification_profile_id": ""}).status_code == 200
    assert client.delete(f"{BASE}/{pid}").status_code == 204
    assert client.get(BASE).json() == []


def test_a_rule_stored_before_the_checks_is_flagged_and_the_salt_never_shown(client, db):
    pid = _profile(client)
    db.add(DeidentificationRule(profile_id=pid, dicom_tag="(0008,0020)", action=DeidentificationAction.HASH))
    db.commit()
    (profile,) = client.get(BASE).json()
    assert "hash_salt" not in profile
    assert "invalid StudyDate" in profile["rules"][0]["problem"]
    # two old rules for one tag, written differently, are both flagged
    db.add_all([DeidentificationRule(profile_id=pid, dicom_tag=t, action=DeidentificationAction.REMOVE) for t in ("PatientName", "(0010,0010)")])
    db.commit()
    (profile,) = client.get(BASE).json()
    flagged = [r["dicom_tag"] for r in profile["rules"] if r["problem"] and "also covers (0010,0010)" in r["problem"]]
    assert sorted(flagged) == ["(0010,0010)", "PatientName"]


def test_only_admins_edit_profiles(client):
    pid = _profile(client)
    client.as_user(ANNOTATOR_SUBJECT)
    assert _rule(client, pid, "PatientName", "remove").status_code == 403
    assert client.delete(f"{BASE}/{pid}").status_code == 403
