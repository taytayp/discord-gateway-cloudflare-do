# Clef message-judgment demo

A one-endpoint Worker that asks Cloudflare's Clef decision model to judge a message and returns its typed answers as JSON. There is no LLM call and no streaming: Clef assigns probabilities to the answers you define, so there is nothing to parse out of generated text.

## Run it locally

Requirements: Node 18+, a Cloudflare account with Workers AI enabled, and Wrangler logged in (`npx wrangler login`).

```sh
cd examples/ai-agent
npm install
npm run dev
```

In another terminal:

```sh
curl -s -X POST http://localhost:8787/api/decide \
  -H 'content-type: application/json' \
  -d '{"text":"hey, tell me a joke"}' | jq
```

You can also pass a short conversation instead of a single string:

```sh
curl -s -X POST http://localhost:8787/api/decide \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"summarize this"},{"role":"user","content":"Long text goes here..."}]}' | jq
```

Other commands:

```sh
npm run typecheck   # tsc --noEmit; the local tsconfig loads @cloudflare/workers-types
npm run deploy      # optional: deploy this demo as its own Worker
```

Local `wrangler dev` inference uses Cloudflare resources and counts toward your daily neuron allowance (10,000/day, resets 00:00 UTC). `wrangler.jsonc` supplies the `AI` binding; no API token is needed in the Worker.

## What you get back

```json
{
  "model": "@cf/cloudflare/clef-flash",
  "answers": {
    "shouldReply": { "type": "noul", "noul": 0.91 },
    "intent": {
      "type": "choice",
      "choice": "joke",
      "probabilities": { "chat": 0.1, "joke": 0.8, "summarize": 0.02, "ignore": 0.08 },
      "confidence": 0.8
    },
    "tone": { "type": "choice", "choice": "playful", "probabilities": {}, "confidence": 0.7 }
  },
  "usage": { "input_tokens": 312, "output_tokens": 0 }
}
```

- `noul` is a yes/no probability (here: should the bot reply?).
- `choice` is the highest-probability option plus the per-option probabilities.
- `score` (not used here) is a probability-weighted level; add one by putting a `criteria` array in a question.

## Things to tweak

- `QUESTIONS` in `src/index.ts` — the judgments themselves. 1–64 questions; `choice`/`score` need `criteria`, `noul` does not.
- `CLEF_MODEL` — swap `clef-flash` for `@cf/cloudflare/clef` (larger, ~6× the input neurons).
- The `state` sent to Clef — bigger prompts cost more. `clef-flash` is 3,455 neurons per million input tokens and has no output-token charge; a ~500-token call is about 1.7 neurons, so decisions are very cheap compared with a chat reply.

## Folding this into the chatbot in `src/`

Keep the demo standalone. To use judgments in the real bot:

1. **Add the binding.** In the repo-root `wrangler.jsonc`, add:

   ```jsonc
   "ai": { "binding": "AI" }
   ```

   Then add `AI: Ai;` to the `Env` interface in `src/index.ts`.

2. **Move the judgment into its own module**, e.g. `src/clef.ts`. Copy `QUESTIONS` from the demo and wrap the call:

   ```ts
   export async function judgeMessage(ai: Ai, text: string) {
     const response = (await ai.run("@cf/cloudflare/clef-flash", {
       model: "clef-flash",
       state: text.slice(0, 2000),
       questions: QUESTIONS,
     })) as {
       answers: {
         shouldReply: { noul: number };
         intent: { choice: string };
         tone: { choice: string };
       };
     };

     return {
       shouldReply: response.answers.shouldReply.noul,
       intent: response.answers.intent.choice,
       tone: response.answers.tone.choice,
     };
   }
   ```

   The cast is needed because generated Workers types don't know the Clef models yet.

3. **Thread `env` into `handleMessage`.** In `src/index.ts`, change the call in `handleEvent` to:

   ```ts
   await handleMessage(
     message,
     createMessageContext(message, env.DISCORD_BOT_TOKEN),
     env,
   );
   ```

   and change the handler signature to:

   ```ts
   async function handleMessage(
     msg: DiscordMessage,
     discord: MessageContext,
     env: Env,
   ): Promise<void> {
   ```

4. **Use the judgment after the cheap checks.** Keep the `msg.author.bot` guard and the exact-match `commands` lookup first, so you never spend neurons on bot messages or commands you can answer locally:

   ```ts
   import { judgeMessage } from "./clef";

   // ...inside handleMessage, after the command lookup:
   const judgment = await judgeMessage(env.AI, msg.content);
   if (judgment.shouldReply < 0.5 || judgment.intent === "ignore") return;

   await discord.reply(`[${judgment.intent}/${judgment.tone}] ...`);
   ```

   `handleEvent` runs under `ctx.waitUntil`, so an async judgment is fine; the webhook still responds immediately.

Guardrails worth keeping: cap the text you send as `state` (long Discord messages can dominate the token count), and wrap the `judgeMessage` call in `try/catch` if a Clef outage should degrade to your existing reaction behavior rather than failing the event.
