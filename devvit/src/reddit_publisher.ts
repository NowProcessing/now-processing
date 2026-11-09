import {
  context,
  reddit,
} from '@devvit/web/server';

import type {
  SpotifyPlayback,
} from './spotify.js';

import type {
  PlaybackHistoryEntry,
} from './state.js';

/**
 * The title remains constant because Now Processing maintains
 * one permanent status post.
 */
const STATUS_POST_TITLE =
  'Now Processing';


/**
 * Escape characters that have special meaning in Reddit Markdown.
 *
 * Spotify metadata is external content, so track, artist, album,
 * and playlist names should not be allowed to accidentally change
 * the Markdown structure of the post.
 */
function escapeMarkdown(
  value: string
): string {
  return value.replace(
    /([[\]\\`*_{}()#+.!|>-])/g,
    '\\$1'
  );
}


/**
 * Format the current Spotify playback as the body of the permanent
 * Reddit status post.
 */
export function formatStatusPost(
  playback: SpotifyPlayback
): string {
  /**
   * Nothing is actively playing.
   */
  if (!playback.track) {
    return [
      '## Nothing playing',
      '',
      '_No active Spotify playback right now._',
      '',
      '---',
      '',
      '_Updated automatically from Spotify._',
    ].join('\n');
  }

  const track =
    escapeMarkdown(
      playback.track
    );

  const artists =
    playback.artists &&
    playback.artists.length > 0
      ? playback.artists
          .map(escapeMarkdown)
          .join(', ')
      : 'Unknown artist';

  /**
   * Make the track title itself clickable when Spotify supplies
   * a public track URL.
   */
  const trackHeading =
    playback.trackUrl
      ? `## [${track}](${playback.trackUrl})`
      : `## ${track}`;

  const playbackState =
    playback.isPlaying
      ? '▶️ **Playing now**'
      : '⏸️ **Paused**';

  const lines = [
    trackHeading,
    '',
    `**${artists}**`,
    '',
    playbackState,
  ];

  /**
   * Album information.
   */
  if (playback.album) {
    lines.push(
      '',
      `Album: *${escapeMarkdown(playback.album)}*`
    );
  }

  /**
   * Playlist context.
   *
   * This is one of the core Now Processing ideas:
   * show not only what is playing, but the listening context
   * the track came from.
   *
   * The playlist name becomes a direct Spotify link.
   */
  if (playback.playlistUrl) {
    const playlistLabel =
      playback.playlistName
        ? escapeMarkdown(
            playback.playlistName
          )
        : 'Spotify playlist';

    lines.push(
      '',
      `From: [**${playlistLabel}**](${playback.playlistUrl})`
    );
  }

  /**
   * Quiet footer so the automation attribution does not compete
   * visually with the actual status.
   */
  lines.push(
    '',
    '---',
    '',
    '_Updated automatically from Spotify._'
  );

  return lines.join('\n');
}


/**
 * Determine whether the status post stored in Redis is still usable.
 *
 * This handles the exact case we hit in r/NowProcessingDev:
 *
 * Redis still contained the old post ID, but the Reddit post had been
 * removed manually.
 *
 * A removed/deleted post should be treated as missing so the scheduler
 * can create a replacement.
 *
 * If Reddit cannot retrieve the stored post at all, that also counts as
 * unusable rather than crashing the scheduler.
 */
export async function isStatusPostUsable(
  postId: string
): Promise<boolean> {
  if (!postId.startsWith('t3_')) {
    return false;
  }

  try {
    const post =
      await reddit.getPostById(
        postId as `t3_${string}`
      );

    return (
      !post.removed &&
      post.removedByCategory === undefined
    );
  } catch (error) {
    console.warn(
      `[Now Processing] Could not retrieve stored status post ${postId}:`,
      error
    );

    return false;
  }
}


/**
 * Format the bounded listening-history catalogue.
 *
 * We maintain ONE Reddit comment and continuously edit it rather than
 * generating a new automated comment for every Spotify track.
 */
export function formatHistoryComment(
  history: PlaybackHistoryEntry[]
): string {
  const lines: string[] = [
    '## Previously Processing',
    '',
    '_Recent tracks, newest first._',
    '',
  ];

  history.forEach(
    (entry, index) => {
      const track =
        entry.track
          ? escapeMarkdown(
              entry.track
            )
          : 'Unknown track';

      const artists =
        entry.artists &&
        entry.artists.length > 0
          ? entry.artists
              .map(escapeMarkdown)
              .join(', ')
          : 'Unknown artist';

      /**
       * Make each previous track clickable when Spotify gave us
       * a public track URL.
       */
      const trackLabel =
        entry.trackUrl
          ? `[${track}](${entry.trackUrl})`
          : track;

      lines.push(
        `${index + 1}. **${trackLabel}** — ${artists}`
      );

      /**
       * Preserve playlist context in history as well.
       */
      if (entry.playlistUrl) {
        const playlistLabel =
          entry.playlistName
            ? escapeMarkdown(
                entry.playlistName
              )
            : 'Spotify playlist';

        lines.push(
          `   From: [${playlistLabel}](${entry.playlistUrl})`
        );
      }

      lines.push('');
    }
  );

  lines.push(
    '---',
    '',
    '_Updated automatically from Spotify._'
  );

  return lines.join('\n');
}


/**
 * Create or update the single permanent Previously Processing comment.
 *
 * If Redis contains a comment ID but the comment was removed/deleted,
 * this function creates a replacement and returns the new ID.
 *
 * The comment is distinguished and stickied so it remains immediately
 * below the live Now Processing post.
 */
export async function upsertHistoryComment(
  postId: string,
  commentId: string | undefined,
  history: PlaybackHistoryEntry[]
): Promise<string> {
  const body =
    formatHistoryComment(
      history
    );

  /**
   * Try to reuse the existing history comment first.
   */
  if (commentId) {
    try {
      if (
        !commentId.startsWith('t1_')
      ) {
        throw new Error(
          `Invalid Reddit comment ID stored in Redis: ${commentId}`
        );
      }

      const comment =
        await reddit.getCommentById(
          commentId as `t1_${string}`
        );

      /**
       * Moderator-removed comments are no longer useful as the visible
       * history catalogue. Fall through and create a replacement.
       */
      if (!comment.removed) {
        await comment.edit({
          text: body,
        });

        console.log(
          `[Now Processing] Updated history comment ${commentId}`
        );

        return commentId;
      }

      console.warn(
        `[Now Processing] History comment ${commentId} was removed; recreating`
      );
    } catch (error) {
      /**
       * Deleted/inaccessible/stale comments should not strand the
       * application. Create a replacement below.
       */
      console.warn(
        `[Now Processing] Could not reuse history comment ${commentId}; recreating:`,
        error
      );
    }
  }

  if (!postId.startsWith('t3_')) {
    throw new Error(
      `Invalid Reddit post ID for history comment: ${postId}`
    );
  }

  /**
   * Create the one permanent history comment as the app account.
   */
  const comment =
    await reddit.submitComment({
      id:
        postId as `t3_${string}`,
      text: body,
      runAs: 'APP',
    });

  /**
   * Distinguish it as a moderator comment and make it sticky.
   */
  await comment.distinguish(true);

  console.log(
    `[Now Processing] Created history comment ${comment.id}`
  );

  return comment.id;
}


/**
 * Create the single app-owned Now Processing status post.
 *
 * Explicitly using APP ownership keeps the post attached to the
 * Devvit application rather than the human developer account.
 */
export async function createStatusPost(
  body: string
): Promise<string> {
  const subredditName =
    context.subredditName;

  if (!subredditName) {
    throw new Error(
      'Cannot create status post: subredditName is unavailable'
    );
  }

  const post =
    await reddit.submitPost({
      subredditName,
      title: STATUS_POST_TITLE,
      text: body,
      runAs: 'APP',
    });

  console.log(
    `[Now Processing] Created Reddit status post ${post.id}`
  );

  return post.id;
}


/**
 * Replace the contents of the existing app-owned status post.
 */
export async function editStatusPost(
  postId: string,
  body: string
): Promise<void> {
  if (!postId.startsWith('t3_')) {
    throw new Error(
      `Invalid Reddit post ID stored in Redis: ${postId}`
    );
  }

  const post =
    await reddit.getPostById(
      postId as `t3_${string}`
    );

  await post.edit({
    text: body,
  });

  console.log(
    `[Now Processing] Updated Reddit status post ${postId}`
  );
}