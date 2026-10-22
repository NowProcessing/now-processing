import {
  context,
  reddit,
} from '@devvit/web/server';

import type {
  SpotifyPlayback,
} from './spotify.js';

/**
 * The title remains constant because Now Processing maintains
 * one permanent status post.
 */
const STATUS_POST_TITLE =
  'Now Processing';

/**
 * Escape characters that have special meaning in Reddit Markdown.
 *
 * Spotify metadata is external content, so we should not assume track,
 * artist, or album names are safe Markdown.
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
 * Format playback as the body of the permanent Reddit status post.
 *
 * The Reddit post title already says "Now Processing", so the body
 * starts directly with the meaningful information.
 */
export function formatStatusPost(
  playback: SpotifyPlayback
): string {
  /**
   * Nothing active.
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
    escapeMarkdown(playback.track);

  const artists =
    playback.artists &&
    playback.artists.length > 0
      ? playback.artists
          .map(escapeMarkdown)
          .join(', ')
      : 'Unknown artist';

  /**
   * Make the song title itself the Spotify link when Spotify provides
   * one. Local or otherwise unlinked tracks still render normally.
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

  if (playback.album) {
    lines.push(
      '',
      `Album: *${escapeMarkdown(playback.album)}*`
    );
  }

  lines.push(
    '',
    '---',
    '',
    '_Updated automatically from Spotify._'
  );

  return lines.join('\n');
}

/**
 * Create the single app-owned Now Processing post.
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
 * Replace the body of the existing app-owned status post.
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