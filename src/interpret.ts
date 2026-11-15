import type { Ai } from "./ai.js";
import { handleKeyword, prepareOutbound } from "./compliance.js";
import { LANDLORD_COMMANDS, type TextHints, bookingFromReply, handleText, isNewRepair, needsHelp, planFind, searchFromYes, showFound, digits, sameReply, usableReply, placeOf } from "./engine.js";
import { tradeForProblem } from "./match.js";
import { bankAlert, notYetReply, paidFromReply, rentFromWords } from "./rent.js";
import { languageFromWords, translateIn, translateOut } from "./translate.js";
import type { Outbound, State } from "./types.js";

/**
 * One incoming text, start to finish, with the slow outside work: the AI
 * rewrites a messy text into a fixed reply first (when it can), and FIND
 * runs a web search before the engine formats the results.
 *
 * `understoodAs` is what the AI turned the text into, so the simulator can
 * show it and you can see when it reads something wrong.
 */
export async function receive(
  state: State,
  from: string,
  body: string,
  now: Date,
  ai: Ai,
  /** True on the live line, where Twilio answers STOP/START/HELP itself. */
  carrierReplies = false,
  /**
   * Sends texts right away, before the rest is ready (the "looking now" note
   * before a slow search). Without it they go first in the returned list.
   */
  sendNow?: (out: Outbound[]) => Promise<void>,
  /** Photos or videos that came with the text (links), for a picture message. */
  media: string[] = [],
): Promise<{ out: Outbound[]; understoodAs?: string }> {
  const keyword = handleKeyword(state, from, body, now, carrierReplies);
  if (keyword) {
    // The STOP/START confirmation always reaches the sender, with no welcome
    // in front (and counts as their welcome). Notices to others follow the rules.
    const d = digits(from);
    state.welcomed = [...new Set([...(state.welcomed ?? []), d])];
    const toSender = keyword.filter((o) => digits(o.to) === d);
    const others = keyword.filter((o) => digits(o.to) !== d);
    return { out: [...toSender, ...prepareOutbound(state, others, now)] };
  }
  // In English for the engine; each reply goes back out in its reader's language.
  const heard = await translateIn(state, from, body, ai.translate);
  const quoted = heard.original
    ? { english: heard.english.trim(), original: heard.original.trim(), language: heard.language!, who: nameOf(state, from) }
    : undefined;
  const early: Outbound[] = [];
  const now_ = async (out: Outbound[]) => {
    const ready = await translateOut(state, prepareOutbound(state, out, now), ai.translate, quoted);
    if (sendNow) await sendNow(ready);
    else early.push(...ready);
  };
  const result = await respond(state, from, heard.english, now, ai, now_, media);
  const out = await translateOut(state, prepareOutbound(state, [...heard.notices, ...result.out], now), ai.translate, quoted);
  return { ...result, out: [...early, ...out] };
}

async function respond(
  state: State,
  from: string,
  body: string,
  now: Date,
  ai: Ai,
  sendNow: (out: Outbound[]) => Promise<void>,
  media: string[],
): Promise<{ out: Outbound[]; understoodAs?: string }> {
  let text = body.trim();
  const isLandlord = state.landlords.some((l) => digits(l.phone) === digits(from));

  // The line just asked this landlord "what kind of repair person?": a reply
  // that isn't a command is the answer, never read some other way.
  const pending = state.pendingFind?.[digits(from)];
  if (pending !== undefined) {
    const { [digits(from)]: _, ...rest } = state.pendingFind!;
    state.pendingFind = rest;
    const word = (text.split(/\s+/)[0] ?? "").toUpperCase().replace(/[^A-Z]/g, "");
    if (isLandlord && !LANDLORD_COMMANDS.includes(word)) text = `FIND ${text} #${pending}`;
  }
  let understoodAs: string | undefined;

  // "Maria speaks Spanish": from now on the line translates for her.
  const language = languageFromWords(state, from, text);
  if (language) return { out: [{ to: from, body: language }] };

  // Rent said plainly: "got it" after "let me know once it's in", or
  // "Kevin paid 600 cash" / "Maria's rent is 1450" any time.
  if (isLandlord) {
    const notYet = notYetReply(state, from, text);
    const paid = paidFromReply(state, from, text);
    if (state.pendingPaid?.[digits(from)]) {
      const { [digits(from)]: _, ...others } = state.pendingPaid;
      state.pendingPaid = others;
    }
    if (notYet) return { out: [{ to: from, body: notYet }] };
    // A forwarded bank alert ("KEVIN SMITH sent you $1,200.00 with Zelle").
    const alert = paid ? null : bankAlert(state, text);
    if (alert && "reply" in alert) return { out: [{ to: from, body: alert.reply }] };
    const plain = paid ?? (alert ? alert.command : rentFromWords(state, text));
    if (plain) text = plain;
  }

  // After a search list or a call-back, "1 tomorrow 8am" is a booking.
  const booking = bookingFromReply(state, from, text, now);
  if (state.pendingBook?.[digits(from)]) {
    const { [digits(from)]: _, ...others } = state.pendingBook;
    state.pendingBook = others;
  }
  if (booking) text = booking;

  // "Search for plumbers near Naugatuck?": a yes runs the search.
  const search = booking ? null : searchFromYes(state, from, text);
  if (search) text = search;

  const help = search || booking || !text ? null : needsHelp(state, from, text, now);
  if (help && ai.understand) {
    try {
      const command = await ai.understand({ ...help, text, now, valid: (c) => usableReply(help.role, c, now), same: (a, b) => sameReply(help.role, a, b, now) });
      if (command) {
        text = command;
        understoodAs = command;
      }
    } catch (error) {
      // An AI outage must not drop the text: fall through to the fixed reader.
      console.error("understand failed:", error);
    }
  }

  if (isLandlord && /^find\b/i.test(text)) {
    const plan = planFind(state, text, from, now);
    if ("reply" in plan) return { out: [{ to: from, body: plan.reply }], understoodAs };
    // A web search takes a while; say so at once, or it looks broken.
    await sendNow([{ to: from, body: `Looking for ${plan.trade} near ${plan.town} for ${placeOf(state, plan.repairId)} now. This takes about a minute.` }]);
    try {
      const results = await ai.find(plan);
      return { out: showFound(state, plan, results, !ai.live), understoodAs };
    } catch (error) {
      console.error("find failed:", error);
      return { out: [{ to: from, body: "The search didn't work just now. Try again in a minute." }], understoodAs };
    }
  }

  // A new repair: the AI judges whether it's urgent ("it's freezing in
  // here" is; "the heater makes a small noise" isn't), and picks the trade
  // when the words don't say ("half the apartment went dark").
  let hints: TextHints = { media };
  if (ai.triage && text && isNewRepair(state, from, text)) {
    try {
      const t = await ai.triage(text);
      if (t) hints = { media, trade: tradeForProblem(text) ? null : t.trade, urgent: t.urgent };
    } catch (error) {
      console.error("triage failed:", error);
    }
  }
  return { out: handleText(state, from, text, now, hints), understoodAs };
}

function nameOf(state: State, phone: string): string {
  const d = digits(phone);
  const person =
    state.landlords.find((l) => digits(l.phone) === d) ??
    state.units.find((u) => digits(u.tenant.phone) === d)?.tenant ??
    state.vendors.find((v) => digits(v.phone) === d);
  return person?.name.split(/\s+/)[0] ?? "They";
}
