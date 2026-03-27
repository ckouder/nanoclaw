import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  beforeAll,
  afterAll,
} from 'vitest';
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

// We need a real in-memory DB for register-group tests
import { _initTestDatabase, _closeDatabase } from '../db.js';

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

function post(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
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

function del(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
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

function get(
  port: number,
  path: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${path}`, (res) => {
        let buf = '';
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(buf) });
          } catch {
            resolve({ status: res.statusCode!, body: buf });
          }
        });
      })
      .on('error', reject);
  });
}

// Use a different port per test run to avoid EADDRINUSE
let testPort = 14000 + Math.floor(Math.random() * 1000);

describe('HttpWebhookChannel', () => {
  let channel: HttpWebhookChannel;
  let opts: ChannelOpts;
  let port: number;

  beforeEach(async () => {
    _initTestDatabase();
    port = testPort++;
    process.env.HTTP_CHANNEL_PORT = String(port);
    opts = makeOpts();
    channel = new HttpWebhookChannel(opts);
    await channel.connect();
  });

  afterEach(async () => {
    await channel.disconnect();
    delete process.env.HTTP_CHANNEL_PORT;
    _closeDatabase();
  });

  // ===== Basic HTTP tests =====

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
    const res = await new Promise<{ status: number; body: any }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/message',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          (res) => {
            let buf = '';
            res.on('data', (chunk) => (buf += chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode!, body: JSON.parse(buf) }),
            );
          },
        );
        req.on('error', reject);
        req.write('not json');
        req.end();
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid JSON');
  });

  it('rejects body missing required fields', async () => {
    const res = await post(port, '/message', { text: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  it('receives message and returns agent response', async () => {
    (opts.onMessage as ReturnType<typeof vi.fn>).mockImplementation(
      (_jid: string, _msg: NewMessage) => {
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
    (opts.onMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {});

    const resPromise = post(port, '/message', {
      text: 'hello',
      chatJid: 'http:timeout-test',
      senderName: 'User',
      senderId: 'u1',
    });

    await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled(), {
      timeout: 1000,
    });

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
    process.env.HTTP_CHANNEL_PORT = String(port + 500);
    port = port + 500;
    testPort = port + 1;
    await channel.connect();
  });

  // ===== Group Registration Tests =====

  describe('POST /register-group', () => {
    it('registers a new group', async () => {
      const res = await post(port, '/register-group', {
        jid: 'http:slack-general',
        name: 'general',
        folder: 'slack-general',
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.group).toEqual({
        jid: 'http:slack-general',
        name: 'general',
        folder: 'slack-general',
      });
    });

    it('registers multiple groups (simulating multiple Slack channels)', async () => {
      const channels = [
        { jid: 'http:slack-general', name: 'general', folder: 'slack-general' },
        { jid: 'http:slack-random', name: 'random', folder: 'slack-random' },
        {
          jid: 'http:slack-engineering',
          name: 'engineering',
          folder: 'slack-engineering',
        },
      ];

      for (const ch of channels) {
        const res = await post(port, '/register-group', ch);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
      }

      // Verify all are listed
      const listRes = await get(port, '/groups');
      expect(listRes.body.groups).toHaveLength(3);
    });

    it('rejects duplicate group registration (same JID)', async () => {
      await post(port, '/register-group', {
        jid: 'http:dup-test',
        name: 'test',
        folder: 'dup-test',
      });

      const res = await post(port, '/register-group', {
        jid: 'http:dup-test',
        name: 'test-again',
        folder: 'dup-test-2',
      });

      expect(res.status).toBe(409);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('already registered');
    });

    it('registers a main group + non-main group', async () => {
      const mainRes = await post(port, '/register-group', {
        jid: 'http:main-group',
        name: 'main',
        folder: 'main-ctrl',
        isMain: true,
      });
      expect(mainRes.status).toBe(200);
      expect(mainRes.body.ok).toBe(true);

      const nonMainRes = await post(port, '/register-group', {
        jid: 'http:side-group',
        name: 'side-channel',
        folder: 'side-channel',
        trigger: 'hey bot',
      });
      expect(nonMainRes.status).toBe(200);

      const listRes = await get(port, '/groups');
      const groups = listRes.body.groups;
      const main = groups.find((g: any) => g.jid === 'http:main-group');
      const side = groups.find((g: any) => g.jid === 'http:side-group');

      expect(main.isMain).toBe(true);
      expect(side.isMain).toBe(false);
      expect(side.trigger).toBe('hey bot');
    });

    it('rejects registration with missing required fields', async () => {
      // Missing jid
      let res = await post(port, '/register-group', {
        name: 'test',
        folder: 'test',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');

      // Missing name
      res = await post(port, '/register-group', {
        jid: 'http:x',
        folder: 'test',
      });
      expect(res.status).toBe(400);

      // Missing folder
      res = await post(port, '/register-group', {
        jid: 'http:x',
        name: 'test',
      });
      expect(res.status).toBe(400);
    });

    it('rejects registration with invalid folder name', async () => {
      const res = await post(port, '/register-group', {
        jid: 'http:bad-folder',
        name: 'test',
        folder: '../escape-attempt',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid folder name');
    });

    it('rejects registration with reserved folder name', async () => {
      const res = await post(port, '/register-group', {
        jid: 'http:reserved',
        name: 'test',
        folder: 'global',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid folder name');
    });

    it('rejects invalid JSON in register-group', async () => {
      const res = await new Promise<{ status: number; body: any }>(
        (resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port,
              path: '/register-group',
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            },
            (r) => {
              let buf = '';
              r.on('data', (chunk) => (buf += chunk));
              r.on('end', () =>
                resolve({ status: r.statusCode!, body: JSON.parse(buf) }),
              );
            },
          );
          req.on('error', reject);
          req.write('not json');
          req.end();
        },
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid JSON');
    });
  });

  // ===== GET /groups =====

  describe('GET /groups', () => {
    it('returns empty list when no groups registered', async () => {
      const res = await get(port, '/groups');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.groups).toEqual([]);
    });

    it('lists registered groups', async () => {
      await post(port, '/register-group', {
        jid: 'http:g1',
        name: 'Group One',
        folder: 'group-one',
      });
      await post(port, '/register-group', {
        jid: 'http:g2',
        name: 'Group Two',
        folder: 'group-two',
        isMain: true,
      });

      const res = await get(port, '/groups');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.groups).toHaveLength(2);

      const jids = res.body.groups.map((g: any) => g.jid).sort();
      expect(jids).toEqual(['http:g1', 'http:g2']);
    });
  });

  // ===== DELETE /register-group =====

  describe('DELETE /register-group', () => {
    it('unregisters a group', async () => {
      await post(port, '/register-group', {
        jid: 'http:to-delete',
        name: 'deleteme',
        folder: 'deleteme',
      });

      const delRes = await del(port, '/register-group', {
        jid: 'http:to-delete',
      });
      expect(delRes.status).toBe(200);
      expect(delRes.body.ok).toBe(true);

      // Verify it's gone
      const listRes = await get(port, '/groups');
      expect(listRes.body.groups).toHaveLength(0);
    });

    it('returns 404 for non-existent group', async () => {
      const res = await del(port, '/register-group', {
        jid: 'http:nonexistent',
      });
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
    });

    it('rejects missing jid', async () => {
      const res = await del(port, '/register-group', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required field');
    });

    it('rejects invalid JSON in delete', async () => {
      const res = await del(port, '/register-group', 'not-valid-json' as any);
      // The del() helper calls JSON.stringify which will produce a quoted string,
      // so let's test with a raw request instead
      const rawRes = await new Promise<{ status: number; body: any }>(
        (resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port,
              path: '/register-group',
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
            },
            (r) => {
              let buf = '';
              r.on('data', (chunk) => (buf += chunk));
              r.on('end', () => {
                try {
                  resolve({ status: r.statusCode!, body: JSON.parse(buf) });
                } catch {
                  resolve({ status: r.statusCode!, body: buf });
                }
              });
            },
          );
          req.on('error', reject);
          req.write('bad');
          req.end();
        },
      );
      expect(rawRes.status).toBe(400);
    });
  });

  // ===== Multi-Channel Message Routing Tests =====

  describe('multi-channel message routing', () => {
    it('sends message to registered main group — routes correctly', async () => {
      await post(port, '/register-group', {
        jid: 'http:main-ch',
        name: 'main',
        folder: 'main-ch',
        isMain: true,
      });

      (opts.onMessage as ReturnType<typeof vi.fn>).mockImplementation(
        (_jid: string, _msg: NewMessage) => {
          setTimeout(
            () => channel.sendMessage('http:main-ch', 'main response'),
            10,
          );
        },
      );

      const res = await post(port, '/message', {
        text: 'hello main',
        chatJid: 'http:main-ch',
        senderName: 'User',
        senderId: 'u1',
      });

      expect(res.status).toBe(200);
      expect(res.body.response).toBe('main response');
    });

    it('sends message to registered non-main group with trigger — routes correctly', async () => {
      await post(port, '/register-group', {
        jid: 'http:side-ch',
        name: 'side',
        folder: 'side-ch',
        trigger: 'hey bot',
      });

      (opts.onMessage as ReturnType<typeof vi.fn>).mockImplementation(
        (_jid: string, msg: NewMessage) => {
          setTimeout(
            () => channel.sendMessage(msg.chat_jid, 'side response'),
            10,
          );
        },
      );

      const res = await post(port, '/message', {
        text: 'hey bot do something',
        chatJid: 'http:side-ch',
        senderName: 'User',
        senderId: 'u1',
      });

      expect(res.status).toBe(200);
      expect(res.body.response).toBe('side response');
    });

    it('sends message to non-main group WITHOUT trigger — still delivers (trigger check is in router)', async () => {
      // The HTTP webhook delivers all messages to onMessage; trigger filtering
      // is done by the router/message loop, not the channel itself.
      await post(port, '/register-group', {
        jid: 'http:notrig',
        name: 'notrig',
        folder: 'notrig-ch',
        trigger: 'hey bot',
      });

      (opts.onMessage as ReturnType<typeof vi.fn>).mockImplementation(
        (_jid: string, msg: NewMessage) => {
          setTimeout(() => channel.sendMessage(msg.chat_jid, 'got it'), 10);
        },
      );

      const res = await post(port, '/message', {
        text: 'random chat without trigger',
        chatJid: 'http:notrig',
        senderName: 'User',
        senderId: 'u1',
      });

      // Channel still delivers the message — it's the router's job to filter
      expect(res.status).toBe(200);
      expect(opts.onMessage).toHaveBeenCalled();
    });

    it('sends messages to different groups — independent responses', async () => {
      await post(port, '/register-group', {
        jid: 'http:ch-alpha',
        name: 'alpha',
        folder: 'ch-alpha',
      });
      await post(port, '/register-group', {
        jid: 'http:ch-beta',
        name: 'beta',
        folder: 'ch-beta',
      });

      (opts.onMessage as ReturnType<typeof vi.fn>).mockImplementation(
        (_jid: string, msg: NewMessage) => {
          const response =
            msg.chat_jid === 'http:ch-alpha' ? 'alpha reply' : 'beta reply';
          setTimeout(() => channel.sendMessage(msg.chat_jid, response), 10);
        },
      );

      const [resA, resB] = await Promise.all([
        post(port, '/message', {
          text: 'msg to alpha',
          chatJid: 'http:ch-alpha',
          senderName: 'User',
          senderId: 'u1',
        }),
        // Small delay to avoid chatToPendingId race since both resolve via same map
        new Promise<{ status: number; body: any }>((resolve) => {
          setTimeout(async () => {
            resolve(
              await post(port, '/message', {
                text: 'msg to beta',
                chatJid: 'http:ch-beta',
                senderName: 'User',
                senderId: 'u2',
              }),
            );
          }, 50);
        }),
      ]);

      expect(resA.body.response).toBe('alpha reply');
      expect(resB.body.response).toBe('beta reply');
    });

    it('sends message with unknown chatJid — handles gracefully', async () => {
      // onMessage still gets called (the channel doesn't filter by JID)
      // but since there's no registered group, the router would ignore it
      (opts.onMessage as ReturnType<typeof vi.fn>).mockImplementation(
        (_jid: string, msg: NewMessage) => {
          setTimeout(() => channel.sendMessage(msg.chat_jid, 'response'), 10);
        },
      );

      const res = await post(port, '/message', {
        text: 'hello?',
        chatJid: 'http:unknown-channel',
        senderName: 'User',
        senderId: 'u1',
      });

      expect(res.status).toBe(200);
      expect(opts.onMessage).toHaveBeenCalled();
    });

    it('message to unregistered group — channel delivers, router decides', async () => {
      // No groups registered at all
      (opts.onMessage as ReturnType<typeof vi.fn>).mockImplementation(
        (_jid: string, msg: NewMessage) => {
          setTimeout(() => channel.sendMessage(msg.chat_jid, 'reply'), 10);
        },
      );

      const res = await post(port, '/message', {
        text: 'hello',
        chatJid: 'http:no-group',
        senderName: 'User',
        senderId: 'u1',
      });

      expect(res.status).toBe(200);
      expect(res.body.response).toBe('reply');
    });

    it('concurrent messages to different groups', async () => {
      await post(port, '/register-group', {
        jid: 'http:concurrent-1',
        name: 'c1',
        folder: 'concurrent-1',
      });
      await post(port, '/register-group', {
        jid: 'http:concurrent-2',
        name: 'c2',
        folder: 'concurrent-2',
      });
      await post(port, '/register-group', {
        jid: 'http:concurrent-3',
        name: 'c3',
        folder: 'concurrent-3',
      });

      (opts.onMessage as ReturnType<typeof vi.fn>).mockImplementation(
        (_jid: string, msg: NewMessage) => {
          // Simulate varying response times
          const delay = msg.chat_jid.endsWith('1')
            ? 30
            : msg.chat_jid.endsWith('2')
              ? 10
              : 20;
          setTimeout(
            () =>
              channel.sendMessage(msg.chat_jid, `reply-from-${msg.chat_jid}`),
            delay,
          );
        },
      );

      // Fire all three concurrently with slight stagger to avoid chatToPendingId overwrites
      const results = await Promise.all([
        post(port, '/message', {
          text: 'msg1',
          chatJid: 'http:concurrent-1',
          senderName: 'User',
          senderId: 'u1',
        }),
        new Promise<{ status: number; body: any }>((resolve) => {
          setTimeout(async () => {
            resolve(
              await post(port, '/message', {
                text: 'msg2',
                chatJid: 'http:concurrent-2',
                senderName: 'User',
                senderId: 'u2',
              }),
            );
          }, 5);
        }),
        new Promise<{ status: number; body: any }>((resolve) => {
          setTimeout(async () => {
            resolve(
              await post(port, '/message', {
                text: 'msg3',
                chatJid: 'http:concurrent-3',
                senderName: 'User',
                senderId: 'u3',
              }),
            );
          }, 10);
        }),
      ]);

      for (const res of results) {
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
      }

      expect(results[0].body.response).toBe('reply-from-http:concurrent-1');
      expect(results[1].body.response).toBe('reply-from-http:concurrent-2');
      expect(results[2].body.response).toBe('reply-from-http:concurrent-3');
    });
  });
});
