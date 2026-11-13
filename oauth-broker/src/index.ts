import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';

import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';


/**
 * Now Processing OAuth Broker
 *
 * This service performs only the short-lived Spotify OAuth handshake.
 *
 * It does NOT:
 *
 *   - poll Spotify
 *   - publish to Reddit
 *   - maintain listening history
 *   - run the Now Processing scheduler
 *
 * Its only job is:
 *
 *   Devvit
 *      ↓
 *   create short-lived OAuth session
 *      ↓
 *   Spotify authorization
 *      ↓
 *   receive callback
 *      ↓
 *   temporarily hold refresh token
 *      ↓
 *   Devvit redeems token once
 *      ↓
 *   broker deletes its copy
 */


const dynamo =
  DynamoDBDocumentClient.from(
    new DynamoDBClient({})
  );


const SESSIONS_TABLE =
  requireEnvironmentVariable(
    'SESSIONS_TABLE'
  );

const SPOTIFY_CLIENT_ID =
  requireEnvironmentVariable(
    'SPOTIFY_CLIENT_ID'
  );

const SPOTIFY_REDIRECT_URI =
  requireEnvironmentVariable(
    'SPOTIFY_REDIRECT_URI'
  );

const BROKER_API_KEY =
  requireEnvironmentVariable(
    'BROKER_API_KEY'
  );


const SESSION_TTL_SECONDS =
  15 * 60;


const SPOTIFY_SCOPE =
  'user-read-currently-playing';


type SessionStatus =
  | 'PENDING'
  | 'AUTHORIZED'
  | 'DENIED'
  | 'FAILED';


type OAuthSessionRecord = {
  sessionId: string;
  status: SessionStatus;
  redeemSecretHash: string;
  codeVerifier?: string;
  createdAt: number;
  expiresAt: number;
  authorizedAt?: string;
  refreshToken?: string;
  grantedScope?: string;
  errorCode?: string;
};


type SpotifyTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};


export const handler:
  APIGatewayProxyHandlerV2 =
async (
  event
) => {

  const method =
    event.requestContext.http.method;

  const path =
    event.rawPath;


  try {

    if (
      method === 'POST' &&
      path === '/oauth/session'
    ) {
      requireBrokerAuthentication(
        event
      );

      return await createOAuthSession();
    }


    if (
      method === 'GET' &&
      path === '/oauth/callback'
    ) {
      return await handleSpotifyCallback(
        event
      );
    }


    if (
      method === 'POST' &&
      path === '/oauth/redeem'
    ) {
      requireBrokerAuthentication(
        event
      );

      return await redeemOAuthSession(
        event
      );
    }


    return jsonResponse(
      404,
      {
        error: 'not_found',
      }
    );

  } catch (error) {

    console.error(
      '[OAuth Broker] Request failed:',
      error
    );


    return jsonResponse(
      500,
      {
        error: 'internal_error',
      }
    );
  }
};


async function createOAuthSession():
  Promise<APIGatewayProxyResultV2> {

  const now =
    Date.now();

  const expiresAt =
    Math.floor(
      now / 1000
    ) +
    SESSION_TTL_SECONDS;


  const sessionId =
    randomToken(
      32
    );


  const redeemSecret =
    randomToken(
      32
    );


  const codeVerifier =
    randomToken(
      64
    );


  const codeChallenge =
    createHash(
      'sha256'
    )
      .update(
        codeVerifier
      )
      .digest(
        'base64url'
      );


  const record:
    OAuthSessionRecord = {

    sessionId,

    status:
      'PENDING',

    redeemSecretHash:
      hashSecret(
        redeemSecret
      ),

    codeVerifier,

    createdAt:
      now,

    expiresAt,
  };


  await dynamo.send(
    new PutCommand({
      TableName:
        SESSIONS_TABLE,

      Item:
        record,

      ConditionExpression:
        'attribute_not_exists(sessionId)',
    })
  );


  const authorizationUrl =
    new URL(
      'https://accounts.spotify.com/authorize'
    );


  authorizationUrl.search =
    new URLSearchParams({

      client_id:
        SPOTIFY_CLIENT_ID,

      response_type:
        'code',

      redirect_uri:
        SPOTIFY_REDIRECT_URI,

      scope:
        SPOTIFY_SCOPE,

      state:
        sessionId,

      code_challenge_method:
        'S256',

      code_challenge:
        codeChallenge,

    }).toString();


  return jsonResponse(
    201,
    {
      sessionId,
      redeemSecret,
      authorizationUrl:
        authorizationUrl.toString(),
      expiresAt,
    }
  );
}


async function handleSpotifyCallback(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {

  const query =
    event.queryStringParameters ??
    {};


  const sessionId =
    query.state;


  if (!sessionId) {
    return htmlResponse(
      400,
      'Invalid Now Processing connection request.'
    );
  }


  const session =
    await getSession(
      sessionId
    );


  if (
    !session ||
    isExpired(
      session
    )
  ) {
    return htmlResponse(
      400,
      'This Now Processing connection request has expired. Return to Reddit and try again.'
    );
  }


  if (query.error) {

    await markSessionFailed(
      sessionId,
      'DENIED',
      'spotify_authorization_denied'
    );


    return htmlResponse(
      200,
      'Spotify authorization was cancelled. You can close this window and return to Reddit.'
    );
  }


  if (
    session.status ===
      'AUTHORIZED'
  ) {
    return htmlResponse(
      200,
      'Spotify is already connected. You can close this window and return to Reddit.'
    );
  }


  if (
    session.status !==
      'PENDING'
  ) {
    return htmlResponse(
      400,
      'This Spotify connection request is no longer active. Return to Reddit and try again.'
    );
  }


  const authorizationCode =
    query.code;


  if (
    !authorizationCode ||
    !session.codeVerifier
  ) {
    return htmlResponse(
      400,
      'Spotify did not return a valid authorization response.'
    );
  }


  const tokenResponse =
    await fetch(
      'https://accounts.spotify.com/api/token',
      {
        method:
          'POST',

        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded',
        },

        body:
          new URLSearchParams({

            grant_type:
              'authorization_code',

            code:
              authorizationCode,

            redirect_uri:
              SPOTIFY_REDIRECT_URI,

            client_id:
              SPOTIFY_CLIENT_ID,

            code_verifier:
              session.codeVerifier,
          }),
      }
    );


  const token =
    (await tokenResponse.json()) as SpotifyTokenResponse;


  if (
    !tokenResponse.ok ||
    !token.refresh_token
  ) {

    console.warn(
      '[OAuth Broker] Spotify authorization-code exchange failed',
      {
        status:
          tokenResponse.status,

        error:
          token.error,
      }
    );


    await markSessionFailed(
      sessionId,
      'FAILED',
      token.error ??
        'spotify_token_exchange_failed'
    );


    return htmlResponse(
      502,
      'Spotify could not be connected. Return to Reddit and try again.'
    );
  }


  const authorizedAt =
    new Date()
      .toISOString();


  await dynamo.send(
    new UpdateCommand({

      TableName:
        SESSIONS_TABLE,

      Key: {
        sessionId,
      },

      UpdateExpression:
        [
          'SET #status = :authorized',
          'refreshToken = :refreshToken',
          'authorizedAt = :authorizedAt',
          'grantedScope = :scope',
          'REMOVE codeVerifier',
        ].join(' '),

      ConditionExpression:
        '#status = :pending',

      ExpressionAttributeNames: {
        '#status':
          'status',
      },

      ExpressionAttributeValues: {

        ':authorized':
          'AUTHORIZED',

        ':pending':
          'PENDING',

        ':refreshToken':
          token.refresh_token,

        ':authorizedAt':
          authorizedAt,

        ':scope':
          token.scope ??
          SPOTIFY_SCOPE,
      },
    })
  );


  return htmlResponse(
    200,
    'Spotify connected successfully. You can close this window and return to Reddit.'
  );
}


async function redeemOAuthSession(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {

  const body =
    parseJsonBody(
      event
    );


  const sessionId =
    typeof body.sessionId ===
      'string'
      ? body.sessionId
      : undefined;


  const redeemSecret =
    typeof body.redeemSecret ===
      'string'
      ? body.redeemSecret
      : undefined;


  if (
    !sessionId ||
    !redeemSecret
  ) {
    return jsonResponse(
      400,
      {
        error:
          'missing_session_credentials',
      }
    );
  }


  const session =
    await getSession(
      sessionId
    );


  if (
    !session ||
    isExpired(
      session
    )
  ) {
    return jsonResponse(
      404,
      {
        error:
          'session_not_found',
      }
    );
  }


  if (
    !secureEquals(
      hashSecret(
        redeemSecret
      ),
      session.redeemSecretHash
    )
  ) {
    return jsonResponse(
      403,
      {
        error:
          'invalid_redeem_secret',
      }
    );
  }


  if (
    session.status ===
      'PENDING'
  ) {
    return jsonResponse(
      409,
      {
        status:
          'pending',
      }
    );
  }


  if (
    session.status !==
      'AUTHORIZED' ||
    !session.refreshToken
  ) {
    return jsonResponse(
      409,
      {
        status:
          session.status.toLowerCase(),
      }
    );
  }


  const refreshToken =
    session.refreshToken;

  const authorizedAt =
    session.authorizedAt;

  const grantedScope =
    session.grantedScope;


  await dynamo.send(
    new DeleteCommand({

      TableName:
        SESSIONS_TABLE,

      Key: {
        sessionId,
      },

      ConditionExpression:
        '#status = :authorized AND redeemSecretHash = :secretHash',

      ExpressionAttributeNames: {
        '#status':
          'status',
      },

      ExpressionAttributeValues: {

        ':authorized':
          'AUTHORIZED',

        ':secretHash':
          session.redeemSecretHash,
      },
    })
  );


  return jsonResponse(
    200,
    {
      refreshToken,
      authorizedAt,
      grantedScope,
    }
  );
}


async function getSession(
  sessionId: string
): Promise<OAuthSessionRecord | undefined> {

  const result =
    await dynamo.send(
      new GetCommand({

        TableName:
          SESSIONS_TABLE,

        Key: {
          sessionId,
        },

        ConsistentRead:
          true,
      })
    );


  return result.Item as OAuthSessionRecord | undefined;
}


async function markSessionFailed(
  sessionId: string,
  status:
    'DENIED' |
    'FAILED',
  errorCode: string
): Promise<void> {

  await dynamo.send(
    new UpdateCommand({

      TableName:
        SESSIONS_TABLE,

      Key: {
        sessionId,
      },

      UpdateExpression:
        [
          'SET #status = :status',
          'errorCode = :errorCode',
          'REMOVE codeVerifier',
        ].join(' '),

      ExpressionAttributeNames: {
        '#status':
          'status',
      },

      ExpressionAttributeValues: {

        ':status':
          status,

        ':errorCode':
          errorCode,
      },
    })
  );
}


function requireBrokerAuthentication(
  event: APIGatewayProxyEventV2
): void {

  const suppliedKey =
    event.headers[
      'x-now-processing-key'
    ];


  if (
    !suppliedKey ||
    !secureEquals(
      suppliedKey,
      BROKER_API_KEY
    )
  ) {
    throw new Error(
      'Unauthorized broker request'
    );
  }
}


function parseJsonBody(
  event: APIGatewayProxyEventV2
): Record<string, unknown> {

  if (!event.body) {
    return {};
  }


  const raw =
    event.isBase64Encoded
      ? Buffer.from(
          event.body,
          'base64'
        ).toString(
          'utf8'
        )
      : event.body;


  try {

    const parsed =
      JSON.parse(
        raw
      ) as unknown;


    if (
      typeof parsed ===
        'object' &&
      parsed !== null &&
      !Array.isArray(
        parsed
      )
    ) {
      return parsed as Record<string, unknown>;
    }

  } catch {
    // Invalid JSON returns an empty object.
  }


  return {};
}


function randomToken(
  byteLength: number
): string {

  return randomBytes(
    byteLength
  ).toString(
    'base64url'
  );
}


function hashSecret(
  value: string
): string {

  return createHash(
    'sha256'
  )
    .update(
      value
    )
    .digest(
      'hex'
    );
}


function secureEquals(
  left: string,
  right: string
): boolean {

  const leftBuffer =
    Buffer.from(
      left
    );

  const rightBuffer =
    Buffer.from(
      right
    );


  if (
    leftBuffer.length !==
    rightBuffer.length
  ) {
    return false;
  }


  return timingSafeEqual(
    leftBuffer,
    rightBuffer
  );
}


function isExpired(
  session: OAuthSessionRecord
): boolean {

  return (
    session.expiresAt <=
    Math.floor(
      Date.now() /
      1000
    )
  );
}


function jsonResponse(
  statusCode: number,
  body: Record<string, unknown>
): APIGatewayProxyResultV2 {

  return {
    statusCode,

    headers: {
      'Content-Type':
        'application/json; charset=utf-8',

      'Cache-Control':
        'no-store',
    },

    body:
      JSON.stringify(
        body
      ),
  };
}


function htmlResponse(
  statusCode: number,
  message: string
): APIGatewayProxyResultV2 {

  const html =
    [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>Now Processing</title>',
      '</head>',
      '<body>',
      '<main>',
      '<h1>Now Processing</h1>',
      `<p>${escapeHtml(message)}</p>`,
      '</main>',
      '</body>',
      '</html>',
    ].join('');


  return {
    statusCode,

    headers: {

      'Content-Type':
        'text/html; charset=utf-8',

      'Cache-Control':
        'no-store',

      'Content-Security-Policy':
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },

    body:
      html,
  };
}


function escapeHtml(
  value: string
): string {

  return value
    .replaceAll(
      '&',
      '&amp;'
    )
    .replaceAll(
      '<',
      '&lt;'
    )
    .replaceAll(
      '>',
      '&gt;'
    )
    .replaceAll(
      '"',
      '&quot;'
    )
    .replaceAll(
      "'",
      '&#39;'
    );
}


function requireEnvironmentVariable(
  name: string
): string {

  const value =
    process.env[name];


  if (
    !value ||
    value.trim() === ''
  ) {
    throw new Error(
      `Missing required environment variable: ${name}`
    );
  }


  return value;
}

