import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiscordApi,
  createMessageContext,
  DiscordApi,
  type DiscordMessage,
} from "../src/discord";

const API = "https://discord.com/api/v10";

function okResponse(): Response {
  return new Response(null, { status: 204 });
}

function message(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: "msg-123",
    channel_id: "channel-456",
    content: "hello",
    author: { id: "user-1", username: "alice" },
    guild_id: "guild-789",
    ...overrides,
  };
}

function fetchSpy() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createDiscordApi", () => {
  it("creates a DiscordApi instance", () => {
    expect(createDiscordApi("token")).toBeInstanceOf(DiscordApi);
  });
});

describe("DiscordApi.sendMessage", () => {
  it("POSTs the content as JSON with bot authorization", async () => {
    const fetch = fetchSpy();

    await createDiscordApi("bot-token").sendMessage("channel-1", "hello");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${API}/channels/channel-1/messages`);
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bot bot-token");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ content: "hello" }));
  });

  it("logs Discord errors but does not throw", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad request", { status: 400 }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      createDiscordApi("token").sendMessage("channel-1", "hello"),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      "Discord API error (400):",
      "bad request",
    );
  });
});

describe("DiscordApi.sendGif", () => {
  it("POSTs a message with an image embed", async () => {
    const fetch = fetchSpy();

    await createDiscordApi("token").sendGif(
      "channel-1",
      "a caption",
      "https://gifs.example/cat.gif",
    );

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${API}/channels/channel-1/messages`);
    expect(JSON.parse(init?.body as string)).toEqual({
      content: "a caption",
      embeds: [{ image: { url: "https://gifs.example/cat.gif" } }],
    });
  });
});

describe("DiscordApi.addReactions", () => {
  it("does nothing for an empty emoji list", async () => {
    const fetch = fetchSpy();

    await createDiscordApi("token").addReactions("c", "m", []);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("URL-encodes each emoji and spaces calls out", async () => {
    vi.useFakeTimers();
    const fetch = fetchSpy();

    const pending = createDiscordApi("token").addReactions("c", "m", [
      "👀",
      "custom:123",
    ]);
    await vi.runAllTimersAsync();
    await pending;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe(
      `${API}/channels/c/messages/m/reactions/%F0%9F%91%80/@me`,
    );
    expect(fetch.mock.calls[0][1]?.method).toBe("PUT");
    expect(
      (fetch.mock.calls[0][1]?.headers as Record<string, string>).Authorization,
    ).toBe("Bot token");
    expect(fetch.mock.calls[1][0]).toBe(
      `${API}/channels/c/messages/m/reactions/custom%3A123/@me`,
    );
  });

  it("retries a rate-limited reaction using retry_after from the body", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ retry_after: 0.5 }), { status: 429 }),
      )
      .mockResolvedValueOnce(okResponse());

    const pending = createDiscordApi("token").addReactions("c", "m", ["🔥"]);
    await vi.runAllTimersAsync();
    await pending;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe(
      `${API}/channels/c/messages/m/reactions/%F0%9F%94%A5/@me`,
    );
    expect(fetch.mock.calls[1][0]).toBe(fetch.mock.calls[0][0]);
  });

  it("falls back to the Retry-After header when the body is empty", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "0" },
        }),
      )
      .mockResolvedValueOnce(okResponse());

    const pending = createDiscordApi("token").addReactions("c", "m", ["x"]);
    await vi.runAllTimersAsync();
    await pending;

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses a default delay when a 429 has no retry information", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(okResponse());

    const pending = createDiscordApi("token").addReactions("c", "m", ["x"]);
    await vi.runAllTimersAsync();
    await pending;

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("logs and stops on non-rate-limit errors", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("forbidden", { status: 403 }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await createDiscordApi("token").addReactions("c", "m", ["x"]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "Failed to react with x:",
      403,
      "forbidden",
    );
  });
});

describe("createMessageContext", () => {
  it("exposes the triggering message", () => {
    const msg = message();

    expect(createMessageContext(msg, "token", async () => 0).message).toBe(msg);
  });

  it("binds reply and replyWithGif to the message channel", async () => {
    const fetch = fetchSpy();
    const discord = createMessageContext(message(), "token", async () => 0);

    await discord.reply("pong");
    await discord.replyWithGif("caption", "https://gifs.example/cat.gif");

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe(`${API}/channels/channel-456/messages`);
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({
      content: "pong",
    });
    expect(fetch.mock.calls[1][0]).toBe(`${API}/channels/channel-456/messages`);
    expect(JSON.parse(fetch.mock.calls[1][1]?.body as string)).toEqual({
      content: "caption",
      embeds: [{ image: { url: "https://gifs.example/cat.gif" } }],
    });
  });

  it("binds react to the message channel and id", async () => {
    const fetch = fetchSpy();
    const discord = createMessageContext(message(), "token", async () => 0);

    await discord.react("👍");

    expect(fetch.mock.calls[0][0]).toBe(
      `${API}/channels/channel-456/messages/msg-123/reactions/%F0%9F%91%8D/@me`,
    );
  });

  it("sends plain messages and GIFs to arbitrary channels", async () => {
    const fetch = fetchSpy();
    const discord = createMessageContext(message(), "token", async () => 0);

    await discord.send("other-channel", "hello");
    await discord.sendGif("other-channel", "caption", "https://gifs.example/x");

    expect(fetch.mock.calls[0][0]).toBe(`${API}/channels/other-channel/messages`);
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({
      content: "hello",
    });
    expect(fetch.mock.calls[1][0]).toBe(`${API}/channels/other-channel/messages`);
    expect(JSON.parse(fetch.mock.calls[1][1]?.body as string)).toEqual({
      content: "caption",
      embeds: [{ image: { url: "https://gifs.example/x" } }],
    });
  });
});
