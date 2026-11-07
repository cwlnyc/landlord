# Repair line

Landlords' repair coordination by text message. A tenant texts a problem,
the landlord texts back who to send, the repair person texts a time, the
tenant confirms they'll be home, and everyone gets a reminder. Nobody
downloads an app.

It does by text the two chases a landlord does by hand on every repair:
chasing the repair person for a time, then chasing the tenant to be home.

## v0: the simulator

Nothing is texted yet. A local page shows three phones (landlord, tenant,
repair person) driving the real logic, with a fake clock to fast-forward
reminders.

```bash
npm install
npm run sim        # http://localhost:4300
npm test
npm run typecheck
```

Try it: as the tenant, text `heat not working`. As the landlord, `SEND HVAC`.
As the repair person, `tomorrow 8am`. As the tenant, `1`. Then press
**+1 day**.

### Commands

| Who | Texts | Does |
|---|---|---|
| Tenant | anything | reports a repair |
| Tenant | `1` / `2` | will / won't be home for the offered time |
| Landlord | `SEND JOHN` | asks John about the newest repair (`SEND JOHN 3` for #3) |
| Landlord | `LIST` | open repairs |
| Landlord | `DONE 3` / `CANCEL 3` | close a repair |
| Repair person | `TUE 9AM`, `tomorrow 2pm`, `11/12 10am` | offers a time |
| Repair person | `NO` | can't do it; goes back to the landlord |

| Landlord | `FIND HVAC` | searches the web for HVAC near the rental, lists 3 to call |
| Landlord | `BOOKED 1 TOMORROW 8AM` | you called result 1 and agreed a time; checks with the tenant |
| Landlord | `BOOKED JOHN TUE 9AM` | same, for someone already saved |

Every landlord on the list (e.g. both parents) gets every update, and
either can reply.

### When the usual person can't come

When a repair person replies NO, the landlord is offered `FIND` + their
trade. The bot searches the web for up to 3 local businesses (best rated,
most reviews, 24/7 if it sounds urgent) and texts back names and numbers.
**The landlord calls them; the bot never texts a business it found.** Many
business numbers are landlines, and they never agreed to texts. After the
call, `BOOKED 1 …` saves them and runs the usual tenant check and
reminders, still without texting the business.

### Messy texts (AI)

With an API key, Claude reads normal texts and turns them into the fixed
replies: "cant tmrw, thurs after 2 ok?" becomes `11/12 2:00pm`, "ya ill be
here" becomes `1`, "can you find another heating guy" becomes `FIND HVAC`.
The simulator shows "AI read this as: …" under each one, so a misread is
easy to spot. The engine still checks everything it's given, and when the
AI isn't sure it answers nothing and the sender is asked to rephrase.

Copy `.env.example` to `.env.local` and add `ANTHROPIC_API_KEY` (from the
Claude Console, not a claude.ai subscription). Without a key the AI is off,
fixed replies still work, and `FIND` shows sample results marked as such.

### Your own rentals

Copy `data/example.json` to `data/real.json` and fill in real units,
tenants and repair people. `real.json` is gitignored so real phone numbers
never get committed. Delete `data/state.json` to start the simulator over.

## Layout

```
src/engine.ts      the whole flow: handleText() for each text in, tick() as time passes,
                   needsHelp/planFind/showFound around the AI and the search
src/interpret.ts   receive(): one text start to finish, AI and search included
src/ai.ts          Claude: understand messy texts; web search for repair people
src/parse-time.ts  reads "tue 9am" style times; returns null rather than guess
src/server.ts      the simulator's local server and fake clock
public/index.html  the three-phone page
data/example.json  sample landlords, units and repair people
```

`engine.ts` has no network, clock or storage, so the same functions will sit
behind a Twilio webhook later.

## Not built yet, on purpose

- **Real texting (Twilio).** Needs an adult's account, a paid number and
  US business-texting (A2P 10DLC) registration. Tenants and repair people
  must agree to get texts and be able to reply STOP.
- **Setup by text.** For now, units and repair people come from the JSON file.
