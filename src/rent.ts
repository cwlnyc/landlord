import type { Outbound, Person, State, Unit } from "./types.js";

/**
 * Rent reminders. Tracking only: tenants pay the way they always have
 * (cash, Zelle, check) and the bot never touches money. It reminds the
 * tenant before the due date, nudges once if rent isn't marked paid a few
 * days after, tells the landlord who's late, and keeps the record.
 *
 * Only the landlord marks rent paid (PAID MARIA). A tenant texting "paid"
 * tells the landlord to check; it doesn't count on its own, because the
 * record is the landlord's and money they haven't seen isn't paid.
 */

export type Payment = {
  unitId: string;
  /** The rent month this counts toward, "2026-11". */
  period: string;
  amount: number;
  method?: string;
  at: string;
};

const DEFAULTS = { remindDaysBefore: 3, graceDays: 5, hour: 9 };
const DAY = 24 * 60 * 60 * 1000;

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const periodKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthName = (period: string) =>
  new Date(Number(period.slice(0, 4)), Number(period.slice(5)) - 1, 1).toLocaleDateString("en-US", { month: "long" });

function settings(state: State) {
  return { ...DEFAULTS, ...state.rentSettings };
}

/** The due date of a month, with day 31 meaning the month's last day. */
function dueDate(year: number, month: number, day: number): Date {
  const last = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, last));
}

/**
 * Which month's rent "now" is about: next month's if it's due within a
 * week (paying on the 28th for the 1st), otherwise this month's.
 */
export function currentPeriod(unit: Unit, now: Date): { period: string; due: Date } {
  const day = unit.rentDue ?? 1;
  const next = dueDate(now.getFullYear(), now.getMonth() + 1, day);
  const due = next.getTime() - now.getTime() <= 7 * DAY ? next : dueDate(now.getFullYear(), now.getMonth(), day);
  return { period: periodKey(due), due };
}

export function paidToward(state: State, unitId: string, period: string): number {
  return (state.payments ?? []).filter((p) => p.unitId === unitId && p.period === period).reduce((sum, p) => sum + p.amount, 0);
}

const rentUnits = (state: State) => state.units.filter((u) => (u.rent ?? 0) > 0);
const toLandlords = (state: State, body: string): Outbound[] => state.landlords.map((l) => ({ to: l.phone, body }));
const landlordName = (state: State) => state.landlords[0]?.name ?? "your landlord";

/** Whether a tenant's text is about rent rather than a repair. */
export function isRentText(text: string): boolean {
  // Not "check" or "pay" alone: "can someone check the heater" is a repair.
  return /\b(paid|rent|zelle[ds]?|venmo(ed)?|cash ?app|money order|payment)\b|\bsent (it|you|the money)\b/i.test(text);
}

/* ------------------------------ tenant ------------------------------ */

export function tenantRentText(state: State, unit: Unit, text: string, now: Date): Outbound[] {
  if (!unit.rent) {
    return [{ to: unit.tenant.phone, body: "Thanks! For anything about rent, please text your landlord directly." }];
  }
  const { period } = currentPeriod(unit, now);
  const left = unit.rent - paidToward(state, unit.id, period);
  if (left <= 0) {
    return [{ to: unit.tenant.phone, body: `Thanks ${unit.tenant.name}! ${monthName(period)} rent is already marked paid.` }];
  }
  return [
    {
      to: unit.tenant.phone,
      body: `Thanks ${unit.tenant.name}! I've let your landlord know. They'll mark it paid once it shows up.`,
    },
    ...toLandlords(
      state,
      `${unit.tenant.name} (${unit.address}) says about rent: "${text}"\n${monthName(period)}: ${money(left)} not marked paid yet. Reply PAID ${unit.tenant.name.toUpperCase()} once it's in.`,
    ),
  ];
}

/* ----------------------------- landlord ----------------------------- */

function findUnit(state: State, who: string): Unit | undefined {
  const w = who.toLowerCase();
  return rentUnits(state).find(
    (u) => u.id.toLowerCase() === w || u.tenant.name.toLowerCase() === w || u.tenant.name.toLowerCase().split(/\s+/)[0] === w,
  );
}

/**
 * PAID MARIA [amount] [how]: marks rent paid for the month in play. With
 * no amount, what's left; a smaller amount is a partial payment.
 */
export function landlordPaid(state: State, landlord: Person, args: string[], now: Date): Outbound[] {
  const reply = (body: string): Outbound[] => [{ to: landlord.phone, body }];
  const names = rentUnits(state).map((u) => u.tenant.name.split(/\s+/)[0]!.toUpperCase()).join(", ");
  const [who = "", ...rest] = args;
  const unit = findUnit(state, who);
  if (!unit || !unit.rent) return reply(`Whose rent? Reply PAID + their name: ${names || "(no rents set up)"}`);

  const { period } = currentPeriod(unit, now);
  const left = unit.rent - paidToward(state, unit.id, period);
  const amountWord = rest.find((w) => /^\$?\d[\d,]*(\.\d+)?$/.test(w));
  const amount = amountWord ? Number(amountWord.replace(/[$,]/g, "")) : Math.max(left, 0);
  const method = rest.filter((w) => w !== amountWord).join(" ").trim() || undefined;
  if (left <= 0 && !amountWord) {
    return reply(`${unit.tenant.name}'s ${monthName(period)} rent is already marked paid.`);
  }
  if (!(amount > 0)) return reply(`How much? e.g. PAID ${unit.tenant.name.toUpperCase()} 600`);

  state.payments = [...(state.payments ?? []), { unitId: unit.id, period, amount, method, at: now.toISOString() }];
  const nowLeft = unit.rent - paidToward(state, unit.id, period);
  const how = method ? ` (${method})` : "";
  return [
    ...toLandlords(
      state,
      nowLeft > 0
        ? `Marked ${money(amount)}${how} from ${unit.tenant.name} for ${monthName(period)}. ${money(nowLeft)} still to come.`
        : `Marked ${unit.tenant.name}'s ${monthName(period)} rent paid${how}. ${rentLine(state, now)}`,
    ),
    {
      to: unit.tenant.phone,
      body:
        nowLeft > 0
          ? `Hi ${unit.tenant.name}, ${landlordName(state)} got ${money(amount)} toward ${monthName(period)} rent. ${money(nowLeft)} left. Thanks!`
          : `Hi ${unit.tenant.name}, ${landlordName(state)} got your ${monthName(period)} rent. Thanks!`,
    },
  ];
}

/** "5 of 7 paid for November." */
function rentLine(state: State, now: Date): string {
  const units = rentUnits(state);
  const paid = units.filter((u) => {
    const { period } = currentPeriod(u, now);
    return paidToward(state, u.id, period) >= u.rent!;
  });
  return `${paid.length} of ${units.length} paid.`;
}

/** RENT: who's paid for the month in play. */
export function rentStatus(state: State, now: Date): string {
  const units = rentUnits(state);
  if (units.length === 0) return "No rents set up yet. Add \"rent\" and \"rentDue\" to each unit in the data file.";
  const since = new Date((state.rentSince ??= now.toISOString()));
  const lines = units.map((u) => {
    const { period, due } = currentPeriod(u, now);
    const paid = paidToward(state, u.id, period);
    const status =
      paid >= u.rent!
        ? "paid"
        : paid > 0
          ? `${money(paid)} of ${money(u.rent!)}`
          : due > now
            ? "not due yet"
            : due < since
              ? "before tracking started"
              : "NOT PAID";
    return `${u.tenant.name}, ${u.address}: ${monthName(period)} ${status}`;
  });
  return [`Rent: ${rentLine(state, now)}`, ...lines].join("\n");
}

/* ------------------------------- time ------------------------------- */

/**
 * As the clock moves: a reminder a few days before the due date, then one
 * nudge to the tenant and one list to the landlords once the grace days
 * are up. Each sent once per unit per month, and never once it's paid.
 * Nothing goes out before 9am.
 */
export function tickRent(state: State, now: Date): Outbound[] {
  const s = settings(state);
  const out: Outbound[] = [];
  const late: string[] = [];
  const sent = (state.rentNotices ??= {});
  // Rent is tracked from the first time the line runs. Without this, the
  // first start would tell every tenant last month's rent "isn't marked
  // paid", when nobody had marked anything yet.
  const since = new Date((state.rentSince ??= now.toISOString()));

  for (const unit of rentUnits(state)) {
    const day = unit.rentDue ?? 1;
    // This month's and next month's due dates, so a reminder for the 1st
    // goes out on the 28th.
    for (const offset of [-1, 0, 1]) {
      const due = dueDate(now.getFullYear(), now.getMonth() + offset, day);
      const period = periodKey(due);
      const key = `${unit.id}|${period}`;
      const done = (sent[key] ??= []);
      const left = unit.rent! - paidToward(state, unit.id, period);
      if (left <= 0) continue;

      const remindAt = new Date(due.getFullYear(), due.getMonth(), due.getDate() - s.remindDaysBefore, s.hour);
      const lateAt = new Date(due.getFullYear(), due.getMonth(), due.getDate() + s.graceDays, s.hour);
      const dueText = due.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

      if (!done.includes("reminder") && now >= remindAt && now < due && remindAt >= since) {
        done.push("reminder");
        out.push({
          to: unit.tenant.phone,
          body: `Hi ${unit.tenant.name}, a reminder from ${landlordName(state)}: ${monthName(period)} rent (${money(left)}) is due ${dueText}. Thanks!`,
        });
      }
      if (!done.includes("late") && now >= lateAt && now.getTime() - lateAt.getTime() < 20 * DAY && due >= since) {
        done.push("late");
        out.push({
          to: unit.tenant.phone,
          body: `Hi ${unit.tenant.name}, ${monthName(period)} rent (${money(left)}, due ${dueText}) isn't marked paid yet. If you've already sent it, reply PAID and I'll let ${landlordName(state)} know.`,
        });
        late.push(`${unit.tenant.name}, ${unit.address}: ${money(left)}`);
      }
    }
  }
  if (late.length) {
    out.push(
      ...toLandlords(
        state,
        `Rent not marked paid:\n${late.join("\n")}\n\nI sent each a friendly reminder. Reply PAID + name when it comes in, or RENT for everyone.`,
      ),
    );
  }
  return out;
}
