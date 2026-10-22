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
 * Small subset of Spotify's currently-playing response.
 *
 * We intentionally model only fields Now Processing currently uses.
 */
type SpotifyCurrentlyPlayingResponse = {
  is_playing: boolean;
  currently_playing_type?: string;

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
 * Normalized playback information used by the rest of Now Processing.
 */
export type SpotifyPlayback = {
  isPlaying: boolean;

  trackId?: string;
  track?: string;
  trackUrl?: string;
  album?: string;
  artists?: string[];
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
 * access token.
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
 * Retrieve the Spotify account's current playback.
 *
 * Spotify returns HTTP 204 when there is no active playback.
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

  /**
   * No active playback is normal.
   */
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

  /**
   * Now Processing currently publishes music tracks.
   *
   * If Spotify returns another playback type, preserve the playback
   * state but omit track-specific metadata.
   */
  if (
    !data.item ||
    data.currently_playing_type !== 'track'
  ) {
    return {
      isPlaying: data.is_playing,
    };
  }

  /**
   * Optional properties are conditionally added because this project
   * uses exactOptionalPropertyTypes.
   */
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
  };
}