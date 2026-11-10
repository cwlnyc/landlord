import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The few pieces of Twilio the repair line needs, with no SDK: check that
 * an incoming text really came from Twilio, read it, and send a text.
 */

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  /** The repair line's own number, e.g. +12035550100. */
  from: string;
};

/** "+1 203 555 0101" or "(203) 555-0101" -> "+12035550101". */
export function toE164(phone: string): string {
  const d = phone.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return phone.trim().startsWith("+") ? `+${d}` : phone.trim();
}

/**
 * Twilio signs each webhook: HMAC-SHA1 of the full URL followed by every
 * POST field (sorted by name, name then value), keyed with the auth token,
 * base64. Anything that fails this check didn't come from Twilio, and
 * acting on it would let anyone on the internet send texts as the line.
 */
export function signatureFor(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function isFromTwilio(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signatureFor(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The text a webhook carries. A shared contact arrives as a picture
 * message with a vCard attached, so its card is fetched and used as the
 * body (the engine reads cards that start with BEGIN:VCARD).
 */
export async function readInbound(
  cfg: TwilioConfig,
  params: Record<string, string>,
): Promise<{ from: string; text: string }> {
  const from = params.From ?? "";
  let text = params.Body ?? "";
  const media = Number(params.NumMedia ?? 0);
  for (let i = 0; i < media; i++) {
    const type = params[`MediaContentType${i}`] ?? "";
    const url = params[`MediaUrl${i}`];
    if (url && /vcard|x-vcard|text\/directory/i.test(type)) {
      const res = await fetch(url, { headers: { authorization: basic(cfg) } });
      if (res.ok) {
        text = await res.text();
        break;
      }
    }
  }
  return { from, text };
}

function basic(cfg: TwilioConfig): string {
  return `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`;
}

/** Sends one text. Throws with Twilio's message if it's refused. */
export async function sendSms(cfg: TwilioConfig, to: string, body: string): Promise<void> {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      authorization: basic(cfg),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: cfg.from, To: toE164(to), Body: body }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Twilio refused the text to ${toE164(to)} (${res.status}): ${detail}`);
  }
}

/** An empty reply: the line answers by sending its own texts instead. */
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
