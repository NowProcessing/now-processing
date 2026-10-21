import { settings } from '@devvit/web/server';

/**
 * Small subset of Spotify's OAuth token response.
 *
 * We model only the fields Now Processing actually needs.
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
 * Spotify can return tracks, episodes, or nothing. For this first version,
 * Now Processing only cares about normal music tracks.
 */
type SpotifyCurrentlyPlayingResponse = {
  is_playing: boolean;
  currently_playing_type?: string;

  item?: {
    id?: string;
    name: string;

    artists?: Array<{
      name: string;
    }>;
  } | null;
};

/**
 * Normalized playback information returned to the rest of our application.
 *
 * Optional properties are omitted entirely when unavailable. This matters
 * because this project uses TypeScript's exactOptionalPropertyTypes setting.
 */
export type SpotifyPlayback = {
  isPlaying: boolean;
  trackId?: string;
  track?: string;
  artists?: string[];
};

/**
 * Require a Devvit setting to contain a non-empty string.
 *
 * This gives us a useful configuration error before making a malformed
 * request to Spotify.
 */
function requireSetting(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing Devvit setting: ${key}`);
  }

  return value;
}

/**
 * Exchange the long-lived Spotify refresh token for a short-lived
 * Spotify access token.
 */
async function getSpotifyAccessToken(): Promise<string> {
  const [clientIdValue, clientSecretValue, refreshTokenValue] =
    await Promise.all([
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

  /**
   * Spotify's token endpoint expects the client ID and client secret
   * as HTTP Basic authentication.
   */
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
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    }
  );

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
 * Read the Spotify account's current playback.
 *
 * Spotify returns HTTP 204 when nothing is currently playing. That is a
 * normal state, not an application error.
 */
export async function getCurrentSpotifyPlayback():
  Promise<SpotifyPlayback> {
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

  /**
   * The endpoint can return something other than a music track.
   * For now, treat that as playback without track metadata.
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
   * exactOptionalPropertyTypes means:
   *
   *   trackId?: string
   *
   * allows trackId to be absent, but does not allow:
   *
   *   trackId: undefined
   *
   * So we conditionally add trackId only when Spotify supplied one.
   */
  return {
    isPlaying: data.is_playing,
    track: data.item.name,
    artists:
      data.item.artists?.map((artist) => artist.name) ?? [],

    ...(data.item.id !== undefined
      ? { trackId: data.item.id }
      : {}),
  };
}