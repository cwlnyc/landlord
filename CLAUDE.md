# CLAUDE.md

See README.md for what this is and how to run it. Rules that matter when changing it:

- `src/engine.ts` stays pure: State in, texts out. No network, timers, file access or `Date.now()` inside it; the caller passes `now`. That is what lets the simulator and a future Twilio webhook share it, and what makes the tests possible.
- Never guess a visit time. `parseVisitTime` returns null on anything unclear and the bot asks again; every time it reads is echoed to the tenant to confirm.
- Times are local to America/New_York: `npm run sim` and `npm test` set `TZ`. Don't remove that from the scripts.
- Real phone numbers live only in `data/real.json` and `data/state.json`, both gitignored. Never commit them, never put them in tests.
- Run `npm test` and `npm run typecheck` before committing.
