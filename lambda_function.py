"""
AWS Lambda entry point for the Now Processing AWS-state phase.

This is intentionally a state-only test harness for now. It proves that the
same state_store.py used locally can read/write DynamoDB.

The full Spotify polling call comes next, after Spotify credentials and the
refresh token are moved into AWS-safe persistent storage.
"""

from state_store import (
    get_backend,
    get_table_name,
    load_last_fingerprint,
    save_last_fingerprint,
)

TEST_STATE_KEY = "lambda-state-test"


def lambda_handler(event, context):
    # Let a test event supply a recognizable value. Otherwise use the AWS
    # request ID so every test invocation is easy to identify.
    requested_fingerprint = event.get("fingerprint")

    if not requested_fingerprint:
        requested_fingerprint = f"lambda-request:{context.aws_request_id}"

    # Read the prior value, write the new one, then read it back. This validates
    # GetItem and PutItem through the shared application state layer.
    previous_fingerprint = load_last_fingerprint(TEST_STATE_KEY)

    save_last_fingerprint(
        requested_fingerprint,
        TEST_STATE_KEY,
    )

    confirmed_fingerprint = load_last_fingerprint(TEST_STATE_KEY)

    # Return useful diagnostics directly in the Lambda Test result.
    return {
        "statusCode": 200,
        "backend": get_backend(),
        "table": get_table_name(),
        "stateKey": TEST_STATE_KEY,
        "previousFingerprint": previous_fingerprint,
        "writtenFingerprint": requested_fingerprint,
        "confirmedFingerprint": confirmed_fingerprint,
        "writeConfirmed": confirmed_fingerprint == requested_fingerprint,
    }
