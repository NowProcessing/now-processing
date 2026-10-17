"""
Spotify application credential provider for Now Processing.

Local development:
    Read SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET from the shell environment.

AWS Lambda:
    Read a JSON secret from AWS Secrets Manager.

This keeps environment-specific credential storage out of the core Spotify
integration code.
"""

from dataclasses import dataclass
import json
import os


# Use one predictable project secret by default. The Lambda environment can
# override this later without requiring a code change.
DEFAULT_SECRET_ID = "NowProcessing/SpotifyApp"
SECRET_ID_ENV = "SPOTIFY_SECRET_ID"


@dataclass(frozen=True)
class SpotifyAppCredentials:
    """Credentials that identify the Now Processing application to Spotify."""

    client_id: str
    client_secret: str


# A warm Lambda execution environment may be reused. Cache the secret after the
# first successful read so subsequent invocations avoid an unnecessary API call.
_cached_aws_credentials: SpotifyAppCredentials | None = None


# Lambda supplies this environment variable automatically. Local development
# does not, so it provides a simple runtime distinction.
def running_in_lambda() -> bool:
    return bool(os.environ.get("AWS_LAMBDA_FUNCTION_NAME"))


# Local runs continue using temporary environment variables, preserving the
# workflow already used successfully from PowerShell / VS Code.
def _load_local_credentials() -> SpotifyAppCredentials:
    client_id = os.environ.get("SPOTIFY_CLIENT_ID")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET")

    if not client_id:
        raise RuntimeError("Environment variable SPOTIFY_CLIENT_ID is not set.")

    if not client_secret:
        raise RuntimeError("Environment variable SPOTIFY_CLIENT_SECRET is not set.")

    return SpotifyAppCredentials(
        client_id=client_id,
        client_secret=client_secret,
    )


# Lambda reads the Spotify app credentials from one JSON-formatted Secrets
# Manager secret. Secret values are never printed or logged by this module.
def _load_aws_credentials() -> SpotifyAppCredentials:
    global _cached_aws_credentials

    if _cached_aws_credentials is not None:
        return _cached_aws_credentials

    import boto3

    secret_id = os.environ.get(SECRET_ID_ENV, DEFAULT_SECRET_ID)

    client = boto3.client("secretsmanager")
    response = client.get_secret_value(SecretId=secret_id)

    secret_string = response.get("SecretString")
    if not secret_string:
        raise RuntimeError(
            f"Secrets Manager secret '{secret_id}' contains no SecretString."
        )

    try:
        secret = json.loads(secret_string)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Secrets Manager secret '{secret_id}' is not valid JSON."
        ) from exc

    client_id = secret.get("client_id")
    client_secret = secret.get("client_secret")

    if not client_id or not client_secret:
        raise RuntimeError(
            f"Secret '{secret_id}' must contain client_id and client_secret."
        )

    _cached_aws_credentials = SpotifyAppCredentials(
        client_id=client_id,
        client_secret=client_secret,
    )

    return _cached_aws_credentials


# Public interface used by spotify_client.py. Callers do not need to know
# whether the credentials came from the local shell or Secrets Manager.
def get_spotify_app_credentials() -> SpotifyAppCredentials:
    if running_in_lambda():
        return _load_aws_credentials()

    return _load_local_credentials()
