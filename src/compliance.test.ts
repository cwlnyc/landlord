import { readFileSync } from "node:fs";
import { sampleFind, type Ai } from "./ai.js";
import { isQuietHour } from "./compliance.js";
import { handleText, tick } from "./engine.js";
import { receive } from "./interpret.js";
import type { Outbound, State } from "./types.js";

const MOM = "+1 203 555 0101";
const DAD = "+1 203 555 0102";
const MARIA = "+1 203 555 0201";
const SAM = "+1 203 555 0301";
const offline: Ai = { understand: null, find: sampleFind, live: false };
const at = (d: number, h: number) => new Date(2026, 10, d, h); // Nov 2026

function fresh(): State {
  const s: State = JSON.parse(readFileSync(new URL("../data/example.json", import.meta.url), "utf8"));
  for (const u of s.units) delete u.rent;
  return s;
}
const to = (out: Outbound[], phone: string) => out.filter((o) => o.to === phone).map((o) => o.body);

describe("the first text to anyone says who, why and how to stop", () => {
  it("tenant, landlord and repair person each get it once, before anything else", async () => {
    const s = fresh();
    let { out } = await receive(s, MARIA, "heat not working", at(8, 12), offline);
    expect(to(out, MARIA)[0]).toMatch(/^Hi Maria, this is Mom's repair and rent line\. You'll get texts here about repairs and rent at 12 Oak St.*Msg & data rates may apply\. Reply HELP for help, STOP to opt out\.$/);
    expect(to(out, MARIA)[1]).toMatch(/Got it, thanks Maria/);
    expect(to(out, MOM)[0]).toMatch(/This is your repair and rent line/);

    ({ out } = await receive(s, MOM, "yes", at(8, 12), offline));
    expect(to(out, SAM)[0]).toMatch(/Hi Sam, this is Mom's repair and rent line\. You'll get texts here about repair jobs/);
    expect(to(out, SAM)[1]).toMatch(/Hi Sam, this is the repair line for Mom/);

    ({ out } = await receive(s, MARIA, "also the sink drips", at(8, 13), offline));
    expect(to(out, MARIA).some((b) => /STOP to opt out/.test(b))).toBe(false);
  });
});

describe("STOP", () => {
  it("a tenant who texts STOP gets nothing more, and the landlord is told", async () => {
    const s = fresh();
    await receive(s, MARIA, "heat not working", at(8, 12), offline);
    const { out } = await receive(s, MARIA, "STOP", at(8, 12), offline);
    expect(to(out, MARIA)[0]).toMatch(/successfully been unsubscribed/);
    expect(to(out, MOM)[0]).toMatch(/Maria \(tenant\) texted STOP: the line won't text them anymore/);
    expect(s.repairs).toHaveLength(1); // STOP isn't a repair

    // Mom sends Sam; Sam offers a time; the "be home?" text to Maria is dropped.
    await receive(s, MOM, "yes", at(8, 12), offline);
    const offer = await receive(s, SAM, "tomorrow 10am", at(8, 12), offline);
    expect(to(offer.out, MARIA)).toEqual([]);
    expect(s.consent?.["2035550201"]?.how).toMatch(/opted out by texting STOP/);
  });

  it("START brings them back", async () => {
    const s = fresh();
    await receive(s, MARIA, "STOP", at(8, 12), offline);
    const { out } = await receive(s, MARIA, "start", at(8, 13), offline);
    expect(to(out, MARIA)[0]).toMatch(/re-subscribed/);
    expect(s.optedOut).toEqual([]);
  });

  it("on the live line Twilio answers STOP itself, so the line only records it", async () => {
    const s = fresh();
    const { out } = await receive(s, MARIA, "unsubscribe", at(8, 12), offline, true);
    expect(to(out, MARIA)).toEqual([]);
    expect(s.optedOut).toContain("2035550201");
  });

  it("CANCEL alone is an opt-out; CANCEL 1 and DROP 1 are commands", async () => {
    const s = fresh();
    await receive(s, MARIA, "heat not working", at(8, 12), offline);
    await receive(s, MOM, "DROP 1", at(8, 12), offline);
    expect(s.repairs[0]!.status).toBe("cancelled");
    await receive(s, DAD, "cancel", at(8, 12), offline);
    expect(s.optedOut).toContain("2035550102");
  });

  it("HELP from a tenant explains the line", async () => {
    const { out } = await receive(fresh(), MARIA, "help", at(8, 12), offline);
    expect(to(out, MARIA).at(-1)).toMatch(/Mom's repair and rent line\. Text a problem/);
  });
});

describe("no automatic texts at night", () => {
  it("a check-back due at 11pm waits until 8am", () => {
    const s = fresh();
    s.welcomed = ["2035550101", "2035550102", "2035550201", "2035550301"];
    handleText(s, MARIA, "heat not working", at(8, 12));
    handleText(s, MOM, "yes", at(8, 12));
    handleText(s, SAM, "tomorrow 6pm", at(8, 12));
    handleText(s, MARIA, "1", at(8, 12));
    expect(tick(s, at(9, 23))).toEqual([]); // 5h after the visit, but night
    expect(tick(s, at(10, 7))).toEqual([]);
    expect(to(tick(s, at(10, 8)), MOM)[0]).toMatch(/Did Sam fix 12 Oak St, Unit 1 \(#1\)\?/);
  });

  it("quiet hours are 9pm to 8am", () => {
    expect(isQuietHour(at(8, 20))).toBe(false);
    expect(isQuietHour(at(8, 21))).toBe(true);
    expect(isQuietHour(at(8, 7))).toBe(true);
    expect(isQuietHour(at(8, 8))).toBe(false);
  });
});

describe("the legal pages match what the line really sends", () => {
  const build = readFileSync(new URL("../legal/build.mjs", import.meta.url), "utf8");
  it("the first-text wording on the opt-in page is the code's", async () => {
    const { out } = await receive(fresh(), MARIA, "heat not working", at(8, 12), offline);
    const welcome = to(out, MARIA)[0]!;
    // Same sentences, different sample names and address.
    const tail = welcome.slice(welcome.indexOf("Msg frequency"));
    expect(build).toContain(tail);
    expect(build).toContain("this is Pat's repair and rent line. You'll get texts here about repairs and rent at");
  });
  it("the STOP confirmation on the opt-in page is the code's", async () => {
    const { out } = await receive(fresh(), MARIA, "STOP", at(8, 12), offline);
    expect(build).toContain(to(out, MARIA)[0]);
  });
  it("quiet hours on the SMS terms page are the code's", () => {
    expect(build).toContain("between 9pm and 8am");
  });
});
