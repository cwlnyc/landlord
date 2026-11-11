import type { Ai } from "./ai.js";
import { handleKeyword, prepareOutbound } from "./compliance.js";
import { handleText, needsHelp, planFind, showFound, digits } from "./engine.js";
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
  const result = await respond(state, from, body, now, ai);
  return { ...result, out: prepareOutbound(state, result.out, now) };
}

async function respond(
  state: State,
  from: string,
  body: string,
  now: Date,
  ai: Ai,
): Promise<{ out: Outbound[]; understoodAs?: string }> {
  let text = body.trim();
  let understoodAs: string | undefined;

  const help = needsHelp(state, from, text, now);
  if (help && ai.understand) {
    try {
      const command = await ai.understand({ ...help, text, now });
      if (command) {
        text = command;
        understoodAs = command;
      }
    } catch (error) {
      // An AI outage must not drop the text: fall through to the fixed reader.
      console.error("understand failed:", error);
    }
  }

  const isLandlord = state.landlords.some((l) => digits(l.phone) === digits(from));
  if (isLandlord && /^find\b/i.test(text)) {
    const plan = planFind(state, text);
    if ("reply" in plan) return { out: [{ to: from, body: plan.reply }], understoodAs };
    try {
      const results = await ai.find(plan);
      return { out: showFound(state, plan, results, !ai.live), understoodAs };
    } catch (error) {
      console.error("find failed:", error);
      return { out: [{ to: from, body: "The search didn't work just now. Try again in a minute." }], understoodAs };
    }
  }

  return { out: handleText(state, from, text, now), understoodAs };
}
