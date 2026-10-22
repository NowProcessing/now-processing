# Now Processing

Now Processing is a Reddit Developer Platform app that publishes the current
Spotify playback state to a single app-owned Reddit post.

Instead of creating a new Reddit post for every song, the app maintains one
status post and updates its contents only when Spotify playback meaningfully
changes.

## Runtime

The Devvit implementation runs entirely on Reddit's hosted Developer Platform.

```text
Devvit Scheduler
      ↓
Spotify Web API
      ↓
Playback normalization
      ↓
Redis change detection
      ↓
Reddit status-post create/edit