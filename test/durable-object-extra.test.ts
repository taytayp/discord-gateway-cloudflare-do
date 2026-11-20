import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordGatewayDO } from "../src/durable-object";
import type { GatewayState } from "../src/types";

const STATE_KEY = "gateway_state";
const CREDENTIALS_KEY = "credentials";

function makeState(overrides: Partial<GatewayState> = {}): GatewayState {
  return {
    wsUrl: null,
    resumeGatewayUrl: null,
    sessionId: null,
    sequence: null,
    heartbeatIntervalMs: null,
    lastHeartbeatAck: null,
    connectedAt: null,
    reconnectAttempts: 0,
    reconnectStrategy: "resume-or-identify",
    identifyCooldownUntil: null,
    sessionStartRemaining: null,
    sessionStartResetAfterMs: null,
    sessionStartTotal: null,
    sessionStartMaxConcurrency: null,
    reconnectDisabled: false,
    ...overrides,
  };
}

async function inFreshDO(fn: (instance: DiscordGatewayDO) => Promise<void>) {
  const id = env.DISCORD_GATEWAY.idFromName("test-" + Math.random());
  await runInDurableObject(env.DISCORD_GATEWAY.get(id), fn);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("start webhook URL validation", () => {
  const privateUrls = [
    "https://127.0.0.1/hook",
    "https://10.1.2.3/hook",
    "https://192.168.1.1/hook",
    "https://172.16.0.1/hook",
    "https://172.31.255.255/hook",
    "https://169.254.169.254/hook",
    "https://0.0.0.0/hook",
    "https://[::1]/hook",
    "https://[fe80::1]/hook",
    "https://[fc00::1]/hook",
    "https://[::ffff:127.0.0.1]/hook",
    "https://service.local/hook",
    "https://foo.localhost/hook",
    "https://LOCALHOST/hook",
  ];

  for (const webhookUrl of privateUrls) {
    it(`rejects non-public host ${webhookUrl}`, async () => {
      await inFreshDO(async (instance) => {
        const result = await instance.start({
          botToken: "token",
          webhookUrl,
        });

        expect("error" in result).toBe(true);
        expect((result as { error: string }).error).toContain(
          "publicly routable",
        );
      });
    });
  }

  it("accepts a public host", async () => {
    await inFreshDO(async (instance) => {
      vi.spyOn(instance as any, "connectInternal").mockResolvedValue({
        ok: true,
      });

      const result = await instance.start({
        botToken: "token",
        webhookUrl: "https://example.com/hook",
      });

      expect(result).toEqual({ status: "connecting" });
    });
  });
});

describe("forwardEvent", () => {
  it("posts the event with the bot token when no webhook secret is stored", async () => {
    await inFreshDO(async (instance) => {
      await instance.ctx.storage.put(CREDENTIALS_KEY, {
        botToken: "bot-token",
        webhookUrl: "https://example.com/hook",
      });
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 200 }));

      await (instance as any).forwardEvent("MESSAGE_CREATE", { id: "1" });

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0];
      expect(url).toBe("https://example.com/hook");
      expect(init?.method).toBe("POST");
      expect(
        (init?.headers as Record<string, string>)["x-discord-gateway-token"],
      ).toBe("bot-token");
      const body = JSON.parse(init?.body as string);
      expect(body.type).toBe("GATEWAY_MESSAGE_CREATE");
      expect(body.data).toEqual({ id: "1" });
      expect(typeof body.timestamp).toBe("number");
    });
  });

  it("retries server errors and network failures", async () => {
    await inFreshDO(async (instance) => {
      await instance.ctx.storage.put(CREDENTIALS_KEY, {
        botToken: "bot-token",
        webhookUrl: "https://example.com/hook",
      });
      vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
      vi.spyOn(console, "error").mockImplementation(() => {});
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("oops", { status: 500 }))
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      await (instance as any).forwardEvent("MESSAGE_REACTION_ADD", {});

      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  it("does not retry client errors", async () => {
    await inFreshDO(async (instance) => {
      await instance.ctx.storage.put(CREDENTIALS_KEY, {
        botToken: "bot-token",
        webhookUrl: "https://example.com/hook",
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("bad", { status: 400 }));

      await (instance as any).forwardEvent("MESSAGE_CREATE", {});

      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  it("does nothing when no credentials are stored", async () => {
    await inFreshDO(async (instance) => {
      const fetch = vi.spyOn(globalThis, "fetch");

      await (instance as any).forwardEvent("MESSAGE_CREATE", {});

      expect(fetch).not.toHaveBeenCalled();
    });
  });
});

describe("normalizeState", () => {
  it("fills in missing fields when reading partial stored state", async () => {
    await inFreshDO(async (instance) => {
      await instance.ctx.storage.put(STATE_KEY, {
        wsUrl: "wss://gateway.discord.gg",
        sequence: 42,
      });

      const status = await instance.status();

      expect(status.sequence).toBe(42);
      expect(status.sessionId).toBeNull();
      expect(status.reconnectAttempts).toBe(0);
      expect(status.status).toBe("connecting");
    });
  });
});
