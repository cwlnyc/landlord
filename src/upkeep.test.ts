import { readFileSync } from "node:fs";
import { handleText, tick } from "./engine.js";
import { buildingOf } from "./upkeep.js";
import type { Outbound, State } from "./types.js";

/*
 * Routine upkeep heads off emergencies like Mom's Sunday-night furnace. Once
 * it's on, a due job arrives as "Send Sam (HVAC)?" and books like any repair.
 */

const MOM = "+1 203 555 0101";
const MARIA = "+1 203 555 0201";
const SAM = "+1 203 555 0301";

function fresh(): State {
  const s: State = JSON.parse(readFileSync(new URL("../data/example.json", import.meta.url), "utf8"));
  for (const u of s.units) delete u.rent;
  return s;
}
const to = (out: Outbound[], phone: string) => out.filter((o) => o.to === phone).map((o) => o.body);
const at = (month: number, day: number, hour = 10) => new Date(2026, month - 1, day, hour);

describe("routine upkeep", () => {
  it("UPKEEP lists the jobs; UPKEEP 1 2 turns those on", () => {
    const s = fresh();
    expect(to(handleText(s, MOM, "UPKEEP", at(9, 1)), MOM)[0]).toMatch(/^Routine upkeep[\s\S]*1\. Furnace\/boiler service, every September[\s\S]*UPKEEP 1 2/);
    expect(to(handleText(s, MOM, "UPKEEP 1 2", at(9, 1)), MOM)[0]).toMatch(/^On: furnace\/boiler service, smoke and co detector check\./);
    expect(s.upkeep!.on).toEqual(["furnace", "smoke"]);
    expect(to(handleText(s, MOM, "UPKEEP", at(9, 1)), MOM)[0]).toMatch(/1\. Furnace\/boiler service, every September, before the cold ✓/);
  });

  it("when due, it asks to book the usual repair person, and YES runs the normal booking", () => {
    const s = fresh();
    handleText(s, MOM, "UPKEEP 1", at(9, 1));
    let out = tick(s, at(9, 15));
    expect(to(out, MOM)[0]).toBe("Upkeep due: furnace/boiler service at 12 Oak St, Naugatuck (#1). It's done every September, before the cold.\n\nSend Sam (HVAC)?");
    expect(s.repairs[0]).toMatchObject({ trade: "HVAC", urgent: false, upkeep: true, text: "Furnace/boiler service (routine upkeep)" });

    out = handleText(s, MOM, "YES", at(9, 15));
    expect(to(out, SAM)[0]).toMatch(/Job at 12 Oak St, Naugatuck, Unit 1: "Furnace\/boiler service \(routine upkeep\)"\. When could you go\?/);
    out = handleText(s, SAM, "tue 9am", at(9, 15));
    expect(to(out, MARIA)[0]).toMatch(/Sam \(HVAC\) can come .* about: "Furnace\/boiler service \(routine upkeep\)"\. Will you be home then\?/);
  });

  it("one building a day, each once a month; nothing outside its months", () => {
    const s = fresh();
    handleText(s, MOM, "UPKEEP 1", at(9, 1));
    expect(to(tick(s, at(9, 15)), MOM)).toHaveLength(1);
    expect(tick(s, at(9, 15, 14))).toEqual([]); // same day: waits
    expect(to(tick(s, at(9, 16)), MOM)[0]).toMatch(/40 Elm Rd, Tolland/);
    expect(to(tick(s, at(9, 17)), MOM)[0]).toMatch(/7 Pine Ave, Hamden/);
    expect(tick(s, at(9, 18))).toEqual([]); // all three done this month
    expect(tick(s, at(10, 15))).toEqual([]); // furnace is September only
    expect(to(tick(s, at(9 + 12, 15)), MOM)).toHaveLength(1); // next September, again
  });

  it("never before 9am or at night, and UPKEEP OFF stops it", () => {
    const s = fresh();
    handleText(s, MOM, "UPKEEP 1", at(9, 1));
    expect(tick(s, at(9, 15, 7))).toEqual([]);
    expect(tick(s, at(9, 15, 22))).toEqual([]);
    handleText(s, MOM, "UPKEEP OFF 1", at(9, 15));
    expect(tick(s, at(9, 15))).toEqual([]);
  });

  it("units in one building get one reminder, not one each", () => {
    const s = fresh();
    s.units[1]!.address = "12 Oak St, Naugatuck, Unit 2";
    expect(buildingOf(s.units[0]!)).toBe(buildingOf(s.units[1]!));
    handleText(s, MOM, "UPKEEP 1", at(9, 1));
    tick(s, at(9, 15));
    expect(to(tick(s, at(9, 16)), MOM)[0]).toMatch(/7 Pine Ave, Hamden/);
  });
});
