import { readFileSync } from "node:fs";
import type { Ai } from "./ai.js";
import { QUESTIONS } from "./applications.js";
import { handleText, needsHelp } from "./engine.js";
import { receive } from "./interpret.js";
import type { Outbound, State } from "./types.js";

/*
 * Rental applications by text: the same questions for everyone, answers
 * passed to the landlord exactly as written, never ranked or judged.
 */

const MOM = "+1 203 555 0101";
const ANA = "+1 914 555 0111";
const BEN = "+1 914 555 0112";
const NOW = new Date(2026, 10, 15, 12);

function fresh(): State {
  const s: State = JSON.parse(readFileSync(new URL("../data/example.json", import.meta.url), "utf8"));
  for (const u of s.units) delete u.rent;
  return s;
}
const to = (out: Outbound[], phone: string) => out.filter((o) => o.to === phone).map((o) => o.body);
const ANSWERS = ["Ana Lopez", "Dec 1", "2", "one cat", "$4,800 (job + voucher)", "Mr. Park 914-555-0199", "ana@example.com", "none"];

function apply(s: State, phone: string, answers = ANSWERS): Outbound[] {
  let out = handleText(s, phone, "hi, is the apartment still available?", NOW);
  for (const a of answers) out = handleText(s, phone, a, NOW);
  return out;
}

describe("rental applications by text", () => {
  it("LISTING opens it; an interested texter gets every question in order; the landlord gets the answers as written", () => {
    const s = fresh();
    expect(to(handleText(s, MOM, "LISTING 12 Oak St Unit 1", NOW), MOM)[0]).toMatch(/Applications are open for 12 Oak St Unit 1 \(listing 1\)[\s\S]*without ranking anyone/);

    let out = handleText(s, ANA, "hi, is the apartment still available?", NOW);
    expect(to(out, ANA)[0]).toMatch(/interest in 12 Oak St Unit 1[\s\S]*everyone who applies gets the same ones\. Reply STOP[\s\S]*\(1\/8\) What's your full name\?$/);
    const asked: string[] = [];
    for (const [i, a] of ANSWERS.entries()) {
      out = handleText(s, ANA, a, NOW);
      if (i < ANSWERS.length - 1) asked.push(to(out, ANA)[0]!);
    }
    expect(asked).toEqual(QUESTIONS.slice(1).map((q, i) => `(${i + 2}/8) ${q}`));
    expect(to(out, ANA)[0]).toBe("Thanks, Ana! I've sent your answers to Mom. They'll reach out to you directly.");
    const sent = to(out, MOM)[0]!;
    expect(sent).toMatch(/^New application for 12 Oak St Unit 1:\nName: Ana Lopez\nMove in: Dec 1\nPeople: 2\nPets: one cat\nMonthly income: \$4,800 \(job \+ voucher\)\nLandlord reference: Mr\. Park 914-555-0199\nEmail: ana@example\.com\nNote: none\nPhone: \+1 914 555 0111/);
  });

  it("asks nothing fair-housing law protects, and counts a voucher as income", () => {
    const all = QUESTIONS.join(" ").toLowerCase();
    for (const word of ["age", "old are", "children", "kids", "married", "religio", "citizen", "where are you from", "disab", "race", "credit", "criminal", "born"]) {
      expect(all).not.toContain(word);
    }
    expect(all).toContain("housing voucher");
  });

  it("APPLICANTS shows everyone in the order received, never ranked", () => {
    const s = fresh();
    handleText(s, MOM, "LISTING 12 Oak St Unit 1", NOW);
    apply(s, ANA);
    apply(s, BEN, ["Ben Ortiz", "Jan 15", "1", "no", "$3,900", "none", "ben@example.com", "I work nights"]);
    const list = to(handleText(s, MOM, "APPLICANTS", NOW), MOM)[0]!;
    expect(list).toMatch(/12 Oak St Unit 1, 2 applicants, in the order received:/);
    expect(list.indexOf("Ana Lopez")).toBeLessThan(list.indexOf("Ben Ortiz"));
    expect(list).toMatch(/Not ranked\.$/);
  });

  it("with no listing open, strangers get the old answer; texts that aren't about renting don't start one", () => {
    const s = fresh();
    expect(to(handleText(s, ANA, "is the apartment available?", NOW), ANA)[0]).toMatch(/isn't set up/);
    handleText(s, MOM, "LISTING 12 Oak St Unit 1", NOW);
    expect(to(handleText(s, ANA, "who is this", NOW), ANA)[0]).toMatch(/If you're asking about a place for rent, reply APPLY/);
    expect(s.applications ?? []).toHaveLength(0);
    expect(to(handleText(s, ANA, "APPLY", NOW), ANA)[0]).toMatch(/\(1\/8\)/);
  });

  it("two listings: asks which place first", () => {
    const s = fresh();
    handleText(s, MOM, "LISTING 12 Oak St Unit 1", NOW);
    handleText(s, MOM, "LISTING 40 Elm Rd Unit 2", NOW);
    expect(to(handleText(s, ANA, "apply", NOW), ANA)[0]).toMatch(/Which place are you asking about\? 1\. 12 Oak St Unit 1  2\. 40 Elm Rd Unit 2/);
    expect(to(handleText(s, ANA, "2", NOW), ANA)[0]).toMatch(/interest in 40 Elm Rd Unit 2[\s\S]*\(1\/8\)/);
  });

  it("CLOSE LISTING stops new applications and keeps the answers; the AI is never asked about these commands", () => {
    const s = fresh();
    handleText(s, MOM, "LISTING 12 Oak St Unit 1", NOW);
    apply(s, ANA);
    expect(needsHelp(s, MOM, "CLOSE LISTING 1", NOW)).toBeNull();
    expect(to(handleText(s, MOM, "CLOSE LISTING 1", NOW), MOM)[0]).toMatch(/Closed listing 1/);
    expect(to(handleText(s, BEN, "apply", NOW), BEN)[0]).toMatch(/isn't set up/);
    expect(to(handleText(s, MOM, "APPLICANTS", NOW), MOM)[0]).toMatch(/12 Oak St Unit 1 \(closed\), 1 applicant/);
  });

  it("STOP from an applicant works like anyone's, and they aren't texted again", async () => {
    const s = fresh();
    handleText(s, MOM, "LISTING 12 Oak St Unit 1", NOW);
    handleText(s, ANA, "apply", NOW);
    const ai: Ai = { understand: null, find: async () => [], live: false };
    await receive(s, ANA, "STOP", NOW, ai);
    const { out } = await receive(s, ANA, "Ana Lopez", NOW, ai);
    expect(to(out, ANA)).toHaveLength(0);
  });
});
