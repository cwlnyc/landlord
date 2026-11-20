/**
 * What the line asks a tenant right after they report a problem, the way Mom
 * would: what exactly is wrong and where, and a photo. Their answers go to
 * the landlord and to the repair person's first text, so the repair person
 * rarely has to ask "what's the issue? can I see a pic?".
 *
 * Plain rules, not the AI: the same problem always gets the same question,
 * and it costs nothing.
 */

/** A safety step to say first, when the problem calls for one. */
export function safetyTip(problem: string): string | null {
  const t = problem.toLowerCase();
  if (/\b(carbon monoxide|co alarm|co detector)\b/.test(t)) {
    return "If the CO alarm is going off, get everyone outside now and call 911.";
  }
  if (/\bgas\b/.test(t) && /\b(smell\w*|leak\w*|odou?r)\b/.test(t)) {
    return "If you smell gas, leave right away and call 911 or the gas company from outside. Don't flip switches.";
  }
  if (/\b(smoke|fire|spark\w*|burning)\b/.test(t)) {
    return "If there's smoke, sparks or fire, get out and call 911.";
  }
  if (/\b(leak\w*|flood\w*|burst|pouring|gushing)\b/.test(t)) {
    return "If you can do it safely, turn off the water valve under the sink or toilet (or the main shutoff) to slow it down.";
  }
  return null;
}

/** The one question that tells the repair person the most, for this problem. */
export function followUpQuestion(problem: string, trade: string | null | undefined): string {
  const t = problem.toLowerCase();
  if (trade === "plumber") {
    if (/\b(leak\w*|drip\w*|flood\w*|burst)\b/.test(t)) return "Where is it leaking from, and is it a drip or a steady flow?";
    if (/\b(clog\w*|backed up|drain\w*|toilet|overflow\w*)\b/.test(t)) return "Which sink, tub or toilet, and is water backing up?";
    if (/\bwater\w*\b/.test(t)) return "Is it no water at all, or just no hot water? Is it every faucet, or just one?";
    return "What exactly is happening, and where (kitchen, bathroom)?";
  }
  if (trade === "HVAC") {
    if (/\b(a\/?c|air ?condition\w*|cool\w*)\b/.test(t)) return "Is the AC not turning on, or running but not cooling?";
    return "Is there no heat anywhere, or just in some rooms? Is the thermostat set to heat?";
  }
  if (trade === "electrician") return "Is it one outlet or room, or the whole place? Did anything trip in the breaker box?";
  if (trade === "appliance") return "Which appliance, and what is it doing (or not doing)?";
  if (trade === "locksmith") return "Are you locked out right now, or is a lock or key not working?";
  if (trade === "roofer") return "Where is it, and is water coming inside?";
  return "What exactly is broken, and where in the apartment?";
}

/** The tenant's first reply: thanks, a safety step if needed, then the question and a photo ask. */
export function intakeReply(name: string, problem: string, trade: string | null | undefined, sentPhoto: boolean): string {
  const tip = safetyTip(problem);
  return [
    `Got it, thanks ${name}. I've told your landlord.${tip ? ` ${tip}` : ""}`,
    "",
    `To help the repair person: ${followUpQuestion(problem, trade)}${sentPhoto ? "" : " A photo or short video helps too. You can send it right here."}`,
  ].join("\n");
}
