"""
Spotify API client for Now Processing.

This module owns Spotify-specific work:
- OAuth authorization and refresh-token handling.
- Reading the currently playing item.
- Resolving playback context into a friendly name.
- Returning a normalized PlaybackSnapshot for the rest of the app.

Application credentials come from spotify_credentials.py.
OAuth token persistence comes from spotify_token_store.py.
"""

from dataclasses import dataclass
import base64
import secrets
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

import requests

from spotify_credentials import get_spotify_app_credentials
from spotify_token_store import (
    get_token_backend,
    load_token,
    save_token,
)


REDIRECT_URI = "http://127.0.0.1:8888/callback"
SCOPES = [
    "user-read-currently-playing",
    "user-read-playback-state",
    "playlist-read-private",
]

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
CURRENTLY_PLAYING_URL = "https://api.spotify.com/v1/me/player/currently-playing"
OEMBED_URL = "https://open.spotify.com/oembed"


@dataclass(frozen=True)
class PlaybackSnapshot:
    """Small app-friendly representation of Spotify's playback response."""

    is_playing: bool
    item_type: str
    item_id: str | None
    title: str
    artist: str
    album: str | None
    item_url: str | None
    context_type: str | None
    context_name: str | None
    context_url: str | None

    @property
    def fingerprint(self) -> str:
        return "|".join(
            [
                "playing" if self.is_playing else "paused",
                self.item_type or "",
                self.item_id or "",
                self.context_type or "",
                self.context_url or "",
            ]
        )


def persist_token(token: dict) -> None:
    # Convert Spotify's relative expiry into an absolute timestamp before the
    # environment-appropriate token store persists the response.
    token["expires_at"] = int(time.time()) + int(token.get("expires_in", 3600))
    save_token(token)


def token_auth_header(client_id: str, client_secret: str) -> str:
    raw = f"{client_id}:{client_secret}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def exchange_code_for_token(
    client_id: str,
    client_secret: str,
    code: str,
) -> dict:
    response = requests.post(
        TOKEN_URL,
        headers={
            "Authorization": token_auth_header(client_id, client_secret),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
        },
        timeout=20,
    )
    response.raise_for_status()

    token = response.json()
    persist_token(token)
    return token


def refresh_access_token(
    client_id: str,
    client_secret: str,
    token: dict,
) -> dict:
    refresh_token = token.get("refresh_token")
    if not refresh_token:
        raise RuntimeError(
            "No Spotify refresh token is available in the configured token store."
        )

    response = requests.post(
        TOKEN_URL,
        headers={
            "Authorization": token_auth_header(client_id, client_secret),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        },
        timeout=20,
    )
    response.raise_for_status()

    refreshed = response.json()

    # Spotify may omit a replacement refresh token. Preserve the current token
    # unless Spotify explicitly gives us a new one.
    if "refresh_token" not in refreshed:
        refreshed["refresh_token"] = refresh_token

    persist_token(refreshed)
    return refreshed


class OAuthCallbackHandler(BaseHTTPRequestHandler):
    """Receive the one-time OAuth redirect from Spotify on localhost."""

    result: dict | None = None

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        OAuthCallbackHandler.result = {
            "code": params.get("code", [None])[0],
            "state": params.get("state", [None])[0],
            "error": params.get("error", [None])[0],
        }

        body = (
            "<html><body style='font-family: sans-serif'>"
            "<h2>Spotify authorization received.</h2>"
            "<p>You can close this browser tab and return to your terminal.</p>"
            "</body></html>"
        ).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        pass


def authorize(client_id: str, client_secret: str) -> dict:
    # Browser authorization is valid only for local development. Lambda cannot
    # complete an interactive localhost callback.
    state = secrets.token_urlsafe(24)

    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": " ".join(SCOPES),
        "state": state,
        "show_dialog": "true",
    }

    url = AUTH_URL + "?" + urllib.parse.urlencode(params)

    print("\nOpening Spotify authorization in your browser...")
    print("If the browser does not open, paste this URL into it:\n")
    print(url)
    print()

    server = HTTPServer(("127.0.0.1", 8888), OAuthCallbackHandler)
    webbrowser.open(url)
    server.handle_request()
    server.server_close()

    result = OAuthCallbackHandler.result or {}

    if result.get("error"):
        raise RuntimeError(f"Spotify authorization failed: {result['error']}")

    if result.get("state") != state:
        raise RuntimeError("Spotify OAuth state did not match. Authorization aborted.")

    code = result.get("code")
    if not code:
        raise RuntimeError("Spotify did not return an authorization code.")

    return exchange_code_for_token(client_id, client_secret, code)


def get_valid_token(client_id: str, client_secret: str) -> dict:
    token = load_token()

    if token is None:
        if get_token_backend() == "dynamodb":
            raise RuntimeError(
                "No Spotify OAuth token exists in DynamoDB. "
                "Bootstrap StateKey 'spotify-oauth-token' before running in Lambda."
            )

        return authorize(client_id, client_secret)

    # A bootstrap row contains only refresh_token and therefore no expires_at.
    # That intentionally forces an immediate refresh on the first Lambda run.
    if int(token.get("expires_at", 0)) <= int(time.time()) + 60:
        token = refresh_access_token(client_id, client_secret, token)

    return token


def spotify_get(url: str, access_token: str) -> requests.Response:
    return requests.get(
        url,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=20,
    )


def resolve_context_name(
    context: dict | None,
    access_token: str,
    item: dict,
) -> str | None:
    if not context:
        return None

    context_type = context.get("type")

    if context_type == "album":
        album = item.get("album") or {}
        if album.get("name"):
            return album["name"]

    href = context.get("href")
    if href:
        response = spotify_get(href, access_token)
        if response.ok:
            obj = response.json()
            if obj.get("name"):
                return obj["name"]

    context_url = (context.get("external_urls") or {}).get("spotify")
    if context_url:
        try:
            response = requests.get(
                OEMBED_URL,
                params={"url": context_url},
                timeout=20,
            )
            if response.ok:
                obj = response.json()
                if obj.get("title"):
                    return obj["title"]
        except requests.RequestException:
            pass

    return None


def normalize_playback(
    playback: dict,
    access_token: str,
) -> PlaybackSnapshot | None:
    item = playback.get("item")
    if not item:
        return None

    item_type = playback.get("currently_playing_type", "unknown")
    item_id = item.get("id")

    if item_type == "track":
        title = item.get("name", "(unknown track)")
        artist = ", ".join(
            entry.get("name", "")
            for entry in item.get("artists", [])
            if entry.get("name")
        )
        album = (item.get("album") or {}).get("name")
    elif item_type == "episode":
        title = item.get("name", "(unknown episode)")
        artist = (item.get("show") or {}).get("name", "")
        album = None
    else:
        title = item.get("name", "(unknown item)")
        artist = ""
        album = None

    context = playback.get("context")
    context_type = context.get("type") if context else None
    context_url = ((context or {}).get("external_urls") or {}).get("spotify")
    context_name = resolve_context_name(context, access_token, item)

    return PlaybackSnapshot(
        is_playing=bool(playback.get("is_playing", False)),
        item_type=item_type,
        item_id=item_id,
        title=title,
        artist=artist,
        album=album,
        item_url=(item.get("external_urls") or {}).get("spotify"),
        context_type=context_type,
        context_name=context_name,
        context_url=context_url,
    )


def get_current_playback() -> PlaybackSnapshot | None:
    credentials = get_spotify_app_credentials()

    token = get_valid_token(
        credentials.client_id,
        credentials.client_secret,
    )
    access_token = token["access_token"]

    response = spotify_get(CURRENTLY_PLAYING_URL, access_token)

    if response.status_code == 401:
        token = refresh_access_token(
            credentials.client_id,
            credentials.client_secret,
            token,
        )
        access_token = token["access_token"]
        response = spotify_get(CURRENTLY_PLAYING_URL, access_token)

    if response.status_code == 204:
        return None

    response.raise_for_status()
    return normalize_playback(response.json(), access_token)
