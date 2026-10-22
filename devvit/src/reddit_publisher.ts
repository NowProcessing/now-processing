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
    escapeMarkdown(playback.track);

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