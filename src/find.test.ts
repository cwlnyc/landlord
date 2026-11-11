import { readFileSync } from "node:fs";
import { sampleFind, type Ai } from "./ai.js";
import { handleText, needsHelp, planFind, tick } from "./engine.js";
import { receive } from "./interpret.js";
import type { Outbound, State } from "./types.js";

const MOM = "+1 203 555 0101";
const MARIA = "+1 203 555 0201";
const SAM = "+1 203 555 0301";
const SUNDAY_9PM = new Date(2026, 10, 8, 21, 0); // Sun Nov 8 2026

function fresh(): State {
  const s: State = JSON.parse(readFileSync(new URL("../data/example.json", import.meta.url), "utf8"));
  // Repairs only here; rent.test.ts covers rent, compliance.test.ts the
  // first-text welcome (so here everyone has had it).
  for (const u of s.units) delete u.rent;
  s.welcomed = [...s.landlords.map((l) => l.phone), ...s.units.map((u) => u.tenant.phone), ...s.vendors.map((v) => v.phone)].map(
    (p) => p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""),
  );
  return s;
}
const to = (out: Outbound[], phone: string) => out.filter((o) => o.to === phone).map((o) => o.body);
const offline: Ai = { understand: null, find: sampleFind, live: false };

/** The usual HVAC guy says no, as on the night of the Naugatuck furnace. */
function samSaysNo(s: State) {
  handleText(s, MARIA, "heat not working", SUNDAY_9PM);
  handleText(s, MOM, "SEND HVAC", SUNDAY_9PM);
  return handleText(s, SAM, "no sorry, booked solid", SUNDAY_9PM);
}

describe("FIND and BOOKED: when the usual person can't come", () => {
  it("offers FIND when the repair person says no", () => {
    const s = fresh();
    expect(to(samSaysNo(s), MOM)[0]).toMatch(/FIND HVAC to search near Naugatuck/);
  });

  it("plans a search for the right repair, trade and town", () => {
    const s = fresh();
    samSaysNo(s);
    expect(planFind(s, "FIND HVAC")).toEqual({
      repairId: 1,
      trade: "HVAC",
      town: "Naugatuck",
      problem: "heat not working",
    });
    expect(planFind(s, "FIND plumber #1")).toMatchObject({ repairId: 1, trade: "plumber" });
    expect(planFind(fresh(), "FIND HVAC")).toHaveProperty("reply"); // no repairs at all
  });

  it("lists results to call, then BOOKED runs the tenant check without texting the business", async () => {
    const s = fresh();
    samSaysNo(s);
    const found = await receive(s, MOM, "FIND HVAC", SUNDAY_9PM, offline);
    const list = to(found.out, MOM)[0]!;
    expect(list).toMatch(/SAMPLE RESULTS/);
    expect(list).toMatch(/1\. Naugatuck HVAC Pros \(sample\) 4\.9★ \(190 reviews\), 24\/7 emergency service\n {3}\(203\) 555-0191/);
    expect(list).toMatch(/BOOKED 1 TOMORROW 8AM/);

    const booked = handleText(s, MOM, "BOOKED 1 TOMORROW 8AM", SUNDAY_9PM);
    expect(to(booked, MARIA)[0]).toMatch(/Naugatuck HVAC Pros \(sample\) \(HVAC\) can come Mon, Nov 9, 8:00 AM.*Reply 1/);
    expect(to(booked, MOM)[0]).toMatch(/I won't text them/);
    expect(booked.some((o) => o.to.includes("555-0191"))).toBe(false);

    const confirmed = handleText(s, MARIA, "1", SUNDAY_9PM);
    expect(s.repairs[0]!.status).toBe("confirmed");
    expect(confirmed.some((o) => o.to.includes("555-0191"))).toBe(false);
    // Reminders and the check-back skip the business too.
    const later = [...tick(s, new Date(2026, 10, 8, 23)), ...tick(s, new Date(2026, 10, 9, 14))];
    expect(later.some((o) => o.to.includes("555-0191"))).toBe(false);
    expect(to(later, MOM)[0]).toMatch(/DONE 1/);
  });

  it("tenant can't make a phone booking: landlord gets the number to call back", async () => {
    const s = fresh();
    samSaysNo(s);
    await receive(s, MOM, "FIND HVAC", SUNDAY_9PM, offline);
    handleText(s, MOM, "BOOKED 1 TOMORROW 8AM", SUNDAY_9PM);
    const out = handleText(s, MARIA, "2", SUNDAY_9PM);
    expect(s.repairs[0]!.status).toBe("new");
    expect(to(out, MOM)[0]).toMatch(/Call Naugatuck HVAC Pros \(sample\) at \(203\) 555-0191.*BOOKED NAUGATUCK/);
    handleText(s, MOM, "BOOKED NAUGATUCK TUE 10AM", SUNDAY_9PM);
    expect(s.repairs[0]!.status).toBe("asking-tenant");
  });

  it("refuses a result number that doesn't exist, and a missing time", async () => {
    const s = fresh();
    samSaysNo(s);
    expect(to(handleText(s, MOM, "BOOKED 1 TOMORROW 8AM", SUNDAY_9PM), MOM)[0]).toMatch(/no result 1/);
    await receive(s, MOM, "FIND HVAC", SUNDAY_9PM, offline);
    expect(to(handleText(s, MOM, "BOOKED 9 TOMORROW 8AM", SUNDAY_9PM), MOM)[0]).toMatch(/no result 9/);
    expect(to(handleText(s, MOM, "BOOKED 1 soon", SUNDAY_9PM), MOM)[0]).toMatch(/What time/);
    expect(s.repairs[0]!.status).toBe("new");
  });

  it("a failed search says so instead of going quiet", async () => {
    const s = fresh();
    samSaysNo(s);
    const broken: Ai = { ...offline, find: async () => { throw new Error("network"); } };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { out } = await receive(s, MOM, "FIND HVAC", SUNDAY_9PM, broken);
    expect(to(out, MOM)[0]).toMatch(/didn't work/);
  });
});

describe("messy texts and the AI", () => {
  it("only asks the AI about texts the engine can't read", () => {
    const s = fresh();
    handleText(s, MARIA, "heat not working", SUNDAY_9PM);
    expect(needsHelp(s, MARIA, "the boiler is leaking too", SUNDAY_9PM)).toBeNull(); // a new report
    expect(needsHelp(s, MOM, "SEND HVAC", SUNDAY_9PM)).toBeNull();
    expect(needsHelp(s, MOM, "get sam on it", SUNDAY_9PM)).toMatchObject({ role: "landlord" });

    handleText(s, MOM, "SEND HVAC", SUNDAY_9PM);
    expect(needsHelp(s, SAM, "tue 9am", SUNDAY_9PM)).toBeNull();
    const vendorHelp = needsHelp(s, SAM, "cant tmrw, thurs after 2 ok?", SUNDAY_9PM);
    expect(vendorHelp).toMatchObject({ role: "vendor" });
    expect(vendorHelp!.context).toMatch(/heat not working/);

    handleText(s, SAM, "tue 9am", SUNDAY_9PM);
    expect(needsHelp(s, MARIA, "1", SUNDAY_9PM)).toBeNull();
    expect(needsHelp(s, MARIA, "ya ill be here", SUNDAY_9PM)).toMatchObject({ role: "tenant" });
  });

  it("uses what the AI reads, and says what it read", async () => {
    const s = fresh();
    handleText(s, MARIA, "heat not working", SUNDAY_9PM);
    handleText(s, MOM, "SEND HVAC", SUNDAY_9PM);
    const ai: Ai = { understand: async () => "11/12 2:00pm", find: sampleFind, live: true };
    const { out, understoodAs } = await receive(s, SAM, "cant tmrw, thurs after 2 ok?", SUNDAY_9PM, ai);
    expect(understoodAs).toBe("11/12 2:00pm");
    expect(to(out, MARIA)[0]).toMatch(/Thu, Nov 12, 2:00 PM/);
  });

  it("falls back to the fixed reader when the AI can't tell or is down", async () => {
    const s = fresh();
    handleText(s, MARIA, "heat not working", SUNDAY_9PM);
    handleText(s, MOM, "SEND HVAC", SUNDAY_9PM);
    const unsure: Ai = { understand: async () => null, find: sampleFind, live: true };
    let { out } = await receive(s, SAM, "maybe later this week", SUNDAY_9PM, unsure);
    expect(to(out, SAM)[0]).toMatch(/didn't catch the time/);

    vi.spyOn(console, "error").mockImplementation(() => {});
    const down: Ai = { understand: async () => { throw new Error("529"); }, find: sampleFind, live: true };
    ({ out } = await receive(s, SAM, "maybe later this week", SUNDAY_9PM, down));
    expect(to(out, SAM)[0]).toMatch(/didn't catch the time/);
  });

  it("an AI-written FIND runs the search", async () => {
    const s = fresh();
    samSaysNo(s);
    const ai: Ai = { understand: async () => "FIND hvac 1", find: sampleFind, live: false };
    const { out } = await receive(s, MOM, "can you look for another heating guy", SUNDAY_9PM, ai);
    expect(to(out, MOM)[0]).toMatch(/HVAC near Naugatuck for #1/);
  });
});
