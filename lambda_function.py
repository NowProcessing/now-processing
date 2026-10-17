"""
AWS Lambda entry point for the current Now Processing integration phase.

Temporary test modes:
- state       -> validate DynamoDB-backed application state.
- credentials -> validate Spotify app credentials from Secrets Manager.
- token-store -> validate Spotify OAuth token persistence in DynamoDB.

No secret/token values are returned by these diagnostics.
"""

from spotify_credentials import get_spotify_app_credentials
from spotify_token_store import get_token_status
from state_store import (
    get_backend,
    get_table_name,
    load_last_fingerprint,
    save_last_fingerprint,
)


TEST_STATE_KEY = "lambda-state-test"


def test_spotify_credentials() -> dict:
    credentials = get_spotify_app_credentials()

    return {
        "statusCode": 200,
        "test": "spotify-credentials",
        "clientIdPresent": bool(credentials.client_id),
        "clientSecretPresent": bool(credentials.client_secret),
        "secretValuesReturned": False,
    }


def test_spotify_token_store() -> dict:
    status = get_token_status()

    return {
        "statusCode": 200,
        "test": "spotify-token-store",
        **status,
    }


def test_state(event, context) -> dict:
    requested_fingerprint = event.get("fingerprint")

    if not requested_fingerprint:
        requested_fingerprint = f"lambda-request:{context.aws_request_id}"

    previous_fingerprint = load_last_fingerprint(TEST_STATE_KEY)
    save_last_fingerprint(requested_fingerprint, TEST_STATE_KEY)
    confirmed_fingerprint = load_last_fingerprint(TEST_STATE_KEY)

    return {
        "statusCode": 200,
        "test": "state",
        "backend": get_backend(),
        "table": get_table_name(),
        "stateKey": TEST_STATE_KEY,
        "previousFingerprint": previous_fingerprint,
        "writtenFingerprint": requested_fingerprint,
        "confirmedFingerprint": confirmed_fingerprint,
        "writeConfirmed": confirmed_fingerprint == requested_fingerprint,
    }


def lambda_handler(event, context):
    mode = event.get("mode", "state")

    if mode == "credentials":
        return test_spotify_credentials()

    if mode == "token-store":
        return test_spotify_token_store()

    if mode == "state":
        return test_state(event, context)

    return {
        "statusCode": 400,
        "error": f"Unsupported test mode: {mode}",
    }
