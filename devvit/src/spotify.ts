import { settings } from '@devvit/web/server';

/**
 * Small subset of Spotify's token response that Now Processing needs.
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
 * We intentionally model only fields we use rather than dragging the
 * entire Spotify response structure into this project.
 */
type SpotifyCurrentlyPlayingResponse = {
  is_playing: boolean;
  currently_playing_type?: string;
  item?: {
    name: string;
    artists?: Array<{
      name: string;
    }>;
  } | null;
};

export type SpotifyPlayback = {
  isPlaying: boolean;
  track?: string;
  artists?: string[];
};

/**
 * Convert a Devvit setting into a required string.
 *
 * This gives us a useful error if one of the three Spotify secrets is
 * missing instead of sending a malformed request to Spotify.
 */
function requireSetting(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing Devvit setting: ${key}`);
  }

  return value;
}

/**
 * Exchange our long-lived Spotify refresh token for a short-lived
 * Spotify access token.
 */
async function getSpotifyAccessToken(): Promise<string> {
  const [clientIdValue, clientSecretValue, refreshTokenValue] =
    await Promise.all([
      settings.get('spotifyClientId'),
      settings.get('spotifyClientSecret'),
      settings.get('spotifyRefreshToken'),
    ]);

  const clientId = requireSetting(clientIdValue, 'spotifyClientId');
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

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const data = (await response.json()) as SpotifyTokenResponse;

  if (!response.ok || !data.access_token) {
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
 * Read the Spotify account's current playback state.
 *
 * HTTP 204 is Spotify's normal "nothing is currently playing" response,
 * so that is not treated as an error.
 */
export async function getCurrentSpotifyPlayback(): Promise<SpotifyPlayback> {
  const accessToken = await getSpotifyAccessToken();

  const response = await fetch(
    'https://api.spotify.com/v1/me/player/currently-playing',
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (response.status === 204) {
    return {
      isPlaying: false,
    };
  }

  if (!response.ok) {
    const detail = await response.text();

    throw new Error(
      `Spotify currently-playing failed (${response.status}): ${detail}`
    );
  }

  const data =
    (await response.json()) as SpotifyCurrentlyPlayingResponse;

  /*
   * Spotify can return something other than a normal music track,
   * such as an episode. For this first test we care only about tracks.
   */
  if (
    !data.item ||
    data.currently_playing_type !== 'track'
  ) {
    return {
      isPlaying: data.is_playing,
    };
  }

  return {
    isPlaying: data.is_playing,
    track: data.item.name,
    artists: data.item.artists?.map((artist) => artist.name) ?? [],
  };
}