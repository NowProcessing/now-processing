import { redis } from '@devvit/web/server';

import type { SpotifyPlayback } from './spotify.js';

/**
 * Stable Redis keys.
 *
 * Devvit Redis is scoped to each app installation, so the DEV
 * installation maintains its own independent Now Processing state.
 */
const LAST_PLAYBACK_FINGERPRINT_KEY =
  'now-processing:last-playback-fingerprint';

const LAST_PLAYBACK_SNAPSHOT_KEY =
  'now-processing:last-playback-snapshot';

const LAST_TRACK_SNAPSHOT_KEY =
  'now-processing:last-track-snapshot';

const STATUS_POST_ID_KEY =
  'now-processing:status-post-id';

const HISTORY_COMMENT_ID_KEY =
  'now-processing:history-comment-id';

const PLAYBACK_HISTORY_KEY =
  'now-processing:playback-history';

/**
 * Keep the Reddit history useful without allowing the comment to grow
 * forever.
 */
export const PLAYBACK_HISTORY_LIMIT = 25;

/**
 * A history item is the complete Spotify playback metadata we already
 * know about the track plus the time when it stopped being current.
 *
 * endedAt is retained even though v0.2 does not have to display it yet.
 * Keeping it now gives us options later without changing the schema.
 */
export type PlaybackHistoryEntry =
  SpotifyPlayback & {
    endedAt: string;
  };

/**
 * Produce a stable identity for a Spotify track.
 *
 * Spotify track ID is preferred. The title + artist combination exists
 * only as a fallback if Spotify did not provide an ID.
 */
function getTrackIdentity(
  playback: SpotifyPlayback | undefined
): string | undefined {
  if (!playback?.track) {
    return undefined;
  }

  return (
    playback.trackId ??
    `${playback.track}|${playback.artists?.join(',') ?? ''}`
  );
}

/**
 * Determine whether two playback snapshots represent the same actual
 * song.
 *
 * This intentionally ignores playing/paused state and playlist context.
 * Those can change without creating a new "Previously Processing" entry.
 */
export function isSameTrack(
  left: SpotifyPlayback | undefined,
  right: SpotifyPlayback | undefined
): boolean {
  const leftIdentity =
    getTrackIdentity(left);

  const rightIdentity =
    getTrackIdentity(right);

  return (
    leftIdentity !== undefined &&
    rightIdentity !== undefined &&
    leftIdentity === rightIdentity
  );
}

/**
 * Convert the complete displayed playback state into a stable string.
 *
 * Unlike isSameTrack(), the fingerprint DOES include playing/paused and
 * playlist context because those changes should update the live Reddit
 * status post.
 */
export function createPlaybackFingerprint(
  playback: SpotifyPlayback
): string {
  const trackIdentity =
    getTrackIdentity(playback);

  if (!trackIdentity) {
    return 'nothing-playing';
  }

  const playbackState =
    playback.isPlaying
      ? 'playing'
      : 'paused';

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
  const value =
    await redis.get(
      LAST_PLAYBACK_FINGERPRINT_KEY
    );

  return value ?? undefined;
}

/**
 * Read the complete playback state from the previous successful publish.
 *
 * This can represent a song, paused playback, or nothing playing.
 */
export async function getLastPlaybackSnapshot():
  Promise<SpotifyPlayback | undefined> {
  const value =
    await redis.get(
      LAST_PLAYBACK_SNAPSHOT_KEY
    );

  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(
      value
    ) as SpotifyPlayback;
  } catch {
    console.warn(
      '[Now Processing] Invalid last playback snapshot in Redis'
    );

    return undefined;
  }
}

/**
 * Read the most recent ACTUAL TRACK.
 *
 * This is deliberately separate from last-playback-snapshot.
 *
 * Example:
 *
 *   Song A
 *      ↓
 *   Spotify reports "nothing playing"
 *      ↓
 *   Song B
 *
 * LAST_PLAYBACK_SNAPSHOT may temporarily become "nothing playing", but
 * LAST_TRACK_SNAPSHOT remains Song A. That means Song A can still be
 * moved into Previously Processing when Song B appears.
 */
export async function getLastTrackSnapshot():
  Promise<SpotifyPlayback | undefined> {
  const value =
    await redis.get(
      LAST_TRACK_SNAPSHOT_KEY
    );

  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(
      value
    ) as SpotifyPlayback;
  } catch {
    console.warn(
      '[Now Processing] Invalid last track snapshot in Redis'
    );

    return undefined;
  }
}

/**
 * Save the successful Spotify state.
 *
 * Fingerprint and complete playback snapshot are written together.
 * LAST_TRACK_SNAPSHOT is updated only when an actual track exists.
 *
 * This function must continue to be called only AFTER the Reddit work
 * succeeds so a failed publish remains retryable on the next scheduler
 * cycle.
 */
export async function savePlaybackState(
  fingerprint: string,
  playback: SpotifyPlayback
): Promise<void> {
  const values: Record<string, string> = {
    [LAST_PLAYBACK_FINGERPRINT_KEY]:
      fingerprint,

    [LAST_PLAYBACK_SNAPSHOT_KEY]:
      JSON.stringify(playback),
  };

  if (playback.track) {
    values[LAST_TRACK_SNAPSHOT_KEY] =
      JSON.stringify(playback);
  }

  await redis.mSet(values);
}

/**
 * Retrieve the Reddit post used as the permanent Now Processing status.
 */
export async function getStatusPostId():
  Promise<string | undefined> {
  const value =
    await redis.get(
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

/**
 * Forget the status post and its attached history comment.
 *
 * We use this when Reddit tells us that the stored post was removed or
 * deleted. The actual listening history remains intact so it can be
 * attached to the replacement post.
 */
export async function clearStatusPostState():
  Promise<void> {
  await Promise.all([
    redis.del(
      STATUS_POST_ID_KEY
    ),

    redis.del(
      HISTORY_COMMENT_ID_KEY
    ),
  ]);
}

/**
 * Retrieve the permanent Previously Processing comment ID.
 */
export async function getHistoryCommentId():
  Promise<string | undefined> {
  const value =
    await redis.get(
      HISTORY_COMMENT_ID_KEY
    );

  return value ?? undefined;
}

/**
 * Remember the permanent Previously Processing comment.
 */
export async function saveHistoryCommentId(
  commentId: string
): Promise<void> {
  await redis.set(
    HISTORY_COMMENT_ID_KEY,
    commentId
  );
}

/**
 * Forget only the history comment.
 *
 * The actual listening history remains untouched.
 */
export async function clearHistoryCommentId():
  Promise<void> {
  await redis.del(
    HISTORY_COMMENT_ID_KEY
  );
}

/**
 * Retrieve the current bounded listening history.
 */
export async function getPlaybackHistory():
  Promise<PlaybackHistoryEntry[]> {
  const value =
    await redis.get(
      PLAYBACK_HISTORY_KEY
    );

  if (!value) {
    return [];
  }

  try {
    return JSON.parse(
      value
    ) as PlaybackHistoryEntry[];
  } catch {
    console.warn(
      '[Now Processing] Invalid playback history in Redis'
    );

    return [];
  }
}

/**
 * Add an outgoing song to Previously Processing.
 *
 * Newest entries are stored first.
 *
 * The first-item duplicate check is deliberate. If Reddit publishing
 * partially succeeds and the scheduler retries, we do not want the same
 * outgoing song inserted twice.
 *
 * A legitimate replay later is still allowed because another track will
 * have become the newest history entry in between.
 */
export async function archivePlayback(
  playback: SpotifyPlayback
): Promise<PlaybackHistoryEntry[]> {
  if (!playback.track) {
    return getPlaybackHistory();
  }

  const history =
    await getPlaybackHistory();

  const newest =
    history[0];

  if (
    newest &&
    isSameTrack(
      newest,
      playback
    )
  ) {
    return history;
  }

  const entry: PlaybackHistoryEntry = {
    ...playback,
    endedAt:
      new Date().toISOString(),
  };

  const updatedHistory = [
    entry,
    ...history,
  ].slice(
    0,
    PLAYBACK_HISTORY_LIMIT
  );

  await redis.set(
    PLAYBACK_HISTORY_KEY,
    JSON.stringify(
      updatedHistory
    )
  );

  return updatedHistory;
}