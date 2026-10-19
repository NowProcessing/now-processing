"""
Publishing adapter for Now Processing.

Current behavior:
    dry-run -> print the exact Markdown that would be sent to Reddit.

Future behavior:
    reddit  -> edit the one configured Reddit profile post.

Keeping this behind one public function means the application orchestration
does not need to change when Reddit publishing is enabled.
"""

from dataclasses import dataclass
import os


PUBLISHER_ENV = "NOW_PROCESSING_PUBLISHER"
DEFAULT_PUBLISHER = "dry-run"


@dataclass(frozen=True)
class PublishResult:
    """Small result object returned after a successful publish operation."""

    backend: str
    published: bool


# Keep backend selection explicit and fail closed if an unsupported value is
# supplied. Until Reddit authentication is implemented, dry-run is the only
# valid production behavior.
def get_publisher_backend() -> str:
    backend = os.environ.get(PUBLISHER_ENV, DEFAULT_PUBLISHER).strip().lower()

    if backend not in {"dry-run", "reddit"}:
        raise RuntimeError(
            f"Unsupported publisher backend '{backend}'. "
            "Expected 'dry-run' or 'reddit'."
        )

    return backend


# Preserve the exact dry-run presentation already used during local and Lambda
# validation so this refactor does not change observable behavior.
def _publish_dry_run(markdown: str) -> PublishResult:
    print("\n" + "=" * 70)
    print("DRY RUN - WOULD PUBLISH THIS STATUS")
    print("=" * 70)
    print(markdown)
    print("=" * 70)

    return PublishResult(
        backend="dry-run",
        published=True,
    )


# Reddit API work deliberately remains isolated here. Enabling the backend
# before credentials/API support exist should fail loudly rather than silently
# pretending a status was published.
def _publish_reddit(markdown: str) -> PublishResult:
    raise RuntimeError(
        "Reddit publishing is not implemented yet. "
        "Leave NOW_PROCESSING_PUBLISHER unset or set it to 'dry-run'."
    )


# Public publishing interface used by now_processing.py.
def publish_status(markdown: str) -> PublishResult:
    backend = get_publisher_backend()

    if backend == "reddit":
        return _publish_reddit(markdown)

    return _publish_dry_run(markdown)
