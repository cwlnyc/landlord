import type { Vendor } from "./types.js";

/**
 * Who should fix what, from plain words. Pure keyword matching: it's fast,
 * free and testable, and the landlord always confirms ("Send Sam? YES")
 * before anyone is texted, so a wrong guess costs one reply.
 */

type Trade = { label: string; aliases: string[]; problems?: RegExp };

// Order matters: the first trade whose problem words match wins.
const TRADES: Trade[] = [
  // Before HVAC, so "water heater" isn't read as "heater".
  { label: "plumber", aliases: ["plumber", "plumbing"], problems: /\b(water heater|hot water|leak\w*|sink|toilet|drain\w*|clog\w*|pipes?|faucet|shower|tub|sewer|backed up)\b/ },
  { label: "HVAC", aliases: ["hvac", "heating", "furnace", "boiler", "ac", "cooling"], problems: /\b(heat|heater|heating|furnace|boiler|radiators?|thermostat|a\/?c|air ?condition\w*|cold)\b/ },
  { label: "electrician", aliases: ["electrician", "electric", "electrical"], problems: /\b(outlets?|power|breakers?|spark\w*|electric\w*|switch\w*|wiring|lights?)\b/ },
  { label: "roofer", aliases: ["roofer", "roofing", "roof"], problems: /\b(roof\w*|gutters?|shingles?)\b/ },
  { label: "appliance", aliases: ["appliance", "appliances"], problems: /\b(fridge|refrigerator|washer|dryer|stove|oven|dishwasher|microwave)\b/ },
  { label: "locksmith", aliases: ["locksmith"], problems: /\b(locked out|locks?|keys?)\b/ },
  { label: "cleaning", aliases: ["cleaning", "cleaner", "cleaners", "cleaner's"] },
  { label: "handyman", aliases: ["handyman", "handy", "maintenance"] },
];

/** "HVAC guy" -> "HVAC", "Plumbing" -> "plumber"; null if no trade word. */
export function tradeLabel(text: string): string | null {
  const words = text.toLowerCase().split(/[^a-z']+/);
  for (const t of TRADES) if (words.some((w) => t.aliases.includes(w))) return t.label;
  return null;
}

/** The trade a tenant's problem needs: "heat not working" -> "HVAC". */
export function tradeForProblem(problem: string): string | null {
  const text = problem.toLowerCase();
  for (const t of TRADES) if (t.problems?.test(text)) return t.label;
  return null;
}

function servesTown(v: Vendor, town: string): boolean {
  const theirs = v.town.toLowerCase();
  return theirs === town.toLowerCase() || /\ball\b|\bany/.test(theirs);
}

/**
 * The best repair person to suggest, or undefined to suggest a search.
 * Trade must fit: a handyman is only offered for jobs that need no
 * specialist (a sticking door, not a dead furnace). Then their town.
 */
export function pickVendor(
  vendors: Vendor[],
  problem: string,
  town: string,
  skip: string[] = [],
): Vendor | undefined {
  const need = tradeForProblem(problem);
  const pool = vendors.filter((v) => !skip.includes(v.code) && v.textable !== false);
  const fits = (v: Vendor) => {
    const theirs = tradeLabel(v.trade) ?? v.trade.toLowerCase();
    return need ? theirs === need : theirs === "handyman";
  };
  const candidates = pool.filter(fits);
  return candidates.find((v) => servesTown(v, town)) ?? candidates[0];
}

/* --------------------------- contact cards --------------------------- */

/**
 * A shared contact as it arrives by text: a vCard. Reads the name and the
 * best phone number (mobile first, since the bot will text it).
 */
export function readContactCard(text: string): { name: string; phone: string } | null {
  if (!/^BEGIN:VCARD/i.test(text.trim())) return null;
  const lines = text.split(/\r?\n/);
  const field = (key: string) => lines.find((l) => l.toUpperCase().startsWith(key));
  const fn = field("FN")?.split(":").slice(1).join(":").trim();
  const n = field("N:")?.slice(2).split(";").filter(Boolean).reverse().join(" ").trim();
  const tels = lines.filter((l) => /^TEL/i.test(l));
  const tel = tels.find((l) => /CELL|MOBILE|IPHONE/i.test(l)) ?? tels[0];
  const phone = tel?.split(":").slice(1).join(":").trim();
  const name = fn || n;
  return name && phone ? { name, phone } : null;
}

/**
 * Splits a contact name saved Mom's way, "John handyman Hamden", into the
 * person, their trade and their town. Missing parts come back undefined.
 */
export function readContactName(
  full: string,
  towns: string[],
): { name: string; trade?: string; town?: string } {
  const lower = full.toLowerCase();
  const town = towns.find((t) => new RegExp(`\\b${t.toLowerCase()}\\b`).test(lower));
  const trade = tradeLabel(full) ?? undefined;
  const tradeWords = TRADES.flatMap((t) => t.aliases);
  const name = full
    .split(/\s+/)
    .filter((w) => !tradeWords.includes(w.toLowerCase().replace(/[^a-z']/g, "")))
    .filter((w) => !town || !town.toLowerCase().split(/\s+/).includes(w.toLowerCase()))
    .filter((w) => !/^(guy|lady|man|the|in|for)$/i.test(w))
    .join(" ")
    .trim();
  return { name: name || full, trade, town };
}
