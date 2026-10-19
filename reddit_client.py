"""
Publishing adapter for Now Processing.

Backends:
    dry-run -> print the exact Markdown that would be sent to Reddit.
    reddit  -> edit one existing Reddit self-post owned by the authenticated user.

The Reddit backend remains opt-in. NOW_PROCESSING_PUBLISHER defaults to dry-run.
"""

from dataclasses import dataclass
import os
import time

import requests

from reddit_credentials import get_reddit_credentials


PUBLISHER_ENV = "NOW_PROCESSING_PUBLISHER"
DEFAULT_PUBLISHER = "dry-run"

TARGET_THING_ENV = "REDDIT_TARGET_THING_ID"

TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
API_BASE = "https://oauth.reddit.com"
EDIT_URL = f"{API_BASE}/api/editusertext"


@dataclass(frozen=True)
class PublishResult:
    backend: str
    published: bool


_cached_access_token: str | None = None
_cached_access_token_expires_at: float = 0.0


def get_publisher_backend() -> str:
    backend = os.environ.get(PUBLISHER_ENV, DEFAULT_PUBLISHER).strip().lower()

    if backend not in {"dry-run", "reddit"}:
        raise RuntimeError(
            f"Unsupported publisher backend '{backend}'. "
            "Expected 'dry-run' or 'reddit'."
        )

    return backend


def _publish_dry_run(markdown: str) -> PublishResult:
    print("\n" + "=" * 70)
    print("DRY RUN - WOULD PUBLISH THIS STATUS")
    print("=" * 70)
    print(markdown)
    print("=" * 70)

    return PublishResult(
        backend="dry-run",
        published=True,
    )


def _get_target_thing_id() -> str:
    thing_id = os.environ.get(TARGET_THING_ENV, "").strip()

    if not thing_id:
        raise RuntimeError(
            "REDDIT_TARGET_THING_ID is not set. "
            "It must contain the fullname of the existing Reddit self-post."
        )

    if not thing_id.startswith("t3_"):
        raise RuntimeError(
            "REDDIT_TARGET_THING_ID must be a Reddit post fullname "
            "beginning with 't3_'."
        )

    return thing_id


def _get_access_token() -> str:
    global _cached_access_token
    global _cached_access_token_expires_at

    now = time.time()

    if _cached_access_token and now < _cached_access_token_expires_at - 60:
        return _cached_access_token

    credentials = get_reddit_credentials()

    response = requests.post(
        TOKEN_URL,
        auth=(credentials.client_id, credentials.client_secret),
        headers={"User-Agent": credentials.user_agent},
        data={
            "grant_type": "refresh_token",
            "refresh_token": credentials.refresh_token,
        },
        timeout=20,
    )
    response.raise_for_status()

    payload = response.json()
    access_token = payload.get("access_token")

    if not access_token:
        raise RuntimeError(
            "Reddit token response did not contain access_token."
        )

    expires_in = int(payload.get("expires_in", 3600))

    _cached_access_token = access_token
    _cached_access_token_expires_at = now + expires_in

    return access_token


def _publish_reddit(markdown: str) -> PublishResult:
    credentials = get_reddit_credentials()
    access_token = _get_access_token()
    thing_id = _get_target_thing_id()

    response = requests.post(
        EDIT_URL,
        headers={
            "Authorization": f"bearer {access_token}",
            "User-Agent": credentials.user_agent,
        },
        data={
            "api_type": "json",
            "thing_id": thing_id,
            "text": markdown,
            "raw_json": 1,
        },
        timeout=20,
    )
    response.raise_for_status()

    payload = response.json()
    errors = ((payload.get("json") or {}).get("errors") or [])

    if errors:
        raise RuntimeError(
            f"Reddit edit request returned API errors: {errors}"
        )

    return PublishResult(
        backend="reddit",
        published=True,
    )


def publish_status(markdown: str) -> PublishResult:
    backend = get_publisher_backend()

    if backend == "reddit":
        return _publish_reddit(markdown)

    return _publish_dry_run(markdown)
