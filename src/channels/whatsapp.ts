import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  STORE_DIR,
} from '../config.js';
import { log } from '../log.js';
import type {
  ChannelAdapter,
  ChannelSetup,
  OutboundMessage,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

class WhatsAppAdapter implements ChannelAdapter {
  name = 'whatsapp';
  channelType = 'whatsapp';
  supportsThreads = false;

  private sock!: WASocket;
  private _connected = false;
  private _setup!: ChannelSetup;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private lastGroupSync = 0;
  private groupSyncTimerStarted = false;

  async setup(config: ChannelSetup): Promise<void> {
    this._setup = config;
    await new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  async teardown(): Promise<void> {
    this._connected = false;
    this.sock?.end(undefined);
  }

  isConnected(): boolean {
    return this._connected;
  }

  async deliver(
    platformId: string,
    _threadId: string | null,
    message: OutboundMessage,
  ): Promise<string | undefined> {
    const content = message.content as { text?: string } | null;
    const text = content?.text ?? JSON.stringify(content);
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (!this._connected) {
      this.outgoingQueue.push({ jid: platformId, text: prefixed });
      log.info('WA disconnected, message queued', {
        jid: platformId,
        queueSize: this.outgoingQueue.length,
      });
      return;
    }
    try {
      const result = await this.sock.sendMessage(platformId, {
        text: prefixed,
      });
      return result?.key?.id ?? undefined;
    } catch (err) {
      this.outgoingQueue.push({ jid: platformId, text: prefixed });
      log.warn('Failed to send, message queued', {
        jid: platformId,
        err,
        queueSize: this.outgoingQueue.length,
      });
    }
  }

  async setTyping(platformId: string, _threadId: string | null): Promise<void> {
    try {
      await this.sock.sendPresenceUpdate('composing', platformId);
    } catch (err) {
      log.debug('Failed to update typing status', { jid: platformId, err });
    }
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch(() => ({
      version: undefined,
    }));

    // Baileys expects a pino-compatible logger with level/child/trace.
    // Wrap our minimal log into a compatible shim.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baileysLogger: any = {
      level: 'silent',
      child: () => baileysLogger,
      trace: () => {},
      debug: (data: Record<string, unknown>, msg?: string) =>
        log.debug(msg ?? '', data),
      info: (data: Record<string, unknown>, msg?: string) =>
        log.info(msg ?? '', data),
      warn: (data: Record<string, unknown>, msg?: string) =>
        log.warn(msg ?? '', data),
      error: (data: Record<string, unknown>, msg?: string) =>
        log.error(msg ?? '', data),
      fatal: (data: Record<string, unknown>, msg?: string) =>
        log.fatal(msg ?? '', data),
    };

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: Browsers.macOS('Chrome'),
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        log.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this._connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        log.info('Connection closed', {
          reason,
          shouldReconnect,
          queuedMessages: this.outgoingQueue.length,
        });

        if (shouldReconnect) {
          log.info('Reconnecting...');
          this.connectInternal().catch((err) => {
            log.error('Failed to reconnect, retrying in 5s', { err });
            setTimeout(() => {
              this.connectInternal().catch((err2) =>
                log.error('Reconnection retry failed', { err: err2 }),
              );
            }, 5000);
          });
        } else {
          log.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        this._connected = true;
        log.info('connected to WA');

        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
          }
        }

        this.sock
          .sendPresenceUpdate('available')
          .catch((err) => log.warn('Failed to send presence update', { err }));
        this.flushOutgoingQueue().catch((err) =>
          log.error('Failed to flush outgoing queue', { err }),
        );
        this.syncGroupMetadata().catch((err) =>
          log.error('Initial group sync failed', { err }),
        );

        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              log.error('Periodic group sync failed', { err }),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const normalized = normalizeMessageContent(msg.message);
        if (!normalized) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        const chatJid = await this.translateJid(rawJid);
        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();
        const isGroup = chatJid.endsWith('@g.us');

        this._setup.onMetadata(chatJid, undefined, isGroup);

        const content =
          normalized.conversation ||
          normalized.extendedTextMessage?.text ||
          normalized.imageMessage?.caption ||
          normalized.videoMessage?.caption ||
          '';

        if (!content) continue;

        const sender = msg.key.participant || msg.key.remoteJid || '';
        const senderName = msg.pushName || sender.split('@')[0];
        const fromMe = msg.key.fromMe || false;
        const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
          ? fromMe
          : content.startsWith(`${ASSISTANT_NAME}:`);

        if (isBotMessage) continue;

        this._setup.onInbound(chatJid, null, {
          id: msg.key.id || `wa-${Date.now()}`,
          kind: 'chat',
          content: { text: content, sender: senderName },
          timestamp,
          isGroup,
        });
      }
    });
  }

  private async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      if (
        this.lastGroupSync &&
        Date.now() - this.lastGroupSync < GROUP_SYNC_INTERVAL_MS
      )
        return;
    }
    try {
      log.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();
      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          this._setup.onMetadata(jid, metadata.subject, true);
          count++;
        }
      }
      this.lastGroupSync = Date.now();
      log.info('Group metadata synced', { count });
    } catch (err) {
      log.error('Failed to sync group metadata', { err });
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    const cached = this.lidToPhoneMap[lidUser];
    if (cached) return cached;

    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        return phoneJid;
      }
    } catch (err) {
      log.debug('Failed to resolve LID via signalRepository', { err, jid });
    }
    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      log.info('Flushing outgoing message queue', {
        count: this.outgoingQueue.length,
      });
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sock.sendMessage(item.jid, { text: item.text });
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannelAdapter('whatsapp', { factory: () => new WhatsAppAdapter() });
