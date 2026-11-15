import { isQuietHour } from "./compliance.js";
import { startUpkeep } from "./engine.js";
import type { Outbound, Person, State, Unit } from "./types.js";

/**
 * Routine upkeep: the jobs that stop emergencies (Mom's Sunday-night furnace
 * lockout). The landlord turns on the ones they want once; when one comes
 * due, the line starts it like a tenant's repair ("Furnace service is due at
 * 12 Oak St. Send Sam (HVAC)?"), so YES books it the usual way: Sam names a
 * time, the tenant confirms, everyone gets reminded the day before.
 *
 * Due months are the usual season for each job in the Northeast.
 */
export const UPKEEP = [
  { key: "furnace", label: "Furnace/boiler service", trade: "HVAC", months: [9], when: "every September, before the cold" },
  { key: "smoke", label: "Smoke and CO detector check", trade: "handyman", months: [1, 7], when: "every January and July" },
  { key: "gutters", label: "Gutter cleaning", trade: "handyman", months: [11], when: "every November, after the leaves" },
  { key: "ac", label: "AC service", trade: "HVAC", months: [4], when: "every April, before the heat" },
  { key: "dryer", label: "Dryer vent cleaning", trade: "handyman", months: [3], when: "every March (lint fires)" },
] as const;
export type UpkeepKey = (typeof UPKEEP)[number]["key"];

const HOUR = 9;
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** One reminder per building, not per apartment: "12 Oak St, Naugatuck" for "12 Oak St, Naugatuck, Unit 1". */
export function buildingOf(unit: Unit): string {
  return unit.address
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !/^(unit|apt|apartment|#|fl|floor)\b/i.test(p))
    .join(", ");
}

function buildings(state: State): { building: string; unit: Unit }[] {
  const seen = new Map<string, Unit>();
  for (const u of state.units) if (!seen.has(buildingOf(u))) seen.set(buildingOf(u), u);
  return [...seen].map(([building, unit]) => ({ building, unit }));
}

/**
 * Starts one upkeep job at one building now: a repair the landlord can say
 * YES to. The demo uses this to skip waiting for the month.
 */
export function upkeepDue(state: State, key: UpkeepKey, unit: Unit, now: Date): Outbound[] {
  const job = UPKEEP.find((j) => j.key === key)!;
  const building = buildingOf(unit);
  const done = (state.upkeep ??= { on: [], sent: {} });
  done.sent[`${key}|${building}`] = monthKey(now);
  done.lastAt = dayKey(now);
  return startUpkeep(state, unit, `${job.label} (routine upkeep)`, job.trade, (id) => `Upkeep due: ${job.label.toLowerCase()} at ${building} (#${id}). It's done ${job.when}.`, now);
}

/**
 * Called as the clock moves. At most one upkeep job a day, from 9am, so a
 * landlord with ten buildings gets them one at a time, not ten at once.
 */
export function tickUpkeep(state: State, now: Date): Outbound[] {
  const up = state.upkeep;
  if (!up?.on.length || isQuietHour(now) || now.getHours() < HOUR || up.lastAt === dayKey(now)) return [];
  const month = now.getMonth() + 1;
  for (const job of UPKEEP) {
    if (!up.on.includes(job.key) || !(job.months as readonly number[]).includes(month)) continue;
    for (const { building, unit } of buildings(state)) {
      if (up.sent[`${job.key}|${building}`] === monthKey(now)) continue;
      return upkeepDue(state, job.key, unit, now);
    }
  }
  return [];
}

/**
 * UPKEEP shows the list; UPKEEP 1 3 turns those on; UPKEEP OFF 2 turns one
 * off; UPKEEP ALL turns everything on.
 */
export function upkeepCommand(state: State, landlord: Person, args: string[]): Outbound[] {
  const reply = (body: string): Outbound[] => [{ to: landlord.phone, body }];
  const up = (state.upkeep ??= { on: [], sent: {} });
  const off = /^off$/i.test(args[0] ?? "");
  const picks = /^all$/i.test(args[0] ?? "")
    ? UPKEEP.map((_, i) => i)
    : args.flatMap((a) => a.split(/[,\s]+/)).map(Number).filter((n) => n >= 1 && n <= UPKEEP.length).map((n) => n - 1);

  if (picks.length) {
    const keys = picks.map((i) => UPKEEP[i]!.key);
    up.on = off ? up.on.filter((k) => !keys.includes(k as UpkeepKey)) : [...new Set([...up.on, ...keys])];
    const names = picks.map((i) => UPKEEP[i]!.label.toLowerCase()).join(", ");
    return reply(
      off
        ? `Turned off: ${names}.`
        : `On: ${names}. When one is due I'll text you and line up the repair person, one building at a time. Text UPKEEP to see the list.`,
    );
  }
  const lines = UPKEEP.map((j, i) => `${i + 1}. ${j.label}, ${j.when}${up.on.includes(j.key) ? " ✓" : ""}`);
  return reply(
    [
      "Routine upkeep, to head off emergencies. I'll text you when each is due and line up the repair person:",
      ...lines,
      "",
      "Reply UPKEEP and the numbers to turn them on (like: UPKEEP 1 2), UPKEEP ALL for all, UPKEEP OFF 2 to stop one.",
    ].join("\n"),
  );
}
