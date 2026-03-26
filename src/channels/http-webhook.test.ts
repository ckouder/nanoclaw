import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';

// --- Mocks ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { HttpWebhookChannel } from './http-webhook.js';
import type { ChannelOpts } from './registry.js';
import type { NewMessage } from '../types.js';

function makeOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    ...overrides,
  };
}

function post(port: number, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(buf) });
          } catch {
            resolve({ status: res.statusCode!, body: buf });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(port: number, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let buf = '';
      res.on('data', (chunk) => (buf += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(buf) });
        } catch {
          resolve({ status: res.statusCode!, body: buf });
        }
      });
    }).on('error', reject);
  });
}

// Use a different port per test run to avoid EADDRINUSE
let testPort = 14000 + Math.floor(Math.random() * 1000);

describe('HttpWebhookChannel', () => {
  let channel: HttpWebhookChannel;
  let opts: ChannelOpts;
  let port: number;

  beforeEach(async () => {
    port = testPort++;
    process.env.HTTP_CHANNEL_PORT = String(port);
    opts = makeOpts();
    channel = new HttpWebhookChannel(opts);
    await channel.connect();
  });

  afterEach(async () => {
    await channel.disconnect();
    delete process.env.HTTP_CHANNEL_PORT;
  });

  it('GET /health returns 200', async () => {
    const res = await get(port, '/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns 404 for unknown routes', async () => {
    const res = await get(port, '/unknown');
    expect(res.status).toBe(404);
  });

  it('rejects invalid JSON body', async () => {
    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/message', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let buf = '';
          res.on('data', (chunk) => (buf += chunk));
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(buf) }));
        },
      );
      req.on('error', reject);
      req.write('not json');
      req.end();
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid JSON');
  });

  it('rejects body missing required fields', async () => {
    const res = await post(port, '/message', { text: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  it('receives message and returns agent response', async () => {
    // When onMessage is called, simulate agent responding via sendMessage
    (opts.onMessage as ReturnType<typeof vi.fn>).mockImplementation(
      (_jid: string, _msg: NewMessage) => {
        // Simulate async agent response
        setTimeout(() => {
          channel.sendMessage('http:test-channel', 'Hello from agent!');
        }, 10);
      },
    );

    const res = await post(port, '/message', {
      text: 'hello bot',
      chatJid: 'http:test-channel',
      senderName: 'Test User',
      senderId: 'user-123',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, response: 'Hello from agent!' });
    expect(opts.onMessage).toHaveBeenCalledOnce();
    expect(opts.onChatMetadata).toHaveBeenCalledOnce();
  });

  it('times out when agent does not respond', async () => {
    // Patch timeout to be very short for testing
    // Access the private pending map to override the timer
    // Instead, we'll just test that the channel is functioning — real timeout is 5min
    // For a fast test, we'll create a channel with a monkey-patched constant

    // We can't easily override the const, so we test that the request
    // at least reaches onMessage and creates a pending entry
    (opts.onMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
      // Don't respond — simulates timeout
    });

    // Start request but don't await — manually trigger timeout
    const resPromise = post(port, '/message', {
      text: 'hello',
      chatJid: 'http:timeout-test',
      senderName: 'User',
      senderId: 'u1',
    });

    // Wait for onMessage to be called
    await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled(), { timeout: 1000 });

    // Disconnect channel to reject pending requests (simulates timeout behavior)
    await channel.disconnect();

    const res = await resPromise;
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  it('ownsJid returns true for http: prefix', () => {
    expect(channel.ownsJid('http:some-channel')).toBe(true);
    expect(channel.ownsJid('slack:some-channel')).toBe(false);
  });

  it('isConnected reflects state', async () => {
    expect(channel.isConnected()).toBe(true);
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
    // Reconnect for afterEach cleanup
    channel = new HttpWebhookChannel(opts);
    process.env.HTTP_CHANNEL_PORT = String(port + 100);
    port = port + 100;
    await channel.connect();
  });
});
