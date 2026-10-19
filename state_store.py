"""
State storage for Now Processing.

Local development uses a small JSON file.
AWS Lambda uses DynamoDB.

The rest of the application calls the same load/save functions regardless of
where the state is physically stored.
"""

from datetime import datetime, timezone
import json
import os
from pathlib import Path

STATE_FILE = Path(__file__).with_name(".now_processing_state.json")

DEFAULT_TABLE_NAME = "NowProcessingState"
DEFAULT_STATE_KEY = "spotify-playback"

BACKEND_ENV = "NOW_PROCESSING_STATE_BACKEND"
TABLE_ENV = "NOW_PROCESSING_STATE_TABLE"
STATE_KEY_ENV = "NOW_PROCESSING_STATE_KEY"


# Choose the storage backend automatically:
# - local computer -> JSON
# - AWS Lambda     -> DynamoDB
# An explicit NOW_PROCESSING_STATE_BACKEND value always wins.
def get_backend() -> str:
    explicit_backend = os.environ.get(BACKEND_ENV)

    if explicit_backend:
        backend = explicit_backend.strip().lower()
    elif os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
        backend = "dynamodb"
    else:
        backend = "local"

    if backend not in {"local", "dynamodb"}:
        raise ValueError(
            f"Unsupported state backend '{backend}'. "
            "Expected 'local' or 'dynamodb'."
        )

    return backend


# Resolve the DynamoDB table name while keeping the current project table as
# the default so Lambda needs minimal configuration.
def get_table_name() -> str:
    return os.environ.get(TABLE_ENV, DEFAULT_TABLE_NAME)


# Resolve the normal application state key. Tests may pass a different key so
# they never overwrite the real spotify-playback record.
def get_state_key(state_key: str | None = None) -> str:
    if state_key:
        return state_key

    return os.environ.get(STATE_KEY_ENV, DEFAULT_STATE_KEY)


# Produce one consistent UTC timestamp format for local JSON and DynamoDB.
def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


# Read local JSON state. The old lowercase field is still accepted so the
# previous local state file remains compatible.
def _load_local_fingerprint(state_key: str) -> str | None:
    if not STATE_FILE.exists():
        return None

    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None

    stored_key = state.get("StateKey")
    if stored_key and stored_key != state_key:
        return None

    return state.get("LastFingerprint") or state.get("last_fingerprint")


# Save local state using the same field names used in DynamoDB. Similar schemas
# make the two environments easier to compare while troubleshooting.
def _save_local_fingerprint(state_key: str, fingerprint: str) -> None:
    state = {
        "StateKey": state_key,
        "LastFingerprint": fingerprint,
        "UpdatedAt": utc_timestamp(),
    }

    STATE_FILE.write_text(
        json.dumps(state, indent=2),
        encoding="utf-8",
    )


# Import boto3 only when DynamoDB is used. Local runs do not need the AWS SDK
# merely to use the JSON state file.
def _get_dynamodb_table():
    try:
        import boto3
    except ImportError as exc:
        raise RuntimeError(
            "The DynamoDB backend requires boto3. "
            "AWS Lambda includes boto3 automatically."
        ) from exc

    dynamodb = boto3.resource("dynamodb")
    return dynamodb.Table(get_table_name())


# Fetch exactly one DynamoDB item by partition key instead of scanning the
# entire table.
def _load_dynamodb_fingerprint(state_key: str) -> str | None:
    table = _get_dynamodb_table()

    response = table.get_item(
        Key={"StateKey": state_key},
        ConsistentRead=True,
    )

    item = response.get("Item")
    if not item:
        return None

    return item.get("LastFingerprint")


# Reuse the same StateKey on each write so DynamoDB keeps one logical record
# rather than creating a new row every time the track changes.
def _save_dynamodb_fingerprint(state_key: str, fingerprint: str) -> None:
    table = _get_dynamodb_table()

    table.put_item(
        Item={
            "StateKey": state_key,
            "LastFingerprint": fingerprint,
            "UpdatedAt": utc_timestamp(),
        }
    )


# Public read function. Callers do not need to know where state is stored.
def load_last_fingerprint(state_key: str | None = None) -> str | None:
    resolved_key = get_state_key(state_key)
    backend = get_backend()

    if backend == "local":
        return _load_local_fingerprint(resolved_key)

    return _load_dynamodb_fingerprint(resolved_key)


# Public write function. Keeping the old call shape means now_processing.py can
# keep using save_last_fingerprint(snapshot.fingerprint) unchanged.
def save_last_fingerprint(
    fingerprint: str,
    state_key: str | None = None,
) -> None:
    resolved_key = get_state_key(state_key)
    backend = get_backend()

    if backend == "local":
        _save_local_fingerprint(resolved_key, fingerprint)
        return

    _save_dynamodb_fingerprint(resolved_key, fingerprint)
