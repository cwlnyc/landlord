import { pickVendor, readContactCard, readContactName, tradeForProblem, tradeLabel } from "./match.js";
import { formatSlot, mentionsTime, parseVisitTime } from "./parse-time.js";
import { isQuietHour } from "./compliance.js";
import { isRentText, landlordPaid, rentStatus, setRent, tenantRentText, tickRent } from "./rent.js";
import type { Found, Outbound, Person, Repair, State, Unit, Vendor } from "./types.js";

/**
 * The whole repair flow, as plain functions over State. No network, no
 * clock, no storage: the caller feeds texts in with `handleText`, calls
 * `tick` as time passes, and does the slow outside work (AI, web search)
 * itself, using `needsHelp`, `planFind` and `showFound` on either side.
 *
 * The flow is Mom's two chases, done by text:
 *   tenant reports -> landlord picks a repair person (SEND JOHN)
 *   -> repair person names a time -> tenant confirms they'll be home
 *   -> reminders the day before -> landlord asked if it's fixed.
 * And her 6am Google search, when the usual person can't come:
 *   FIND HVAC -> numbered list of businesses to call
 *   -> landlord calls, then BOOKED 1 TOMORROW 8AM -> tenant check as above.
 *
 * The engine itself only reads fixed replies (SEND JOHN, 1/2, TUE 9AM).
 * Messy texts are turned into those by the AI layer first; without it they
 * get a short "reply like this" instead of a guess.
 */

const OPEN: Repair["status"][] = ["new", "asking-vendor", "asking-tenant", "confirmed"];
const HOUR = 60 * 60 * 1000;

const YES_WORDS = ["YES", "Y", "YEP", "YEAH", "YA", "OK", "OKAY", "SURE", "K"];
const NO_WORDS = ["NO", "N", "NOPE", "NAH"];
export const LANDLORD_COMMANDS = ["SEND", "LIST", "STATUS", "DONE", "CANCEL", "DROP", "FIND", "BOOKED", "HELP", "PAID", "RENT", ...YES_WORDS, ...NO_WORDS];

export function digits(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
}

const same = (a: string, b: string) => digits(a) === digits(b);

function unitOf(state: State, repair: Repair): Unit {
  const unit = state.units.find((u) => u.id === repair.unitId);
  if (!unit) throw new Error(`Repair #${repair.id} points at unknown unit ${repair.unitId}`);
  return unit;
}

export function townOf(unit: Unit): string {
  return unit.town ?? unit.address.split(",")[1]?.trim() ?? "";
}

function vendorOf(state: State, repair: Repair): Vendor | undefined {
  return state.vendors.find((v) => v.code === repair.vendorCode);
}

/** Vendors the bot may text. Businesses booked by phone are left out. */
function textable(state: State): Vendor[] {
  return state.vendors.filter((v) => v.textable !== false);
}

function toLandlords(state: State, body: string): Outbound[] {
  return state.landlords.map((l) => ({ to: l.phone, body }));
}

function vendorList(state: State): string {
  return textable(state).map((v) => `${v.code} (${v.trade}, ${v.town})`).join(", ");
}

function landlordOf(state: State, from: string): Person | undefined {
  return state.landlords.find((l) => same(l.phone, from));
}
function vendorFrom(state: State, from: string): Vendor | undefined {
  return state.vendors.find((v) => same(v.phone, from));
}
function unitFrom(state: State, from: string): Unit | undefined {
  return state.units.find((u) => same(u.tenant.phone, from));
}

const HELP = [
  "Commands:",
  "YES = send the person I suggested (YES 3 for repair #3)",
  "SEND JOHN = ask John to fix the newest repair (SEND JOHN 3 for repair #3)",
  "FIND HVAC = search for HVAC near the rental, for you to call",
  "BOOKED 1 TUE 9AM = you booked result 1 (or BOOKED JOHN TUE 9AM)",
  "LIST = open repairs",
  "DONE 3 = mark #3 fixed",
  "DROP 3 = drop #3 (never text just CANCEL or STOP: that turns this line off for you)",
  "PAID MARIA = Maria's rent came in (PAID MARIA 600 CASH for part of it)",
  "RENT = who's paid this month (RENT MARIA 1200 DUE 1 sets Maria's rent)",
  "To add a repair person, share their contact card with this number.",
].join("\n");

/** One incoming text. Returns the texts to send back out. */
export type TextHints = {
  /** The trade a new repair needs, when the AI read it ("burning smell" -> HVAC). */
  trade?: string | null;
};

export function handleText(state: State, from: string, body: string, now: Date, hints: TextHints = {}): Outbound[] {
  const text = body.trim();
  const landlord = landlordOf(state, from);
  if (landlord) return fromLandlord(state, landlord, text, now);
  const vendor = vendorFrom(state, from);
  if (vendor) return fromVendor(state, vendor, text, now);
  const unit = unitFrom(state, from);
  if (unit) return fromTenant(state, unit, text, now, hints);
  return [{ to: from, body: "Sorry, this number isn't set up. Please text your landlord directly." }];
}

/* ------------------------- help from the AI ------------------------- */

export type Role = "landlord" | "tenant" | "vendor";
export type HelpRequest = { role: Role; context: string };

/**
 * Whether a text needs the AI to turn it into a fixed reply first, and what
 * it needs to know to do that. Null when the engine already understands it
 * (or the text is a free-form repair report, which needs no translating).
 */
export function needsHelp(state: State, from: string, body: string, now: Date): HelpRequest | null {
  const help = needsHelpWithout(state, from, body, now);
  const last = state.lastSent?.[digits(from)];
  return help && last ? { ...help, context: `${help.context}\nThe last text the line sent them, which their message may be answering:\n"${last}"` } : help;
}

function needsHelpWithout(state: State, from: string, body: string, now: Date): HelpRequest | null {
  const text = body.trim();
  if (landlordOf(state, from)) {
    const word = (text.split(/\s+/)[0] ?? "").toUpperCase().replace(/[^A-Z]/g, "");
    if (LANDLORD_COMMANDS.includes(word) || readContactCard(text) || state.pendingContact || state.pendingFind?.[digits(from)]) return null;
    const open = state.repairs.filter((r) => OPEN.includes(r.status));
    const found = state.lastFound !== undefined ? state.found?.[state.lastFound] : undefined;
    return {
      role: "landlord",
      context: [
        "Open repairs:",
        ...(open.length ? open.map((r) => describe(state, r)) : ["(none)"]),
        `Repair people the bot can text, by code: ${vendorList(state) || "(none)"}`,
        found
          ? `Latest search results (for repair #${state.lastFound}):\n${found.map((f, i) => `${i + 1}. ${f.name}`).join("\n")}`
          : "No search results yet.",
      ].join("\n"),
    };
  }

  const vendor = vendorFrom(state, from);
  if (vendor) {
    const ask = state.repairs.find((r) => r.vendorCode === vendor.code && r.status === "asking-vendor");
    if (!ask) return null;
    if (isRefusal(text) || parseVisitTime(text.replace(/^#\d+\s+/, ""), now)) return null;
    const unit = unitOf(state, ask);
    return {
      role: "vendor",
      context: `This repair person (${vendor.name}, ${vendor.trade}) was asked when they can fix repair #${ask.id} at ${unit.address}: "${ask.text}".`,
    };
  }

  const unit = unitFrom(state, from);
  if (unit) {
    const waiting = state.repairs.find((r) => r.unitId === unit.id && r.status === "asking-tenant");
    if (!waiting || isYes(text) || isNo(text)) return null;
    return {
      role: "tenant",
      context: `This tenant (${unit.tenant.name}) was asked whether they'll be home for a repair visit on ${formatSlot(waiting.slot!)} about "${waiting.text}". Reply 1 means yes, 2 means no.`,
    };
  }
  return null;
}

/**
 * Whether an AI's rewrite of a text is one the line can act on: a real
 * landlord command, a time it can read or a NO from a repair person, a 1 or 2
 * from a tenant. A cheap model's answer that fails this goes to the strong one.
 */
export function usableReply(role: Role, command: string, now: Date): boolean {
  const text = command.trim();
  if (role === "landlord") {
    const word = (text.split(/\s+/)[0] ?? "").toUpperCase().replace(/[^A-Z]/g, "");
    return LANDLORD_COMMANDS.includes(word);
  }
  if (role === "vendor") return isRefusal(text) || parseVisitTime(text.replace(/^#\d+\s+/, ""), now) !== null;
  return /^[12]$/.test(text);
}

/** Whether two rewrites mean the same thing: same time, same command words. */
export function sameReply(role: Role, a: string, b: string, now: Date): boolean {
  const norm = (t: string) => t.replace(/#/g, "").trim().toUpperCase().replace(/\s+/g, " ");
  if (norm(a) === norm(b)) return true;
  if (role === "vendor") {
    if (isRefusal(a) && isRefusal(b)) return true;
    const ta = parseVisitTime(a.replace(/^#\d+\s+/, ""), now);
    const tb = parseVisitTime(b.replace(/^#\d+\s+/, ""), now);
    return !!ta && !!tb && ta.getTime() === tb.getTime();
  }
  return false;
}

/* ------------------------------ tenant ------------------------------ */

function isYes(text: string) {
  return /^(1|y|yes|yeah|yep|ok|okay|sure)\b/i.test(text);
}
function isNo(text: string) {
  return /^(2|n|no|nope|cant|can't|cannot)\b/i.test(text);
}
/** A repair person's flat no. "cant tmrw, thurs ok?" is an offer, not a no. */
function isRefusal(text: string) {
  return isNo(text) && !mentionsTime(text);
}

/** Whether a tenant's text will start a new repair (not a reply, not rent). */
export function isNewRepair(state: State, from: string, body: string): boolean {
  const unit = unitFrom(state, from);
  if (!unit || landlordOf(state, from) || vendorFrom(state, from)) return false;
  const text = body.trim();
  const waiting = state.repairs.some((r) => r.unitId === unit.id && r.status === "asking-tenant");
  return !(waiting && (isYes(text) || isNo(text))) && !isRentText(text);
}

/** The trade a repair needs: what the AI or the words said, else a guess from its text. */
export function needOf(repair: Repair): string | null {
  return repair.trade ?? tradeForProblem(repair.text);
}

function fromTenant(state: State, unit: Unit, text: string, now: Date, hints: TextHints = {}): Outbound[] {
  const waiting = state.repairs.find(
    (r) => r.unitId === unit.id && r.status === "asking-tenant",
  );
  if (waiting && (isYes(text) || isNo(text))) {
    return isYes(text) ? tenantConfirms(state, waiting, now) : tenantDeclines(state, waiting);
  }
  if (isRentText(text)) return tenantRentText(state, unit, text, now);

  const repair: Repair = {
    id: state.nextId++,
    unitId: unit.id,
    text,
    status: "new",
    createdAt: now.toISOString(),
    ...(tradeForProblem(text) ?? hints.trade ? { trade: (tradeForProblem(text) ?? hints.trade)! } : {}),
  };
  state.repairs.push(repair);
  return [
    {
      to: unit.tenant.phone,
      body: `Got it, thanks ${unit.tenant.name}. I've told your landlord (repair #${repair.id}). You'll get a text when a repair person has a time.`,
    },
    ...toLandlords(
      state,
      `New repair #${repair.id} from ${unit.tenant.name}, ${unit.address}:\n"${text}"\n\n${suggest(state, repair)}`,
    ),
  ];
}

/**
 * "Send Sam (HVAC)? Reply YES" when someone fits, else how to pick or
 * search. Remembers the suggestion so a bare YES means it.
 */
/** "plumber" -> "plumbers", "HVAC" -> "HVAC companies". */
function plural(trade: string): string {
  const special: Record<string, string> = {
    HVAC: "HVAC companies",
    handyman: "handymen",
    cleaning: "cleaners",
    appliance: "appliance repair shops",
    locksmith: "locksmiths",
  };
  return special[trade] ?? `${trade}s`;
}

/** What `repair.suggested` holds when the suggestion is a web search. */
export const SUGGEST_SEARCH = "FIND";

function suggest(state: State, repair: Repair): string {
  const unit = unitOf(state, repair);
  const need = needOf(repair);
  const town = townOf(unit);
  const pick = pickVendor(state.vendors, need, town, repair.tried);
  const others = textable(state).filter((v) => v.code !== pick?.code && !repair.tried?.includes(v.code));
  if (pick) {
    repair.suggested = pick.code;
    const alt = others.length ? ` Or SEND + someone else (${others.map((v) => v.code).join(", ")}).` : "";
    return `Send ${pick.name} (${pick.trade})? Reply YES.${alt}`;
  }
  const who = others.length ? ` Or SEND + someone (${others.map((v) => v.code).join(", ")}).` : "";
  if (need) {
    // Nobody saved fits: the next step is a search, one YES away.
    repair.suggested = SUGGEST_SEARCH;
    const lead = repair.tried?.length ? `No one else saved does ${need} work.` : `No saved ${need} for this.`;
    return `${lead} Search for ${plural(need)} near ${town}? Reply YES.${who}`;
  }
  delete repair.suggested;
  return `What kind of repair person? Reply FIND + the trade (e.g. FIND ELECTRICIAN) to search near ${town}.${who}`;
}

/**
 * When a landlord's YES means "search": the FIND command it stands for
 * (e.g. "FIND plumber #3"), so the caller can run the search. Else null.
 */
export function searchFromYes(state: State, from: string, body: string): string | null {
  if (!landlordOf(state, from)) return null;
  const [word = "", idWord] = body.trim().split(/\s+/);
  if (!YES_WORDS.includes(word.toUpperCase().replace(/[^A-Z]/g, ""))) return null;
  const id = idArg(idWord);
  const repair = Number.isNaN(id)
    ? [...state.repairs].reverse().find((r) => r.status === "new" && r.suggested)
    : state.repairs.find((r) => r.id === id && r.status === "new" && r.suggested);
  if (!repair || repair.suggested !== SUGGEST_SEARCH) return null;
  delete repair.suggested;
  return `FIND ${needOf(repair)} #${repair.id}`;
}

function tenantConfirms(state: State, repair: Repair, now: Date): Outbound[] {
  const unit = unitOf(state, repair);
  const vendor = vendorOf(state, repair);
  repair.status = "confirmed";
  const when = formatSlot(repair.slot!);
  // Already inside the reminder window: this confirmation is the reminder,
  // so no second text seconds later.
  repair.reminded = new Date(repair.slot!).getTime() - now.getTime() <= 24 * HOUR;
  const out: Outbound[] = [
    {
      to: unit.tenant.phone,
      body: `Great, you're confirmed for ${when}.${repair.reminded ? "" : " I'll remind you the day before."}`,
    },
    ...toLandlords(state, `Confirmed #${repair.id}: ${vendor?.name ?? "repair person"} at ${unit.address}, ${when}.`),
  ];
  if (vendor && vendor.textable !== false) {
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
  delete repair.slot;

  // Booked by phone: the landlord has to call them back.
  if (vendor && vendor.textable === false) {
    repair.status = "new";
    return [
      { to: unit.tenant.phone, body: "No problem. Your landlord will find another time." },
      ...toLandlords(
        state,
        `${unit.tenant.name} can't do ${when} for #${repair.id}. Call ${vendor.name} at ${vendor.phone} for another time, then text BOOKED ${vendor.code} + the new day and time.`,
      ),
    ];
  }

  repair.status = "asking-vendor";
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

/** Offer a time to the tenant. Shared by a texted reply and a phone booking. */
function offerToTenant(state: State, repair: Repair, vendor: Vendor, slot: Date): Outbound[] {
  const unit = unitOf(state, repair);
  repair.vendorCode = vendor.code;
  repair.slot = slot.toISOString();
  repair.status = "asking-tenant";
  repair.reminded = false;
  repair.checkedBack = false;
  return [
    {
      to: unit.tenant.phone,
      body: `${vendor.name} (${vendor.trade}) can come ${formatSlot(repair.slot)} about: "${repair.text}". Reply 1 if you'll be home, 2 if not.`,
    },
  ];
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

  if (isRefusal(text)) {
    repair.status = "new";
    delete repair.vendorCode;
    repair.tried = [...(repair.tried ?? []), vendor.code];
    return [
      { to: vendor.phone, body: "No problem, thanks for letting us know." },
      ...toLandlords(state, `${vendor.name} can't do #${repair.id} (${unit.address}). ${suggest(state, repair)}`),
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

  const when = formatSlot(slot.toISOString());
  return [
    { to: vendor.phone, body: `Thanks! Checking ${when} with the tenant. I'll text you when it's confirmed.` },
    ...offerToTenant(state, repair, vendor, slot),
    ...toLandlords(state, `${vendor.name} offered ${when} for #${repair.id}. Checking with ${unit.tenant.name}.`),
  ];
}

/* ----------------------------- landlord ----------------------------- */

const idArg = (s: string | undefined) => (s && /^#?\d+$/.test(s) ? Number(s.replace(/^#/, "")) : NaN);

/** The repair a command means: the one named, else the newest still unbooked. */
function pickRepair(state: State, id: number): Repair | undefined {
  if (!Number.isNaN(id)) return state.repairs.find((r) => r.id === id && OPEN.includes(r.status));
  return [...state.repairs].reverse().find((r) => r.status === "new" || r.status === "asking-vendor");
}

function sendTo(state: State, vendor: Vendor, repair: Repair): Outbound[] {
  const unit = unitOf(state, repair);
  repair.vendorCode = vendor.code;
  repair.status = "asking-vendor";
  delete repair.slot;
  delete repair.suggested;
  repair.reminded = false;
  return [
    {
      to: vendor.phone,
      body: `Hi ${vendor.name}, this is the repair line for ${state.landlords[0]?.name ?? "your landlord"}. Job at ${unit.address}: "${repair.text}". When can you go? Reply with a day and time like TUE 9AM, or NO if you can't.`,
    },
    ...toLandlords(state, `Asked ${vendor.name} about #${repair.id}. I'll text you when they reply.`),
  ];
}

function fromLandlord(state: State, landlord: Person, text: string, now: Date): Outbound[] {
  const reply = (body: string): Outbound[] => [{ to: landlord.phone, body }];
  const [word = "", ...rest] = text.split(/\s+/);
  const command = word.toUpperCase().replace(/[^A-Z]/g, "");

  const card = readContactCard(text);
  if (card) return saveContact(state, landlord, card.name, card.phone);
  if (/^BEGIN:VCARD/i.test(text)) return reply("I couldn't read a name and number on that contact. Try sharing it again.");

  if (state.pendingContact && !LANDLORD_COMMANDS.includes(command)) {
    const { name, phone } = state.pendingContact;
    delete state.pendingContact;
    const towns = state.units.map(townOf);
    const said = readContactName(text, towns);
    const trade = said.trade ?? text.split(/\s+/)[0]?.toLowerCase();
    return saveContact(state, landlord, name, phone, trade, said.town ?? "all");
  }

  if (command === "PAID") return landlordPaid(state, landlord, rest, now);
  if (command === "RENT") return rest.length ? setRent(state, landlord, rest) : reply(rentStatus(state, now));

  if (YES_WORDS.includes(command) || NO_WORDS.includes(command)) {
    const id = idArg(rest[0]);
    const repair = Number.isNaN(id)
      ? [...state.repairs].reverse().find((r) => r.status === "new" && r.suggested)
      : state.repairs.find((r) => r.id === id && r.status === "new" && r.suggested);
    if (!repair) return reply("There's nothing waiting on a yes or no. Reply LIST to see open repairs.");
    if (NO_WORDS.includes(command)) {
      const declined = repair.suggested;
      delete repair.suggested;
      const unit = unitOf(state, repair);
      if (declined === SUGGEST_SEARCH) {
        return reply(`OK, no search. Reply SEND + who to ask (${vendorList(state)}), or FIND + another trade.`);
      }
      // Skip the person they turned down, and offer the next step as a YES:
      // the next saved person who fits, or a search.
      repair.tried = [...(repair.tried ?? []), declined!];
      return reply(`OK, not ${state.vendors.find((v) => v.code === declined)?.name ?? "them"}. ${suggest(state, repair)}`);
    }
    const vendor = state.vendors.find((v) => v.code === repair.suggested);
    if (!vendor) return reply(`Who should I ask? Reply SEND + one of: ${vendorList(state)}`);
    return sendTo(state, vendor, repair);
  }

  if (command === "SEND") {
    const code = (rest[0] ?? "").toUpperCase();
    const vendor = textable(state).find((v) => v.code === code);
    if (!vendor) return reply(`Who should I ask? Reply SEND + one of: ${vendorList(state)}`);
    const id = idArg(rest[1]);
    const repair = Number.isNaN(id)
      ? [...state.repairs].reverse().find((r) => r.status === "new")
      : state.repairs.find((r) => r.id === id && OPEN.includes(r.status));
    if (!repair) return reply(Number.isNaN(id) ? "No new repairs waiting. Reply LIST to see open ones." : `There's no open repair #${id}.`);
    return sendTo(state, vendor, repair);
  }

  if (command === "BOOKED") return booked(state, landlord, rest.join(" "), now);

  if (command === "FIND") {
    // The caller runs the search; reaching here means nobody did.
    const plan = planFind(state, text);
    return reply("reply" in plan ? plan.reply : "Search isn't available right now. Try again in a minute.");
  }

  if (command === "LIST" || command === "STATUS") {
    const open = state.repairs.filter((r) => OPEN.includes(r.status));
    if (open.length === 0) return reply("No open repairs.");
    return reply(open.map((r) => describe(state, r)).join("\n"));
  }

  // "CANCEL" alone is a carrier opt-out word, so DROP is the safer name.
  if (command === "DROP") return fromLandlord(state, landlord, `CANCEL ${rest.join(" ")}`, now);
  if (command === "DONE" || command === "CANCEL") {
    const id = idArg(rest[0]);
    const repair = state.repairs.find((r) => r.id === id && OPEN.includes(r.status));
    if (!repair) return reply(`Which one? Reply ${command} + the repair number, e.g. ${command} 3.`);
    repair.status = command === "DONE" ? "done" : "cancelled";
    return toLandlords(state, `#${repair.id} marked ${repair.status}.`);
  }

  return reply(HELP);
}

/* --------------------------- contacts --------------------------- */

/**
 * A repair person shared as a contact card. Mom saves them as
 * "John handyman Hamden", so the name usually carries the trade and town;
 * when it doesn't, the bot asks once.
 */
function saveContact(
  state: State,
  landlord: Person,
  fullName: string,
  phone: string,
  trade?: string,
  town?: string,
): Outbound[] {
  const reply = (body: string): Outbound[] => [{ to: landlord.phone, body }];
  if (state.landlords.some((l) => same(l.phone, phone)) || state.units.some((u) => same(u.tenant.phone, phone))) {
    return reply(`${fullName} is already a landlord or tenant here, so I didn't add them as a repair person.`);
  }
  const said = readContactName(fullName, state.units.map(townOf));
  const finalTrade = trade ?? said.trade;
  if (!finalTrade) {
    state.pendingContact = { name: said.name, phone };
    return reply(`Got ${said.name}'s number. What do they do, and where? Reply like: PLUMBER HAMDEN, or HANDYMAN ALL.`);
  }
  const label = tradeLabel(finalTrade) ?? finalTrade;
  const where = town ?? said.town ?? "all";
  const existing = state.vendors.find((v) => same(v.phone, phone));
  if (existing) {
    Object.assign(existing, { name: said.name, trade: label, town: where, textable: true });
    return reply(`Updated ${existing.name}: ${label}, ${where === "all" ? "all towns" : where} (code ${existing.code}).`);
  }
  const vendor: Vendor = { code: codeFor(state, said.name), name: said.name, trade: label, town: where, phone };
  state.vendors.push(vendor);
  return reply(
    `Saved ${vendor.name}: ${label}, ${where === "all" ? "all towns" : where} (code ${vendor.code}). I'll suggest them for ${label} jobs. Share another contact, or you're all set.`,
  );
}

/* ------------------------- find and booked ------------------------- */

export type FindPlan = { repairId: number; trade: string; town: string; problem: string };

/**
 * Reads "FIND HVAC", "FIND plumber 3" or "FIND #3 plumber" into what to
 * search for. The search itself is outside the engine (it's slow and costs
 * money); its results come back through `showFound`.
 */
export function planFind(state: State, text: string, from?: string): FindPlan | { reply: string } {
  const words = text.trim().split(/\s+/).slice(1);
  const idWord = words.find((w) => /^#?\d+$/.test(w));
  const repair = pickRepair(state, idArg(idWord));
  if (!repair) return { reply: "Which repair? Reply LIST, then FIND + a trade + the repair number, e.g. FIND HVAC 3." };
  // What they said, else who was asked before, else what the problem needs
  // ("sink leaking" is a plumber): only ask when none of those says.
  const trade =
    words.filter((w) => w !== idWord).join(" ") || vendorOf(state, repair)?.trade || needOf(repair) || "";
  if (!trade) {
    // Remember the question, so a bare "plumber" next is read as the answer.
    if (from) state.pendingFind = { ...state.pendingFind, [digits(from)]: repair.id };
    return { reply: `What kind of repair person for #${repair.id} ("${repair.text}")? Reply like PLUMBER, HVAC or ELECTRICIAN.` };
  }
  const unit = unitOf(state, repair);
  return { repairId: repair.id, trade, town: townOf(unit), problem: repair.text };
}

/** Shows search results as a numbered list to call. Keeps them for BOOKED. */
export function showFound(state: State, plan: FindPlan, results: Found[], sample = false): Outbound[] {
  if (results.length === 0) {
    return toLandlords(state, `I couldn't find any ${plan.trade} near ${plan.town}. Try FIND with a different trade or a bigger town nearby.`);
  }
  state.found = { ...state.found, [plan.repairId]: results.map((f) => ({ ...f, trade: plan.trade })) };
  state.lastFound = plan.repairId;
  const lines = results.map((f, i) => {
    const stars = f.rating ? ` ${f.rating}★${f.reviews ? ` (${f.reviews} reviews)` : ""}` : "";
    return `${i + 1}. ${f.name}${stars}${f.note ? `, ${f.note}` : ""}\n   ${f.phone}`;
  });
  return toLandlords(
    state,
    [
      `${sample ? "SAMPLE RESULTS (search is off). " : ""}${plan.trade.toUpperCase()} near ${plan.town} for #${plan.repairId}:`,
      ...lines,
      "",
      `Call them. When one agrees to a time, text BOOKED + the number + the time, e.g. BOOKED 1 TOMORROW 8AM. Numbers come from the web, so double-check before you rely on one.`,
    ].join("\n"),
  );
}

function codeFor(state: State, name: string): string {
  const base = (name.match(/[A-Za-z0-9]+/)?.[0] ?? "PRO").toUpperCase();
  let code = base;
  for (let n = 2; state.vendors.some((v) => v.code === code); n++) code = `${base}${n}`;
  return code;
}

/**
 * "BOOKED 1 TOMORROW 8AM": the landlord called result 1 from the latest
 * search and agreed a time. "BOOKED JOHN TUE 9AM" works for any saved
 * repair person booked by phone. An optional "#3" names the repair.
 */
function booked(state: State, landlord: Person, args: string, now: Date): Outbound[] {
  const reply = (body: string): Outbound[] => [{ to: landlord.phone, body }];
  const usage = "Reply like BOOKED 1 TOMORROW 8AM (result 1 from your last search) or BOOKED JOHN TUE 9AM.";
  const idMatch = args.match(/(?:^|\s)#(\d+)\b/);
  const rest = args.replace(/(?:^|\s)#\d+\b/, " ").trim();
  const [who = "", ...timeWords] = rest.split(/\s+/);

  let vendor: Vendor | undefined;
  let repair: Repair | undefined;
  if (/^\d+$/.test(who)) {
    const forRepair = idMatch ? Number(idMatch[1]) : state.lastFound;
    const results = forRepair !== undefined ? state.found?.[forRepair] : undefined;
    const pick = results?.[Number(who) - 1];
    if (!pick || forRepair === undefined) return reply(`There's no result ${who} to book. ${usage}`);
    repair = state.repairs.find((r) => r.id === forRepair && OPEN.includes(r.status));
    vendor = state.vendors.find((v) => same(v.phone, pick.phone));
    if (!vendor && repair) {
      vendor = {
        code: codeFor(state, pick.name),
        name: pick.name,
        trade: pick.trade ?? "repair",
        town: townOf(unitOf(state, repair)),
        phone: pick.phone,
        textable: false,
      };
      state.vendors.push(vendor);
    }
  } else {
    vendor = state.vendors.find((v) => v.code === who.toUpperCase());
    if (!vendor) return reply(`I don't know ${who || "who that is"}. ${usage}`);
    repair = pickRepair(state, idMatch ? Number(idMatch[1]) : NaN);
  }
  if (!repair) return reply("Which repair? Add its number, e.g. BOOKED 1 TOMORROW 8AM #3.");
  if (!vendor) return reply(usage);

  const slot = parseVisitTime(timeWords.join(" "), now);
  if (!slot) return reply(`What time did you book? ${usage}`);

  const unit = unitOf(state, repair);
  return [
    ...offerToTenant(state, repair, vendor, slot),
    ...toLandlords(
      state,
      `Booked ${vendor.name} for #${repair.id}, ${formatSlot(slot.toISOString())}. Checking with ${unit.tenant.name}. (Saved as ${vendor.code}; I won't text them.)`,
    ),
  ];
}

function describe(state: State, r: Repair): string {
  const unit = unitOf(state, r);
  const who = vendorOf(state, r)?.name;
  const where = `#${r.id} ${unit.address}: "${r.text}"`;
  switch (r.status) {
    case "new":
      return r.suggested
        ? `${where} - suggested ${state.vendors.find((v) => v.code === r.suggested)?.name}, waiting on your YES`
        : `${where} - nobody booked yet`;
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

/**
 * Call as the clock moves. Sends the day-before reminders, asks the
 * landlord whether it got fixed a few hours after the visit, and sends
 * the rent reminders (rent.ts).
 */
export function tick(state: State, now: Date): Outbound[] {
  const out: Outbound[] = [];
  // Automatic texts wait for daytime; everything here is retried each tick.
  if (isQuietHour(now)) return out;
  for (const r of state.repairs) {
    if (r.status !== "confirmed" || !r.slot) continue;
    const at = new Date(r.slot).getTime();
    const unit = unitOf(state, r);
    const vendor = vendorOf(state, r);
    const when = formatSlot(r.slot);

    if (!r.reminded && at - now.getTime() <= 24 * HOUR && at > now.getTime()) {
      r.reminded = true;
      out.push({ to: unit.tenant.phone, body: `Reminder: ${vendor?.name ?? "the repair person"} is coming ${when}.` });
      if (vendor && vendor.textable !== false) {
        out.push({ to: vendor.phone, body: `Reminder: ${when} at ${unit.address}.` });
      }
    }
    if (!r.checkedBack && now.getTime() - at >= 4 * HOUR) {
      r.checkedBack = true;
      out.push(...toLandlords(state, `Did ${vendor?.name ?? "the repair person"} fix #${r.id} at ${unit.address}? Reply DONE ${r.id} if so.`));
    }
  }
  out.push(...tickRent(state, now));
  return out;
}
