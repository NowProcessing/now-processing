"""
Spotify OAuth token persistence for Now Processing.

Local development:
    Read/write .spotify_token.json beside the application.

AWS Lambda:
    Read/write the OAuth token in the existing NowProcessingState DynamoDB table.

The public interface is deliberately tiny:
    load_token()
    save_token(token)

That keeps Spotify API logic independent from where token state is persisted.
"""

from datetime import datetime, timezone
import json
import os
from pathlib import Path


TOKEN_FILE = Path(__file__).with_name(".spotify_token.json")
DEFAULT_TABLE_NAME = "NowProcessingState"
DEFAULT_STATE_KEY = "spotify-oauth-token"
TABLE_ENV = "NOW_PROCESSING_STATE_TABLE"
TOKEN_BACKEND_ENV = "NOW_PROCESSING_TOKEN_BACKEND"


def get_token_backend() -> str:
    explicit = os.environ.get(TOKEN_BACKEND_ENV)

    if explicit:
        backend = explicit.strip().lower()
    elif os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
        backend = "dynamodb"
    else:
        backend = "local"

    if backend not in {"local", "dynamodb"}:
        raise RuntimeError(
            f"Unsupported Spotify token backend '{backend}'. "
            "Expected 'local' or 'dynamodb'."
        )

    return backend


def get_table_name() -> str:
    return os.environ.get(TABLE_ENV, DEFAULT_TABLE_NAME)


def get_state_key() -> str:
    return DEFAULT_STATE_KEY


def _load_local_token() -> dict | None:
    if not TOKEN_FILE.exists():
        return None

    return json.loads(TOKEN_FILE.read_text(encoding="utf-8"))


def _save_local_token(token: dict) -> None:
    TOKEN_FILE.write_text(
        json.dumps(token, indent=2),
        encoding="utf-8",
    )


def _get_dynamodb_table():
    try:
        import boto3
    except ImportError as exc:
        raise RuntimeError(
            "DynamoDB token storage requires boto3. "
            "AWS Lambda includes boto3 automatically."
        ) from exc

    return boto3.resource("dynamodb").Table(get_table_name())


def _load_dynamodb_token() -> dict | None:
    table = _get_dynamodb_table()

    response = table.get_item(
        Key={"StateKey": get_state_key()},
        ConsistentRead=True,
    )

    item = response.get("Item")
    if not item:
        return None

    token_json = item.get("TokenJson")
    if token_json:
        try:
            token = json.loads(token_json)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                "Stored Spotify TokenJson in DynamoDB is not valid JSON."
            ) from exc

        if not isinstance(token, dict):
            raise RuntimeError(
                "Stored Spotify TokenJson must decode to a JSON object."
            )

        return token

    # Bootstrap format: create one row with only RefreshToken. The first
    # successful refresh replaces it with the normal TokenJson representation.
    refresh_token = item.get("RefreshToken")
    if refresh_token:
        return {"refresh_token": refresh_token}

    return None


def _save_dynamodb_token(token: dict) -> None:
    table = _get_dynamodb_table()

    table.put_item(
        Item={
            "StateKey": get_state_key(),
            "TokenJson": json.dumps(
                token,
                separators=(",", ":"),
                ensure_ascii=False,
            ),
            "UpdatedAt": datetime.now(timezone.utc).isoformat(),
        }
    )


def load_token() -> dict | None:
    if get_token_backend() == "dynamodb":
        return _load_dynamodb_token()

    return _load_local_token()


def save_token(token: dict) -> None:
    if get_token_backend() == "dynamodb":
        _save_dynamodb_token(token)
        return

    _save_local_token(token)


def get_token_status() -> dict:
    token = load_token()

    return {
        "backend": get_token_backend(),
        "table": get_table_name() if get_token_backend() == "dynamodb" else None,
        "stateKey": get_state_key(),
        "tokenFound": token is not None,
        "refreshTokenPresent": bool((token or {}).get("refresh_token")),
        "accessTokenPresent": bool((token or {}).get("access_token")),
        "expiresAtPresent": bool((token or {}).get("expires_at")),
        "secretValuesReturned": False,
    }
