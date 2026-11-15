import { readFileSync } from "node:fs";
import type { Ai } from "./ai.js";
import { receive } from "./interpret.js";
import { looksForeign, type Translator } from "./translate.js";
import type { Outbound, State } from "./types.js";

/*
 * The line translates between people who don't share a language. A fake
 * translator stands in for the AI: it knows a few Spanish lines, and marks
 * everything it translates out as [es], so the tests can see what went where.
 */

const MOM = "+1 203 555 0101";
const MARIA = "+1 203 555 0201";
const JOHN = "+1 203 555 0302";

const SPANISH: Record<string, string> = {
  "no hay agua caliente": "there's no hot water",
  "sí, estaré en casa": "yes, I'll be home",
  "aquí está la foto": "here is the photo",
};
const fake: Translator = {
  toEnglish: async (text) => {
    const english = SPANISH[text.trim().toLowerCase()];
    return english ? { language: "Spanish", english } : { language: "English", english: text };
  },
  fromEnglish: async (text, language) => `[${language === "Spanish" ? "es" : language}] ${text}`,
};

function fresh(): State {
  const s: State = JSON.parse(readFileSync(new URL("../data/example.json", import.meta.url), "utf8"));
  for (const u of s.units) delete u.rent;
  s.welcomed = ["2035550101", "2035550102", "2035550201", "8605550202", "2035550203", "2035550301", "2035550302", "8605550303"];
  return s;
}
const ai = (translate: Translator | null = fake): Ai => ({ understand: null, find: async () => [], live: true, translate });
const to = (out: Outbound[], phone: string) => out.filter((o) => o.to === phone).map((o) => o.body);
const SUNDAY_9PM = new Date(2026, 10, 8, 21, 0);

describe("translating between tenants, landlords and repair people", () => {
  it("a tenant who writes in Spanish: the engine reads English, she's answered in Spanish, the landlord sees both", async () => {
    const s = fresh();
    const { out } = await receive(s, MARIA, "No hay agua caliente", SUNDAY_9PM, ai());
    expect(s.units[0]!.tenant.lang).toBe("Spanish");
    expect(s.repairs[0]!.text).toBe("there's no hot water");
    expect(to(out, MARIA)[0]).toMatch(/^\[es\] Got it, thanks Maria/);
    const mom = to(out, MOM);
    expect(mom[0]).toBe("Maria wrote in Spanish, so I'll translate between you from now on. (To stop: Maria speaks English)");
    expect(mom[1]).toMatch(/from Maria:\n"there's no hot water"[\s\S]*\(Maria wrote in Spanish: "No hay agua caliente"\)$/);
  });

  it("the repair person's question reaches her in Spanish, and her answer reaches him in English with her words", async () => {
    const s = fresh();
    await receive(s, MARIA, "No hay agua caliente", SUNDAY_9PM, ai());
    await receive(s, MOM, "SEND JOHN", SUNDAY_9PM, ai());
    let { out } = await receive(s, JOHN, "can I see a pic?", SUNDAY_9PM, ai());
    expect(to(out, MARIA)[0]).toMatch(/^\[es\] John \(handyman\)/);
    ({ out } = await receive(s, MARIA, "Aquí está la foto", SUNDAY_9PM, ai(), false, undefined, ["https://x.test/p.jpg"]));
    expect(to(out, JOHN)[0]).toMatch(/^Maria says: "here is the photo"[\s\S]*\(Maria wrote in Spanish: "Aquí está la foto"\)$/);
  });

  it("the landlord can set a language by text, and switch it back", async () => {
    const s = fresh();
    let { out } = await receive(s, MOM, "John speaks Spanish", SUNDAY_9PM, ai());
    expect(to(out, MOM)[0]).toBe("Got it: I'll text John in Spanish and translate their texts for you.");
    expect(s.vendors.find((v) => v.name === "John")!.lang).toBe("Spanish");
    await receive(s, MARIA, "sink leaking", SUNDAY_9PM, ai());
    ({ out } = await receive(s, MOM, "SEND JOHN", SUNDAY_9PM, ai()));
    expect(to(out, JOHN)[0]).toMatch(/^\[es\] Hi John/);
    ({ out } = await receive(s, MOM, "John speaks English", SUNDAY_9PM, ai()));
    expect(to(out, MOM)[0]).toBe("Got it: John gets texts in English again.");
    expect(s.vendors.find((v) => v.name === "John")!.lang).toBeUndefined();
  });

  it("plain English costs nothing: the AI isn't even asked", async () => {
    const s = fresh();
    let asked = 0;
    const counting: Translator = { ...fake, toEnglish: async (t) => (asked++, fake.toEnglish(t)) };
    await receive(s, MARIA, "sink is leaking", SUNDAY_9PM, ai(counting));
    expect(asked).toBe(0);
    expect(looksForeign("sink is leaking")).toBe(false);
    expect(looksForeign("no hay agua")).toBe(true);
    expect(looksForeign("暖气坏了")).toBe(true);
  });

  it("with no AI, nothing is translated and nothing breaks", async () => {
    const s = fresh();
    const { out } = await receive(s, MARIA, "No hay agua caliente", SUNDAY_9PM, ai(null));
    expect(s.units[0]!.tenant.lang).toBeUndefined();
    expect(to(out, MOM)[0]).toMatch(/"No hay agua caliente"/);
  });

  it("a translator outage falls back to English instead of dropping the text", async () => {
    const s = fresh();
    s.units[0]!.tenant.lang = "Spanish";
    const broken: Translator = { toEnglish: async () => { throw new Error("down"); }, fromEnglish: async () => { throw new Error("down"); } };
    const { out } = await receive(s, MARIA, "sink leaking", SUNDAY_9PM, ai(broken));
    expect(to(out, MARIA)[0]).toMatch(/^Got it, thanks Maria/);
    expect(s.repairs).toHaveLength(1);
  });
});
