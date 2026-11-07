import { formatSlot, parseVisitTime } from "./parse-time.js";
import type { Outbound, Person, Repair, State, Unit, Vendor } from "./types.js";

/**
 * The whole repair flow, as plain functions over State. No network, no
 * clock, no storage: the simulator (and later Twilio) feeds texts in with
 * `handleText`, and calls `tick` as time passes for reminders.
 *
 * The flow is Mom's two chases, done by text:
 *   tenant reports -> landlord picks a repair person (SEND JOHN)
 *   -> repair person names a time -> tenant confirms they'll be home
 *   -> reminders to both the day before -> landlord asked if it's fixed.
 *
 * v0 understands fixed replies only (SEND JOHN, 1/2, TUE 9AM). Messy texts
 * get a short "reply like this" instead of a guess.
 */

const OPEN: Repair["status"][] = ["new", "asking-vendor", "asking-tenant", "confirmed"];

export function digits(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
}

const same = (a: string, b: string) => digits(a) === digits(b);

function unitOf(state: State, repair: Repair): Unit {
  const unit = state.units.find((u) => u.id === repair.unitId);
  if (!unit) throw new Error(`Repair #${repair.id} points at unknown unit ${repair.unitId}`);
  return unit;
}

function vendorOf(state: State, repair: Repair): Vendor | undefined {
  return state.vendors.find((v) => v.code === repair.vendorCode);
}

function toLandlords(state: State, body: string): Outbound[] {
  return state.landlords.map((l) => ({ to: l.phone, body }));
}

function vendorList(state: State): string {
  return state.vendors.map((v) => `${v.code} (${v.trade}, ${v.town})`).join(", ");
}

const HELP = [
  "Commands:",
  "SEND JOHN = ask John to fix the newest repair (SEND JOHN 3 for repair #3)",
  "LIST = open repairs",
  "DONE 3 = mark #3 fixed",
  "CANCEL 3 = drop #3",
].join("\n");

/** One incoming text. Returns the texts to send back out. */
export function handleText(state: State, from: string, body: string, now: Date): Outbound[] {
  const text = body.trim();
  const landlord = state.landlords.find((l) => same(l.phone, from));
  if (landlord) return fromLandlord(state, landlord, text, now);
  const vendor = state.vendors.find((v) => same(v.phone, from));
  if (vendor) return fromVendor(state, vendor, text, now);
  const unit = state.units.find((u) => same(u.tenant.phone, from));
  if (unit) return fromTenant(state, unit, text, now);
  return [{ to: from, body: "Sorry, this number isn't set up. Please text your landlord directly." }];
}

/* ------------------------------ tenant ------------------------------ */

function isYes(text: string) {
  return /^(1|y|yes|yeah|yep|ok|okay|sure)\b/i.test(text);
}
function isNo(text: string) {
  return /^(2|n|no|nope|cant|can't|cannot)\b/i.test(text);
}

function fromTenant(state: State, unit: Unit, text: string, now: Date): Outbound[] {
  const waiting = state.repairs.find(
    (r) => r.unitId === unit.id && r.status === "asking-tenant",
  );
  if (waiting && (isYes(text) || isNo(text))) {
    return isYes(text) ? tenantConfirms(state, waiting, now) : tenantDeclines(state, waiting);
  }

  const repair: Repair = {
    id: state.nextId++,
    unitId: unit.id,
    text,
    status: "new",
    createdAt: now.toISOString(),
  };
  state.repairs.push(repair);
  return [
    {
      to: unit.tenant.phone,
      body: `Got it, thanks ${unit.tenant.name}. I've told your landlord (repair #${repair.id}). You'll get a text when a repair person has a time.`,
    },
    ...toLandlords(
      state,
      `New repair #${repair.id} from ${unit.tenant.name}, ${unit.address}:\n"${text}"\n\nReply SEND + who to ask: ${vendorList(state)}`,
    ),
  ];
}

function tenantConfirms(state: State, repair: Repair, now: Date): Outbound[] {
  const unit = unitOf(state, repair);
  const vendor = vendorOf(state, repair);
  repair.status = "confirmed";
  const when = formatSlot(repair.slot!);
  // A visit tomorrow morning needs no "reminder" seconds after "confirmed".
  repair.reminded = new Date(repair.slot!).getTime() - now.getTime() < 18 * HOUR;
  const out: Outbound[] = [
    {
      to: unit.tenant.phone,
      body: `Great, you're confirmed for ${when}.${repair.reminded ? "" : " I'll remind you the day before."}`,
    },
    ...toLandlords(state, `Confirmed #${repair.id}: ${vendor?.name ?? "repair person"} at ${unit.address}, ${when}.`),
  ];
  if (vendor) {
    out.push({
      to: vendor.phone,
      body: `Confirmed: ${when} at ${unit.address}. The tenant will be home. Thanks!`,
    });
  }
  return out;
}

function tenantDeclines(state: State, repair: Repair): Outbound[] {
  const unit = unitOf(state, repair);
  const vendor = vendorOf(state, repair);
  const when = formatSlot(repair.slot!);
  repair.status = "asking-vendor";
  delete repair.slot;
  const out: Outbound[] = [
    { to: unit.tenant.phone, body: "No problem. I'll ask for another time." },
    ...toLandlords(state, `${unit.tenant.name} can't do ${when} for #${repair.id}. Asking ${vendor?.name ?? "the repair person"} for another time.`),
  ];
  if (vendor) {
    out.push({
      to: vendor.phone,
      body: `The tenant at ${unit.address} can't do ${when}. What other day and time work? Reply like TUE 9AM, or NO.`,
    });
  }
  return out;
}

/* ------------------------------ vendor ------------------------------ */

function fromVendor(state: State, vendor: Vendor, raw: string, now: Date): Outbound[] {
  // "#3 tue 9am" picks a repair; otherwise their oldest open ask.
  // Needs the "#": a bare "9 am" is a time, not repair #9.
  const idMatch = raw.match(/^#(\d+)\s+(?=\S)/);
  const asks = state.repairs.filter(
    (r) => r.vendorCode === vendor.code && r.status === "asking-vendor",
  );
  const picked = idMatch ? asks.find((r) => r.id === Number(idMatch[1])) : undefined;
  const repair = picked ?? asks[0];
  const text = picked && idMatch ? raw.slice(idMatch[0].length) : raw;

  if (!repair) {
    return [{ to: vendor.phone, body: "Thanks! There's nothing waiting on you right now." }];
  }
  const unit = unitOf(state, repair);

  if (isNo(text)) {
    repair.status = "new";
    delete repair.vendorCode;
    return [
      { to: vendor.phone, body: "No problem, thanks for letting us know." },
      ...toLandlords(
        state,
        `${vendor.name} can't do #${repair.id} (${unit.address}). Reply SEND + someone else: ${vendorList(state)}`,
      ),
    ];
  }

  const slot = parseVisitTime(text, now);
  if (!slot) {
    return [
      {
        to: vendor.phone,
        body: "Sorry, I didn't catch the time. Reply with a day and time like TUE 9AM or TOMORROW 2PM, or NO if you can't.",
      },
    ];
  }

  repair.slot = slot.toISOString();
  repair.status = "asking-tenant";
  const when = formatSlot(repair.slot);
  return [
    { to: vendor.phone, body: `Thanks! Checking ${when} with the tenant. I'll text you when it's confirmed.` },
    {
      to: unit.tenant.phone,
      body: `${vendor.name} (${vendor.trade}) can come ${when} about: "${repair.text}". Reply 1 if you'll be home, 2 if not.`,
    },
    ...toLandlords(state, `${vendor.name} offered ${when} for #${repair.id}. Checking with ${unit.tenant.name}.`),
  ];
}

/* ----------------------------- landlord ----------------------------- */

function fromLandlord(state: State, landlord: Person, text: string, now: Date): Outbound[] {
  const reply = (body: string): Outbound[] => [{ to: landlord.phone, body }];
  const [word = "", ...rest] = text.split(/\s+/);
  const command = word.toUpperCase();
  const idArg = (s: string | undefined) => (s ? Number(s.replace(/^#/, "")) : NaN);

  if (command === "SEND") {
    const code = (rest[0] ?? "").toUpperCase();
    const vendor = state.vendors.find((v) => v.code === code);
    if (!vendor) return reply(`Who should I ask? Reply SEND + one of: ${vendorList(state)}`);
    const id = idArg(rest[1]);
    const repair = Number.isNaN(id)
      ? [...state.repairs].reverse().find((r) => r.status === "new")
      : state.repairs.find((r) => r.id === id && OPEN.includes(r.status));
    if (!repair) return reply(Number.isNaN(id) ? "No new repairs waiting. Reply LIST to see open ones." : `There's no open repair #${id}.`);
    const unit = unitOf(state, repair);
    repair.vendorCode = vendor.code;
    repair.status = "asking-vendor";
    delete repair.slot;
    repair.reminded = false;
    return [
      {
        to: vendor.phone,
        body: `Hi ${vendor.name}, this is the repair line for ${state.landlords[0]?.name ?? "your landlord"}. Job at ${unit.address}: "${repair.text}". When can you go? Reply with a day and time like TUE 9AM, or NO if you can't.`,
      },
      ...toLandlords(state, `Asked ${vendor.name} about #${repair.id}. I'll text you when they reply.`),
    ];
  }

  if (command === "LIST" || command === "STATUS") {
    const open = state.repairs.filter((r) => OPEN.includes(r.status));
    if (open.length === 0) return reply("No open repairs.");
    return reply(open.map((r) => describe(state, r)).join("\n"));
  }

  if (command === "DONE" || command === "CANCEL") {
    const id = idArg(rest[0]);
    const repair = state.repairs.find((r) => r.id === id && OPEN.includes(r.status));
    if (!repair) return reply(`Which one? Reply ${command} + the repair number, e.g. ${command} 3.`);
    repair.status = command === "DONE" ? "done" : "cancelled";
    return toLandlords(state, `#${repair.id} marked ${repair.status}.`);
  }

  return reply(HELP);
}

function describe(state: State, r: Repair): string {
  const unit = unitOf(state, r);
  const who = vendorOf(state, r)?.name;
  const where = `#${r.id} ${unit.address}: "${r.text}"`;
  switch (r.status) {
    case "new":
      return `${where} - nobody asked yet`;
    case "asking-vendor":
      return `${where} - waiting on ${who}`;
    case "asking-tenant":
      return `${where} - ${who} offered ${formatSlot(r.slot!)}, waiting on tenant`;
    case "confirmed":
      return `${where} - ${who}, ${formatSlot(r.slot!)}`;
    default:
      return `${where} - ${r.status}`;
  }
}

/* ------------------------------- time ------------------------------- */

const HOUR = 60 * 60 * 1000;

/**
 * Call as the clock moves. Sends the day-before reminders, and asks the
 * landlord whether it got fixed a few hours after the visit.
 */
export function tick(state: State, now: Date): Outbound[] {
  const out: Outbound[] = [];
  for (const r of state.repairs) {
    if (r.status !== "confirmed" || !r.slot) continue;
    const at = new Date(r.slot).getTime();
    const unit = unitOf(state, r);
    const vendor = vendorOf(state, r);
    const when = formatSlot(r.slot);

    if (!r.reminded && at - now.getTime() <= 24 * HOUR && at > now.getTime()) {
      r.reminded = true;
      out.push({ to: unit.tenant.phone, body: `Reminder: ${vendor?.name ?? "the repair person"} is coming ${when}.` });
      if (vendor) out.push({ to: vendor.phone, body: `Reminder: ${when} at ${unit.address}.` });
    }
    if (!r.checkedBack && now.getTime() - at >= 4 * HOUR) {
      r.checkedBack = true;
      out.push(...toLandlords(state, `Did ${vendor?.name ?? "the repair person"} fix #${r.id} at ${unit.address}? Reply DONE ${r.id} if so.`));
    }
  }
  return out;
}
