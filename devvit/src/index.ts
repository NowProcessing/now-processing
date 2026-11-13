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
  SpotifyCooldownError,
} from './spotify.js';

import {
  archivePlayback,
  clearStatusPostState,
  createPlaybackFingerprint,
  getHistoryCommentId,
  getLastPlaybackFingerprint,
  getLastTrackSnapshot,
  getPlaybackHistory,
  getStatusPostId,
  isSameTrack,
  saveHistoryCommentId,
  savePlaybackState,
  saveStatusPostId,
} from './state.js';

import {
  createStatusPost,
  editStatusPost,
  formatStatusPost,
  isStatusPostUsable,
  upsertHistoryComment,
} from './reddit_publisher.js';


/**
 * Now Processing Devvit server.
 */
const app =
  new Hono();


/**
 * Scheduled Now Processing poll.
 */
app.post(
  '/internal/scheduler/heartbeat',
  async (c) => {
    await c.req.json<TaskRequest>();

    try {
      /**
       * Read Spotify's current playback state.
       */
      const playback =
        await getCurrentSpotifyPlayback();

      const fingerprint =
        createPlaybackFingerprint(
          playback
        );


      /**
       * Read persistent application state.
       */
      /**
       * Read persistent application state.
       */
      const [
        previousFingerprint,
        initialPostId,
        previousTrack,
        initialHistoryCommentId,
      ] = await Promise.all([
        getLastPlaybackFingerprint(),
        getStatusPostId(),
        getLastTrackSnapshot(),
        getHistoryCommentId(),
      ]);

      let existingPostId =
        initialPostId;

      let historyCommentId =
        initialHistoryCommentId;


      /**
       * Redis may still contain a Reddit post ID after the visible post
       * was manually removed or deleted.
       */
      if (existingPostId) {
        const usable =
          await isStatusPostUsable(
            existingPostId
          );

        if (!usable) {
          console.warn(
            `[Now Processing] Stored Reddit post ${existingPostId} is no longer usable; recreating`
          );

          await clearStatusPostState();

          existingPostId =
            undefined;

          historyCommentId =
            undefined;
        }
      }


      /**
       * Nothing changed and the Reddit post remains healthy.
       */
      if (
        fingerprint ===
          previousFingerprint &&
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
       * Friendly playlist metadata is resolved only when something
       * actually needs publishing.
       */
      const publishPlayback =
        await resolveSpotifyPlaylistContext(
          playback
        );


      /**
       * Load bounded listening history.
       */
      let history =
        await getPlaybackHistory();


      /**
       * Archive only a real track transition.
       *
       * Pause/resume and temporary "nothing playing" states do not create
       * duplicate history entries.
       */
      if (
        previousTrack?.track &&
        publishPlayback.track &&
        !isSameTrack(
          previousTrack,
          publishPlayback
        )
      ) {
        history =
          await archivePlayback(
            previousTrack
          );

        console.log(
          `[Now Processing] Archived previous track: ${previousTrack.track}`
        );
      }


      const body =
        formatStatusPost(
          publishPlayback
        );


      /**
       * Maintain exactly one live Reddit status post.
       */
      let activePostId =
        existingPostId;

      if (activePostId) {
        await editStatusPost(
          activePostId,
          body
        );
      } else {
        activePostId =
          await createStatusPost(
            body
          );

        await saveStatusPostId(
          activePostId
        );
      }


      /**
       * Maintain one permanent Previously Processing comment.
       */
      if (
        history.length > 0
      ) {
        const activeHistoryCommentId =
          await upsertHistoryComment(
            activePostId,
            historyCommentId,
            history
          );

        if (
          activeHistoryCommentId !==
          historyCommentId
        ) {
          await saveHistoryCommentId(
            activeHistoryCommentId
          );

          historyCommentId =
            activeHistoryCommentId;
        }
      }


      /**
       * Persist the new successful playback only after the Reddit work
       * succeeds.
       */
      await savePlaybackState(
        fingerprint,
        publishPlayback
      );


      if (
        !publishPlayback.track
      ) {
        console.log(
          '[Now Processing] Published: nothing currently playing'
        );
      } else {
        const artists =
          publishPlayback.artists &&
          publishPlayback.artists.length >
            0
            ? publishPlayback.artists.join(
                ', '
              )
            : 'Unknown artist';

        console.log(
          `[Now Processing] Published: ${publishPlayback.track} — ${artists}`
        );
      }


      return c.json<TaskResponse>(
        {
          status: 'ok',
        },
        200
      );
    } catch (error) {
      /**
       * Spotify rate limiting is expected and recoverable.
       *
       * Return HTTP 200 so Devvit does not report a failed scheduler
       * endpoint every minute while the Redis cooldown is active.
       */
      if (
        error instanceof
        SpotifyCooldownError
      ) {
        const remainingSeconds =
          Math.max(
            1,
            Math.ceil(
              (
                error.retryAt -
                Date.now()
              ) / 1000
            )
          );

        console.warn(
          `[Now Processing] Spotify cooldown active; skipping scheduler run (${remainingSeconds}s remaining)`
        );

        return c.json<TaskResponse>(
          {
            status: 'ok',
          },
          200
        );
      }


      const message =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        `[Now Processing] run failed: ${message}`
      );

      throw error;
    }
  }
);


/**
 * Lightweight health endpoint.
 */
app.get(
  '/api/health',
  (c) =>
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