/**
 * Minimal Clef demo: ask a cheap decision model to judge a message.
 *
 * Clef returns probabilities over the answers you define — no generated text,
 * nothing to parse. Return the whole response to see `answers` and `usage`.
 *
 *   curl -X POST http://localhost:8787/api/decide \
 *     -H 'content-type: application/json' \
 *     -d '{"text":"hey, tell me a joke"}'
 *
 * Requires the `ai` binding in the sibling wrangler.jsonc.
 * @license MIT
 */

interface Env {
  AI: Ai;
}

// Swap to "@cf/cloudflare/clef" for the larger model.
const CLEF_MODEL = "@cf/cloudflare/clef-flash";

// Edit these to change what Clef judges. 1-64 questions; `choice` and `score`
// need criteria, `noul` is a yes/no probability.
const QUESTIONS = {
  shouldReply: {
    type: "noul",
    instructions: "Should the assistant reply to this message?",
  },
  intent: {
    type: "choice",
    instructions: "What does this message want?",
    criteria: {
      chat: "A question, small talk, or a request for help",
      joke: "A joke, pun, or something funny",
      summarize: "Text that should be condensed",
      ignore: "Spam, gibberish, or nothing needing a reply",
    },
  },
  tone: {
    type: "choice",
    instructions: "What tone suits this message?",
    criteria: {
      warm: "Friendly and encouraging",
      playful: "Witty and a little silly",
      terse: "Minimal and matter-of-fact",
    },
  },
} as const;

interface Body {
  text?: string;
  messages?: { role: string; content: string }[];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/api/decide") {
      return new Response("Not found", { status: 404 });
    }

    try {
      const body = (await request.json()) as Body;
      const state = body.text ?? body.messages;
      if (state === undefined) {
        return Response.json(
          { error: "Provide `text` or `messages`." },
          { status: 400 },
        );
      }

      const result = await env.AI.run(CLEF_MODEL, {
        model: "clef-flash",
        state,
        questions: QUESTIONS,
      });
      return Response.json(result);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Env>;
