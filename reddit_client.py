"""
Publishing adapter for Now Processing.

Backends:
    dry-run -> print the exact Markdown that would be sent to Reddit.
    reddit  -> edit one existing Reddit self-post owned by the authenticated user.

Target configuration:
    Preferred: REDDIT_TARGET_POST_URL
    Advanced fallback: REDDIT_TARGET_THING_ID

Before the first real edit in a process, the Reddit backend verifies that the
authenticated OAuth user owns the configured target self-post.
"""

from dataclasses import dataclass
import os
import re
import time
from urllib.parse import urlparse

import requests

from reddit_credentials import get_reddit_credentials


PUBLISHER_ENV = "NOW_PROCESSING_PUBLISHER"
DEFAULT_PUBLISHER = "dry-run"

TARGET_POST_URL_ENV = "REDDIT_TARGET_POST_URL"
TARGET_THING_ENV = "REDDIT_TARGET_THING_ID"

TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
API_BASE = "https://oauth.reddit.com"
ME_URL = f"{API_BASE}/api/v1/me"
INFO_URL = f"{API_BASE}/api/info"
EDIT_URL = f"{API_BASE}/api/editusertext"

# Reddit submission IDs are base36. We deliberately require the normal comments
# URL shape instead of trying to accept arbitrary Reddit URLs.
POST_PATH_RE = re.compile(
    r"/comments/([0-9a-z]+)/",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class PublishResult:
    backend: str
    published: bool


@dataclass(frozen=True)
class ValidatedRedditTarget:
    thing_id: str
    authenticated_user: str
    post_author: str
    post_title: str | None


_cached_access_token: str | None = None
_cached_access_token_expires_at: float = 0.0

# Ownership does not need to be re-queried for every song change in one warm
# Lambda process. Cache only the safe validation result, never credentials.
_cached_validated_target: ValidatedRedditTarget | None = None


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


# Convert an ordinary Reddit post URL into the fullname required by the edit API.
# Example:
#   .../comments/1xa1hun/nowprocessing/ -> t3_1xa1hun
def thing_id_from_post_url(post_url: str) -> str:
    parsed = urlparse(post_url.strip())

    hostname = (parsed.hostname or "").lower()
    allowed_hosts = {
        "reddit.com",
        "www.reddit.com",
        "old.reddit.com",
        "new.reddit.com",
    }

    if hostname not in allowed_hosts:
        raise RuntimeError(
            "REDDIT_TARGET_POST_URL must be a reddit.com post URL."
        )

    match = POST_PATH_RE.search(parsed.path)
    if not match:
        raise RuntimeError(
            "Could not find a Reddit submission ID in REDDIT_TARGET_POST_URL. "
            "Expected a URL containing '/comments/<post-id>/'."
        )

    post_id = match.group(1).lower()
    return f"t3_{post_id}"


def _validate_thing_id(thing_id: str) -> str:
    value = thing_id.strip()

    if not re.fullmatch(r"t3_[0-9a-z]+", value, re.IGNORECASE):
        raise RuntimeError(
            "REDDIT_TARGET_THING_ID must be a Reddit post fullname "
            "such as 't3_1xa1hun'."
        )

    return value.lower()


# URL is the user-friendly configuration. Direct fullname remains available for
# advanced use. If both are supplied, require them to identify the same post.
def resolve_target_thing_id() -> str:
    post_url = os.environ.get(TARGET_POST_URL_ENV, "").strip()
    explicit_thing_id = os.environ.get(TARGET_THING_ENV, "").strip()

    url_thing_id = thing_id_from_post_url(post_url) if post_url else None
    direct_thing_id = (
        _validate_thing_id(explicit_thing_id)
        if explicit_thing_id
        else None
    )

    if url_thing_id and direct_thing_id and url_thing_id != direct_thing_id:
        raise RuntimeError(
            "REDDIT_TARGET_POST_URL and REDDIT_TARGET_THING_ID "
            "refer to different posts."
        )

    target = url_thing_id or direct_thing_id

    if not target:
        raise RuntimeError(
            "No Reddit target is configured. Set REDDIT_TARGET_POST_URL "
            "or REDDIT_TARGET_THING_ID."
        )

    return target


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


def _oauth_headers(access_token: str, user_agent: str) -> dict:
    return {
        "Authorization": f"bearer {access_token}",
        "User-Agent": user_agent,
    }


# Ask Reddit which account the refresh token represents.
def _get_authenticated_username(
    access_token: str,
    user_agent: str,
) -> str:
    response = requests.get(
        ME_URL,
        headers=_oauth_headers(access_token, user_agent),
        params={"raw_json": 1},
        timeout=20,
    )
    response.raise_for_status()

    username = response.json().get("name")
    if not username:
        raise RuntimeError(
            "Reddit identity response did not contain an account name."
        )

    return username


# Fetch the configured post through Reddit's fullname lookup endpoint and return
# only the metadata needed for the ownership safety check.
def _get_target_post_metadata(
    access_token: str,
    user_agent: str,
    thing_id: str,
) -> dict:
    response = requests.get(
        INFO_URL,
        headers=_oauth_headers(access_token, user_agent),
        params={
            "id": thing_id,
            "raw_json": 1,
        },
        timeout=20,
    )
    response.raise_for_status()

    payload = response.json()
    children = (
        ((payload.get("data") or {}).get("children"))
        or []
    )

    if not children:
        raise RuntimeError(
            f"Reddit could not resolve target post '{thing_id}'."
        )

    post = (children[0].get("data") or {})

    returned_name = (post.get("name") or "").lower()
    if returned_name != thing_id.lower():
        raise RuntimeError(
            "Reddit returned unexpected post metadata for the configured target."
        )

    return post


# Refuse to edit unless the OAuth account is exactly the author of an existing
# self-post. This catches account/post mix-ups before any text is changed.
def validate_reddit_target() -> ValidatedRedditTarget:
    global _cached_validated_target

    thing_id = resolve_target_thing_id()

    if (
        _cached_validated_target
        and _cached_validated_target.thing_id == thing_id
    ):
        return _cached_validated_target

    credentials = get_reddit_credentials()
    access_token = _get_access_token()

    authenticated_user = _get_authenticated_username(
        access_token,
        credentials.user_agent,
    )

    post = _get_target_post_metadata(
        access_token,
        credentials.user_agent,
        thing_id,
    )

    post_author = post.get("author")
    if not post_author:
        raise RuntimeError(
            f"Target Reddit post '{thing_id}' has no visible author."
        )

    if authenticated_user.casefold() != post_author.casefold():
        raise RuntimeError(
            "Reddit ownership validation failed: authenticated user "
            f"'{authenticated_user}' does not own target post '{thing_id}', "
            f"whose author is '{post_author}'."
        )

    if post.get("is_self") is not True:
        raise RuntimeError(
            f"Target Reddit post '{thing_id}' is not a self/text post."
        )

    _cached_validated_target = ValidatedRedditTarget(
        thing_id=thing_id,
        authenticated_user=authenticated_user,
        post_author=post_author,
        post_title=post.get("title"),
    )

    return _cached_validated_target


def _publish_reddit(markdown: str) -> PublishResult:
    credentials = get_reddit_credentials()
    access_token = _get_access_token()

    # Validate ownership before constructing or sending the edit request.
    target = validate_reddit_target()

    response = requests.post(
        EDIT_URL,
        headers=_oauth_headers(
            access_token,
            credentials.user_agent,
        ),
        data={
            "api_type": "json",
            "thing_id": target.thing_id,
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
