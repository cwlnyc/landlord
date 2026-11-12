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
    expect(to(samSaysNo(s), MOM)[0]).toMatch(/Sam can't do #1.*No one else saved does HVAC work\. Search for HVAC companies near Naugatuck\?$/);
  });

  it("plans a search for the right repair, trade and town", () => {
    const s = fresh();
    samSaysNo(s);
    expect(planFind(s, "FIND HVAC", undefined, SUNDAY_9PM)).toEqual({
      repairId: 1,
      trade: "HVAC",
      town: "Naugatuck",
      problem: "heat not working",
      urgent: true,
      when: "now (Sunday 9:00 PM), or first thing tomorrow (Monday) at the latest",
    });
    expect(planFind(s, "FIND plumber #1")).toMatchObject({ repairId: 1, trade: "plumber" });
    expect(planFind(fresh(), "FIND HVAC")).toHaveProperty("reply"); // no repairs at all
  });

  it("lists results to call, then BOOKED runs the tenant check without texting the business", async () => {
    const s = fresh();
    samSaysNo(s);
    const found = await receive(s, MOM, "FIND HVAC", SUNDAY_9PM, offline);
    expect(to(found.out, MOM)[0]).toMatch(/^Looking for HVAC near Naugatuck for #1 now/);
    const list = to(found.out, MOM)[1]!;
    expect(list).toMatch(/SAMPLE RESULTS/);
    expect(list).toMatch(/1\. Naugatuck HVAC Pros \(sample\) 4\.9★ \(190 reviews\), 24\/7 emergency service\n {3}\(203\) 555-0191/);
    expect(list).toMatch(/tell me who you booked and when \(like: 1, tomorrow 8am\)/);

    const booked = handleText(s, MOM, "BOOKED 1 TOMORROW 8AM", SUNDAY_9PM);
    expect(to(booked, MARIA)[0]).toMatch(/Naugatuck HVAC Pros \(sample\) \(HVAC\) can come Mon, Nov 9, 8:00 AM.*Will you be home then\?/);
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
    expect(to(out, MOM)[0]).toMatch(/Call Naugatuck HVAC Pros \(sample\) at \(203\) 555-0191 for another time, then tell me the new day and time/);
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
    expect(to(out, MOM)[0]).toMatch(/^Looking for HVAC/);
    expect(to(out, MOM)[1]).toMatch(/didn't work/);
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
    expect(to(out, SAM)[0]).toMatch(/didn't catch the day and time/);

    vi.spyOn(console, "error").mockImplementation(() => {});
    const down: Ai = { understand: async () => { throw new Error("529"); }, find: sampleFind, live: true };
    ({ out } = await receive(s, SAM, "maybe later this week", SUNDAY_9PM, down));
    expect(to(out, SAM)[0]).toMatch(/didn't catch the day and time/);
  });

  it("an AI-written FIND runs the search", async () => {
    const s = fresh();
    samSaysNo(s);
    const ai: Ai = { understand: async () => "FIND hvac 1", find: sampleFind, live: false };
    const { out } = await receive(s, MOM, "can you look for another heating guy", SUNDAY_9PM, ai);
    expect(to(out, MOM)[1]).toMatch(/HVAC near Naugatuck for #1, who can come now or offer 24\/7 service:/);
  });
});

describe("FIND in context (from the family test)", () => {
  // Dad's test: a saved repair person had the code PLUMBER, he texted FIND,
  // was asked what kind, answered "plumber", and the line read it as
  // "send the saved plumber". Then the search was silent for a while.
  function withSavedPlumber() {
    const s = fresh();
    s.vendors.push({ code: "PLUMBER", name: "Test Plumber", trade: "plumber", town: "all", phone: "+1 203 555 0399" });
    s.welcomed!.push("2035550399");
    return s;
  }

  it("a bare FIND takes the trade from the problem: a leak means a plumber", async () => {
    const s = withSavedPlumber();
    handleText(s, MARIA, "kitchen sink is leaking", SUNDAY_9PM);
    const { out } = await receive(s, MOM, "find", SUNDAY_9PM, offline);
    expect(to(out, MOM)[0]).toMatch(/^Looking for plumber near Naugatuck for #1 now/);
    expect(to(out, MOM)[1]).toMatch(/PLUMBER near Naugatuck for #1, who can come now/);
  });

  it("when it has to ask, the next word is the answer, even if a saved code matches it", async () => {
    const s = withSavedPlumber();
    handleText(s, MARIA, "weird noise in the wall", SUNDAY_9PM);
    let { out } = await receive(s, MOM, "FIND", SUNDAY_9PM, offline);
    expect(to(out, MOM)[0]).toMatch(/What kind of repair person for #1 \("weird noise in the wall"\)\?/);
    // An AI that would misread it, like it did for Dad, must not be asked.
    const wouldMisread: Ai = { understand: async () => "SEND PLUMBER 1", find: sampleFind, live: false };
    ({ out } = await receive(s, MOM, "plumber", SUNDAY_9PM, wouldMisread));
    expect(to(out, MOM)[0]).toMatch(/^Looking for plumber near Naugatuck for #1 now/);
    expect(s.repairs[0]!.status).toBe("new"); // nobody was sent
    expect(s.pendingFind).toEqual({});
  });

  it("a command instead of the answer cancels the question", async () => {
    const s = withSavedPlumber();
    handleText(s, MARIA, "weird noise in the wall", SUNDAY_9PM);
    await receive(s, MOM, "FIND", SUNDAY_9PM, offline);
    await receive(s, MOM, "LIST", SUNDAY_9PM, offline);
    expect(s.pendingFind).toEqual({});
  });

  it("the 'looking now' note goes out before the search finishes", async () => {
    const s = withSavedPlumber();
    handleText(s, MARIA, "kitchen sink is leaking", SUNDAY_9PM);
    const sentFirst: string[] = [];
    let searchStarted = false;
    const slow: Ai = {
      understand: null,
      live: true,
      find: async (plan) => {
        searchStarted = true;
        expect(sentFirst[0]).toMatch(/Looking for plumber/); // already sent
        return sampleFind(plan);
      },
    };
    const { out } = await receive(s, MOM, "find", SUNDAY_9PM, slow, false, async (now) => {
      sentFirst.push(...now.map((o) => o.body));
    });
    expect(searchStarted).toBe(true);
    expect(to(out, MOM)[0]).toMatch(/PLUMBER near Naugatuck/); // only the results are left
  });

  it("the AI is shown the last text the line sent, so it can read replies in context", () => {
    const s = withSavedPlumber();
    s.lastSent = { "2035550101": "Send Sam (HVAC)? Reply YES, or FIND HVAC to search near Naugatuck." };
    const help = needsHelp(s, MOM, "how about the other guy", SUNDAY_9PM);
    expect(help!.context).toMatch(/The last text the line sent them[^]*Send Sam \(HVAC\)\?/);
  });
});

describe("the landlord does the least work (Dad's wish)", () => {
  function withPlumber() {
    const s = fresh();
    s.vendors.push({ code: "PLUMBER", name: "Test Plumber", trade: "plumber", town: "all", phone: "+1 203 555 0399" });
    s.welcomed!.push("2035550399");
    return s;
  }
  const PLUMBER = "+1 203 555 0399";

  it("'my waters not working' -> Send Test Plumber? YES -> they can't -> Search? YES -> results", async () => {
    const s = withPlumber();
    let { out } = await receive(s, MARIA, "my waters not working", SUNDAY_9PM, offline);
    expect(to(out, MOM)[0]).toMatch(/Send Test Plumber \(plumber\)\?$/);

    ({ out } = await receive(s, MOM, "yes", SUNDAY_9PM, offline));
    expect(to(out, PLUMBER)[0]).toMatch(/my waters not working/);

    ({ out } = await receive(s, PLUMBER, "no sorry", SUNDAY_9PM, offline));
    expect(to(out, MOM)[0]).toMatch(/Test Plumber can't do #1.*No one else saved does plumber work\. Search for plumbers near Naugatuck\?$/);

    ({ out } = await receive(s, MOM, "yes", SUNDAY_9PM, offline));
    expect(to(out, MOM)[0]).toMatch(/^Looking for plumber near Naugatuck for #1 now/);
    expect(to(out, MOM)[1]).toMatch(/PLUMBER near Naugatuck for #1, who can come now or offer 24\/7 service:\n1\./);
  });

  it("the AI picks the trade when the words don't say", async () => {
    const s = fresh();
    s.vendors.push({ code: "SPARKY", name: "Sparky", trade: "electrician", town: "all", phone: "+1 203 555 0398" });
    s.welcomed!.push("2035550398");
    const ai: Ai = { understand: null, find: sampleFind, live: true, trade: async () => "electrician" };
    const { out } = await receive(s, MARIA, "half the apartment went dark", SUNDAY_9PM, ai);
    expect(to(out, MOM)[0]).toMatch(/Send Sparky \(electrician\)\?$/);
    expect(s.repairs[0]!.trade).toBe("electrician");
  });

  it("the AI isn't asked when the words already say, or for rent and replies", async () => {
    const s = withPlumber();
    let asked = 0;
    const ai: Ai = { understand: null, find: sampleFind, live: true, trade: async () => (asked++, "HVAC") };
    await receive(s, MARIA, "toilet is clogged", SUNDAY_9PM, ai);
    await receive(s, MARIA, "sent the rent on zelle", SUNDAY_9PM, ai);
    expect(asked).toBe(0);
    expect(s.repairs[0]!.trade).toBe("plumber");
  });

  it("if the AI is down, the repair still goes through", async () => {
    const s = fresh();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ai: Ai = { understand: null, find: sampleFind, live: true, trade: async () => { throw new Error("529"); } };
    const { out } = await receive(s, MARIA, "half the apartment went dark", SUNDAY_9PM, ai);
    expect(to(out, MOM)[0]).toMatch(/New repair #1/);
  });
});

describe("replies a person would actually write", () => {
  it("after a search list, '1, tomorrow 8am' books result 1", async () => {
    const s = fresh();
    samSaysNo(s);
    await receive(s, MOM, "FIND HVAC", SUNDAY_9PM, offline);
    const { out } = await receive(s, MOM, "1, tomorrow 8am", SUNDAY_9PM, offline);
    expect(to(out, MOM)[0]).toMatch(/Booked Naugatuck HVAC Pros \(sample\) for #1, Mon, Nov 9, 8:00 AM/);
    expect(to(out, MARIA)[0]).toMatch(/Will you be home then\?/);
  });

  it("after 'call them back', a bare day and time books them again", async () => {
    const s = fresh();
    samSaysNo(s);
    await receive(s, MOM, "FIND HVAC", SUNDAY_9PM, offline);
    await receive(s, MOM, "1 tomorrow 8am", SUNDAY_9PM, offline);
    await receive(s, MARIA, "no", SUNDAY_9PM, offline);
    const { out } = await receive(s, MOM, "tue 10am", SUNDAY_9PM, offline);
    expect(to(out, MARIA)[0]).toMatch(/Tue, Nov 10, 10:00 AM.*Will you be home then\?/);
  });

  it.each(["my waters not working", "water's off", "ceiling is leaking", "basement flooded"])("'%s' is urgent", (problem) => {
    const s = fresh();
    handleText(s, MARIA, problem, SUNDAY_9PM);
    expect(planFind(s, "FIND plumber", undefined, SUNDAY_9PM)).toMatchObject({ urgent: true });
  });

  it("a non-urgent job searches for the next couple of days, not tonight", () => {
    const s = fresh();
    handleText(s, MARIA, "closet door is off its track", SUNDAY_9PM);
    const plan = planFind(s, "FIND handyman", undefined, SUNDAY_9PM);
    expect(plan).toMatchObject({ urgent: false, when: "in the next couple of days (Monday or Tuesday)" });
  });

  it("an urgent search only lists ones who can come now", async () => {
    const s = fresh();
    samSaysNo(s);
    const { out } = await receive(s, MOM, "FIND HVAC", SUNDAY_9PM, offline);
    const list = to(out, MOM)[1]!;
    expect(list).toMatch(/24\/7 emergency service/);
    expect(list).not.toMatch(/Mon-Fri/);
  });
});
