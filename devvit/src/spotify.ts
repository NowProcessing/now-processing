import { settings } from '@devvit/web/server';

/**
 * Small subset of Spotify's OAuth token response.
 */
type SpotifyTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

/**
 * Spotify playback context.
 *
 * We currently care specifically about playlist context, but retaining
 * the type makes this extensible to albums/artists later.
 */
type SpotifyPlaybackContext = {
  type: string;
  href?: string;
  uri?: string;

  external_urls?: {
    spotify?: string;
  };
};

/**
 * Small subset of Spotify's currently-playing response.
 */
type SpotifyCurrentlyPlayingResponse = {
  is_playing: boolean;
  currently_playing_type?: string;
  context?: SpotifyPlaybackContext | null;

  item?: {
    id?: string;
    name: string;

    external_urls?: {
      spotify?: string;
    };

    album?: {
      name?: string;
    };

    artists?: Array<{
      name: string;
    }>;
  } | null;
};

/**
 * Small subset of Spotify's playlist response.
 */
type SpotifyPlaylistResponse = {
  name?: string;

  external_urls?: {
    spotify?: string;
  };
};

/**
 * Normalized playback information used by Now Processing.
 */
export type SpotifyPlayback = {
  isPlaying: boolean;

  trackId?: string;
  track?: string;
  trackUrl?: string;

  album?: string;
  artists?: string[];

  playlistId?: string;
  playlistName?: string;
  playlistUrl?: string;
};

/**
 * Require a Devvit secret to contain a usable string.
 */
function requireSetting(
  value: unknown,
  key: string
): string {
  if (
    typeof value !== 'string' ||
    value.trim() === ''
  ) {
    throw new Error(
      `Missing Devvit setting: ${key}`
    );
  }

  return value;
}

/**
 * Exchange our long-lived Spotify refresh token for a short-lived
 * Spotify access token.
 */
async function getSpotifyAccessToken():
  Promise<string> {
  const [
    clientIdValue,
    clientSecretValue,
    refreshTokenValue,
  ] = await Promise.all([
    settings.get('spotifyClientId'),
    settings.get('spotifyClientSecret'),
    settings.get('spotifyRefreshToken'),
  ]);

  const clientId = requireSetting(
    clientIdValue,
    'spotifyClientId'
  );

  const clientSecret = requireSetting(
    clientSecretValue,
    'spotifyClientSecret'
  );

  const refreshToken = requireSetting(
    refreshTokenValue,
    'spotifyRefreshToken'
  );

  const basicAuth = Buffer.from(
    `${clientId}:${clientSecret}`,
    'utf8'
  ).toString('base64');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetch(
    'https://accounts.spotify.com/api/token',
    {
      method: 'POST',

      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type':
          'application/x-www-form-urlencoded',
      },

      body: body.toString(),
    }
  );

  const data =
    (await response.json()) as SpotifyTokenResponse;

  if (
    !response.ok ||
    !data.access_token
  ) {
    const detail =
      data.error_description ??
      data.error ??
      response.statusText;

    throw new Error(
      `Spotify token refresh failed (${response.status}): ${detail}`
    );
  }

  return data.access_token;
}

/**
 * Extract a Spotify playlist ID from playback context.
 */
function getPlaylistId(
  context: SpotifyPlaybackContext | null | undefined
): string | undefined {
  if (
    !context ||
    context.type !== 'playlist'
  ) {
    return undefined;
  }

  /**
   * Preferred form:
   *
   * spotify:playlist:<playlist-id>
   */
  if (
    context.uri?.startsWith(
      'spotify:playlist:'
    )
  ) {
    return context.uri.substring(
      'spotify:playlist:'.length
    );
  }

  /**
   * Fallback to extracting the ID from Spotify's API URL.
   */
  if (context.href) {
    try {
      const url = new URL(context.href);
      const parts =
        url.pathname.split('/').filter(Boolean);

      const playlistIndex =
        parts.indexOf('playlists');

      if (
        playlistIndex >= 0 &&
        parts[playlistIndex + 1]
      ) {
        return parts[playlistIndex + 1];
      }
    } catch {
      // Context enrichment is optional.
    }
  }

  return undefined;
}

/**
 * Read the Spotify account's current playback.
 *
 * This first request intentionally captures only enough playlist context
 * to identify it. We do NOT look up the playlist name every minute.
 */
export async function getCurrentSpotifyPlayback():
  Promise<SpotifyPlayback> {
  const accessToken =
    await getSpotifyAccessToken();

  const response = await fetch(
    'https://api.spotify.com/v1/me/player/currently-playing',
    {
      headers: {
        Authorization:
          `Bearer ${accessToken}`,
      },
    }
  );

  if (response.status === 204) {
    return {
      isPlaying: false,
    };
  }

  if (!response.ok) {
    const detail =
      await response.text();

    throw new Error(
      `Spotify currently-playing failed (${response.status}): ${detail}`
    );
  }

  const data =
    (await response.json()) as SpotifyCurrentlyPlayingResponse;

  if (
    !data.item ||
    data.currently_playing_type !== 'track'
  ) {
    return {
      isPlaying: data.is_playing,
    };
  }

  const playlistId =
    getPlaylistId(data.context);

  const playlistUrl =
    data.context?.type === 'playlist'
      ? data.context.external_urls?.spotify
      : undefined;

  return {
    isPlaying: data.is_playing,

    track: data.item.name,

    artists:
      data.item.artists?.map(
        (artist) => artist.name
      ) ?? [],

    ...(data.item.id !== undefined
      ? {
          trackId: data.item.id,
        }
      : {}),

    ...(data.item.external_urls?.spotify !== undefined
      ? {
          trackUrl:
            data.item.external_urls.spotify,
        }
      : {}),

    ...(data.item.album?.name !== undefined
      ? {
          album: data.item.album.name,
        }
      : {}),

    ...(playlistId !== undefined
      ? {
          playlistId,
        }
      : {}),

    ...(playlistUrl !== undefined
      ? {
          playlistUrl,
        }
      : {}),
  };
}

/**
 * Resolve the friendly playlist name only when we actually need to
 * publish a changed state.
 *
 * Playlist enrichment is deliberately non-fatal. If Spotify refuses the
 * metadata request, Now Processing still publishes the track normally.
 */
export async function resolveSpotifyPlaylistContext(
  playback: SpotifyPlayback
): Promise<SpotifyPlayback> {
  if (!playback.playlistId) {
    return playback;
  }

  try {
    const accessToken =
      await getSpotifyAccessToken();

    const playlistUrl = new URL(
      `https://api.spotify.com/v1/playlists/${encodeURIComponent(
        playback.playlistId
      )}`
    );

    /**
     * We need only two fields rather than the potentially large complete
     * playlist object.
     */
    playlistUrl.searchParams.set(
      'fields',
      'name,external_urls'
    );

    const response = await fetch(
      playlistUrl.toString(),
      {
        headers: {
          Authorization:
            `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      console.warn(
        `[Now Processing] Spotify playlist lookup failed (${response.status})`
      );

      return playback;
    }

    const data =
      (await response.json()) as SpotifyPlaylistResponse;

    const resolvedPlaylistUrl =
      data.external_urls?.spotify ??
      playback.playlistUrl;

    return {
      ...playback,

      ...(data.name !== undefined
        ? {
            playlistName: data.name,
          }
        : {}),

      ...(resolvedPlaylistUrl !== undefined
        ? {
            playlistUrl:
              resolvedPlaylistUrl,
          }
        : {}),
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.warn(
      `[Now Processing] Spotify playlist enrichment skipped: ${message}`
    );

    return playback;
  }
}