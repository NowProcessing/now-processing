import {
  redis,
} from '@devvit/web/server';


/**
 * Per-installation Spotify authorization state.
 *
 * Devvit Redis is scoped to the app installation, so each subreddit
 * installation receives its own independent Spotify credentials and
 * connection state.
 *
 * IMPORTANT:
 * The refresh token is stored separately from the public connection
 * metadata so ordinary status checks never have to load or expose it.
 */


/**
 * Redis keys.
 */
const SPOTIFY_REFRESH_TOKEN_KEY =
  'now-processing:spotify-auth:refresh-token';

const SPOTIFY_CONNECTION_KEY =
  'now-processing:spotify-auth:connection';

const SPOTIFY_OAUTH_SESSION_KEY =
  'now-processing:spotify-auth:oauth-session';


/**
 * This is the same access-token cache currently used by spotify.ts.
 *
 * It is included here so disconnect/reconnect operations can invalidate
 * an old Spotify access token immediately.
 */
const SPOTIFY_ACCESS_TOKEN_CACHE_KEY =
  'now-processing:spotify-access-token';


/**
 * Public connection states.
 */
export type SpotifyConnectionStatus =
  | 'disconnected'
  | 'connected'
  | 'reconnect_required';


/**
 * Non-secret information describing the Spotify connection.
 *
 * Never put the refresh token in this object.
 */
export type SpotifyConnection = {
  status: SpotifyConnectionStatus;

  /**
   * ISO timestamp when Spotify authorization most recently succeeded.
   */
  authorizedAt?: string;

  /**
   * Reddit username of the moderator who connected Spotify.
   *
   * Optional because the auth system should not depend on this field.
   */
  connectedBy?: string;

  /**
   * Human-readable internal reason when reauthorization is required.
   */
  reconnectReason?: string;
};


/**
 * Short-lived state used while a moderator is completing Spotify OAuth.
 *
 * sessionId:
 *   Public opaque identifier understood by the OAuth broker.
 *
 * redeemSecret:
 *   Private high-entropy value known only to this Devvit installation
 *   and the broker. It must never be sent through the browser URL.
 *
 * createdAt / expiresAt:
 *   Millisecond Unix timestamps.
 */
export type SpotifyOAuthSession = {
  sessionId: string;
  redeemSecret: string;
  createdAt: number;
  expiresAt: number;
};


/**
 * Validate a parsed SpotifyConnection object.
 */
function isSpotifyConnection(
  value: unknown
): value is SpotifyConnection {

  if (
    typeof value !== 'object' ||
    value === null
  ) {
    return false;
  }


  const candidate =
    value as {
      status?: unknown;
      authorizedAt?: unknown;
      connectedBy?: unknown;
      reconnectReason?: unknown;
    };


  if (
    candidate.status !==
      'disconnected' &&
    candidate.status !==
      'connected' &&
    candidate.status !==
      'reconnect_required'
  ) {
    return false;
  }


  if (
    candidate.authorizedAt !==
      undefined &&
    typeof candidate.authorizedAt !==
      'string'
  ) {
    return false;
  }


  if (
    candidate.connectedBy !==
      undefined &&
    typeof candidate.connectedBy !==
      'string'
  ) {
    return false;
  }


  if (
    candidate.reconnectReason !==
      undefined &&
    typeof candidate.reconnectReason !==
      'string'
  ) {
    return false;
  }


  return true;
}


/**
 * Validate a parsed short-lived OAuth session.
 */
function isSpotifyOAuthSession(
  value: unknown
): value is SpotifyOAuthSession {

  if (
    typeof value !== 'object' ||
    value === null
  ) {
    return false;
  }


  const candidate =
    value as {
      sessionId?: unknown;
      redeemSecret?: unknown;
      createdAt?: unknown;
      expiresAt?: unknown;
    };


  return (
    typeof candidate.sessionId ===
      'string' &&
    candidate.sessionId.length > 0 &&

    typeof candidate.redeemSecret ===
      'string' &&
    candidate.redeemSecret.length > 0 &&

    typeof candidate.createdAt ===
      'number' &&
    Number.isFinite(
      candidate.createdAt
    ) &&

    typeof candidate.expiresAt ===
      'number' &&
    Number.isFinite(
      candidate.expiresAt
    )
  );
}


/**
 * Return the current connection state.
 *
 * A missing or corrupt record safely behaves as disconnected.
 */
export async function getSpotifyConnection():
  Promise<SpotifyConnection> {

  const value =
    await redis.get(
      SPOTIFY_CONNECTION_KEY
    );


  if (!value) {
    return {
      status: 'disconnected',
    };
  }


  try {

    const parsed =
      JSON.parse(
        value
      ) as unknown;


    if (
      isSpotifyConnection(
        parsed
      )
    ) {
      return parsed;
    }

  } catch {
    // Invalid state is handled below.
  }


  console.warn(
    '[Now Processing] Invalid Spotify connection state in Redis'
  );


  return {
    status: 'disconnected',
  };
}


/**
 * Return the installation's Spotify refresh token.
 *
 * This should only be consumed by Spotify authentication code.
 * Never include this value in logs, Reddit posts, menu responses,
 * error messages, or browser URLs.
 */
export async function getSpotifyRefreshToken():
  Promise<string | undefined> {

  const value =
    await redis.get(
      SPOTIFY_REFRESH_TOKEN_KEY
    );


  if (
    !value ||
    value.trim() === ''
  ) {
    return undefined;
  }


  return value;
}


/**
 * Save a newly authorized Spotify connection.
 *
 * The refresh token and public connection metadata are deliberately
 * stored separately.
 */
export async function saveSpotifyConnection(
  refreshToken: string,
  authorizedAt: string,
  connectedBy?: string
): Promise<void> {

  if (
    refreshToken.trim() === ''
  ) {
    throw new Error(
      'Cannot save an empty Spotify refresh token'
    );
  }


  const connection:
    SpotifyConnection = {
      status: 'connected',
      authorizedAt,
    };


  if (
    connectedBy &&
    connectedBy.trim() !== ''
  ) {
    connection.connectedBy =
      connectedBy;
  }


  await redis.mSet({
    [SPOTIFY_REFRESH_TOKEN_KEY]:
      refreshToken,

    [SPOTIFY_CONNECTION_KEY]:
      JSON.stringify(
        connection
      ),
  });


  /**
   * A newly authorized account must never inherit an access token
   * cached for an earlier connection.
   */
  await redis.del(
    SPOTIFY_ACCESS_TOKEN_CACHE_KEY
  );
}


/**
 * Mark the installation as requiring Spotify reauthorization.
 *
 * Spotify now expires refresh tokens after six months. An invalid_grant
 * response must discard the old token rather than retrying forever.
 */
export async function markSpotifyReconnectRequired(
  reason: string
): Promise<void> {

  const current =
    await getSpotifyConnection();


  const connection:
    SpotifyConnection = {
      status:
        'reconnect_required',
      reconnectReason:
        reason,
    };


  if (
    current.authorizedAt
  ) {
    connection.authorizedAt =
      current.authorizedAt;
  }


  if (
    current.connectedBy
  ) {
    connection.connectedBy =
      current.connectedBy;
  }


  await redis.set(
    SPOTIFY_CONNECTION_KEY,
    JSON.stringify(
      connection
    )
  );


  /**
   * An expired/revoked refresh token must not remain usable.
   */
  await Promise.all([
    redis.del(
      SPOTIFY_REFRESH_TOKEN_KEY
    ),

    redis.del(
      SPOTIFY_ACCESS_TOKEN_CACHE_KEY
    ),
  ]);
}


/**
 * Disconnect Spotify from this installation.
 *
 * Listening history and Reddit post state are intentionally untouched.
 * This clears only Spotify authorization/session credentials.
 */
export async function disconnectSpotify():
  Promise<void> {

  await Promise.all([
    redis.del(
      SPOTIFY_REFRESH_TOKEN_KEY
    ),

    redis.del(
      SPOTIFY_CONNECTION_KEY
    ),

    redis.del(
      SPOTIFY_OAUTH_SESSION_KEY
    ),

    redis.del(
      SPOTIFY_ACCESS_TOKEN_CACHE_KEY
    ),
  ]);
}


/**
 * Save a short-lived OAuth pairing session.
 *
 * Redis TTL provides a second expiration mechanism in addition to
 * expiresAt inside the object.
 */
export async function saveSpotifyOAuthSession(
  session: SpotifyOAuthSession
): Promise<void> {

  const remainingMilliseconds =
    session.expiresAt -
    Date.now();


  if (
    remainingMilliseconds <= 0
  ) {
    throw new Error(
      'Cannot save an already-expired Spotify OAuth session'
    );
  }


  const ttlSeconds =
    Math.max(
      1,
      Math.ceil(
        remainingMilliseconds /
        1000
      )
    );


  await redis.set(
    SPOTIFY_OAUTH_SESSION_KEY,
    JSON.stringify(
      session
    )
  );


  await redis.expire(
    SPOTIFY_OAUTH_SESSION_KEY,
    ttlSeconds
  );
}


/**
 * Read the active OAuth pairing session.
 *
 * Expired or corrupt sessions are discarded.
 */
export async function getSpotifyOAuthSession():
  Promise<SpotifyOAuthSession | undefined> {

  const value =
    await redis.get(
      SPOTIFY_OAUTH_SESSION_KEY
    );


  if (!value) {
    return undefined;
  }


  try {

    const parsed =
      JSON.parse(
        value
      ) as unknown;


    if (
      !isSpotifyOAuthSession(
        parsed
      )
    ) {
      throw new Error(
        'Invalid OAuth session shape'
      );
    }


    if (
      parsed.expiresAt <=
      Date.now()
    ) {
      await clearSpotifyOAuthSession();

      return undefined;
    }


    return parsed;

  } catch {

    await clearSpotifyOAuthSession();


    console.warn(
      '[Now Processing] Invalid Spotify OAuth session in Redis'
    );


    return undefined;
  }
}


/**
 * Clear the short-lived OAuth pairing state.
 */
export async function clearSpotifyOAuthSession():
  Promise<void> {

  await redis.del(
    SPOTIFY_OAUTH_SESSION_KEY
  );
}