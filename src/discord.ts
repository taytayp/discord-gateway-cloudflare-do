/** Discord REST API base */
const DISCORD_API = "https://discord.com/api/v10";

/** Pause between reaction calls to stay comfortably under rate limits. */
const REACTION_DELAY_MS = 400;

/** Fallback wait when Discord returns 429 without a usable retry_after. */
const DEFAULT_RETRY_AFTER_SECONDS = 1;

/** Subset of Discord's MESSAGE_CREATE payload used by the bot. */
export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  guild_id?: string;
  mentions?: Array<{ id: string }>;
}

/**
 * Small helper bound to a single incoming message.
 *
 * Use this inside `handleMessage` instead of building Discord REST calls
 * by hand:
 *
 * ```ts
 * await discord.reply("Pong! 🏓");
 * await discord.replyWithGif("bong!", GIF_URL);
 * await discord.react("👀");
 * await discord.send(otherChannelId, "hello");
 * ```
 */
export interface MessageContext {
  /** The message that triggered this handler. */
  message: DiscordMessage;

  /** Reply in the same channel. */
  reply(content: string): Promise<void>;

  /** Reply in the same channel with a GIF embed. */
  replyWithGif(content: string, url: string): Promise<void>;

  /** Add one or more reactions to the triggering message. */
  react(...emojis: string[]): Promise<void>;

  /** Send a message to any channel. */
  send(channelId: string, content: string): Promise<void>;

  /** Send a GIF embed to any channel. */
  sendGif(channelId: string, content: string, url: string): Promise<void>;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Thin wrapper around the Discord REST endpoints the bot uses.
 * Create one per request/message; construction is cheap.
 */
export class DiscordApi {
  constructor(private readonly botToken: string) {}

  /** Send a plain text message. */
  async sendMessage(channelId: string, content: string): Promise<void> {
    await this.request(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }

  /** Send a message with a GIF embed. */
  async sendGif(
    channelId: string,
    content: string,
    url: string,
  ): Promise<void> {
    await this.request(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content,
        embeds: [{ image: { url } }],
      }),
    });
  }

  /** Add multiple reactions to a message, spacing them out. */
  async addReactions(
    channelId: string,
    messageId: string,
    emojis: string[],
  ): Promise<void> {
    for (let i = 0; i < emojis.length; i++) {
      await this.addReaction(channelId, messageId, emojis[i]);
      if (i < emojis.length - 1) {
        await sleep(REACTION_DELAY_MS);
      }
    }
  }

  /** Add a single reaction, retrying on Discord rate limits. */
  private async addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const url =
      `${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/` +
      `${encodeURIComponent(emoji)}/@me`;

    for (;;) {
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bot ${this.botToken}`,
        },
      });

      if (response.status === 429) {
        const body = (await response.json().catch(() => ({}))) as {
          retry_after?: number;
        };
        const header = response.headers.get("Retry-After");
        const headerSeconds = header ? Number(header) : Number.NaN;
        const retryAfterSeconds =
          body.retry_after ??
          (Number.isFinite(headerSeconds)
            ? headerSeconds
            : DEFAULT_RETRY_AFTER_SECONDS);

        await sleep(retryAfterSeconds * 1000);
        continue;
      }

      if (!response.ok) {
        console.error(
          `Failed to react with ${emoji}:`,
          response.status,
          await response.text(),
        );
      }
      return;
    }
  }

  /** Send an authenticated JSON request and log Discord errors. */
  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bot ${this.botToken}`);
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(`${DISCORD_API}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      console.error(
        `Discord API error (${response.status}):`,
        await response.text(),
      );
    }

    return response;
  }
}

/** Create a Discord REST client for the given bot token. */
export function createDiscordApi(botToken: string): DiscordApi {
  return new DiscordApi(botToken);
}

/**
 * Bind a `MessageContext` to an incoming message.
 * This is what `handleMessage` receives as its second argument.
 */
export function createMessageContext(
  message: DiscordMessage,
  botToken: string,
): MessageContext {
  const api = createDiscordApi(botToken);

  return {
    message,
    reply: (content) => api.sendMessage(message.channel_id, content),
    replyWithGif: (content, url) =>
      api.sendGif(message.channel_id, content, url),
    react: (...emojis) =>
      api.addReactions(message.channel_id, message.id, emojis),
    send: (channelId, content) => api.sendMessage(channelId, content),
    sendGif: (channelId, content, url) =>
      api.sendGif(channelId, content, url),
  };
}
