import { readFileSync } from "node:fs";
import type { Ai } from "./ai.js";
import { receive } from "./interpret.js";
import { readBankAlert } from "./rent.js";
import type { Outbound, State } from "./types.js";

/*
 * Mom: no tenant texts their landlord "I paid". The money shows up in the
 * bank, and the bank sends an alert. The landlord forwards that alert to the
 * line, and the line marks it paid and says who's still missing. No bank
 * login anywhere.
 */

const MOM = "+1 203 555 0101";
const KEVIN = "+1 860 555 0202"; // $1,200

function fresh(): State {
  const s: State = JSON.parse(readFileSync(new URL("../data/example.json", import.meta.url), "utf8"));
  s.welcomed = ["2035550101", "2035550102", "2035550201", "8605550202", "2035550203"];
  return s;
}
const to = (out: Outbound[], phone: string) => out.filter((o) => o.to === phone).map((o) => o.body);
const offline: Ai = { understand: null, find: async () => [], live: false };
const DEC_3 = new Date(2026, 11, 3, 12);

describe("reading a bank's payment alert", () => {
  it.each([
    ["Chase: You received $1,200.00 from KEVIN SMITH. Reply STOP to end alerts", "KEVIN SMITH", 1200],
    ["BofA: KEVIN SMITH sent you $1,200.00 with Zelle(R). Learn more at bofa.com", "KEVIN SMITH", 1200],
    ["You received a Zelle payment of $1,450.00 from MARIA LOPEZ", "MARIA LOPEZ", 1450],
    ["Kevin Smith paid you $600.00", "Kevin Smith", 600],
    ["A deposit of $1,600 from PRIYA SHAH posted to your account ending 1234.", "PRIYA SHAH", 1600],
    ["Fwd: You've received $1,200 from Kevin Smith via Zelle", "Kevin Smith", 1200],
  ])("%s", (text, payer, amount) => {
    expect(readBankAlert(text)).toEqual({ payer, amount });
  });

  it("ordinary texts aren't alerts", () => {
    expect(readBankAlert("Kevin paid")).toBeNull();
    expect(readBankAlert("SEND JOHN")).toBeNull();
    expect(readBankAlert("the plumber charged $250 from what I saw")).toBeNull();
  });
});

describe("forwarding one to the line", () => {
  it("marks that tenant paid, thanks them, and says who's still missing", async () => {
    const s = fresh();
    const { out } = await receive(s, MOM, "BofA: KEVIN SMITH sent you $1,200.00 with Zelle(R).", DEC_3, offline);
    expect(to(out, MOM)[0]).toMatch(/^Marked Kevin's December rent paid \(bank alert\)\. 1 of 3 paid\. Still waiting on Maria, Priya\.$/);
    expect(to(out, KEVIN)[0]).toMatch(/got your December rent\. Thanks!/);
    expect(s.payments).toHaveLength(1);
  });

  it("a partial payment says what's left", async () => {
    const s = fresh();
    const { out } = await receive(s, MOM, "Kevin Smith paid you $600.00", DEC_3, offline);
    expect(to(out, MOM)[0]).toMatch(/Marked \$600 \(bank alert\) from Kevin for December\. \$600 still to come\./);
  });

  it("someone who isn't a tenant: asks whose rent it is, marks nothing", async () => {
    const s = fresh();
    const { out } = await receive(s, MOM, "You received $1,200.00 from JANE DOE", DEC_3, offline);
    expect(to(out, MOM)[0]).toBe("That's $1,200 from JANE DOE, but I can't tell whose rent it is. Reply like: Maria paid 1200");
    expect(s.payments ?? []).toHaveLength(0);
  });
});
