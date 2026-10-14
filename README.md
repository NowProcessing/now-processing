# Now Processing

Personal, non-commercial automation that displays my current Spotify playback
information in a single Reddit profile post.

## Project status

The Spotify proof of concept is working locally. The current application phase
reads Spotify playback, resolves playlist/context information, formats the
future Reddit Markdown, and performs local change detection.

Reddit publishing is currently held in **dry-run mode** while Data API access is
pending.

## Intended Reddit API use

The application is intentionally narrow:

- Authenticate as the owner's own Reddit account.
- Edit one existing text post owned by that account.
- Update it only when the displayed Spotify playback state changes.
- Do not scrape Reddit content.
- Do not read or profile other Reddit users.
- Do not vote, comment, message users, or perform moderation actions.
- Do not create repeated "now playing" posts.

The goal is to maintain one persistent profile status instead of generating
feed spam.

## Current architecture

```text
Spotify Web API
      |
      v
spotify_client.py
      |
      v
PlaybackSnapshot
      |
      +----> state_store.py ----> changed?
      |
      v
status_formatter.py
      |
      v
Reddit-style Markdown
      |
      v
dry-run console output

Future:
dry-run output -> Reddit API -> edit one existing profile post
```

## Files

- `spotify_now_processing_test_v3.py` - original working Spotify proof of concept.
- `spotify_client.py` - Spotify OAuth, token refresh, playback lookup, and normalization.
- `status_formatter.py` - creates the Reddit-style Markdown.
- `state_store.py` - local JSON change detection used during development.
- `now_processing.py` - application entry point and dry-run orchestration.
- `requirements.txt` - Python package dependency list.

## Local setup

Python 3.10+ is recommended.

Install dependencies:

```powershell
py -m pip install -r .\requirements.txt
```

Set Spotify credentials for the current PowerShell session:

```powershell
$env:SPOTIFY_CLIENT_ID = "YOUR_CLIENT_ID"
$env:SPOTIFY_CLIENT_SECRET = "YOUR_CLIENT_SECRET"
```

The Spotify Developer Dashboard redirect URI must be:

```text
http://127.0.0.1:8888/callback
```

Run one polling cycle:

```powershell
py .\now_processing.py
```

Force the Markdown preview even when the current track has not changed:

```powershell
py .\now_processing.py --force
```

## Local private files

These are deliberately excluded from GitHub by `.gitignore`:

- `.spotify_token.json` - Spotify OAuth access/refresh token data.
- `.now_processing_state.json` - last processed playback fingerprint.
- `.env` - reserved for local secrets/configuration if used later.
- `*.token` - generic token files.

Never commit OAuth tokens, client secrets, AWS credentials, or other private
configuration to this repository.

## Planned AWS deployment

Once the local application flow is stable, the intended serverless design is:

```text
EventBridge Scheduler
        |
        v
AWS Lambda
        |
        +---- Spotify Web API
        |
        +---- persistent state (likely DynamoDB)
        |
        +---- secrets/configuration
        |
        v
Reddit API
```

The Lambda will wake on a schedule, check Spotify, do nothing when the visible
state is unchanged, and edit the single Reddit post when a meaningful change is
detected.
