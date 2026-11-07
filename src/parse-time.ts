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

export function parseVisitTime(input: string, now: Date): Date | null {
  const text = input.toLowerCase();
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
