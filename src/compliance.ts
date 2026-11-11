import { digits } from "./engine.js";
import type { Outbound, State } from "./types.js";

/**
 * The texting rules that keep the line on the right side of the law
 * (the TCPA and carrier rules), in one place, applied to every text the
 * simulator and the live line send:
 *
 * - STOP works: whoever texts STOP (or UNSUBSCRIBE, CANCEL, END, QUIT,
 *   STOPALL) gets nothing more until they text START. The landlord is told,
 *   so they know to reach that person another way.
 * - The first text to anyone says who it's from, what it's for, and how to
 *   stop, then is recorded so it's never repeated.
 * - Automatic texts (reminders, check-backs) never go out at night; they
 *   wait until 8am. Replies to someone who just texted go out right away.
 *
 * Carriers treat those keywords as exact, whole-message words, so "cancel 3"
 * is a command and "cancel" alone is an opt-out.
 */

export const OPT_OUT = /^(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout|opt out)$/i;
export const OPT_IN = /^(start|unstop|yes start)$/i;
export const HELP_WORDS = /^(help|info)$/i;

/** No automatic texts from 9pm to 8am, the window carriers and state laws expect. */
export const QUIET_START = 21;
export const QUIET_END = 8;
export const isQuietHour = (now: Date) => now.getHours() >= QUIET_START || now.getHours() < QUIET_END;

type Who = { name: string; role: "landlord" | "tenant" | "repair person"; about: string };

function whoIs(state: State, phone: string): Who | undefined {
  const d = digits(phone);
  const landlordName = state.landlords[0]?.name ?? "your landlord";
  const landlord = state.landlords.find((l) => digits(l.phone) === d);
  if (landlord) return { name: landlord.name, role: "landlord", about: "your rentals" };
  const unit = state.units.find((u) => digits(u.tenant.phone) === d);
  if (unit) return { name: unit.tenant.name, role: "tenant", about: `repairs and rent at ${unit.address}` };
  const vendor = state.vendors.find((v) => digits(v.phone) === d);
  if (vendor) return { name: vendor.name, role: "repair person", about: `repair jobs at ${landlordName}'s rentals` };
  return undefined;
}

export function isOptedOut(state: State, phone: string): boolean {
  return (state.optedOut ?? []).includes(digits(phone));
}

/** The first text anyone gets: who, why, how often, and how to stop. */
export function welcomeText(state: State, phone: string): string | null {
  const who = whoIs(state, phone);
  if (!who) return null;
  const landlordName = state.landlords[0]?.name ?? "your landlord";
  if (who.role === "landlord") {
    return `This is your repair and rent line. Your tenants and repair people text this number; I'll keep you posted here. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;
  }
  return `Hi ${who.name}, this is ${landlordName}'s repair and rent line. You'll get texts here about ${who.about}. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;
}

/**
 * Applies the rules to texts about to go out: drops anything to someone
 * who opted out, and puts the welcome text before anyone's first one.
 */
export function prepareOutbound(state: State, out: Outbound[], now: Date): Outbound[] {
  const welcomed = new Set(state.welcomed ?? []);
  const ready: Outbound[] = [];
  for (const o of out) {
    const d = digits(o.to);
    if (isOptedOut(state, o.to)) continue;
    if (!welcomed.has(d)) {
      const hello = welcomeText(state, o.to);
      if (hello) ready.push({ to: o.to, body: hello });
      welcomed.add(d);
      state.consent = {
        ...state.consent,
        [d]: state.consent?.[d] ?? { at: now.toISOString(), how: "added by the landlord, who agreed to tell them first; first text explained STOP" },
      };
    }
    ready.push(o);
  }
  state.welcomed = [...welcomed];
  return ready;
}

/**
 * STOP / START / HELP from anyone. Returns null for any other text.
 * `carrierReplies`: on the live line Twilio itself answers these words, so
 * the line only records them; the simulator answers the way Twilio would.
 */
export function handleKeyword(
  state: State,
  from: string,
  text: string,
  now: Date,
  carrierReplies: boolean,
): Outbound[] | null {
  const word = text.trim();
  const d = digits(from);
  const who = whoIs(state, from);
  const toLandlords = (body: string) =>
    state.landlords.filter((l) => digits(l.phone) !== d && !isOptedOut(state, l.phone)).map((l) => ({ to: l.phone, body }));

  if (OPT_OUT.test(word)) {
    state.optedOut = [...new Set([...(state.optedOut ?? []), d])];
    state.consent = { ...state.consent, [d]: { at: now.toISOString(), how: `opted out by texting ${word.toUpperCase()}` } };
    const out: Outbound[] = carrierReplies
      ? []
      : [{ to: from, body: "You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe." }];
    if (who && who.role !== "landlord") {
      out.push(...toLandlords(`${who.name} (${who.role}) texted ${word.toUpperCase()}: the line won't text them anymore. Reach them directly; they can text START to come back.`));
    }
    return out;
  }
  if (OPT_IN.test(word)) {
    state.optedOut = (state.optedOut ?? []).filter((p) => p !== d);
    state.consent = { ...state.consent, [d]: { at: now.toISOString(), how: `opted back in by texting ${word.toUpperCase()}` } };
    const out: Outbound[] = carrierReplies
      ? []
      : [{ to: from, body: "You have successfully been re-subscribed to messages from this number. Reply HELP for help. Reply STOP to unsubscribe." }];
    if (who && who.role !== "landlord") out.push(...toLandlords(`${who.name} (${who.role}) texted START: the line can text them again.`));
    return out;
  }
  if (HELP_WORDS.test(word) && who?.role !== "landlord") {
    // Landlords' HELP is the command list (the engine); everyone else gets this.
    if (carrierReplies) return [];
    const landlordName = state.landlords[0]?.name ?? "your landlord";
    return [
      {
        to: from,
        body: `${landlordName}'s repair and rent line. Text a problem with your home to report it, or reply to the texts you get. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.`,
      },
    ];
  }
  return null;
}
