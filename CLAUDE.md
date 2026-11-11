# CLAUDE.md

See README.md for what this is and how to run it. Rules that matter when changing it:

- `src/engine.ts` stays pure: State in, texts out. No network, timers, file access or `Date.now()` inside it; the caller passes `now`. That is what lets the simulator and a future Twilio webhook share it, and what makes the tests possible.
- Slow or paid work (Claude, web search) lives in `src/ai.ts` and is called from `src/interpret.ts`, never from the engine. Tests use stub `Ai` objects; never call the real API in tests.
- The bot never texts a business found by search (`textable: false`). The landlord calls them.
- A repair person's "no" that mentions a day or time is an offer, not a refusal, and a text naming two days is never parsed: the AI or the sender sorts it out.
- `ANTHROPIC_API_KEY` lives only in `.env.local` (gitignored). Never commit it or print it.
- Never guess a visit time. `parseVisitTime` returns null on anything unclear and the bot asks again; every time it reads is echoed to the tenant to confirm.
- Times are local to America/New_York: `npm run sim` and `npm test` set `TZ`. Don't remove that from the scripts.
- Real phone numbers live only in `data/real.json` and `data/state.json`, both gitignored. Never commit them, never put them in tests.
- Run `npm test` and `npm run typecheck` before committing.
- `npm run live` sends real texts. Never weaken its Twilio signature check, its "only text known numbers" rule, or the STOP/HELP keyword pass-through. Never run it from tests.
- Twilio credentials live only in `.env.local`. Never commit or print them.
- Rent is tracking only: never collect, request or move money. Only the landlord's PAID marks rent paid; a tenant saying so just tells the landlord.
- Never send a rent notice about a month due before `rentSince` (the line's first run): turning the line on must not tell every tenant they're late.
- Every outgoing text goes through `prepareOutbound` (src/compliance.ts): it drops texts to anyone who opted out and sends the first-text welcome. Never send around it. Scheduled texts (anything from `tick`) must respect quiet hours.
- If a message wording changes, the sample on the legal opt-in page must change with it; compliance.test.ts checks the key ones. Carriers compare them.
