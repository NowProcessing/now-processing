import {
  redis,
  settings,
} from '@devvit/web/server';


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

  context?:
    | SpotifyPlaybackContext
    | null;

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
 * Cached Spotify access token.
 */
type CachedSpotifyAccessToken = {
  accessToken: string;
  expiresAt: number;
};


/**
 * Cached friendly playlist metadata.
 */
type CachedSpotifyPlaylist = {
  name?: string;
  url?: string;
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
 * Thrown when Spotify has explicitly told us to stop making requests,
 * or when Devvit's outbound HTTP layer is enforcing such a cooldown.
 *
 * index.ts treats this as an expected condition and returns HTTP 200
 * rather than turning every scheduler invocation into a server error.
 */
export class SpotifyCooldownError
  extends Error {
  readonly retryAt: number;

  constructor(
    retryAt: number,
    message =
      'Spotify rate-limit cooldown active'
  ) {
    super(message);

    this.name =
      'SpotifyCooldownError';

    this.retryAt =
      retryAt;
  }
}


/**
 * Redis keys used only by the Spotify integration.
 */
const ACCESS_TOKEN_CACHE_KEY =
  'now-processing:spotify-access-token';

const SPOTIFY_COOLDOWN_KEY =
  'now-processing:spotify-cooldown-until';

const PLAYLIST_CACHE_PREFIX =
  'now-processing:spotify-playlist:';


/**
 * Cache policy.
 *
 * Spotify access tokens are normally valid for about an hour. We use
 * Spotify's returned expires_in value and subtract a safety margin.
 *
 * Playlist names change rarely, so a one-day cache prevents repeatedly
 * resolving the same listening context while still allowing changes to
 * eventually refresh.
 */
const TOKEN_SAFETY_MARGIN_SECONDS =
  60;

const PLAYLIST_CACHE_SECONDS =
  24 * 60 * 60;


/**
 * If Spotify provides no Retry-After value, wait one minute.
 */
const DEFAULT_RATE_LIMIT_SECONDS =
  60;


/**
 * Devvit can sometimes block outbound Spotify calls after an upstream
 * 429 before our code receives another normal HTTP response.
 *
 * In that situation there is no Retry-After header available, so use a
 * conservative five-minute local cooldown rather than hammering the
 * blocked endpoint every scheduler cycle.
 */
const DEVVIT_RATE_LIMIT_FALLBACK_SECONDS =
  5 * 60;


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
 * Detect the characteristic error produced when Devvit's outbound
 * fetch layer blocks additional Spotify traffic due to rate limiting.
 */
function isDevvitRateLimitError(
  error: unknown
): boolean {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  const normalized =
    message.toLowerCase();

  return (
    normalized.includes(
      'too many requests'
    ) ||
    normalized.includes(
      'not allowed due to too many requests'
    )
  );
}


/**
 * Read the active Spotify cooldown from Redis.
 *
 * An expired value is cleaned up automatically if Redis has not already
 * removed the key through its TTL.
 */
async function getSpotifyCooldownUntil():
  Promise<number | undefined> {
  const value =
    await redis.get(
      SPOTIFY_COOLDOWN_KEY
    );

  if (!value) {
    return undefined;
  }

  const retryAt =
    Number(value);

  if (
    !Number.isFinite(retryAt)
  ) {
    await redis.del(
      SPOTIFY_COOLDOWN_KEY
    );

    return undefined;
  }

  if (
    retryAt <= Date.now()
  ) {
    await redis.del(
      SPOTIFY_COOLDOWN_KEY
    );

    return undefined;
  }

  return retryAt;
}


/**
 * Store a Spotify cooldown with an expiration.
 */
async function setSpotifyCooldown(
  seconds: number,
  reason: string
): Promise<number> {
  const safeSeconds =
    Math.max(
      1,
      Math.ceil(seconds)
    );

  const retryAt =
    Date.now() +
    safeSeconds * 1000;

  await redis.set(
    SPOTIFY_COOLDOWN_KEY,
    String(retryAt)
  );

  await redis.expire(
    SPOTIFY_COOLDOWN_KEY,
    safeSeconds + 60
  );

  console.warn(
    `[Now Processing] Spotify cooldown set for ${safeSeconds}s: ${reason}`
  );

  return retryAt;
}


/**
 * Stop before making a Spotify API request when a known cooldown is
 * already active.
 */
async function enforceSpotifyCooldown():
  Promise<void> {
  const retryAt =
    await getSpotifyCooldownUntil();

  if (!retryAt) {
    return;
  }

  throw new SpotifyCooldownError(
    retryAt
  );
}


/**
 * Read Retry-After from an HTTP 429.
 */
function getRetryAfterSeconds(
  response: Response
): number {
  const header =
    response.headers.get(
      'retry-after'
    );

  if (!header) {
    return DEFAULT_RATE_LIMIT_SECONDS;
  }

  const seconds =
    Number(header);

  if (
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    return DEFAULT_RATE_LIMIT_SECONDS;
  }

  return seconds;
}


/**
 * Retrieve a still-valid cached Spotify access token.
 */
async function getCachedSpotifyAccessToken():
  Promise<string | undefined> {
  const value =
    await redis.get(
      ACCESS_TOKEN_CACHE_KEY
    );

  if (!value) {
    return undefined;
  }

  try {
    const cached =
      JSON.parse(
        value
      ) as CachedSpotifyAccessToken;

    /**
     * Leave a small buffer in addition to the Redis TTL in case the
     * token is near expiry while a request is in flight.
     */
    if (
      cached.accessToken &&
      cached.expiresAt >
        Date.now() + 30_000
    ) {
      return cached.accessToken;
    }
  } catch {
    // Invalid cache data is simply discarded below.
  }

  await redis.del(
    ACCESS_TOKEN_CACHE_KEY
  );

  return undefined;
}


/**
 * Remove the cached access token.
 *
 * Used when Spotify returns 401 so we can refresh once and retry.
 */
async function clearCachedSpotifyAccessToken():
  Promise<void> {
  await redis.del(
    ACCESS_TOKEN_CACHE_KEY
  );
}


/**
 * Exchange the long-lived refresh token for a short-lived Spotify
 * access token and cache it in Redis.
 */
async function refreshSpotifyAccessToken():
  Promise<string> {
  const [
    clientIdValue,
    clientSecretValue,
    refreshTokenValue,
  ] = await Promise.all([
    settings.get(
      'spotifyClientId'
    ),

    settings.get(
      'spotifyClientSecret'
    ),

    settings.get(
      'spotifyRefreshToken'
    ),
  ]);

  const clientId =
    requireSetting(
      clientIdValue,
      'spotifyClientId'
    );

  const clientSecret =
    requireSetting(
      clientSecretValue,
      'spotifyClientSecret'
    );

  const refreshToken =
    requireSetting(
      refreshTokenValue,
      'spotifyRefreshToken'
    );

  const basicAuth =
    Buffer.from(
      `${clientId}:${clientSecret}`,
      'utf8'
    ).toString(
      'base64'
    );

  const body =
    new URLSearchParams({
      grant_type:
        'refresh_token',

      refresh_token:
        refreshToken,
    });


  let response: Response;

  try {
    response =
      await fetch(
        'https://accounts.spotify.com/api/token',
        {
          method: 'POST',

          headers: {
            Authorization:
              `Basic ${basicAuth}`,

            'Content-Type':
              'application/x-www-form-urlencoded',
          },

          body:
            body.toString(),
        }
      );
  } catch (error) {
    if (
      isDevvitRateLimitError(
        error
      )
    ) {
      const retryAt =
        await setSpotifyCooldown(
          DEVVIT_RATE_LIMIT_FALLBACK_SECONDS,
          'Devvit blocked Spotify token request due to too many requests'
        );

      throw new SpotifyCooldownError(
        retryAt
      );
    }

    throw error;
  }


  if (
    response.status === 429
  ) {
    const retrySeconds =
      getRetryAfterSeconds(
        response
      );

    const retryAt =
      await setSpotifyCooldown(
        retrySeconds,
        'Spotify token endpoint returned 429'
      );

    throw new SpotifyCooldownError(
      retryAt
    );
  }


  const data =
    (await response.json()) as
      SpotifyTokenResponse;


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


  const expiresIn =
    data.expires_in ??
    3600;

  const cacheSeconds =
    Math.max(
      30,
      expiresIn -
        TOKEN_SAFETY_MARGIN_SECONDS
    );

  const cached:
    CachedSpotifyAccessToken = {
      accessToken:
        data.access_token,

      expiresAt:
        Date.now() +
        cacheSeconds * 1000,
    };


  await redis.set(
    ACCESS_TOKEN_CACHE_KEY,
    JSON.stringify(
      cached
    )
  );

  await redis.expire(
    ACCESS_TOKEN_CACHE_KEY,
    cacheSeconds
  );


  return data.access_token;
}


/**
 * Get a cached access token when possible.
 */
async function getSpotifyAccessToken(
  forceRefresh = false
): Promise<string> {
  if (!forceRefresh) {
    const cached =
      await getCachedSpotifyAccessToken();

    if (cached) {
      return cached;
    }
  }

  return refreshSpotifyAccessToken();
}


/**
 * Central Spotify Web API request helper.
 *
 * Responsibilities:
 *
 * - obey Redis-backed cooldown
 * - reuse cached access token
 * - refresh/retry once on HTTP 401
 * - capture HTTP 429 Retry-After
 * - recognize Devvit's own "too many requests" fetch rejection
 */
async function spotifyApiFetch(
  url: string | URL
): Promise<Response> {
  await enforceSpotifyCooldown();

  let accessToken =
    await getSpotifyAccessToken();


  for (
    let attempt = 0;
    attempt < 2;
    attempt += 1
  ) {
    let response: Response;

    try {
      response =
        await fetch(
          url.toString(),
          {
            headers: {
              Authorization:
                `Bearer ${accessToken}`,
            },
          }
        );
    } catch (error) {
      if (
        isDevvitRateLimitError(
          error
        )
      ) {
        const retryAt =
          await setSpotifyCooldown(
            DEVVIT_RATE_LIMIT_FALLBACK_SECONDS,
            'Devvit blocked Spotify API request due to too many requests'
          );

        throw new SpotifyCooldownError(
          retryAt
        );
      }

      throw error;
    }


    /**
     * Cached access token unexpectedly expired/revoked.
     *
     * Clear it and retry exactly once with a fresh token.
     */
    if (
      response.status === 401 &&
      attempt === 0
    ) {
      await clearCachedSpotifyAccessToken();

      accessToken =
        await getSpotifyAccessToken(
          true
        );

      continue;
    }


    /**
     * Spotify explicitly rate limited us.
     */
    if (
      response.status === 429
    ) {
      const retrySeconds =
        getRetryAfterSeconds(
          response
        );

      const retryAt =
        await setSpotifyCooldown(
          retrySeconds,
          'Spotify API returned 429'
        );

      throw new SpotifyCooldownError(
        retryAt
      );
    }


    return response;
  }


  throw new Error(
    'Spotify API authentication retry exhausted'
  );
}


/**
 * Extract a Spotify playlist ID from playback context.
 */
function getPlaylistId(
  context:
    | SpotifyPlaybackContext
    | null
    | undefined
): string | undefined {
  if (
    !context ||
    context.type !==
      'playlist'
  ) {
    return undefined;
  }


  /**
   * Preferred URI:
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
   * Fallback to Spotify's API URL.
   */
  if (context.href) {
    try {
      const url =
        new URL(
          context.href
        );

      const parts =
        url.pathname
          .split('/')
          .filter(Boolean);

      const playlistIndex =
        parts.indexOf(
          'playlists'
        );

      if (
        playlistIndex >= 0 &&
        parts[
          playlistIndex + 1
        ]
      ) {
        return parts[
          playlistIndex + 1
        ];
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
 * Playlist context is captured here, but friendly playlist metadata is
 * resolved only when the Reddit status actually needs updating.
 */
export async function getCurrentSpotifyPlayback():
  Promise<SpotifyPlayback> {
  const response =
    await spotifyApiFetch(
      'https://api.spotify.com/v1/me/player/currently-playing'
    );


  if (
    response.status === 204
  ) {
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
    (await response.json()) as
      SpotifyCurrentlyPlayingResponse;


  if (
    !data.item ||
    data.currently_playing_type !==
      'track'
  ) {
    return {
      isPlaying:
        data.is_playing,
    };
  }


  const playlistId =
    getPlaylistId(
      data.context
    );

  const playlistUrl =
    data.context?.type ===
    'playlist'
      ? data.context
          .external_urls
          ?.spotify
      : undefined;


  return {
    isPlaying:
      data.is_playing,

    track:
      data.item.name,

    artists:
      data.item.artists?.map(
        (artist) =>
          artist.name
      ) ?? [],

    ...(data.item.id !==
    undefined
      ? {
          trackId:
            data.item.id,
        }
      : {}),

    ...(data.item
      .external_urls
      ?.spotify !==
    undefined
      ? {
          trackUrl:
            data.item
              .external_urls
              .spotify,
        }
      : {}),

    ...(data.item.album
      ?.name !==
    undefined
      ? {
          album:
            data.item.album
              .name,
        }
      : {}),

    ...(playlistId !==
    undefined
      ? {
          playlistId,
        }
      : {}),

    ...(playlistUrl !==
    undefined
      ? {
          playlistUrl,
        }
      : {}),
  };
}


/**
 * Build the Redis key for one playlist's friendly metadata.
 */
function getPlaylistCacheKey(
  playlistId: string
): string {
  return (
    PLAYLIST_CACHE_PREFIX +
    playlistId
  );
}


/**
 * Retrieve friendly playlist metadata from Redis.
 */
async function getCachedPlaylist(
  playlistId: string
): Promise<
  CachedSpotifyPlaylist |
  undefined
> {
  const value =
    await redis.get(
      getPlaylistCacheKey(
        playlistId
      )
    );

  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(
      value
    ) as CachedSpotifyPlaylist;
  } catch {
    await redis.del(
      getPlaylistCacheKey(
        playlistId
      )
    );

    return undefined;
  }
}


/**
 * Cache friendly playlist metadata.
 */
async function saveCachedPlaylist(
  playlistId: string,
  playlist: CachedSpotifyPlaylist
): Promise<void> {
  const key =
    getPlaylistCacheKey(
      playlistId
    );

  await redis.set(
    key,
    JSON.stringify(
      playlist
    )
  );

  await redis.expire(
    key,
    PLAYLIST_CACHE_SECONDS
  );
}


/**
 * Resolve friendly playlist metadata only when we actually need to
 * publish a changed playback state.
 *
 * Playlist enrichment remains non-fatal.
 */
export async function resolveSpotifyPlaylistContext(
  playback: SpotifyPlayback
): Promise<SpotifyPlayback> {
  if (
    !playback.playlistId
  ) {
    return playback;
  }


  /**
   * Prefer Redis before asking Spotify again.
   */
  const cached =
    await getCachedPlaylist(
      playback.playlistId
    );

  if (cached) {
    return {
      ...playback,

      ...(cached.name
        ? {
            playlistName:
              cached.name,
          }
        : {}),

      ...(cached.url
        ? {
            playlistUrl:
              cached.url,
          }
        : {}),
    };
  }


  try {
    const playlistUrl =
      new URL(
        `https://api.spotify.com/v1/playlists/${encodeURIComponent(
          playback.playlistId
        )}`
      );

    playlistUrl.searchParams.set(
      'fields',
      'name,external_urls'
    );


    const response =
      await spotifyApiFetch(
        playlistUrl
      );


    if (!response.ok) {
      console.warn(
        `[Now Processing] Spotify playlist lookup failed (${response.status})`
      );

      return playback;
    }


    const data =
      (await response.json()) as
        SpotifyPlaylistResponse;


    const resolvedPlaylistUrl =
      data.external_urls
        ?.spotify ??
      playback.playlistUrl;


    const playlistCache:
      CachedSpotifyPlaylist = {
        ...(data.name
          ? {
              name:
                data.name,
            }
          : {}),

        ...(resolvedPlaylistUrl
          ? {
              url:
                resolvedPlaylistUrl,
            }
          : {}),
      };


    await saveCachedPlaylist(
      playback.playlistId,
      playlistCache
    );


    return {
      ...playback,

      ...(data.name !==
      undefined
        ? {
            playlistName:
              data.name,
          }
        : {}),

      ...(resolvedPlaylistUrl !==
      undefined
        ? {
            playlistUrl:
              resolvedPlaylistUrl,
          }
        : {}),
    };
  } catch (error) {
    /**
     * A playlist metadata lookup is optional.
     *
     * If this request caused a Spotify cooldown, preserve the cooldown
     * in Redis but still allow the current song itself to publish.
     */
    if (
      error instanceof
      SpotifyCooldownError
    ) {
      console.warn(
        '[Now Processing] Spotify playlist enrichment skipped because Spotify is rate limited'
      );

      return playback;
    }


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