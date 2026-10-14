"""
Spotify API client for Now Processing.

This module owns Spotify-specific work:
- OAuth authorization and refresh-token handling.
- Reading the currently playing item.
- Resolving the playback context into a friendly name.
- Returning a small normalized PlaybackSnapshot for the rest of the app.
"""

from dataclasses import dataclass
import base64
import json
import os
from pathlib import Path
import secrets
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

import requests


# Keep Spotify URLs and OAuth settings in one place so API details do not leak
# throughout the rest of the application.
REDIRECT_URI = "http://127.0.0.1:8888/callback"
SCOPES = [
    "user-read-currently-playing",
    "user-read-playback-state",
    "playlist-read-private",
]
TOKEN_FILE = Path(__file__).with_name(".spotify_token.json")

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
CURRENTLY_PLAYING_URL = "https://api.spotify.com/v1/me/player/currently-playing"
OEMBED_URL = "https://open.spotify.com/oembed"


@dataclass(frozen=True)
class PlaybackSnapshot:
    """Small, app-friendly representation of Spotify's much larger response."""

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
        # Build a compact value that changes when the visible playback state changes.
        return "|".join(
            [
                "playing" if self.is_playing else "paused",
                self.item_type or "",
                self.item_id or "",
                self.context_type or "",
                self.context_url or "",
            ]
        )


# Read required secrets from environment variables instead of putting them in
# source code, which keeps the GitHub repository safe to publish.
def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Environment variable {name} is not set.")
    return value


# Persist Spotify's token response locally during development so the browser
# authorization step is normally needed only once.
def save_token(token: dict) -> None:
    token["expires_at"] = int(time.time()) + int(token.get("expires_in", 3600))
    TOKEN_FILE.write_text(json.dumps(token, indent=2), encoding="utf-8")


# Load the locally cached OAuth token when one already exists.
def load_token() -> dict | None:
    if not TOKEN_FILE.exists():
        return None
    return json.loads(TOKEN_FILE.read_text(encoding="utf-8"))


# Spotify's token endpoint expects the client ID and secret as HTTP Basic auth.
def token_auth_header(client_id: str, client_secret: str) -> str:
    raw = f"{client_id}:{client_secret}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


# Exchange the one-time browser authorization code for access and refresh tokens.
def exchange_code_for_token(client_id: str, client_secret: str, code: str) -> dict:
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
    save_token(token)
    return token


# Refresh an expired Spotify access token without asking the user to authorize
# again in the browser.
def refresh_access_token(client_id: str, client_secret: str, token: dict) -> dict:
    refresh_token = token.get("refresh_token")
    if not refresh_token:
        raise RuntimeError(
            "No Spotify refresh token is available. "
            "Delete .spotify_token.json and authorize again."
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

    # Spotify does not always issue a replacement refresh token, so preserve
    # the existing one when it is omitted from the refresh response.
    if "refresh_token" not in refreshed:
        refreshed["refresh_token"] = refresh_token

    save_token(refreshed)
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
            "<p>You can close this browser tab and return to PowerShell.</p>"
            "</body></html>"
        ).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # Silence the local callback server's normal request logging.
    def log_message(self, format: str, *args) -> None:
        pass


# Run Spotify's browser-based Authorization Code flow and return the token once
# the local callback receives Spotify's response.
def authorize(client_id: str, client_secret: str) -> dict:
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


# Load the cached token and refresh it when needed; if no token exists, perform
# the browser authorization flow once.
def get_valid_token(client_id: str, client_secret: str) -> dict:
    token = load_token()

    if token is None:
        return authorize(client_id, client_secret)

    if int(token.get("expires_at", 0)) <= int(time.time()) + 60:
        token = refresh_access_token(client_id, client_secret, token)

    return token


# Wrap authenticated Spotify GET requests so the same Authorization header does
# not have to be rebuilt in multiple places.
def spotify_get(url: str, access_token: str) -> requests.Response:
    return requests.get(
        url,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=20,
    )


# Resolve a friendly playback-context name, using Spotify oEmbed as a fallback
# when the normal Web API endpoint is restrictive.
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


# Convert Spotify's large currently-playing response into the small consistent
# PlaybackSnapshot used by the formatter, state store, and future Reddit client.
def normalize_playback(playback: dict, access_token: str) -> PlaybackSnapshot | None:
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


# Fetch live playback, retry once after refreshing a rejected token, and return
# None when Spotify reports no active playable item.
def get_current_playback() -> PlaybackSnapshot | None:
    client_id = require_env("SPOTIFY_CLIENT_ID")
    client_secret = require_env("SPOTIFY_CLIENT_SECRET")

    token = get_valid_token(client_id, client_secret)
    access_token = token["access_token"]

    response = spotify_get(CURRENTLY_PLAYING_URL, access_token)

    if response.status_code == 401:
        token = refresh_access_token(client_id, client_secret, token)
        access_token = token["access_token"]
        response = spotify_get(CURRENTLY_PLAYING_URL, access_token)

    if response.status_code == 204:
        return None

    response.raise_for_status()
    return normalize_playback(response.json(), access_token)
