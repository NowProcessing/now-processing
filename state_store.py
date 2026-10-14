"""
Tiny local state store for change detection.

For local development this is just a JSON file. When we move to AWS Lambda,
the same responsibility can be swapped to DynamoDB without changing the
Spotify or formatting code.
"""

import json
from pathlib import Path


STATE_FILE = Path(__file__).with_name(".now_processing_state.json")


# Read the last handled playback fingerprint; a missing or damaged state file
# simply behaves like a first run.
def load_last_fingerprint() -> str | None:
    if not STATE_FILE.exists():
        return None

    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return state.get("last_fingerprint")
    except (json.JSONDecodeError, OSError):
        return None


# Save only the minimum state needed to avoid publishing the same playback
# status repeatedly on every scheduled poll.
def save_last_fingerprint(fingerprint: str) -> None:
    STATE_FILE.write_text(
        json.dumps(
            {"last_fingerprint": fingerprint},
            indent=2,
        ),
        encoding="utf-8",
    )
