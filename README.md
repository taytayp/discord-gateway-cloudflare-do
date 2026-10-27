# discord-gateway-cloudflare-do
[original repo](https://github.com/dcartertwo/discord-gateway-cloudflare-do/)

Persistent Discord Gateway WebSocket via [Durable Objects](https://developers.cloudflare.com/durable-objects/). Forwards messages and reactions to your Worker as HTTP POSTs — no discord.js, no Node.js, no cron.


```bash
npx wrangler deploy
```