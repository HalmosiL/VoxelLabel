#!/usr/bin/env python3
"""Setup: registers this repo's AnnotationTypes (`freehand_mask`,
`freehand_mask_volume`, `segmentation_volume`) on the main platform's
admin-service, so the backend's `POST /annotations` can reference them
by name. Safe -- and meant -- to re-run after an upgrade: an already
registered type gets its schema brought up to this file's version.

Usage:
    python3 scripts/register_annotation_type.py \\
        --keycloak-url http://localhost:8080 \\
        --admin-service-url http://localhost:8004 \\
        --username platform-admin --password platform-admin
"""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

FREEHAND_MASK_SCHEMA = {
    "type": "object",
    "properties": {"mask_storage_key": {"type": "string"}},
    "required": ["mask_storage_key"],
    "additionalProperties": False,
}

# A whole-series 3D mask volume (gzip-packed Uint8Array, one byte per
# voxel), distinct from `freehand_mask` above (a single 2D PNG tied to
# one Instance) -- see backend/app/main.py's mask-volume endpoints and
# ~/.claude/plans/unified-splashing-blossom.md for why this is a
# separate registered type rather than overloading the existing one.
FREEHAND_MASK_VOLUME_SCHEMA = {
    "type": "object",
    "properties": {"mask_volume_key": {"type": "string"}},
    "required": ["mask_volume_key"],
    "additionalProperties": False,
}

# CVAT-style multi-object segmentation: the volume blob now stores an
# *object id* per voxel (0 = background) rather than a plain 0/255 mask,
# so the payload also carries the label/object definitions those ids
# refer to. Superseding FREEHAND_MASK_VOLUME_SCHEMA above (left
# registered, not migrated) rather than widening its schema in place --
# see ~/.claude/plans/unified-splashing-blossom.md.
#
# Grows over time (the script re-applies it to an already registered
# type -- see register_annotation_type): `comment` and `review_status`
# per object came with the review surface; a label's `fields` (its
# per-object form: tick / pick one / scale, see the frontend's
# components/ObjectForm.tsx) and an object's `attributes` (the answers)
# with the per-object form. Every addition is optional so older saved
# payloads still validate.
OBJECT_FIELD_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "kind": {"type": "string", "enum": ["check", "choice", "scale"]},
        "options": {"type": "array", "items": {"type": "string"}},
        "min": {"type": "number"},
        "max": {"type": "number"},
        "step": {"type": "number"},
    },
    "required": ["name", "kind"],
    "additionalProperties": False,
}

SEGMENTATION_VOLUME_SCHEMA = {
    "type": "object",
    "properties": {
        "mask_volume_key": {"type": "string"},
        "labels": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "name": {"type": "string"},
                    "color": {"type": "string"},
                    "fields": {"type": "array", "items": OBJECT_FIELD_SCHEMA},
                },
                "required": ["id", "name", "color"],
                "additionalProperties": False,
            },
        },
        "objects": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "label_id": {"type": "integer"},
                    "instance_number": {"type": "integer"},
                    "locked": {"type": "boolean"},
                    "hidden": {"type": "boolean"},
                    "comment": {"type": "string"},
                    "review_status": {"type": "string", "enum": ["pending", "accepted", "rejected"]},
                    "attributes": {
                        "type": "object",
                        "additionalProperties": {"type": ["string", "boolean", "number"]},
                    },
                },
                "required": ["id", "label_id", "instance_number", "locked", "hidden"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["mask_volume_key", "labels", "objects"],
    "additionalProperties": False,
}


def _post_form(url: str, data: dict) -> dict:
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def get_access_token(keycloak_url: str, username: str, password: str) -> str:
    token_url = f"{keycloak_url}/realms/ct-platform/protocol/openid-connect/token"
    token_response = _post_form(
        token_url,
        {"client_id": "ct-platform", "grant_type": "password", "username": username, "password": password},
    )
    return token_response["access_token"]


def register_annotation_type(admin_service_url: str, token: str, name: str, schema: dict) -> None:
    """Registers the type, or -- when it already exists -- brings its
    schema up to this file's version (a no-op if it already matches), so
    re-running this script after an upgrade is all a deployment needs."""
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    req = urllib.request.Request(
        f"{admin_service_url}/admin/annotation-types?name={name}", data=json.dumps(schema).encode(), method="POST", headers=headers
    )
    try:
        with urllib.request.urlopen(req) as resp:
            print(f"Registered '{name}' annotation type: {resp.read().decode()}")
            return
    except urllib.error.HTTPError as exc:
        if exc.code != 409:
            print(f"Failed ({exc.code}): {exc.read().decode()}", file=sys.stderr)
            raise
    req = urllib.request.Request(
        f"{admin_service_url}/admin/annotation-types/{name}/schema", data=json.dumps(schema).encode(), method="PUT", headers=headers
    )
    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
            state = f"schema updated to version {result['schema_version']}" if result.get("changed") else "schema already current"
            print(f"'{name}' annotation type already registered -- {state}.")
    except urllib.error.HTTPError as exc:
        print(f"Failed to update '{name}' schema ({exc.code}): {exc.read().decode()}", file=sys.stderr)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keycloak-url", default="http://localhost:8080")
    parser.add_argument("--admin-service-url", default="http://localhost:8004")
    parser.add_argument("--username", required=True, help="Must hold the global Keycloak 'admin' realm role")
    parser.add_argument("--password", required=True)
    args = parser.parse_args()

    token = get_access_token(args.keycloak_url, args.username, args.password)
    register_annotation_type(args.admin_service_url, token, "freehand_mask", FREEHAND_MASK_SCHEMA)
    register_annotation_type(args.admin_service_url, token, "freehand_mask_volume", FREEHAND_MASK_VOLUME_SCHEMA)
    register_annotation_type(args.admin_service_url, token, "segmentation_volume", SEGMENTATION_VOLUME_SCHEMA)


if __name__ == "__main__":
    main()
