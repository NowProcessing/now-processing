"""
Turn a PlaybackSnapshot into the Markdown that will eventually become the
single pinned Reddit profile post.
"""

from datetime import datetime, timezone

from spotify_client import PlaybackSnapshot


# Give each Spotify context type a readable label so album, artist, and playlist
# playback still produce useful output without pretending everything is a playlist.
def context_label(snapshot: PlaybackSnapshot) -> str:
    labels = {
        "playlist": "Playing from playlist",
        "album": "Playing from album",
        "artist": "Playing from artist",
        "show": "Playing from show",
    }
    return labels.get(snapshot.context_type or "", "Playing from")


# Build public-facing Markdown independently of Spotify and Reddit API code so
# presentation changes do not require touching authentication code.
def format_status(snapshot: PlaybackSnapshot) -> str:
    lines: list[str] = [
        "## 🎧 Now Processing",
        "",
        f"**{snapshot.title}**",
    ]

    if snapshot.artist:
        lines.append(f"*{snapshot.artist}*")

    lines.append("")

    if snapshot.album:
        lines.append(f"**Album:** {snapshot.album}")

    if snapshot.context_name:
        label = context_label(snapshot)
        if snapshot.context_url:
            lines.append(
                f"**{label}:** [{snapshot.context_name}]({snapshot.context_url})"
            )
        else:
            lines.append(f"**{label}:** {snapshot.context_name}")

    if snapshot.item_url:
        lines.extend(
            [
                "",
                f"[Listen on Spotify]({snapshot.item_url})",
            ]
        )

    # Record when this status was generated; the app does not rewrite the post
    # every minute when nothing meaningful has changed.
    updated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines.extend(
        [
            "",
            "---",
            f"*Updated {updated}*",
        ]
    )

    return "\n".join(lines)
