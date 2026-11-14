import { readFileSync } from "node:fs";
import { handleText, needsHelp } from "./engine.js";
import type { Outbound, State } from "./types.js";

/*
 * How Mom actually books a repair: the repair person's first answer is
 * rarely yes or no. It's "what's the issue? can I see a picture?" Then the
 * tenant sends a photo, the repair person offers a time or two, and the
 * tenant picks one. The line carries each step so she doesn't have to.
 */

const MOM = "+1 203 555 0101";
const MARIA = "+1 203 555 0201";
const JOHN = "+1 203 555 0302";
const PHOTO = "https://example.com/leak.jpg";

function fresh(): State {
  const s: State = JSON.parse(readFileSync(new URL("../data/example.json", import.meta.url), "utf8"));
  for (const u of s.units) delete u.rent;
  return s;
}
const SUNDAY_9PM = new Date(2026, 10, 8, 21, 0);
const to = (out: Outbound[], phone: string) => out.filter((o) => o.to === phone);
const bodies = (out: Outbound[], phone: string) => to(out, phone).map((o) => o.body);

function askedJohn(): State {
  const s = fresh();
  handleText(s, MARIA, "sink leaking under the cabinet", SUNDAY_9PM);
  handleText(s, MOM, "SEND JOHN", SUNDAY_9PM);
  return s;
}

describe("the repair person asks first (Mom's real flow)", () => {
  it("question -> photo from the tenant -> two times -> tenant picks -> confirmed", () => {
    const s = askedJohn();

    let out = handleText(s, JOHN, "what's the issue? can I see pictures?", SUNDAY_9PM);
    expect(bodies(out, JOHN)[0]).toMatch(/I'll ask Maria and send you the photos here/);
    expect(bodies(out, MARIA)[0]).toMatch(/John \(handyman\), about "sink leaking under the cabinet", asks: "what's the issue\? can I see pictures\?"/);
    expect(bodies(out, MARIA)[0]).toMatch(/send a photo or video right here/);
    expect(bodies(out, MOM)[0]).toMatch(/John asked Maria about .*\(#1\)/);
    expect(s.repairs[0]!.status).toBe("asking-vendor");

    // A picture message: the photo goes straight to John, with the next question.
    out = handleText(s, MARIA, "here, it's dripping from the pipe", SUNDAY_9PM, { media: [PHOTO] });
    expect(bodies(out, MARIA)[0]).toBe("Thanks, I sent that to John.");
    const toJohn = to(out, JOHN)[0]!;
    expect(toJohn.body).toMatch(/Maria says: "here, it's dripping from the pipe"\n\nWhen could you go to 12 Oak St/);
    expect(toJohn.media).toEqual([PHOTO]);
    expect(s.repairs).toHaveLength(1); // the answer isn't a new repair

    // Two offers: the tenant picks, nobody has to go back and forth.
    out = handleText(s, JOHN, "ok I see it. I can do tue 9am or wed 2pm", SUNDAY_9PM);
    expect(bodies(out, MARIA)[0]).toMatch(/can come Tue, Nov 10, 9:00 AM or Wed, Nov 11, 2:00 PM about: "sink leaking under the cabinet"\. Which works for you\?/);
    expect(bodies(out, MOM)[0]).toMatch(/John offered Tue, Nov 10, 9:00 AM or Wed, Nov 11, 2:00 PM at .*Asking Maria which works/);

    out = handleText(s, MARIA, "wed works", SUNDAY_9PM);
    expect(s.repairs[0]!.status).toBe("confirmed");
    expect(new Date(s.repairs[0]!.slot!).getDate()).toBe(11);
    expect(bodies(out, MARIA)[0]).toMatch(/confirmed for Wed, Nov 11, 2:00 PM/);
    expect(bodies(out, JOHN)[0]).toMatch(/Confirmed: Wed, Nov 11, 2:00 PM/);
    expect(bodies(out, MOM)[0]).toMatch(/Confirmed: John at 12 Oak St, Unit 1 \(#1\), Wed, Nov 11, 2:00 PM/);
  });

  it("a photo sent with the report goes to the repair person and the landlord", () => {
    const s = fresh();
    let out = handleText(s, MARIA, "sink leaking", SUNDAY_9PM, { media: [PHOTO] });
    expect(to(out, MOM)[0]!.media).toEqual([PHOTO]);
    out = handleText(s, MOM, "SEND JOHN", SUNDAY_9PM);
    expect(to(out, JOHN)[0]!.media).toEqual([PHOTO]);
    // Asking for a picture again gets the one already sent, without bothering the tenant.
    out = handleText(s, JOHN, "can you send a pic?", SUNDAY_9PM);
    expect(to(out, JOHN)[0]!.media).toEqual([PHOTO]);
    expect(to(out, MARIA)).toHaveLength(0);
  });

  it("more photos keep going over until the repair person answers; then texts are new again", () => {
    const s = askedJohn();
    handleText(s, JOHN, "can I see a video?", SUNDAY_9PM);
    handleText(s, MARIA, "", SUNDAY_9PM, { media: [PHOTO] });
    const out = handleText(s, MARIA, "", SUNDAY_9PM, { media: ["https://example.com/2.mp4"] });
    expect(to(out, JOHN)[0]!.body).toBe("Maria sent this"); // no repeat of "when could you go?"
    expect(s.repairs[0]!.photos).toHaveLength(2);
    handleText(s, JOHN, "tue 9am", SUNDAY_9PM);
    handleText(s, MARIA, "yes", SUNDAY_9PM);
    handleText(s, MARIA, "also the bathroom fan is broken", SUNDAY_9PM);
    expect(s.repairs).toHaveLength(2);
  });

  it("a question that isn't about photos is passed along too", () => {
    const s = askedJohn();
    const out = handleText(s, JOHN, "is it the hot or cold side?", SUNDAY_9PM);
    expect(bodies(out, MARIA)[0]).toMatch(/asks: "is it the hot or cold side\?"/);
    expect(bodies(out, MARIA)[0]).not.toMatch(/photo/);
    const back = handleText(s, MARIA, "cold i think", SUNDAY_9PM);
    expect(bodies(back, JOHN)[0]).toMatch(/Maria says: "cold i think"/);
  });
});

describe("choosing between offered times", () => {
  function offered(): State {
    const s = askedJohn();
    handleText(s, JOHN, "tue 9am or wed 2pm", SUNDAY_9PM);
    return s;
  }

  it("'yes' to two choices asks which one", () => {
    const s = offered();
    const out = handleText(s, MARIA, "yes", SUNDAY_9PM);
    expect(bodies(out, MARIA)[0]).toMatch(/^Which one works for you: Tue, Nov 10, 9:00 AM or Wed, Nov 11, 2:00 PM\?$/);
    expect(s.repairs[0]!.status).toBe("asking-tenant");
  });

  it("picks by number, by day, by 'either'", () => {
    for (const [reply, day] of [["2", 11], ["tuesday", 10], ["either is fine", 10], ["the second one", 11]] as const) {
      const s = offered();
      handleText(s, MARIA, reply, SUNDAY_9PM);
      expect(s.repairs[0]!.status).toBe("confirmed");
      expect(new Date(s.repairs[0]!.slot!).getDate()).toBe(day);
    }
  });

  it("neither: the repair person is asked for other times", () => {
    const s = offered();
    const out = handleText(s, MARIA, "neither, sorry", SUNDAY_9PM);
    expect(s.repairs[0]!.status).toBe("asking-vendor");
    expect(s.repairs[0]!.offers).toBeUndefined();
    expect(bodies(out, JOHN)[0]).toMatch(/can't do Tue, Nov 10, 9:00 AM or Wed, Nov 11, 2:00 PM\. What other day and time/);
  });

  it("'tue or wed at 9am' is two offers", () => {
    const s = askedJohn();
    const out = handleText(s, JOHN, "tue or wed at 9am", SUNDAY_9PM);
    expect(bodies(out, MARIA)[0]).toMatch(/Tue, Nov 10, 9:00 AM or Wed, Nov 11, 9:00 AM/);
  });

  it("an unclear answer to the choice goes to the AI with the options", () => {
    const s = offered();
    const help = needsHelp(s, MARIA, "whenever my husband is home lol", SUNDAY_9PM);
    expect(help).toMatchObject({ role: "tenant" });
    expect(help!.context).toMatch(/1\. Tue, Nov 10, 9:00 AM, 2\. Wed, Nov 11, 2:00 PM/);
    expect(needsHelp(s, MARIA, "wed", SUNDAY_9PM)).toBeNull();
  });
});
