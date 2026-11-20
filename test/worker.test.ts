import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { DiscordMessage } from "../src/discord";

const BOT_TOKEN = "bot-token";
const WEBHOOK_SECRET = "gateway-secret";
const API = "https://discord.com/api/v10";

type WorkerEnv = Parameters<typeof worker.fetch>[1];

type FetchSpy = ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

function makeEnv() {
  const stub = {
    start: vi.fn().mockResolvedValue({ status: "connecting" }),
    disconnect: vi.fn().mockResolvedValue({ status: "disconnected" }),
    status: vi.fn().mockResolvedValue({
      status: "connected",
      sessionId: "session-123",
      connectedAt: "2026-01-01T00:00:00.000Z",
      sequence: 7,
      reconnectAttempts: 0,
    }),
  };
  const namespace = {
    idFromName: vi.fn(() => "id"),
    get: vi.fn(() => stub),
  };
  const env = {
    DISCORD_GATEWAY: namespace,
    DISCORD_BOT_TOKEN: BOT_TOKEN,
    DISCORD_GATEWAY_SECRET: WEBHOOK_SECRET,
  } as unknown as WorkerEnv;

  return { env, stub, namespace };
}

function makeContext() {
  const pending: Promise<void>[] = [];
  const ctx = {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      pending.push(promise as Promise<void>);
    }),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  return { ctx, pending };
}

function request(path: string, options: RequestInit = {}): Request {
  return new Request(`https://bot.example${path}`, options);
}

function discordCalls(fetch: FetchSpy) {
  return fetch.mock.calls.filter(([url]) =>
    String(url).startsWith(API),
  );
}

function postedBodies(fetch: FetchSpy): unknown[] {
  return discordCalls(fetch)
    .map(([, init]) => init?.body)
    .filter((body): body is string => typeof body === "string")
    .map((body) => JSON.parse(body));
}

function messageEvent(data: Partial<DiscordMessage> = {}) {
  const message: DiscordMessage = {
    id: "msg-1",
    channel_id: "channel-1",
    content: "hello",
    author: { id: "user-1", username: "alice" },
    guild_id: "guild-1",
    ...data,
  };
  return {
    type: "GATEWAY_MESSAGE_CREATE",
    timestamp: 1234,
    data: message,
  };
}

async function dispatch(env: WorkerEnv, event: unknown): Promise<void> {
  const { ctx, pending } = makeContext();
  const response = await worker.fetch(
    request("/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-discord-gateway-token": WEBHOOK_SECRET,
      },
      body: JSON.stringify(event),
    }),
    env,
    ctx,
  );

  expect(response.status).toBe(200);
  expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  await Promise.all(pending);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("worker fetch routing", () => {
  it("rejects webhook requests with the wrong token", async () => {
    const { env } = makeEnv();
    const { ctx } = makeContext();

    const response = await worker.fetch(
      request("/webhook", { method: "POST" }),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("accepts webhook requests with the configured secret", async () => {
    const { env } = makeEnv();

    const response = await worker.fetch(
      request("/webhook", {
        method: "POST",
        headers: { "x-discord-gateway-token": WEBHOOK_SECRET },
        body: JSON.stringify(messageEvent()),
      }),
      env,
      makeContext().ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });

  it("returns 404 for unknown paths and wrong methods", async () => {
    const { env } = makeEnv();

    expect((await worker.fetch(request("/unknown"), env, makeContext().ctx)).status).toBe(404);
    expect(
      (await worker.fetch(request("/webhook"), env, makeContext().ctx)).status,
    ).toBe(404);
  });

  it("starts the gateway with credentials and the request origin", async () => {
    const { env, stub } = makeEnv();

    const response = await worker.fetch(
      request("/gateway/start", { method: "POST" }),
      env,
      makeContext().ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "connecting" });
    expect(stub.start).toHaveBeenCalledWith({
      botToken: BOT_TOKEN,
      webhookUrl: "https://bot.example/webhook",
      webhookSecret: WEBHOOK_SECRET,
    });
  });

  it("disconnects the gateway", async () => {
    const { env, stub } = makeEnv();

    const response = await worker.fetch(
      request("/gateway/disconnect", { method: "POST" }),
      env,
      makeContext().ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "disconnected" });
    expect(stub.disconnect).toHaveBeenCalledTimes(1);
  });

  it("reports gateway status", async () => {
    const { env, stub } = makeEnv();

    const response = await worker.fetch(
      request("/gateway/status"),
      env,
      makeContext().ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "connected",
      sessionId: "session-123",
    });
    expect(stub.status).toHaveBeenCalledTimes(1);
  });
});

describe("handleMessage via GATEWAY_MESSAGE_CREATE", () => {
  it("replies to !ping (case-insensitively)", async () => {
    const { env } = makeEnv();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await dispatch(env, messageEvent({ content: "!PING" }));

    expect(discordCalls(fetch)).toHaveLength(1);
    expect(postedBodies(fetch)).toEqual([{ content: "Pong! 🏓" }]);
  });

  it("replies to !bing with a GIF embed", async () => {
    const { env } = makeEnv();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await dispatch(env, messageEvent({ content: "!bing" }));

    const [body] = postedBodies(fetch) as Array<{
      content: string;
      embeds: Array<{ image: { url: string } }>;
    }>;
    expect(body.content).toBe("bong! :statue_of_liberty:");
    expect(body.embeds[0].image.url).toContain("giphy.com");
  });

  it("ignores bot messages", async () => {
    const { env } = makeEnv();
    const fetch = vi.spyOn(globalThis, "fetch");

    await dispatch(
      env,
      messageEvent({
        content: "!ping",
        author: { id: "bot-1", username: "robot", bot: true },
      }),
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores unrelated guild messages", async () => {
    const { env } = makeEnv();
    const fetch = vi.spyOn(globalThis, "fetch");

    await dispatch(env, messageEvent({ content: "just chatting" }));

    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires an exact command match", async () => {
    const { env } = makeEnv();
    const fetch = vi.spyOn(globalThis, "fetch");

    await dispatch(env, messageEvent({ content: "!ping please" }));

    expect(fetch).not.toHaveBeenCalled();
  });

  it("echoes direct messages that are not commands", async () => {
    const { env } = makeEnv();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await dispatch(env, messageEvent({ content: "hey there", guild_id: undefined }));

    expect(postedBodies(fetch)).toEqual([{ content: "You said: hey there" }]);
  });

  it("does not echo a direct message that matched a command", async () => {
    const { env } = makeEnv();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await dispatch(env, messageEvent({ content: "!ping", guild_id: undefined }));

    expect(discordCalls(fetch)).toHaveLength(1);
    expect(postedBodies(fetch)).toEqual([{ content: "Pong! 🏓" }]);
  });

  it("reacts with eyes when the message mentions bot", async () => {
    const { env } = makeEnv();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await dispatch(env, messageEvent({ content: "is anyone a BOT here?" }));

    expect(discordCalls(fetch)).toHaveLength(1);
    expect(String(fetch.mock.calls[0][0])).toContain(
      "/reactions/%F0%9F%91%80/@me",
    );
  });

  it("spells dogass with letter reactions", async () => {
    const { env } = makeEnv();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await dispatch(env, messageEvent({ content: "DOGASS" }));

    expect(discordCalls(fetch)).toHaveLength(6);
    expect(String(fetch.mock.calls[0][0])).toContain("/reactions/");
  });

  it("reacts to lmao only when the random roll succeeds", async () => {
    const { env } = makeEnv();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    vi.spyOn(Math, "random").mockReturnValue(0.1);

    await dispatch(env, messageEvent({ content: "that was LMAO" }));

    expect(discordCalls(fetch)).toHaveLength(1);
    expect(String(fetch.mock.calls[0][0])).toContain(
      "/reactions/yusuke%3A788128744308211762/@me",
    );

    vi.spyOn(Math, "random").mockReturnValue(0.9);
    fetch.mockClear();

    await dispatch(env, messageEvent({ content: "lmao" }));

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("handleEvent for other forwarded events", () => {
  it("logs reaction events without calling Discord", async () => {
    const { env } = makeEnv();
    const fetch = vi.spyOn(globalThis, "fetch");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await dispatch(env, {
      type: "GATEWAY_MESSAGE_REACTION_ADD",
      timestamp: 1234,
      data: { emoji: "👀" },
    });
    await dispatch(env, {
      type: "GATEWAY_MESSAGE_REACTION_REMOVE",
      timestamp: 1234,
      data: { emoji: "👀" },
    });

    expect(log).toHaveBeenCalledWith("Reaction added:", { emoji: "👀" });
    expect(log).toHaveBeenCalledWith("Reaction removed:", { emoji: "👀" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
