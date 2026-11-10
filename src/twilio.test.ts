import { isFromTwilio, signatureFor, toE164 } from "./twilio.js";

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
