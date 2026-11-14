/**
 * Reads a visit time out of a repair person's text: "tue 9am",
 * "tomorrow 2:30pm", "11/12 10am", "8am". Returns null when it can't tell,
 * so the bot asks again instead of guessing.
 *
 * Times are local (the process runs with TZ=America/New_York). Every time
 * read here is echoed back to the tenant to confirm, so a misread is caught
 * before anyone drives over.
 */

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function readClock(text: string): { h: number; m: number } | null {
  if (/\bnoon\b/.test(text)) return { h: 12, m: 0 };
  const match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\b(?!\s*\/)/);
  if (!match) return null;
  let h = Number(match[1]);
  const m = Number(match[2] ?? 0);
  const suffix = match[3];
  if (h > 23 || m > 59) return null;
  if (suffix?.startsWith("p") && h < 12) h += 12;
  else if (suffix?.startsWith("a") && h === 12) h = 0;
  // No am/pm: repair people work days, so 1-6 means afternoon.
  else if (!suffix && h >= 1 && h <= 6) h += 12;
  return { h, m };
}

function readDay(text: string, now: Date): Date | null | "none" {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (/\btoday\b/.test(text)) return start;
  if (/\b(tomorrow|tmrw|tmr|tomorow)\b/.test(text)) {
    start.setDate(start.getDate() + 1);
    return start;
  }
  const date = text.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (date) {
    const month = Number(date[1]) - 1;
    const day = Number(date[2]);
    if (month > 11 || day < 1 || day > 31) return null;
    const d = new Date(now.getFullYear(), month, day);
    if (d < start) d.setFullYear(d.getFullYear() + 1);
    return d;
  }
  const word = text.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/);
  if (word) {
    const target = DAYS.indexOf(word[1]!);
    const ahead = (target - start.getDay() + 7) % 7;
    start.setDate(start.getDate() + ahead);
    return start;
  }
  return "none";
}

const DAY_WORDS = /\b(today|tomorrow|tmrw|tmr|tomorow|sun|mon|tue|wed|thu|fri|sat)[a-z]*\b|\b\d{1,2}\/\d{1,2}\b/g;

/** Whether a text talks about a day or a time at all ("cant tmrw" does). */
/**
 * Whether a text offers another time: a later day or a clock time. "Booked
 * today" or "can't tonight" only says why not, so it isn't an offer.
 */
export function offersTime(input: string): boolean {
  const text = input.toLowerCase();
  return /\b(tomorrow|tmrw|tmr|tomorow|noon|morning|afternoon|evening)\b|\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{1,2}\/\d{1,2}\b|\bafter \d/.test(
    text,
  );
}

export function mentionsTime(input: string): boolean {
  const text = input.toLowerCase();
  return /\b(today|tomorrow|tmrw|tmr|tomorow|noon|morning|afternoon|evening)\b|\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{1,2}\/\d{1,2}\b/.test(text);
}

export function parseVisitTime(input: string, now: Date): Date | null {
  const text = input.toLowerCase();
  // "cant tmrw, thurs ok" names two days: too risky to pick one.
  if ((text.match(DAY_WORDS) ?? []).length > 1) return null;
  const day = readDay(text, now);
  if (day === null) return null;
  // Strip the date so "11/12" isn't read as a clock time.
  const clock = readClock(text.replace(/\b\d{1,2}\/\d{1,2}\b/, " "));
  if (!clock) return null;

  if (day === "none") {
    // Only a time: today if it's still ahead, else tomorrow.
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), clock.h, clock.m);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  const d = new Date(day);
  d.setHours(clock.h, clock.m, 0, 0);
  // "tue 9am" said on a Tuesday at noon means next Tuesday.
  if (d <= now && /\b(sun|mon|tue|wed|thu|fri|sat)/.test(text)) {
    d.setDate(d.getDate() + 7);
  }
  return d <= now ? null : d;
}

/** "Tue Nov 11, 9:00 AM" */
export function formatSlot(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${day}, ${time}`;
}

const CLOCK = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\bnoon\b/gi;
const HAS_DAY = /\b(today|tomorrow|tmrw|tmr|tomorow|sun|mon|tue|wed|thu|fri|sat)[a-z]*\b|\b\d{1,2}\/\d{1,2}\b/i;

/**
 * Every visit time a repair person offers: "tue 9am" gives one, "tue 9am or
 * wed 2pm" two, "tue or wed at 9am" two (the day without a time borrows the
 * one named). A text with a no or a rough window in it ("can't tmrw, thurs
 * after 2") gives none, so nobody's time is guessed. At most three, earliest first.
 */
export function parseOffers(input: string, now: Date): Date[] {
  const single = parseVisitTime(input, now);
  if (single) return [single];
  // "can't tmrw, thurs after 2" is a no plus a rough window: too risky to read
  // as offers, so it goes to the AI (or back to the repair person) instead.
  if (/\b(no|cant|can't|cannot|not|busy|booked|after|before|around|between|until|till|maybe)\b/i.test(input)) return [];
  const clocks = input.match(CLOCK) ?? [];
  const lastClock = clocks[clocks.length - 1];
  const parts = input.split(/\s*(?:\bor\b|\band\b|\balso\b|,|;|\/(?!\d)|\.\s)\s*/i).filter((p) => p.trim());
  const found: Date[] = [];
  for (const part of parts) {
    let d = parseVisitTime(part, now);
    if (!d && lastClock && HAS_DAY.test(part) && !part.match(CLOCK)) d = parseVisitTime(`${part} ${lastClock}`, now);
    if (d && !found.some((f) => f.getTime() === d!.getTime())) found.push(d);
  }
  return found.sort((a, b) => a.getTime() - b.getTime()).slice(0, 3);
}

/** "Tue, Nov 17, 9:00 AM or Wed, Nov 18, 2:00 PM" */
export function formatOffers(isos: string[]): string {
  const all = isos.map(formatSlot);
  return all.length < 3 ? all.join(" or ") : `${all.slice(0, -1).join(", ")} or ${all[all.length - 1]}`;
}

/**
 * Which offered time a tenant picked: its index, "none" for neither, or null
 * when the text doesn't say ("yes" to two choices doesn't).
 */
export function pickOffer(isos: string[], input: string, now: Date): number | "none" | null {
  const text = input.toLowerCase().trim();
  if (/\b(neither|none)\b|^(no|nope|nah|cant|can't|cannot)\b/.test(text)) return "none";
  const n = text.match(/^#?([1-3])\b/);
  if (n && Number(n[1]) <= isos.length) return Number(n[1]) - 1;
  if (/\b(first|1st|earlier|earliest|sooner)\b/.test(text)) return 0;
  if (/\b(second|2nd)\b/.test(text) && isos.length >= 2) return 1;
  if (/\b(third|3rd)\b/.test(text) && isos.length >= 3) return 2;
  if (/\b(last|later|latest)\b/.test(text)) return isos.length - 1;
  if (/\b(either|any|both|whichever|all)\b/.test(text)) return 0;
  const times = isos.map((s) => new Date(s));
  const exact = parseVisitTime(text, now);
  if (exact) {
    const i = times.findIndex((t) => t.getTime() === exact.getTime());
    if (i >= 0) return i;
  }
  // "wed works", "tomorrow", "the 2pm one": one offer that matches what they named.
  const matches = times
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => {
      const day = DAYS[t.getDay()]!;
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const ahead = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() - start.getTime()) / 86_400_000);
      const named =
        new RegExp(`\\b${day}[a-z]*\\b`).test(text) ||
        (ahead === 0 && /\btoday\b/.test(text)) ||
        (ahead === 1 && /\b(tomorrow|tmrw|tmr|tomorow)\b/.test(text));
      const clock = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
      const hour = clock ? (Number(clock[1]) % 12) + (clock[3] === "pm" ? 12 : 0) : null;
      return named || (hour !== null && t.getHours() === hour);
    })
    .map(({ i }) => i);
  return matches.length === 1 ? matches[0]! : null;
}
