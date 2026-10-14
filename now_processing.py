#!/usr/bin/env python3
"""
Now Processing application entry point.

Current phase:
Spotify -> normalize -> format -> change detection -> dry-run output.

Reddit publishing is deliberately not implemented yet because API approval is
still pending. The dry-run output shows exactly what would be sent later.
"""

import argparse
import sys

import requests

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
        help="Generate dry-run output even when playback has not changed.",
    )
    return parser.parse_args()


# For now, publishing means printing the exact Markdown that would be sent to
# Reddit. Later this can call a Reddit publisher without changing Spotify logic.
def dry_run_publish(markdown: str) -> None:
    print("\n" + "=" * 70)
    print("DRY RUN - WOULD PUBLISH THIS STATUS")
    print("=" * 70)
    print(markdown)
    print("=" * 70)


# Orchestrate one polling cycle: read Spotify, skip unchanged states, format a
# changed status, and record that it was handled successfully.
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
    dry_run_publish(markdown)

    # Treat a successful dry run like a successful publish so repeated local
    # polls demonstrate the same change-detection behavior Lambda will use.
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
