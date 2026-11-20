import { readFileSync } from "node:fs";
import { handleText } from "./engine.js";
import { followUpQuestion, safetyTip } from "./intake.js";
import type { Outbound, State } from "./types.js";

/*
 * Mom works with the tenant first: what exactly is wrong, where, and a
 * photo. The line does the same right after a report, so the repair person's
 * first text already has the details.
 */

const MOM = "+1 203 555 0101";
const MARIA = "+1 203 555 0201";
const JOHN = "+1 203 555 0302";
const PHOTO = "https://example.com/sink.jpg";

function fresh(): State {
  const s: State = JSON.parse(readFileSync(new URL("../data/example.json", import.meta.url), "utf8"));
  for (const u of s.units) delete u.rent;
  return s;
}
const to = (out: Outbound[], phone: string) => out.filter((o) => o.to === phone);
const bodies = (out: Outbound[], phone: string) => to(out, phone).map((o) => o.body);
const SUNDAY_9PM = new Date(2026, 10, 8, 21, 0);

describe("working with the tenant first", () => {
  it("'my waters not working': asks exactly what and where, and for a photo; the landlord hears right away", () => {
    const s = fresh();
    const out = handleText(s, MARIA, "my waters not working", SUNDAY_9PM);
    expect(bodies(out, MARIA)[0]).toBe(
      "Got it, thanks Maria. I've told your landlord.\n\nTo help the repair person: Is it no water at all, or just no hot water? Is it every faucet, or just one? A photo or short video helps too. You can send it right here.",
    );
    expect(bodies(out, MOM)[0]).toMatch(/^New repair \(sounds urgent\)/);
  });

  it("the answer and photo are saved, go to the landlord, and are in the repair person's first text", () => {
    const s = fresh();
    handleText(s, MARIA, "my waters not working", SUNDAY_9PM);
    let out = handleText(s, MARIA, "no hot water, kitchen and bathroom", SUNDAY_9PM);
    expect(bodies(out, MARIA)[0]).toBe("Thanks, that helps. I've passed it on. A photo would help too, if you can.");
    expect(bodies(out, MOM)[0]).toMatch(/Maria added about 12 Oak St, Unit 1 \(#1\): "no hot water, kitchen and bathroom"\n\nNo saved plumber for this\. Search for plumbers near Naugatuck\?$/);
    out = handleText(s, MARIA, "", SUNDAY_9PM, { media: [PHOTO] });
    expect(bodies(out, MARIA)[0]).toBe("Thanks, that helps. I've passed it on.");
    expect(to(out, MOM)[0]!.media).toEqual([PHOTO]);
    expect(s.repairs).toHaveLength(1);

    out = handleText(s, MOM, "SEND JOHN", SUNDAY_9PM);
    const first = to(out, JOHN)[0]!;
    expect(first.body).toMatch(/Job at 12 Oak St, Naugatuck, Unit 1: "my waters not working"\. Maria adds: "no hot water, kitchen and bathroom"\. When could you go\?/);
    expect(first.media).toEqual([PHOTO]);
    // He asks for a picture anyway: he gets the one she sent, she isn't bothered.
    out = handleText(s, JOHN, "can I see a pic?", SUNDAY_9PM);
    expect(to(out, JOHN)[0]!.media).toEqual([PHOTO]);
    expect(to(out, MARIA)).toHaveLength(0);
  });

  it("a detail sent after the repair person was asked goes to them too", () => {
    const s = fresh();
    handleText(s, MARIA, "sink leaking", SUNDAY_9PM);
    handleText(s, MOM, "SEND JOHN", SUNDAY_9PM);
    const out = handleText(s, MARIA, "it's under the kitchen sink, steady drip", SUNDAY_9PM);
    expect(bodies(out, JOHN)[0]).toBe('Maria added about 12 Oak St, Naugatuck, Unit 1: "it\'s under the kitchen sink, steady drip"');
  });

  it("after words and a photo, or two texts, the next text is a new repair", () => {
    const s = fresh();
    handleText(s, MARIA, "heat not working", SUNDAY_9PM);
    handleText(s, MARIA, "no heat anywhere", SUNDAY_9PM);
    handleText(s, MARIA, "", SUNDAY_9PM, { media: [PHOTO] });
    handleText(s, MARIA, "also the bathroom fan is broken", SUNDAY_9PM);
    expect(s.repairs).toHaveLength(2);
  });

  it("a day later, a text is a new repair, not a detail", () => {
    const s = fresh();
    handleText(s, MARIA, "heat not working", SUNDAY_9PM);
    handleText(s, MARIA, "the door lock is broken", new Date(2026, 10, 9, 21, 0));
    expect(s.repairs).toHaveLength(2);
  });

  it("safety first when it matters, and nothing scary when it doesn't", () => {
    expect(safetyTip("I smell gas in the kitchen")).toMatch(/leave right away and call 911/);
    expect(safetyTip("sparks from the outlet")).toMatch(/call 911/);
    expect(safetyTip("CO alarm keeps beeping")).toMatch(/get everyone outside/);
    expect(safetyTip("pipe burst, water everywhere")).toMatch(/turn off the water valve/);
    expect(safetyTip("bedroom door won't close")).toBeNull();
    expect(safetyTip("gas stove won't light")).toBeNull();
  });

  it("each kind of problem gets its own question", () => {
    expect(followUpQuestion("heat not working", "HVAC")).toMatch(/no heat anywhere/);
    expect(followUpQuestion("outlet dead", "electrician")).toMatch(/breaker box/);
    expect(followUpQuestion("toilet clogged", "plumber")).toMatch(/backing up/);
    expect(followUpQuestion("door won't close", null)).toMatch(/What exactly is broken/);
  });
});
