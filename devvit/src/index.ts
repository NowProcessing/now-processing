import { Hono } from 'hono';
import { serve } from '@hono/node-server';

import {
  createServer,
  getServerPort,
  type TaskRequest,
  type TaskResponse,
} from '@devvit/web/server';

import { getCurrentSpotifyPlayback } from './spotify.js';

import {
  createPlaybackFingerprint,
  getLastPlaybackFingerprint,
  savePlaybackFingerprint,
} from './state.js';

/**
 * Now Processing Devvit server.
 *
 * Current runtime:
 *
 *   Scheduler
 *      ↓
 *   Spotify
 *      ↓
 *   Playback fingerprint
 *      ↓
 *   Redis comparison
 *      ↓
 *   Log only when playback changes
 */
const app = new Hono();

/**
 * Scheduled Now Processing poll.
 *
 * The recurring task in devvit.json invokes this endpoint once per minute.
 */
app.post('/internal/scheduler/heartbeat', async (c) => {
  /**
   * Consume the Devvit scheduler request body.
   *
   * We don't need any task-specific input yet, but reading it keeps this
   * endpoint aligned with the normal Devvit scheduler handler pattern.
   */
  await c.req.json<TaskRequest>();

  try {
    /**
     * Step 1:
     * Ask Spotify what is currently playing.
     */
    const playback =
      await getCurrentSpotifyPlayback();

    /**
     * Step 2:
     * Convert that playback state into a stable comparison value.
     */
    const fingerprint =
      createPlaybackFingerprint(playback);

    /**
     * Step 3:
     * Retrieve the last playback state that we successfully handled.
     */
    const previousFingerprint =
      await getLastPlaybackFingerprint();

    /**
     * Most scheduler runs should stop here.
     *
     * We still poll Spotify once per minute, but if nothing has changed,
     * there is no reason to perform downstream work.
     */
    if (fingerprint === previousFingerprint) {
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
     * Playback changed.
     *
     * For this milestone we only log the result. Reddit publishing will
     * eventually happen here.
     */
    if (!playback.track) {
      console.log(
        '[Now Processing] Spotify: nothing currently playing'
      );
    } else {
      const artists =
        playback.artists &&
        playback.artists.length > 0
          ? playback.artists.join(', ')
          : 'Unknown artist';

      const playbackState =
        playback.isPlaying ? '' : ' (paused)';

      console.log(
        `[Now Processing] Spotify: ${playback.track} — ${artists}${playbackState}`
      );
    }

    /**
     * Step 4:
     * Record the state only after successful processing.
     *
     * Once Reddit publishing exists, this will remain below the publishing
     * operation so a failed Reddit edit does not falsely mark the track as
     * successfully processed.
     */
    await savePlaybackFingerprint(fingerprint);

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
      `[Now Processing] Spotify check failed: ${message}`
    );

    /**
     * Allow the scheduler invocation itself to fail visibly instead of
     * hiding the error behind a successful HTTP response.
     */
    throw error;
  }
});

/**
 * Simple development health endpoint.
 *
 * This is unrelated to the scheduler; it simply gives us a lightweight
 * endpoint for confirming that the server is alive.
 */
app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    app: 'now-processing',
  })
);

/**
 * Start the Devvit-hosted Hono server.
 */
serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});