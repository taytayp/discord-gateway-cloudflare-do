import type { DiscordGatewayOptions } from "./types";
import type { DiscordGatewayDO } from "./durable-object";

export type {
  DiscordGatewayOptions,
  GatewayCredentials,
  GatewayStatus,
  GatewayState,
} from "./types";

export function getGatewayStub(
  options: DiscordGatewayOptions,
): DurableObjectStub<DiscordGatewayDO> {
  const name = options.name ?? "default";
  const id = options.namespace.idFromName(name);
  return options.locationHint
    ? options.namespace.get(id, { locationHint: options.locationHint })
    : options.namespace.get(id);
}

interface Env {
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGatewayDO>;
  DISCORD_BOT_TOKEN: string;
  DISCORD_GATEWAY_SECRET: string;
}

// import { DiscordGatewayDO, getGatewayStub } from "discord-gateway-cloudflare-do";

// Re-export the Durable Object class so Cloudflare can instantiate it
export { DiscordGatewayDO };

interface Env {
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGatewayDO>;
  DISCORD_BOT_TOKEN: string;
  DISCORD_GATEWAY_SECRET: string;
}

/**
  Forwarded Gateway event shape.
 * This is the format DiscordGatewayDO POSTs to your webhook URL.
 */
interface ForwardedEvent {
  type: `GATEWAY_${string}`;
  timestamp: number;
  data: unknown;
}

/** Subset of Discord's MESSAGE_CREATE payload we care about */
interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  guild_id?: string;
  mentions?: Array<{ id: string }>;
}

/** Discord REST API base */
const DISCORD_API = "https://discord.com/api/v10";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── Webhook endpoint ─────────────────────────────────────────────
    // Receives forwarded Gateway events from DiscordGatewayDO
    if (url.pathname === "/webhook" && request.method === "POST") {
      // Verify the request came from our Gateway DO
      const token = request.headers.get("x-discord-gateway-token");
      if (token !== env.DISCORD_GATEWAY_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      const event = (await request.json()) as ForwardedEvent;
      ctx.waitUntil(handleEvent(event, env));
      return new Response("OK", { status: 200 });
    }

    // ── Gateway management ───────────────────────────────────────────

    if (url.pathname === "/gateway/start" && request.method === "POST") {
      const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY });
      const result = await gateway.start({
        botToken: env.DISCORD_BOT_TOKEN,
        webhookUrl: `${url.origin}/webhook`,
        webhookSecret: env.DISCORD_GATEWAY_SECRET,
      });
      return Response.json(result);
    }

    if (url.pathname === "/gateway/disconnect" && request.method === "POST") {
      const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY });
      const result = await gateway.disconnect();
      return Response.json(result);
    }

    if (url.pathname === "/gateway/status" && request.method === "GET") {
      const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY });
      return Response.json(await gateway.status());
    }

    return new Response("Not found", { status: 404 });
  },
};

// ── Event handling ─────────────────────────────────────────────────────

async function handleEvent(event: ForwardedEvent, env: Env): Promise<void> {
  switch (event.type) {
    case "GATEWAY_MESSAGE_CREATE":
      await handleMessage(event.data as DiscordMessage, env);
      break;
    case "GATEWAY_MESSAGE_REACTION_ADD":
      console.log("Reaction added:", event.data);
      break;
    case "GATEWAY_MESSAGE_REACTION_REMOVE":
      console.log("Reaction removed:", event.data);
      break;
  }
}

async function handleMessage(msg: DiscordMessage, env: Env): Promise<void> {
  // Ignore bot messages (including our own)
  if (msg.author.bot) return;

  // Simple echo: reply when someone says "!ping"
  if (msg.content.toLowerCase() === "!ping") {
    await sendMessage(msg.channel_id, "Pong! 🏓", env);
    return;
  }
  if (msg.content.toLowerCase() === "!bing") {
    await sendMessageAttachment(msg.channel_id, "bong! :statue_of_liberty:", env);
    return;
  }
  if (msg.content.toLowerCase().includes("lmao")) {
    if (Math.random() < 0.25) {
      await addReactionToMessage(
        msg.channel_id,
        msg.id,
        ["yusuke:788128744308211762"],
        env
      )
    }
  }

  if (msg.content.toLowerCase().includes(" bot ") || msg.content.toLowerCase() === "bot") {
    await addReactionToMessage(
      msg.channel_id,
      msg.id,
      ["👀"],
      env
    )
  }

  if (msg.content.toLowerCase().includes("dogass")) {
    await addReactionToMessage(
      msg.channel_id,
      msg.id,
      ["🇩", "🇴", "🇬", "🇦", "🇸", "5️⃣"],
      env
    )
  }

  // Reply to DMs
  if (!msg.guild_id) {
    await sendMessage(msg.channel_id, `You said: ${msg.content}`, env);
    return;
  }
}

async function sendMessage(
  channelId: string,
  content: string,
  env: Env,
): Promise<void> {
  await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
}

async function sendMessageAttachment(
  channelId: string,
  content: string,
  env: Env,
): Promise<void> {
  const payload = {
    content: content,
    embeds: [
      {
        image: {
          url: "https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExMnY5aGRsNHh4ajg5MzFxZmJqbG5xMG53ZGFuNW5sd2xxdHl5bG50YSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/BT0rUpCcIaiEbjmsTc/giphy.gif",
        },
      },
    ],
  };

  const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Discord API Error (${response.status}):`, errorText);
  }
}

async function addReactionToMessage(
  channelId: string,
  messageId: string,
  emoji_list: Array<string>,
  env: Env,
) {
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const emoji of emoji_list) {
    const url =
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/` +
      `${encodeURIComponent(emoji)}/@me`;

    while (true) {
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        },
      });

      if (response.status === 429) {
        const body: any = await response.json();
        const retryAfterSeconds =
          body.retry_after ?? Number(response.headers.get("Retry-After")) ?? 1;
        await sleep(retryAfterSeconds * 1000);
        continue; // Retry this emoji
      }

      if (!response.ok) {
        console.error(`Failed for ${emoji}:`, response.status, await response.text());
      }
      break;
    }

    await sleep(400); // Pause before the next emoji
  }
}
