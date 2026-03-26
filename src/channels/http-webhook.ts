import http from 'node:http';

import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, NewMessage, OnInboundMessage, OnChatMetadata } from '../types.js';

const DEFAULT_PORT = 4000;
const REQUEST_TIMEOUT = 300_000; // 5 minutes — matches container timeout

interface IncomingBody {
  text: string;
  chatJid: string;
  senderName: string;
  senderId: string;
  replyTo?: string;
}

interface PendingRequest {
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HttpWebhookChannel implements Channel {
  name = 'http-webhook';

  private server: http.Server;
  private port: number;
  private connected = false;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;

  // Map of message ID → pending HTTP request awaiting agent response
  private pending = new Map<string, PendingRequest>();
  // Map of chatJid → latest pending message ID (for sendMessage routing)
  private chatToPendingId = new Map<string, string>();

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.port = parseInt(process.env.HTTP_CHANNEL_PORT || String(DEFAULT_PORT), 10);
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, () => {
        this.connected = true;
        logger.info({ port: this.port }, 'HTTP webhook channel listening');
        resolve();
      });
      this.server.once('error', reject);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const msgId = this.chatToPendingId.get(jid);
    if (!msgId) {
      logger.warn({ jid }, 'http-webhook: no pending request for JID');
      return;
    }

    const pending = this.pending.get(msgId);
    if (!pending) {
      logger.warn({ jid, msgId }, 'http-webhook: pending request already resolved');
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(msgId);
    this.chatToPendingId.delete(jid);
    pending.resolve(text);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('http:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Channel shutting down'));
      this.pending.delete(id);
    }
    this.chatToPendingId.clear();

    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/message') {
      this.handleMessage(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  }

  private handleMessage(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      let parsed: IncomingBody;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }

      if (!parsed.text || !parsed.chatJid || !parsed.senderName || !parsed.senderId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Missing required fields: text, chatJid, senderName, senderId' }));
        return;
      }

      const msgId = `http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const jid = parsed.chatJid;

      // Report chat metadata
      const timestamp = new Date().toISOString();
      this.onChatMetadata(jid, timestamp, undefined, 'http-webhook', true);

      // Create promise that resolves when sendMessage is called with the response
      const responsePromise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(msgId);
          this.chatToPendingId.delete(jid);
          reject(new Error('Request timeout'));
        }, REQUEST_TIMEOUT);

        this.pending.set(msgId, { resolve, reject, timer });
        this.chatToPendingId.set(jid, msgId);
      });

      // Deliver the message to the handler
      const message: NewMessage = {
        id: msgId,
        chat_jid: jid,
        sender: parsed.senderId,
        sender_name: parsed.senderName,
        content: parsed.text,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      };

      this.onMessage(jid, message);

      // Wait for agent response
      responsePromise
        .then((response) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, response }));
        })
        .catch((err: Error) => {
          const status = err.message === 'Request timeout' ? 504 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        });
    });
  }
}

registerChannel('http-webhook', (opts: ChannelOpts) => {
  const enabled = process.env.HTTP_WEBHOOK_ENABLED;
  if (enabled && enabled !== 'true') {
    logger.info('HTTP webhook channel disabled (HTTP_WEBHOOK_ENABLED != true)');
    return null;
  }
  return new HttpWebhookChannel(opts);
});
