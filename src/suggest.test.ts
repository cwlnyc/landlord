import { readFileSync } from "node:fs";
import { handleText, needsHelp } from "./engine.js";
import type { Outbound, State } from "./types.js";

const MOM = "+1 203 555 0101";
const DAD = "+1 203 555 0102";
const MARIA = "+1 203 555 0201"; // Naugatuck
const KEVIN = "+1 860 555 0202"; // Tolland
const SAM = "+1 203 555 0301"; // HVAC, all CT
const ROB = "+1 860 555 0303"; // handyman, Tolland
const NOW = new Date(2026, 10, 8, 21, 0);

function fresh(): State {
  const s: State = JSON.parse(readFileSync(new URL("../data/example.json", import.meta.url), "utf8"));
  // Repairs only here; rent.test.ts covers rent.
  for (const u of s.units) delete u.rent;
  return s;
}
const to = (out: Outbound[], phone: string) => out.filter((o) => o.to === phone).map((o) => o.body);
const card = (name: string, phone: string) =>
  `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL:${phone}\nEND:VCARD`;

describe("the bot suggests who to send", () => {
  it("heat problem: 'Send Sam?', and YES sends him", () => {
    const s = fresh();
    const out = handleText(s, MARIA, "heat not working", NOW);
    expect(to(out, MOM)[0]).toMatch(/Send Sam \(HVAC\)\?$/);
    const yes = handleText(s, MOM, "yes", NOW);
    expect(to(yes, SAM)[0]).toMatch(/heat not working/);
    expect(s.repairs[0]!.status).toBe("asking-vendor");
  });

  it("odd job in Tolland: suggests the Tolland handyman", () => {
    const s = fresh();
    const out = handleText(s, KEVIN, "bedroom door won't close", NOW);
    expect(to(out, DAD)[0]).toMatch(/Send Rob \(handyman\)\?/);
    handleText(s, DAD, "Y", NOW);
    expect(s.repairs[0]!.vendorCode).toBe("TOLLAND");
  });

  it("they say no: suggests the next person, then a search", () => {
    const s = fresh();
    handleText(s, KEVIN, "bedroom door won't close", NOW);
    handleText(s, MOM, "yes", NOW);
    let out = handleText(s, ROB, "no sorry", NOW);
    expect(to(out, MOM)[0]).toMatch(/Rob can't do .* \(#1\).*Send John \(handyman\)\?$/);
    handleText(s, MOM, "yes", NOW);
    out = handleText(s, "+1 203 555 0302", "no", NOW);
    // A door is handyman work with no search trade, so it asks what kind.
    expect(to(out, MOM)[0]).toMatch(/John can't do .* \(#1\).*What kind of repair person should I look for, near Tolland\?$/);
  });

  it("no one saved fits: says so and offers FIND", () => {
    const s = fresh();
    const out = handleText(s, MARIA, "outlet sparking in kitchen", NOW);
    expect(to(out, MOM)[0]).toMatch(/No saved electrician for this\. Search for electricians near Naugatuck\?$/);
    // That YES is a search: handled before the engine (receive), so the
    // engine alone has nothing to send.
    expect(s.repairs[0]!.suggested).toBe("FIND");
  });

  it("NO to a suggested person offers the next step as a YES: here, a search", () => {
    const s = fresh();
    handleText(s, MARIA, "heat not working", NOW);
    const out = handleText(s, MOM, "no", NOW);
    expect(to(out, MOM)[0]).toMatch(/^OK, not Sam\. No one else saved does HVAC work\. Search for HVAC companies near Naugatuck\?$/);
    expect(s.repairs[0]!.status).toBe("new");
    expect(s.repairs[0]!.suggested).toBe("FIND");
    expect(s.repairs[0]!.tried).toEqual(["HVAC"]);
  });

  it("NO to a suggested person offers the next one who fits", () => {
    const s = fresh();
    handleText(s, KEVIN, "bedroom door won't close", NOW); // Tolland: Rob first
    const out = handleText(s, MOM, "nope", NOW);
    expect(to(out, MOM)[0]).toMatch(/^OK, not Rob\. Send John \(handyman\)\?$/);
  });

  it("NO to a search keeps it waiting for the landlord's pick", () => {
    const s = fresh();
    handleText(s, MARIA, "outlet sparking in kitchen", NOW); // no electrician saved
    const out = handleText(s, MOM, "no", NOW);
    expect(to(out, MOM)[0]).toMatch(/^OK, no search\. Reply SEND/);
    expect(s.repairs[0]!.suggested).toBeUndefined();
  });

  it("normal yeses work: 'sure', 'go ahead', 'sounds good'", () => {
    for (const reply of ["sure", "go ahead", "sounds good", "yup"]) {
      const s = fresh();
      handleText(s, MARIA, "heat not working", NOW);
      handleText(s, MOM, reply, NOW);
      expect(s.repairs[0]!.status, reply).toBe("asking-vendor");
    }
  });

  it("YES with no pending suggestion doesn't send anyone", () => {
    const s = fresh();
    expect(to(handleText(s, MOM, "ok", NOW), MOM)[0]).toMatch(/Nothing's waiting on you right now/);
  });
});

describe("adding repair people by sharing a contact", () => {
  it("'Mike plumber Hamden' is saved and suggested for the next leak there", () => {
    const s = fresh();
    const out = handleText(s, MOM, card("Mike plumber Hamden", "(203) 555-0404"), NOW);
    expect(to(out, MOM)[0]).toMatch(/Saved Mike: plumber, Hamden \(code MIKE\)/);
    const leak = handleText(s, "+1 203 555 0203", "sink is leaking under the cabinet", NOW);
    expect(to(leak, MOM)[0]).toMatch(/Send Mike \(plumber\)\?/);
  });

  it("asks once when the name doesn't say the trade", () => {
    const s = fresh();
    let out = handleText(s, MOM, card("Dave Smith", "(203) 555-0405"), NOW);
    expect(to(out, MOM)[0]).toMatch(/What do they do, and where\? \(Like: plumber, Hamden\)/);
    expect(needsHelp(s, MOM, "electrician hamden", NOW)).toBeNull();
    out = handleText(s, MOM, "electrician hamden", NOW);
    expect(to(out, MOM)[0]).toMatch(/Saved Dave Smith: electrician, Hamden/);
  });

  it("sharing someone again updates them instead of adding a copy", () => {
    const s = fresh();
    handleText(s, MOM, card("Sam HVAC Naugatuck", "+1 203 555 0301"), NOW);
    expect(s.vendors.filter((v) => v.phone === SAM || v.phone.includes("555-0301") || v.phone.endsWith("0301"))).toHaveLength(1);
    expect(s.vendors.find((v) => v.code === "HVAC")?.town).toBe("Naugatuck");
  });

  it("won't add a tenant as a repair person", () => {
    const s = fresh();
    const out = handleText(s, MOM, card("Maria", MARIA), NOW);
    expect(to(out, MOM)[0]).toMatch(/already a landlord or tenant/);
  });
});
