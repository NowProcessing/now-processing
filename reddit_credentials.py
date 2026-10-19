"""
Reddit application credential provider for Now Processing.

Local development:
    REDDIT_CLIENT_ID
    REDDIT_CLIENT_SECRET
    REDDIT_REFRESH_TOKEN
    REDDIT_USER_AGENT

AWS Lambda:
    AWS Secrets Manager secret named NowProcessing/RedditApp by default.

Expected JSON secret:
{
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "...",
  "user_agent": "..."
}
"""

from dataclasses import dataclass
import json
import os


DEFAULT_SECRET_ID = "NowProcessing/RedditApp"
SECRET_ID_ENV = "REDDIT_SECRET_ID"


@dataclass(frozen=True)
class RedditCredentials:
    client_id: str
    client_secret: str
    refresh_token: str
    user_agent: str


_cached_aws_credentials: RedditCredentials | None = None


def running_in_lambda() -> bool:
    return bool(os.environ.get("AWS_LAMBDA_FUNCTION_NAME"))


def _validate(values: dict, source: str) -> RedditCredentials:
    required = ("client_id", "client_secret", "refresh_token", "user_agent")
    missing = [key for key in required if not values.get(key)]

    if missing:
        raise RuntimeError(
            f"Reddit credentials from {source} are missing: "
            + ", ".join(missing)
        )

    return RedditCredentials(
        client_id=values["client_id"],
        client_secret=values["client_secret"],
        refresh_token=values["refresh_token"],
        user_agent=values["user_agent"],
    )


def _load_local_credentials() -> RedditCredentials:
    return _validate(
        {
            "client_id": os.environ.get("REDDIT_CLIENT_ID"),
            "client_secret": os.environ.get("REDDIT_CLIENT_SECRET"),
            "refresh_token": os.environ.get("REDDIT_REFRESH_TOKEN"),
            "user_agent": os.environ.get("REDDIT_USER_AGENT"),
        },
        "environment variables",
    )


def _load_aws_credentials() -> RedditCredentials:
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
        values = json.loads(secret_string)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Secrets Manager secret '{secret_id}' is not valid JSON."
        ) from exc

    _cached_aws_credentials = _validate(
        values,
        f"Secrets Manager secret '{secret_id}'",
    )
    return _cached_aws_credentials


def get_reddit_credentials() -> RedditCredentials:
    if running_in_lambda():
        return _load_aws_credentials()

    return _load_local_credentials()
