import { readFileSync } from "node:fs";
import { handleText, tick } from "./engine.js";
import { currentPeriod, isRentText } from "./rent.js";
import type { Outbound, State } from "./types.js";

const MOM = "+1 203 555 0101";
const MARIA = "+1 203 555 0201"; // $1,450, due the 1st
const KEVIN = "+1 860 555 0202"; // $1,200
const PRIYA = "+1 203 555 0203"; // $1,600

function fresh(): State {
  return JSON.parse(readFileSync(new URL("../data/example.json", import.meta.url), "utf8"));
}
const to = (out: Outbound[], phone: string) => out.filter((o) => o.to === phone).map((o) => o.body);
const at = (month: number, day: number, hour = 12) => new Date(2026, month - 1, day, hour);

describe("which month's rent", () => {
  const unit = { id: "u", address: "", tenant: { name: "A", phone: "" }, rent: 1000, rentDue: 1 };
  it.each([
    [at(11, 15), "2026-11"], // mid-month: this month's
    [at(11, 2), "2026-11"], // just after the 1st: this month's (late)
    [at(11, 28), "2026-12"], // 3 days before the 1st: next month's
    [at(12, 29), "2027-01"], // across the new year
  ])("%s -> %s", (now, period) => {
    expect(currentPeriod(unit, now).period).toBe(period);
  });
  it("day 31 means the last day of a short month", () => {
    expect(currentPeriod({ ...unit, rentDue: 31 }, at(2, 20)).due.getDate()).toBe(28);
  });
});

describe("a month of rent reminders", () => {
  it("reminds before, nudges after, tells the landlord who's late, and stops once paid", () => {
    const s = fresh();
    // First run on Nov 20: November's rent was never tracked, so nobody
    // is told it's late.
    expect(tick(s, at(11, 20))).toEqual([]);
    // 3 days before Dec 1, at 9am: everyone gets a reminder, once.
    expect(tick(s, at(11, 28, 8))).toEqual([]); // not before 9am
    const remind = tick(s, at(11, 28, 9));
    expect(to(remind, MARIA)[0]).toMatch(/reminder from Mom: December rent \(\$1,450\) is due Tue, Dec 1/);
    expect(remind).toHaveLength(3);
    expect(tick(s, at(11, 29))).toEqual([]);

    // Maria pays on the 1st; Kevin pays half.
    let out = handleText(s, MOM, "PAID MARIA zelle", at(12, 1));
    expect(to(out, MOM)[0]).toMatch(/Marked Maria's December rent paid \(zelle\)\. 1 of 3 paid\./);
    expect(to(out, MARIA)[0]).toMatch(/Mom got your December rent/);
    out = handleText(s, MOM, "paid kevin 600 cash", at(12, 2));
    expect(to(out, MOM)[0]).toMatch(/Marked \$600 \(cash\) from Kevin for December\. \$600 still to come\./);

    // 5 days after the due date, 9am: nudges for Kevin's balance and Priya, one list for the landlords.
    const late = tick(s, at(12, 6, 9));
    expect(to(late, MARIA)).toEqual([]);
    expect(to(late, KEVIN)[0]).toMatch(/December rent \(\$600, due Tue, Dec 1\) isn't marked paid yet\. If you've already sent it, reply PAID/);
    expect(to(late, PRIYA)).toHaveLength(1);
    expect(to(late, MOM)[0]).toMatch(/Rent not marked paid:\nKevin, 40 Elm Rd, Tolland, Unit 2: \$600\nPriya, 7 Pine Ave, Hamden, Unit 3: \$1,600/);
    expect(tick(s, at(12, 7, 9))).toEqual([]); // once only

    const status = to(handleText(s, MOM, "RENT", at(12, 7)), MOM)[0]!;
    expect(status).toMatch(/Rent: 1 of 3 paid\./);
    expect(status).toMatch(/Kevin.*December \$600 of \$1,200/);
    expect(status).toMatch(/Priya.*December NOT PAID/);
  });
});

describe("starting the line", () => {
  it("never texts 'not paid' about rent from before it started", () => {
    const s = fresh();
    expect(tick(s, at(11, 10, 9))).toEqual([]); // Nov 1 rent, 9 days late, never tracked
    expect(tick(s, at(12, 6, 9)).length).toBeGreaterThan(0); // December is tracked
  });

  it("RENT doesn't call untracked months unpaid", () => {
    const s = fresh();
    const status = to(handleText(s, MOM, "RENT", at(11, 10)), MOM)[0]!;
    expect(status).toMatch(/Maria.*November before tracking started/);
    expect(status).not.toMatch(/NOT PAID/);
  });

  it("a reminder whose time already passed when the line started isn't sent late", () => {
    const s = fresh();
    expect(tick(s, at(11, 30, 10))).toEqual([]); // reminder time was Nov 28, before the start
  });
});

describe("tenants and rent", () => {
  it("a tenant saying they paid tells the landlord, but doesn't mark it paid", () => {
    const s = fresh();
    const out = handleText(s, MARIA, "sent the rent on zelle this morning", at(12, 2));
    expect(to(out, MARIA)[0]).toMatch(/I've let your landlord know/);
    expect(to(out, MOM)[0]).toMatch(/Maria .* says about rent: "sent the rent on zelle this morning"\nDecember: \$1,450 not marked paid yet\. Reply PAID MARIA/);
    expect(s.payments ?? []).toHaveLength(0);
    expect(s.repairs).toHaveLength(0);
  });

  it("repair texts aren't mistaken for rent", () => {
    expect(isRentText("can someone check the heater")).toBe(false);
    expect(isRentText("sink is leaking")).toBe(false);
    expect(isRentText("paid")).toBe(true);
    expect(isRentText("just zelled you")).toBe(true);
    expect(isRentText("sent it")).toBe(true);
  });

  it("PAID for an unknown name lists the real ones", () => {
    const out = handleText(fresh(), MOM, "PAID BOB", at(12, 2));
    expect(to(out, MOM)[0]).toMatch(/Whose rent\? Reply PAID \+ their name: MARIA, KEVIN, PRIYA/);
  });

  it("units without rent get no reminders", () => {
    const s = fresh();
    for (const u of s.units) delete u.rent;
    expect(tick(s, at(11, 28, 9))).toEqual([]);
    expect(to(handleText(s, MOM, "RENT", at(11, 28)), MOM)[0]).toMatch(/No rents set up/);
  });
});
