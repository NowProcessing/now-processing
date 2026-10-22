import { redis } from '@devvit/web/server';

import type { SpotifyPlayback } from './spotify.js';

/**
 * Stable Redis key used to remember the last playback state handled by
 * Now Processing.
 *
 * Devvit Redis is scoped to an app installation, so this state belongs
 * specifically to the app installed in this subreddit.
 */
const LAST_PLAYBACK_FINGERPRINT_KEY =
  'now-processing:last-playback-fingerprint';

/**
 * Convert a Spotify playback snapshot into a small stable string.
 *
 * Track ID is preferable because it uniquely identifies the Spotify track.
 * The title/artist combination is retained as a fallback.
 *
 * Playing vs paused is also included because changing playback state is
 * meaningful even when the track itself did not change.
 */
export function createPlaybackFingerprint(
  playback: SpotifyPlayback
): string {
  if (!playback.track) {
    return 'nothing-playing';
  }

  const trackIdentity =
    playback.trackId ??
    `${playback.track}|${playback.artists?.join(',') ?? ''}`;

  const playbackState =
    playback.isPlaying
      ? 'playing'
      : 'paused';

  /**
   * Playback context is part of the displayed Now Processing state.
   *
   * If the same track continues while the Spotify playlist changes,
   * that is meaningful because the Reddit post's "From:" line should
   * change too.
   */
  const playlistContext =
    playback.playlistId
      ? `|playlist:${playback.playlistId}`
      : '';

  return (
    `${trackIdentity}|${playbackState}` +
    playlistContext
  );
}

/**
 * Read the fingerprint handled by the previous successful scheduler run.
 */
export async function getLastPlaybackFingerprint():
  Promise<string | undefined> {
  const value = await redis.get(
    LAST_PLAYBACK_FINGERPRINT_KEY
  );

  return value ?? undefined;
}

/**
 * Persist the playback fingerprint after we have successfully handled
 * the changed playback.
 *
 * Later, when Reddit publishing is added, this call will occur only after
 * the Reddit post has been successfully created/edited.
 */
export async function savePlaybackFingerprint(
  fingerprint: string
): Promise<void> {
  await redis.set(
    LAST_PLAYBACK_FINGERPRINT_KEY,
    fingerprint
  );
}

const STATUS_POST_ID_KEY =
  'now-processing:status-post-id';

  /**
 * Retrieve the Reddit post used as the permanent Now Processing status.
 */
export async function getStatusPostId():
  Promise<string | undefined> {
  const value = await redis.get(
    STATUS_POST_ID_KEY
  );

  return value ?? undefined;
}

/**
 * Remember the app-owned Reddit status post.
 */
export async function saveStatusPostId(
  postId: string
): Promise<void> {
  await redis.set(
    STATUS_POST_ID_KEY,
    postId
  );
}