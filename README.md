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
npm run dev        # http://localhost:4300; pulls updates every 30s and restarts itself
npm run sim        # same simulator, no auto-updating
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
| Landlord | `YES` | sends the person the bot suggested (`YES 3` for #3); `NO` to pick yourself |
| Landlord | *shares a contact card* | saves a repair person; "John handyman Hamden" gives name, trade and town |
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

### Who to send

Each new repair comes with a suggestion: "heat not working" is an HVAC job,
"sink leaking" a plumber's, a sticking door a handyman's (`src/match.ts`,
plain keywords). It prefers someone who covers the rental's town, never
offers a handyman for a specialist job, and skips anyone who already said
no. The landlord answers YES and it's sent. When nobody saved fits, it says
so and offers `FIND`.

### Adding repair people

Share a contact card with the repair line (iPhone: open the contact, Share
Contact, pick the repair line). Names saved like "John handyman Hamden" are
read as name, trade and town; otherwise the bot asks once ("PLUMBER
HAMDEN"). A text can't read someone's whole contact list, so it's one card
per person: a minute for the 3 to 6 people a small landlord uses. In the
simulator, the landlord phone has a **Share a contact** button.

Tell your repair people the repair line will text them before it does.

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
The bot's reply shows what it understood ("Asked John about #1"), and the
terminal running the simulator logs each AI reading for debugging. The engine still checks everything it's given, and when the
AI isn't sure it answers nothing and the sender is asked to rephrase.

Copy `.env.example` to `.env.local` and add `ANTHROPIC_API_KEY` (from the
Claude Console, not a claude.ai subscription). Without a key the AI is off,
fixed replies still work, and `FIND` shows sample results marked as such.

### Rent reminders

The landlord texts `RENT MARIA 1450` (due the 1st) or `RENT MARIA 1450 DUE 15`
to set a tenant's rent; it can also go in the data file as `"rent": 1450`,
`"rentDue": 1` (31 means the last day). Then the same line keeps track of rent. Tracking only: tenants
pay the way they always have and no money goes through the bot.

- **3 days before it's due, 9am:** the tenant gets a friendly reminder.
- **5 days after, 9am,** if it isn't marked paid: one nudge to the tenant,
  and one list to the landlords of everyone not marked paid.
- **`PAID MARIA`** marks it paid (`PAID MARIA 600 CASH` for part of it) and
  thanks the tenant. **`RENT`** shows who's paid this month.
- **A tenant texting "paid" / "sent it on zelle"** tells the landlord to
  check. It doesn't mark anything paid: only the landlord does.
- Paying a few days early counts toward next month's rent.
- Nothing from before the line first ran is ever called late, so turning it
  on mid-month doesn't text every tenant that they owe last month's rent.

Each text goes out once per unit per month. Timings live in
`rentSettings` in the data file (`remindDaysBefore`, `graceDays`, `hour`).
In the simulator, **+1 week** steps through every hour, so reminders fire on
their day. Tell tenants about the reminders before turning them on.

### Your own rentals

Copy `data/example.json` to `data/real.json` and fill in real units,
tenants and repair people. `real.json` is gitignored so real phone numbers
never get committed. Delete `data/state.json` to start the simulator over.

## Going live: a real phone number

`npm run live` is the real repair line: the same engine, with texts coming
in from Twilio and real texts going out. The simulator (`npm run dev`) never
texts anyone; `live` does.

**1. Twilio (an adult's account).** At twilio.com, sign up, buy a local
number with SMS, and copy the Account SID and Auth Token.

**2. Register for business texting (A2P 10DLC).** In the Twilio console:
Messaging, Regulatory Compliance. A sole-proprietor registration is enough
for a family's rentals. US carriers block unregistered business texts, and
approval can take days to a couple of weeks, so start it first. Until then
a trial account can usually text only numbers verified in the console.

**3. Real data.** Copy `data/example.json` to `data/real.json` with the real
units, tenants and repair people (gitignored). Tell everyone on it the
repair line will text them; they can reply STOP at any time.

**4. cloudflared.** Twilio has to reach your computer, through a free
Cloudflare tunnel. Download cloudflared once to `~/bin` (no Homebrew needed):

```bash
mkdir -p ~/bin && cd ~/bin
curl -L -o cloudflared.tgz "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$( [ "$(uname -m)" = arm64 ] && echo arm64 || echo amd64 ).tgz"
tar -xzf cloudflared.tgz && rm cloudflared.tgz
```

`npm run live` starts the tunnel itself and points the Twilio webhook at it
every time, so there's no address to copy. The line is off whenever the
computer sleeps: fine for testing, not for a furnace at 9pm. Real use needs
an always-on host (then set `PUBLIC_URL` to its address).

**5. Settings.** Fill in the Twilio lines of `.env.local` (see
`.env.example`). Leave `PUBLIC_URL` empty. At first, set `ALLOW_ONLY` to
your own family's numbers.

**6. Check, then run it.** `npm run check` looks over everything `live`
needs (settings, the people file, the Twilio credentials and webhook, the AI
key, the tunnel) and says what to fix, without printing any key. Then
`npm run live` (it starts the tunnel and sets the Twilio webhook), and text
the number. Run `npm run check` again while live is running to confirm a
text can get in.

What `live` does to stay safe:
- Rejects any request not signed by Twilio, so nobody else can make the
  line send texts.
- Only ever texts numbers in its own data: landlords, tenants and repair
  people saved as textable. Businesses found by FIND are never texted.
- Leaves STOP, START, HELP and the other carrier keywords to Twilio.
- `ALLOW_ONLY` logs every other text instead of sending it.

## Staying legal

Unwanted texts can cost $500 to $1,500 each under the TCPA, so the rules are
in the code, applied to every text the simulator and the live line send
(`src/compliance.ts`, tested in `src/compliance.test.ts`):

- **Consent.** Only people a landlord added after they agreed, or who
  texted the line themselves, are ever texted.
- **First text explains everything:** who it's from, what for, frequency,
  "Msg & data rates may apply", HELP and STOP. Sent once, recorded.
- **STOP works instantly** (also UNSUBSCRIBE, CANCEL, END, QUIT): nothing
  more until START, and the landlord is told to reach them directly. On the
  live line Twilio sends the confirmation; the line records it.
- **No automatic texts 9pm to 8am.** Reminders and check-backs wait for
  morning. Replies to someone who just texted go out right away.
- **Records:** when each person was added, welcomed, opted out or back in.
- Landlords use **DROP 3**, not CANCEL: "cancel" alone is a carrier
  opt-out word and would turn the line off for them.

**Legal pages** (privacy policy, terms of service, SMS terms, how people opt
in, with the real sample messages) are templates in `legal/build.mjs`, filled
from `legal/config.json`. Fill in the TODOs (the operator must be an adult
or a business), then:

```bash
npm run legal              # builds legal-site/ to look at
npm run legal:publish      # puts it on https://repairline-legal.pages.dev
```

Twilio's registration asks for the privacy policy and opt-in description
URLs that `legal:publish` prints. A test checks the sample messages on the
pages match what the code really sends. **These are templates, not legal
advice: have a lawyer review them before charging customers.**

## Layout

```
src/engine.ts      the whole flow: handleText() for each text in, tick() as time passes,
                   needsHelp/planFind/showFound around the AI and the search
src/interpret.ts   receive(): one text start to finish, AI and search included
src/rent.ts        rent reminders, PAID and RENT, late lists (tracking only)
src/ai.ts          Claude: understand messy texts; web search for repair people
src/live.ts        the real line: Twilio webhook in, real texts out, reminders every minute
src/twilio.ts      signature check, reading a text (and shared contact cards), sending, setting the webhook
src/tunnel.ts      starts a Cloudflare quick tunnel and reads its address
src/check.ts       npm run check: what's wrong before a live test
src/compliance.ts  STOP/START/HELP, first-text welcome, quiet hours, consent records
legal/             privacy policy, terms, SMS terms, opt-in page; npm run legal(:publish)
src/parse-time.ts  reads "tue 9am" style times; returns null rather than guess
src/server.ts      the simulator's local server and fake clock
public/index.html  the three-phone page
data/example.json  sample landlords, units and repair people
```

`engine.ts` has no network, clock or storage, so the same functions will sit
behind a Twilio webhook later.

## Not built yet, on purpose

- **An always-on host** for `npm run live`, so the line works when the
  computer is asleep.
- **Setup by text.** For now, units and repair people come from the JSON file.
