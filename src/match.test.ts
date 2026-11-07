import { pickVendor, readContactCard, readContactName, tradeForProblem } from "./match.js";
import type { Vendor } from "./types.js";

const v = (code: string, trade: string, town: string, textable = true): Vendor => ({
  code, name: code[0] + code.slice(1).toLowerCase(), trade, town, phone: `+1 203 555 0${code.length}00`, textable,
});
const SAM = v("SAM", "HVAC", "all CT");
const JOHN = v("JOHN", "handyman", "Hamden");
const ROB = v("ROB", "handyman", "Tolland");
const MIKE = v("MIKE", "plumber", "Hamden");

it.each([
  ["heat not working", "HVAC"],
  ["furnace has a red light", "HVAC"],
  ["no hot water", "plumber"],
  ["water heater leaking", "plumber"],
  ["toilet clogged", "plumber"],
  ["outlet sparking", "electrician"],
  ["fridge stopped cooling", "appliance"],
  ["front door sticks", null],
])("%s needs %s", (problem, trade) => {
  expect(tradeForProblem(problem)).toBe(trade);
});

describe("pickVendor", () => {
  const all = [SAM, JOHN, ROB, MIKE];
  it("matches the trade", () => {
    expect(pickVendor(all, "heat not working", "Naugatuck")?.code).toBe("SAM");
    expect(pickVendor(all, "sink leaking", "Hamden")?.code).toBe("MIKE");
  });
  it("prefers someone in the rental's town", () => {
    expect(pickVendor(all, "door sticks", "Tolland")?.code).toBe("ROB");
    expect(pickVendor(all, "door sticks", "Hamden")?.code).toBe("JOHN");
  });
  it("never offers a handyman for a specialist job", () => {
    expect(pickVendor([JOHN, ROB], "furnace out", "Hamden")).toBeUndefined();
  });
  it("skips people who said no, and businesses found by search", () => {
    expect(pickVendor(all, "door sticks", "Hamden", ["JOHN"])?.code).toBe("ROB");
    expect(pickVendor([v("VALLEY", "HVAC", "Naugatuck", false)], "no heat", "Naugatuck")).toBeUndefined();
  });
});

describe("contact cards", () => {
  it("reads an iPhone vCard, mobile number first", () => {
    const card = "BEGIN:VCARD\r\nVERSION:3.0\r\nN:handyman Hamden;John;;;\r\nFN:John handyman Hamden\r\nTEL;type=HOME:(203) 555-1111\r\nTEL;type=CELL;type=VOICE;type=pref:(203) 555-2222\r\nEND:VCARD";
    expect(readContactCard(card)).toEqual({ name: "John handyman Hamden", phone: "(203) 555-2222" });
  });
  it("ignores ordinary texts", () => {
    expect(readContactCard("heat not working")).toBeNull();
  });
  it("splits Mom's naming: name, trade, town", () => {
    const towns = ["Naugatuck", "Tolland", "Hamden", "New Haven"];
    expect(readContactName("John handyman Hamden", towns)).toEqual({ name: "John", trade: "handyman", town: "Hamden" });
    expect(readContactName("HVAC guy Tolland", towns)).toEqual({ name: "HVAC guy Tolland", trade: "HVAC", town: "Tolland" });
    expect(readContactName("Karen cleaning Naugatuck", towns)).toEqual({ name: "Karen", trade: "cleaning", town: "Naugatuck" });
    expect(readContactName("Dave plumber New Haven", towns)).toEqual({ name: "Dave", trade: "plumber", town: "New Haven" });
    expect(readContactName("Bob Smith", towns)).toEqual({ name: "Bob Smith", trade: undefined, town: undefined });
  });
});
