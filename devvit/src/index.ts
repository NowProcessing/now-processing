import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import {
  createServer,
  getServerPort,
  type TaskRequest,
  type TaskResponse,
} from '@devvit/web/server';

/**
 * Minimal Now Processing Devvit server.
 *
 * First goal:
 * prove that Reddit's hosted scheduler can invoke this app once per minute.
 *
 * Spotify, Redis state, and Reddit post editing come later.
 */
const app = new Hono();

/**
 * Scheduled heartbeat.
 *
 * The recurring task in devvit.json calls this endpoint once per minute.
 * Seeing these timestamps in Devvit logs proves the app is executing on
 * Reddit's infrastructure rather than depending on this PC.
 */
app.post('/internal/scheduler/heartbeat', async (c) => {
  await c.req.json<TaskRequest>();

  const timestamp = new Date().toISOString();

  console.log(`[Now Processing] scheduler heartbeat ${timestamp}`);

  return c.json<TaskResponse>(
    {
      status: 'ok',
    },
    200
  );
});

/**
 * Simple development health endpoint.
 */
app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    app: 'now-processing',
  })
);

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});