import { digits } from "./engine.js";
import type { Outbound, State } from "./types.js";

/**
 * Landlords, tenants and repair people don't always share a language. Each
 * person can have one (`lang`); the line reads what they send in English and
 * texts them back in theirs, so nobody has to translate by hand.
 *
 * The engine only ever sees English: a text comes in, is translated to
 * English, the engine answers, and each answer is translated for whoever it
 * goes to. Names, addresses, times, amounts and commands are kept as is.
 */

/** The AI's two jobs here; null when there's no AI (then nothing is translated). */
export type Translator = {
  /** Into English, saying which language it was in ("Spanish"; "English" if it already was). */
  toEnglish: (text: string) => Promise<{ language: string; english: string } | null>;
  /** From English into `language`. */
  fromEnglish: (text: string, language: string) => Promise<string | null>;
};

const isEnglish = (lang: string | undefined) => !lang || /^english$/i.test(lang.trim());
const title = (lang: string) => lang.trim().replace(/\b\w/g, (c) => c.toUpperCase());

type Someone = { name: string; lang?: string };

function personFor(state: State, phone: string): Someone | undefined {
  const d = digits(phone);
  return (
    state.landlords.find((l) => digits(l.phone) === d) ??
    state.units.find((u) => digits(u.tenant.phone) === d)?.tenant ??
    state.vendors.find((v) => digits(v.phone) === d)
  );
}

export function languageOf(state: State, phone: string): string | undefined {
  const lang = personFor(state, phone)?.lang;
  return isEnglish(lang) ? undefined : lang;
}

/**
 * Text that might not be English: accented or non-Latin letters, or common
 * Spanish words written without accents ("no hay agua"). Only these are sent
 * to the AI to check, so plain English texts cost nothing extra.
 */
export function looksForeign(text: string): boolean {
  return (
    /[À-ɏͰ-ԯ֐-ۿऀ-෿฀-໿ᄀ-ᇿ぀-ヿ㐀-鿿가-힯]/.test(text) ||
    /\b(hola|agua|no hay|gracias|por favor|manana|bano|luz|calefaccion|puerta|cuando|necesito|tengo|esta rota|renta|pague|ya pague)\b/i.test(text)
  );
}

/**
 * "Maria speaks Spanish", "language Maria Spanish", "John speaks English":
 * a landlord setting someone's language. The reply, or null if it isn't that.
 */
export function languageFromWords(state: State, from: string, text: string): string | null {
  if (!state.landlords.some((l) => digits(l.phone) === digits(from))) return null;
  const m = text.trim().match(/^(?:language\s+(\S+)\s+([a-z]+)|(\S+?)(?:'s language is|\s+speaks)\s+([a-z]+))[.!]?$/i);
  if (!m) return null;
  const who = (m[1] ?? m[3])!.toLowerCase();
  const lang = title((m[2] ?? m[4])!);
  const people: Someone[] = [...state.landlords, ...state.units.map((u) => u.tenant), ...state.vendors];
  const person = people.find((p) => p.name.toLowerCase() === who || p.name.toLowerCase().split(/\s+/)[0] === who) ??
    state.vendors.find((v) => v.code.toLowerCase() === who);
  if (!person) return `I don't know a ${m[1] ?? m[3]}. Use the name I have, like: ${state.units[0]?.tenant.name ?? "Maria"} speaks Spanish`;
  const first = person.name.split(/\s+/)[0];
  if (isEnglish(lang)) {
    delete person.lang;
    return `Got it: ${first} gets texts in English again.`;
  }
  person.lang = lang;
  return `Got it: I'll text ${first} in ${lang} and translate their texts for you.`;
}

/**
 * An incoming text, in English for the engine. A person with no language set
 * who writes in another one gets it set, and the landlords are told.
 */
export async function translateIn(
  state: State,
  from: string,
  body: string,
  t: Translator | null | undefined,
): Promise<{ english: string; original?: string; language?: string; notices: Outbound[] }> {
  const person = personFor(state, from);
  const set = languageOf(state, from);
  if (!t || !person || !body.trim() || (!set && !looksForeign(body))) return { english: body, notices: [] };
  let read: { language: string; english: string } | null = null;
  try {
    read = await t.toEnglish(body);
  } catch (error) {
    console.error("translate failed:", error);
  }
  if (!read || isEnglish(read.language)) return { english: body, notices: [] };
  const notices: Outbound[] = [];
  const isLandlord = state.landlords.includes(person as State["landlords"][number]);
  if (!set) {
    person.lang = title(read.language);
    if (!isLandlord) {
      const first = person.name.split(/\s+/)[0];
      notices.push(
        ...state.landlords.map((l) => ({
          to: l.phone,
          body: `${first} wrote in ${person.lang}, so I'll translate between you from now on. (To stop: ${first} speaks English)`,
        })),
      );
    }
  }
  return { english: read.english, original: body, language: person.lang ?? read.language, notices };
}

/**
 * Texts on their way out, each in its reader's language. When a landlord's
 * text quotes words that were translated, the original goes along too, so
 * nobody has to trust the translation blind.
 */
export async function translateOut(
  state: State,
  out: Outbound[],
  t: Translator | null | undefined,
  quoted?: { english: string; original: string; language: string; who: string },
): Promise<Outbound[]> {
  const ready: Outbound[] = [];
  for (const o of out) {
    const lang = languageOf(state, o.to);
    let body = o.body;
    if (lang && t) {
      try {
        body = (await t.fromEnglish(o.body, lang)) ?? o.body;
      } catch (error) {
        console.error("translate failed:", error);
      }
    } else if (quoted && o.body.includes(`"${quoted.english}"`)) {
      body = `${o.body}\n\n(${quoted.who} wrote in ${quoted.language}: "${quoted.original}")`;
    }
    ready.push(body === o.body ? o : { ...o, body });
  }
  return ready;
}
