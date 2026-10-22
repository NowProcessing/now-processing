import { Hono } from 'hono';
import { serve } from '@hono/node-server';

import {
  createServer,
  getServerPort,
  type TaskRequest,
  type TaskResponse,
} from '@devvit/web/server';

import {
  getCurrentSpotifyPlayback,
  resolveSpotifyPlaylistContext,
} from './spotify.js';

import {
  createPlaybackFingerprint,
  getLastPlaybackFingerprint,
  getStatusPostId,
  savePlaybackFingerprint,
  saveStatusPostId,
} from './state.js';

import {
  createStatusPost,
  editStatusPost,
  formatStatusPost,
} from './reddit_publisher.js';

/**
 * Now Processing Devvit server.
 *
 * Current runtime:
 *
 *   Scheduler
 *      ↓
 *   Spotify
 *      ↓
 *   Redis change detection
 *      ↓
 *   Format Reddit Markdown
 *      ↓
 *   Create OR edit one app-owned Reddit post
 *      ↓
 *   Save successful playback fingerprint
 */
const app = new Hono();

/**
 * Scheduled Now Processing poll.
 */
app.post('/internal/scheduler/heartbeat', async (c) => {
  await c.req.json<TaskRequest>();

  try {
    /**
     * Read Spotify.
     */
    const playback =
      await getCurrentSpotifyPlayback();

    const fingerprint =
      createPlaybackFingerprint(playback);

    /**
     * Read both pieces of persistent application state.
     */
    const [
      previousFingerprint,
      existingPostId,
    ] = await Promise.all([
      getLastPlaybackFingerprint(),
      getStatusPostId(),
    ]);

    /**
     * If playback is unchanged AND our Reddit status post already exists,
     * there is nothing to do.
     *
     * Notice that a missing post ID deliberately bypasses this check.
     * That lets a fresh installation create its first status post even if
     * Redis already knows the current Spotify fingerprint.
     */
    if (
      fingerprint === previousFingerprint &&
      existingPostId
    ) {
      console.log(
        '[Now Processing] Spotify: playback unchanged'
      );

      return c.json<TaskResponse>(
        {
          status: 'ok',
        },
        200
      );
    }

    /**
     * We only resolve playlist metadata after determining that Reddit
     * actually needs an update.
     */
    const publishPlayback =
      await resolveSpotifyPlaylistContext(
        playback
      );

    const body =
      formatStatusPost(
        publishPlayback
      );

    /**
     * Maintain exactly one Reddit status post.
     */
    if (existingPostId) {
      await editStatusPost(
        existingPostId,
        body
      );
    } else {
      const newPostId =
        await createStatusPost(body);

      await saveStatusPostId(
        newPostId
      );
    }

    /**
     * Only mark the Spotify state as handled AFTER Reddit publishing
     * succeeds.
     *
     * If Reddit creation/editing fails, the fingerprint remains unchanged
     * in Redis and the next scheduler run will retry.
     */
    await savePlaybackFingerprint(
      fingerprint
    );

    if (!playback.track) {
      console.log(
        '[Now Processing] Published: nothing currently playing'
      );
    } else {
      const artists =
        playback.artists &&
        playback.artists.length > 0
          ? playback.artists.join(', ')
          : 'Unknown artist';

      console.log(
        `[Now Processing] Published: ${playback.track} — ${artists}`
      );
    }

    return c.json<TaskResponse>(
      {
        status: 'ok',
      },
      200
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      `[Now Processing] run failed: ${message}`
    );

    throw error;
  }
});

/**
 * Lightweight server health endpoint.
 */
app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    app: 'now-processing',
  })
);

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});