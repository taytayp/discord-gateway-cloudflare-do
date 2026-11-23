import { DiscordGatewayDO } from "./durable-object";
import {
  createMessageContext,
  createDiscordApi,
  type DiscordMessage,
  type MessageContext,
} from "./discord";
import type {
  DiscordGatewayOptions,
  ForwardedGatewayEvent,
} from "./types";

// Re-export the Durable Object class so Cloudflare can instantiate it.
export { DiscordGatewayDO };

export type {
  DiscordGatewayOptions,
  GatewayCredentials,
  GatewayStatus,
  GatewayState,
} from "./types";

interface Env {
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGatewayDO>;
  DISCORD_BOT_TOKEN: string;
  DISCORD_GATEWAY_SECRET: string;
}

export function getGatewayStub(
  options: DiscordGatewayOptions,
): DurableObjectStub<DiscordGatewayDO> {
  const name = options.name ?? "default";
  const id = options.namespace.idFromName(name);
  return options.locationHint
    ? options.namespace.get(id, { locationHint: options.locationHint })
    : options.namespace.get(id);
}

// -- Bot configuration ----------------------------------------------------

const GIF_URL =
  "https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExMnY5aGRsNHh4ajg5MzFxZmJqbG5xMG53ZGFuNW5sd2xxdHl5bG50YSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/BT0rUpCcIaiEbjmsTc/giphy.gif";

type CommandHandler = (discord: MessageContext) => Promise<void> | void;

/**
 * Exact-match commands, keyed by the lowercased message content.
 * Add new commands here without touching the gateway plumbing.
 */
const commands: Record<string, CommandHandler> = {
  "!ping": (discord) => discord.reply("Pong! 🏓"),
  "!bing": (discord) =>
    discord.replyWithGif("bong! :statue_of_liberty:", GIF_URL),
};

// -- Worker entrypoint ----------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env, ctx);
    }

    if (url.pathname === "/gateway/start" && request.method === "POST") {
      return startGateway(url, env);
    }

    if (url.pathname === "/gateway/disconnect" && request.method === "POST") {
      return disconnectGateway(env);
    }

    if (url.pathname === "/gateway/status" && request.method === "GET") {
      return gatewayStatus(env);
    }

    return new Response("Not found", { status: 404 });
  },

  // poll for mtg lol
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(postWeeklyPoll(env))
  }
};

async function postWeeklyPoll(env: Env): Promise<void> {
  const api = createDiscordApi(env.DISCORD_BOT_TOKEN);
  await api.sendPoll("1337172094861181029", {
    question: "Want to play magic online NEXT Sunday?",
    answers: ["yes", "no"],
    durationHours: 48
  })
}

// -- Gateway webhook + management -----------------------------------------

async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const token = request.headers.get("x-discord-gateway-token");
  if (token !== env.DISCORD_GATEWAY_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const event = (await request.json()) as ForwardedGatewayEvent;
  ctx.waitUntil(handleEvent(event, env));
  return new Response("OK", { status: 200 });
}

async function startGateway(url: URL, env: Env): Promise<Response> {
  const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY });
  const result = await gateway.start({
    botToken: env.DISCORD_BOT_TOKEN,
    webhookUrl: `${url.origin}/webhook`,
    webhookSecret: env.DISCORD_GATEWAY_SECRET,
  });
  return Response.json(result);
}

async function disconnectGateway(env: Env): Promise<Response> {
  const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY });
  return Response.json(await gateway.disconnect());
}

async function gatewayStatus(env: Env): Promise<Response> {
  const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY });
  return Response.json(await gateway.status());
}

// -- Event dispatch -------------------------------------------------------

async function handleEvent(
  event: ForwardedGatewayEvent,
  env: Env,
): Promise<void> {
  switch (event.type) {
    case "GATEWAY_MESSAGE_CREATE": {
      const message = event.data as DiscordMessage;
      await handleMessage(
        message,
        createMessageContext(message, env.DISCORD_BOT_TOKEN),
      );
      break;
    }
    case "GATEWAY_MESSAGE_REACTION_ADD":
      console.log("Reaction added:", event.data);
      break;
    case "GATEWAY_MESSAGE_REACTION_REMOVE":
      console.log("Reaction removed:", event.data);
      break;
  }
}

// -- Your bot logic -------------------------------------------------------

/**
 * Customize bot behavior here.
 *
 * `discord` is bound to the incoming message:
 *   discord.reply("text")
 *   discord.replyWithGif("text", url)
 *   discord.react("👍", "🔥")
 *   discord.send(channelId, "text")
 *   discord.sendGif(channelId, "text", url)
 */
async function handleMessage(
  msg: DiscordMessage,
  discord: MessageContext,
): Promise<void> {
  // Ignore bot messages (including our own).
  if (msg.author.bot) return;

  const text = msg.content.toLowerCase();

  // Exact-match commands from the `commands` table above.
  const command = commands[text];
  if (command) {
    return command(discord);
  }

  if (text.includes("lmao") && Math.random() < 0.25) {
    await discord.react("yusuke:788128744308211762");
  }

  if (text.includes("!spin")) {
    const emojis = await discord.listCustomEmojis();
    if (emojis.length) {
      await discord.react(emojis[Math.floor(Math.random() * emojis.length)]);
    }
    else {
      await discord.react("⚠️")
    }
  }

  if (text.includes(" bot ") || text === "bot") {
    await discord.react("👀");
  }

  if (text.includes("dogass")) {
    await discord.react("🇩", "🇴", "🇬", "🇦", "🇸", "5️⃣");
  }

  // Reply to DMs.
  if (!msg.guild_id) {
    await discord.reply(`You said: ${msg.content}`);
  }
}
