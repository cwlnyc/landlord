import { readFileSync } from "node:fs";
import { handleText, tick } from "./engine.js";
import type { Outbound, State } from "./types.js";

const MOM = "+1 203 555 0101";
const DAD = "+1 203 555 0102";
const MARIA = "+1 203 555 0201";
const SAM = "+1 203 555 0301";
const JOHN = "+1 203 555 0302";

function fresh(): State {
  const s: State = JSON.parse(readFileSync(new URL("../data/example.json", import.meta.url), "utf8"));
  // Repairs only here; rent.test.ts covers rent.
  for (const u of s.units) delete u.rent;
  return s;
}
// Sunday Nov 8 2026, 9pm: when the Naugatuck furnace went out.
const SUNDAY_9PM = new Date(2026, 10, 8, 21, 0);
const to = (out: Outbound[], phone: string) => out.filter((o) => o.to === phone).map((o) => o.body);

describe("the furnace story, by text", () => {
  it("runs both chases and the reminders", () => {
    const s = fresh();

    // 1. Tenant reports. Both parents hear about it.
    let out = handleText(s, MARIA, "heat not working", SUNDAY_9PM);
    expect(to(out, MARIA)[0]).toMatch(/repair #1/);
    expect(to(out, MOM)[0]).toMatch(/New repair #1 from Maria/);
    expect(to(out, DAD)).toHaveLength(1);

    // 2. Mom picks the HVAC guy.
    out = handleText(s, MOM, "send hvac", SUNDAY_9PM);
    expect(to(out, SAM)[0]).toMatch(/12 Oak St.*heat not working/);
    expect(s.repairs[0]!.status).toBe("asking-vendor");

    // 3. He names a time; the tenant is asked (chase #2, done for her).
    out = handleText(s, SAM, "tomorrow 8am", SUNDAY_9PM);
    expect(to(out, MARIA)[0]).toMatch(/Mon, Nov 9, 8:00 AM.*Reply 1/);
    expect(s.repairs[0]!.status).toBe("asking-tenant");

    // 4. Tenant confirms. Everyone hears.
    out = handleText(s, MARIA, "1", SUNDAY_9PM);
    expect(s.repairs[0]!.status).toBe("confirmed");
    expect(to(out, SAM)[0]).toMatch(/Confirmed/);
    expect(to(out, MOM)[0]).toMatch(/Confirmed #1/);

    // 5. Visit is the next morning: no reminder right after "confirmed".
    expect(to(out, MARIA)[0]).not.toMatch(/remind you/);
    expect(tick(s, new Date(2026, 10, 8, 22, 0))).toEqual([]);

    // 6. After the visit, the landlords are asked if it's fixed.
    out = tick(s, new Date(2026, 10, 9, 13, 0));
    expect(to(out, MOM)[0]).toMatch(/DONE 1/);
    out = handleText(s, DAD, "done 1", new Date(2026, 10, 9, 13, 5));
    expect(s.repairs[0]!.status).toBe("done");
  });
});

describe("when things go sideways", () => {
  it("repair person says no: back to the landlords", () => {
    const s = fresh();
    handleText(s, MARIA, "sink leaking", SUNDAY_9PM);
    handleText(s, MOM, "SEND JOHN", SUNDAY_9PM);
    const out = handleText(s, JOHN, "no sorry booked", SUNDAY_9PM);
    expect(s.repairs[0]!.status).toBe("new");
    expect(to(out, MOM)[0]).toMatch(/can't do #1.*SEND/);
  });

  it("tenant can't make it: repair person asked for another time", () => {
    const s = fresh();
    handleText(s, MARIA, "sink leaking", SUNDAY_9PM);
    handleText(s, MOM, "SEND JOHN", SUNDAY_9PM);
    handleText(s, JOHN, "tue 9am", SUNDAY_9PM);
    const out = handleText(s, MARIA, "2", SUNDAY_9PM);
    expect(s.repairs[0]!.status).toBe("asking-vendor");
    expect(to(out, JOHN)[0]).toMatch(/can't do Tue, Nov 10, 9:00 AM/);
  });

  it("asks again instead of guessing a time", () => {
    const s = fresh();
    handleText(s, MARIA, "sink leaking", SUNDAY_9PM);
    handleText(s, MOM, "SEND JOHN", SUNDAY_9PM);
    const out = handleText(s, JOHN, "sometime this week prob", SUNDAY_9PM);
    expect(to(out, JOHN)[0]).toMatch(/didn't catch the time/);
    expect(s.repairs[0]!.status).toBe("asking-vendor");
  });

  it("a 'no' that offers another day is not a refusal, and is never guessed", () => {
    const s = fresh();
    handleText(s, MARIA, "sink leaking", SUNDAY_9PM);
    handleText(s, MOM, "SEND JOHN", SUNDAY_9PM);
    const out = handleText(s, JOHN, "cant tmrw, thurs after 2 ok?", SUNDAY_9PM);
    expect(s.repairs[0]!.status).toBe("asking-vendor");
    expect(s.repairs[0]!.vendorCode).toBe("JOHN");
    expect(to(out, JOHN)[0]).toMatch(/didn't catch the time/);
  });

  it("reads a bare '9 am' as a time, not repair #9", () => {
    const s = fresh();
    s.nextId = 9;
    handleText(s, MARIA, "door sticks", SUNDAY_9PM);
    handleText(s, MOM, "SEND JOHN", SUNDAY_9PM);
    handleText(s, JOHN, "9 am", SUNDAY_9PM);
    expect(s.repairs[0]!.status).toBe("asking-tenant");
  });

  it("a visit 20 hours away: the confirmation is the reminder, nothing after", () => {
    const s = fresh();
    const noon = new Date(2026, 10, 8, 12, 0);
    handleText(s, MARIA, "sink leaking", noon);
    handleText(s, MOM, "SEND JOHN", noon);
    handleText(s, JOHN, "tomorrow 8am", noon);
    const confirm = handleText(s, MARIA, "1", noon);
    expect(to(confirm, MARIA)[0]).not.toMatch(/remind you/);
    expect(tick(s, noon)).toEqual([]);
  });

  it("a visit days away gets one reminder the day before", () => {
    const s = fresh();
    handleText(s, MARIA, "sink leaking", SUNDAY_9PM);
    handleText(s, MOM, "SEND JOHN", SUNDAY_9PM);
    handleText(s, JOHN, "wed 10am", SUNDAY_9PM);
    const confirm = handleText(s, MARIA, "yes", SUNDAY_9PM);
    expect(to(confirm, MARIA)[0]).toMatch(/remind you the day before/);
    expect(tick(s, new Date(2026, 10, 9, 12, 0))).toEqual([]); // Mon noon: too early
    const out = tick(s, new Date(2026, 10, 10, 12, 0)); // Tue noon
    expect(to(out, MARIA)[0]).toMatch(/Reminder: John is coming Wed, Nov 11, 10:00 AM/);
    expect(to(out, JOHN)[0]).toMatch(/Reminder/);
    expect(tick(s, new Date(2026, 10, 10, 13, 0))).toEqual([]); // only once
  });

  it("unknown vendor code lists the real ones", () => {
    const s = fresh();
    handleText(s, MARIA, "sink leaking", SUNDAY_9PM);
    const out = handleText(s, MOM, "send plumber", SUNDAY_9PM);
    expect(to(out, MOM)[0]).toMatch(/HVAC.*JOHN.*TOLLAND/);
  });

  it("strangers are turned away", () => {
    const s = fresh();
    const out = handleText(s, "+1 555 000 0000", "hi", SUNDAY_9PM);
    expect(out[0]!.body).toMatch(/isn't set up/);
    expect(s.repairs).toHaveLength(0);
  });

  it("anything else from a landlord gets the command list", () => {
    const out = handleText(fresh(), MOM, "hello?", SUNDAY_9PM);
    expect(out[0]!.body).toMatch(/SEND JOHN/);
  });
});
