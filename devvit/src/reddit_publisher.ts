import {
  context,
  reddit,
} from '@devvit/web/server';

import type { SpotifyPlayback } from './spotify.js';

/**
 * Stable title for the single Now Processing status post.
 *
 * The body changes. The post itself does not.
 */
const STATUS_POST_TITLE = 'Now Processing';

/**
 * Format Spotify playback as the Reddit Markdown body.
 *
 * This is intentionally simple for the first publishing milestone.
 * Once create/edit behavior is proven, we can port the richer formatting
 * from the Python implementation.
 */
export function formatStatusPost(
  playback: SpotifyPlayback
): string {
  if (!playback.track) {
    return [
      '# Now Processing',
      '',
      '_Nothing currently playing._',
      '',
      '---',
      '',
      'Updated automatically from Spotify.',
    ].join('\n');
  }

  const artists =
    playback.artists && playback.artists.length > 0
      ? playback.artists.join(', ')
      : 'Unknown artist';

  const state =
    playback.isPlaying
      ? '▶️ Playing'
      : '⏸️ Paused';

  return [
    '# Now Processing',
    '',
    `## ${playback.track}`,
    '',
    `**${artists}**`,
    '',
    state,
    '',
    '---',
    '',
    'Updated automatically from Spotify.',
  ].join('\n');
}

/**
 * Create the app-owned status post.
 *
 * submitPost() defaults to runAs: APP, but we specify it explicitly here
 * because app ownership is an important architectural requirement.
 */
export async function createStatusPost(
  body: string
): Promise<string> {
  const subredditName = context.subredditName;

  if (!subredditName) {
    throw new Error(
      'Cannot create status post: subredditName is unavailable'
    );
  }

  const post = await reddit.submitPost({
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

  const post = await reddit.getPostById(
    postId as `t3_${string}`
  );

  await post.edit({
    text: body,
  });

  console.log(
    `[Now Processing] Updated Reddit status post ${postId}`
  );
}