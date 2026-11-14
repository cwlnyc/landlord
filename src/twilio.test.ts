import { isFromTwilio, readInbound, sendSms, signatureFor, toE164 } from "./twilio.js";

describe("Twilio webhook signatures", () => {
  const token = "12345";
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+12349013030",
    Digits: "1234",
    From: "+12349013030",
    To: "+18005551212",
  };

  it("matches Twilio's own library", () => {
    // Expected values computed with twilio@5's getExpectedTwilioSignature.
    expect(signatureFor(token, url, params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
    expect(
      signatureFor(token, "https://abc.trycloudflare.com/sms", {
        From: "+12035550101",
        Body: "heat not working",
        NumMedia: "0",
      }),
    ).toBe("Ws6ykqtZn1sdnNstO5p4SyMROdo=");
  });

  it("accepts the right signature and rejects anything else", () => {
    const good = signatureFor(token, url, params);
    expect(isFromTwilio(token, url, params, good)).toBe(true);
    expect(isFromTwilio(token, url, { ...params, Body: "SEND JOHN" }, good)).toBe(false);
    expect(isFromTwilio("wrong", url, params, good)).toBe(false);
    expect(isFromTwilio(token, url, params, undefined)).toBe(false);
  });
});

it.each([
  ["+1 203 555 0101", "+12035550101"],
  ["(203) 555-0101", "+12035550101"],
  ["12035550101", "+12035550101"],
])("%s -> %s", (input, out) => {
  expect(toE164(input)).toBe(out);
});

describe("picture messages", () => {
  const cfg = { accountSid: "AC1", authToken: "t", from: "+12035550000" };

  it("a tenant's photo comes in as a link, next to the words", async () => {
    const got = await readInbound(cfg, {
      From: "+12035550201",
      Body: "here",
      NumMedia: "2",
      MediaContentType0: "image/jpeg",
      MediaUrl0: "https://api.twilio.com/media/1",
      MediaContentType1: "video/mp4",
      MediaUrl1: "https://api.twilio.com/media/2",
    });
    expect(got).toEqual({ from: "+12035550201", text: "here", media: ["https://api.twilio.com/media/1", "https://api.twilio.com/media/2"] });
  });

  it("sends each photo as a MediaUrl", async () => {
    let sent = "";
    vi.stubGlobal("fetch", async (_url: string, init: { body: URLSearchParams }) => {
      sent = init.body.toString();
      return new Response("{}", { status: 201 });
    });
    try {
      await sendSms(cfg, "+1 203 555 0302", "Maria sent this", ["https://x.test/a.jpg", "https://x.test/b.jpg"]);
    } finally {
      vi.unstubAllGlobals();
    }
    const form = new URLSearchParams(sent);
    expect(form.getAll("MediaUrl")).toEqual(["https://x.test/a.jpg", "https://x.test/b.jpg"]);
    expect(form.get("Body")).toBe("Maria sent this");
  });
});
