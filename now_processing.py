#!/usr/bin/env python3
"""
Now Processing application entry point.

Application flow:
Spotify -> normalize -> change detection -> format -> publish -> persist state.

Publishing is delegated to reddit_client.py. The current publisher backend is
dry-run; the Reddit API implementation will later replace only that adapter.
"""

import argparse
import sys

import requests

from reddit_client import publish_status
from spotify_client import get_current_playback
from state_store import load_last_fingerprint, save_last_fingerprint
from status_formatter import format_status


# Ask Python to emit UTF-8 when the host console supports reconfiguration.
# Windows PowerShell may still need a UTF-8 code page to render emoji perfectly.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


# Keep command-line behavior small but provide --force for previewing the
# formatter even when Spotify playback has not changed.
def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the Now Processing status from current Spotify playback."
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Publish the current status even when playback has not changed.",
    )
    return parser.parse_args()


# Orchestrate one polling cycle. State is saved only after the publisher returns
# successfully, so a future Reddit API failure will not incorrectly mark a track
# as already handled.
def run_once(force: bool = False) -> int:
    snapshot = get_current_playback()

    if snapshot is None:
        print("Spotify reports no currently playable item. Nothing to publish.")
        return 0

    previous_fingerprint = load_last_fingerprint()
    changed = snapshot.fingerprint != previous_fingerprint

    if not changed and not force:
        print(
            f"No meaningful playback change: "
            f"{snapshot.title} - {snapshot.artist or '(unknown artist)'}"
        )
        return 0

    markdown = format_status(snapshot)
    publish_status(markdown)

    # Persist the fingerprint only after publishing succeeds. This is important
    # once the dry-run publisher is replaced by a real Reddit API call.
    save_last_fingerprint(snapshot.fingerprint)

    return 0


# Keep top-level error handling readable so normal module functions can focus
# on their own jobs instead of duplicating console reporting logic.
def main() -> int:
    args = parse_args()

    try:
        return run_once(force=args.force)
    except requests.HTTPError as exc:
        response = exc.response
        print("\nSpotify API request failed.")

        if response is not None:
            print(f"HTTP status: {response.status_code}")
            try:
                print(response.json())
            except Exception:
                print(response.text)
        else:
            print(str(exc))

        return 1
    except Exception as exc:
        print(f"\nERROR: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
