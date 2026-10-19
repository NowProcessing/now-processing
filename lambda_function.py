"""
AWS Lambda entry point for Now Processing.

EventBridge Scheduler invokes this function periodically. Each invocation runs
one normal application polling cycle:

Spotify -> change detection -> Markdown formatting -> dry-run output -> state

Until Reddit publishing is available, a changed status is written to the
Lambda/CloudWatch log exactly as the local dry run prints it.
"""

from now_processing import run_once


# Keep the AWS entry point deliberately thin. The actual application workflow
# remains in now_processing.py so local execution and Lambda execute the same
# orchestration instead of maintaining two copies of the business logic.
def lambda_handler(event, context):
    # Scheduled invocations use an empty event and therefore force=False.
    # A manual Lambda test may pass {"force": true} to preview the current
    # Markdown even when the playback fingerprint has not changed.
    force = bool(event.get("force", False)) if isinstance(event, dict) else False

    result_code = run_once(force=force)

    # run_once currently returns 0 for every successfully handled cycle.
    # Unexpected exceptions are deliberately allowed to escape so Lambda marks
    # the invocation failed and Scheduler/CloudWatch can surface the problem.
    if result_code != 0:
        raise RuntimeError(
            f"Now Processing run_once returned unexpected result code {result_code}."
        )

    return {
        "statusCode": 200,
        "mode": "scheduled-dry-run",
        "force": force,
        "requestId": getattr(context, "aws_request_id", None),
    }
