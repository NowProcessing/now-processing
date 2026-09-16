#!/usr/bin/env python3
"""
Now Processing - Spotify proof of concept

What this does:
1. Authenticates your Spotify account with OAuth Authorization Code flow.
2. Stores the resulting token locally in .spotify_token.json.
3. Refreshes the access token automatically when needed.
4. Reads your currently playing Spotify item.
5. If the playback context is a playlist, resolves and prints the playlist name.

Before running, set these environment variables:
    SPOTIFY_CLIENT_ID
    SPOTIFY_CLIENT_SECRET

The redirect URI configured in the Spotify Developer Dashboard must be:
    http://127.0.0.1:8888/callback
"""

import base64
import json
import os
import secrets
import sys
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

# Force UTF-8 console output so playlist names containing emoji or other
# Unicode characters do not crash on Windows consoles using legacy code pages.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

import requests


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


def require_env(name):
    value = os.environ.get(name)
    if not value:
        print(f"ERROR: Environment variable {name} is not set.")
        sys.exit(1)
    return value


def save_token(token):
    token["expires_at"] = int(time.time()) + int(token.get("expires_in", 3600))
    TOKEN_FILE.write_text(json.dumps(token, indent=2), encoding="utf-8")


def load_token():
    if not TOKEN_FILE.exists():
        return None
    return json.loads(TOKEN_FILE.read_text(encoding="utf-8"))


def token_auth_header(client_id, client_secret):
    raw = f"{client_id}:{client_secret}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def exchange_code_for_token(client_id, client_secret, code):
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


def refresh_access_token(client_id, client_secret, token):
    refresh_token = token.get("refresh_token")
    if not refresh_token:
        raise RuntimeError("No Spotify refresh token is available. Delete .spotify_token.json and authorize again.")

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

    # Spotify may not return a new refresh_token every time.
    if "refresh_token" not in refreshed:
        refreshed["refresh_token"] = refresh_token

    save_token(refreshed)
    return refreshed


class OAuthCallbackHandler(BaseHTTPRequestHandler):
    result = None

    def do_GET(self):
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

    def log_message(self, format, *args):
        # Keep the local callback quiet.
        pass


def authorize(client_id, client_secret):
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


def get_valid_token(client_id, client_secret):
    token = load_token()

    if token is None:
        return authorize(client_id, client_secret)

    # Refresh about one minute before actual expiration.
    if int(token.get("expires_at", 0)) <= int(time.time()) + 60:
        token = refresh_access_token(client_id, client_secret, token)

    return token


def spotify_get(url, access_token):
    response = requests.get(
        url,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=20,
    )
    return response


def resolve_context_name(context, access_token, item):
    """
    Resolve a human-readable name for the current playback context.

    Resolution order:
      1. Album name already present in the currently-playing response.
      2. Spotify Web API context href.
      3. Spotify oEmbed lookup using the public Spotify context URL.

    The oEmbed fallback is especially useful for Spotify-owned/editorial
    playlists where Development Mode API behavior may be more restrictive.
    """
    if not context:
        return None, None

    context_type = context.get("type")

    # For albums, the current track already carries the album name.
    if context_type == "album" and isinstance(item, dict):
        album = item.get("album") or {}
        if album.get("name"):
            return album["name"], "currently-playing response"

    # First try the normal Web API context endpoint.
    href = context.get("href")
    if href:
        response = spotify_get(href, access_token)
        if response.ok:
            obj = response.json()
            if obj.get("name"):
                return obj["name"], "Spotify Web API"

    # Fallback: Spotify's public oEmbed endpoint can resolve a Spotify URL
    # to basic metadata such as the entity title.
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
                    return obj["title"], "Spotify oEmbed"
        except requests.RequestException:
            pass

    return None, None


def main():
    client_id = require_env("SPOTIFY_CLIENT_ID")
    client_secret = require_env("SPOTIFY_CLIENT_SECRET")

    try:
        token = get_valid_token(client_id, client_secret)
        access_token = token["access_token"]

        response = spotify_get(CURRENTLY_PLAYING_URL, access_token)

        # Retry once after a token refresh if Spotify rejects the token.
        if response.status_code == 401:
            token = refresh_access_token(client_id, client_secret, token)
            access_token = token["access_token"]
            response = spotify_get(CURRENTLY_PLAYING_URL, access_token)

        if response.status_code == 204:
            print("\nSpotify reports that nothing is currently playing.")
            return

        response.raise_for_status()
        playback = response.json()

        item = playback.get("item")
        if not item:
            print("\nSpotify returned playback state, but no playable item.")
            return

        item_type = playback.get("currently_playing_type", "unknown")
        is_playing = playback.get("is_playing", False)

        if item_type == "track":
            title = item.get("name", "(unknown track)")
            artists = ", ".join(a.get("name", "") for a in item.get("artists", []) if a.get("name"))
            album = (item.get("album") or {}).get("name")
        elif item_type == "episode":
            title = item.get("name", "(unknown episode)")
            artists = (item.get("show") or {}).get("name", "")
            album = None
        else:
            title = item.get("name", "(unknown item)")
            artists = ""
            album = None

        track_url = (item.get("external_urls") or {}).get("spotify")

        context = playback.get("context")
        context_type = context.get("type") if context else None
        context_url = ((context or {}).get("external_urls") or {}).get("spotify")
        context_name, context_name_source = resolve_context_name(context, access_token, item)

        print("\n" + "=" * 62)
        print("NOW PROCESSING - SPOTIFY PROOF OF CONCEPT")
        print("=" * 62)
        print(f"Status:       {'PLAYING' if is_playing else 'PAUSED'}")
        print(f"Type:         {item_type}")
        print(f"Title:        {title}")
        if artists:
            print(f"Artist/Show:  {artists}")
        if album:
            print(f"Album:        {album}")
        print(f"Track URL:    {track_url or '(not supplied)'}")
        print()
        print(f"Context type: {context_type or '(none)'}")
        print(f"Context name: {context_name or '(Spotify did not expose/resolution failed)'}")
        print(f"Resolved via: {context_name_source or '(not resolved)'}")
        print(f"Context URL:  {context_url or '(none)'}")
        print("=" * 62)

        if context_type != "playlist":
            print("\nNOTE: This item is not currently playing from a playlist context.")
            print("For our Reddit version, we can display the actual context type instead.")

    except requests.HTTPError as exc:
        response = exc.response
        print("\nSpotify API request failed.")
        if response is not None:
            print(f"HTTP status: {response.status_code}")
            try:
                print(json.dumps(response.json(), indent=2))
            except Exception:
                print(response.text)
        else:
            print(str(exc))
        sys.exit(1)
    except Exception as exc:
        print(f"\nERROR: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
