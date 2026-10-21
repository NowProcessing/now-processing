import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import {
  createServer,
  getServerPort,
  type TaskRequest,
  type TaskResponse,
} from '@devvit/web/server';

import { getCurrentSpotifyPlayback } from './spotify.js';

/**
 * Now Processing Devvit server.
 */
const app = new Hono();

/**
 * Scheduled Now Processing poll.
 *
 * We keep the original heartbeat endpoint for this milestone because
 * Reddit has already proven that this scheduled task runs once per minute.
 *
 * For now:
 *   scheduler -> Spotify -> console
 *
 * Later:
 *   scheduler -> Spotify -> state comparison -> Reddit post
 */
app.post('/internal/scheduler/heartbeat', async (c) => {
  await c.req.json<TaskRequest>();

  try {
    const playback = await getCurrentSpotifyPlayback();

    if (!playback.track) {
      console.log('[Now Processing] Spotify: nothing currently playing');
    } else {
      const artists =
        playback.artists && playback.artists.length > 0
          ? playback.artists.join(', ')
          : 'Unknown artist';

      const state = playback.isPlaying ? '' : ' (paused)';

      console.log(
        `[Now Processing] Spotify: ${playback.track} — ${artists}${state}`
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
      error instanceof Error ? error.message : String(error);

    console.error(
      `[Now Processing] Spotify check failed: ${message}`
    );

    throw error;
  }
});

/**
 * Simple development health endpoint.
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