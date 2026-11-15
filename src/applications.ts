import { digits } from "./engine.js";
import type { Outbound, Person, State } from "./types.js";

/**
 * Rental applications by text. The landlord opens a listing; people who want
 * the place text the line and answer the same questions, one at a time; the
 * landlord gets each set of answers exactly as written.
 *
 * Deliberately NOT here: ranking, scoring, or any judgment of applicants, and
 * any question about something fair-housing law protects (age, children,
 * marital status, religion, national origin, disability, or how income is
 * paid: a housing voucher counts as income). The landlord decides, by the
 * same standards for everyone. Have a lawyer read these questions before
 * real applicants answer them.
 *
 * The line never texts an applicant first: every text to one is a reply.
 */

export const QUESTIONS = [
  "What's your full name?",
  "When would you like to move in?",
  "How many people in total would live there?",
  "Any pets? If so, what kind?",
  "What's your total monthly household income? Count every source, like a job, benefits or a housing voucher.",
  "The name and phone number of a current or past landlord we can contact? (Reply none if you don't have one.)",
  "Best email to reach you?",
  "Anything else you'd like the landlord to know? (Reply none if not.)",
];
/** Short labels for the landlord's summary, in the same order as QUESTIONS. */
const LABELS = ["Name", "Move in", "People", "Pets", "Monthly income", "Landlord reference", "Email", "Note"];

const MAX_ANSWER = 300;
const INTERESTED = /\b(apply|application|apartment|apt|unit|available|listing|for rent|rent it|interested|vacan\w*|showing|lease)\b/i;

const landlordName = (state: State) => state.landlords[0]?.name ?? "the landlord";
const toLandlords = (state: State, body: string): Outbound[] => state.landlords.map((l) => ({ to: l.phone, body }));
const open = (state: State) => (state.listings ?? []).filter((l) => l.open);

export function applicationOf(state: State, from: string) {
  return (state.applications ?? []).find((a) => digits(a.phone) === digits(from));
}

/** Whether the line may text this number back: it applied (and the live line may answer it). */
export function isApplicant(state: State, phone: string): boolean {
  return !!applicationOf(state, phone);
}

/**
 * A text from a number that isn't a landlord, tenant or repair person. Starts
 * or continues an application when a listing is open; null otherwise.
 */
export function fromStranger(state: State, from: string, raw: string, now: Date): Outbound[] | null {
  const text = raw.trim().slice(0, MAX_ANSWER);
  const reply = (body: string): Outbound[] => [{ to: from, body }];
  const app = applicationOf(state, from);

  if (app) {
    const listing = (state.listings ?? []).find((l) => l.id === app.listingId);
    if (app.listingId === 0) {
      // They were asked which place.
      const choice = open(state)[Number(text.match(/\d+/)?.[0] ?? NaN) - 1];
      if (!choice) return reply(`Which place? ${placeList(state)} (reply with the number)`);
      app.listingId = choice.id;
      return reply(`${intro(state, choice.place)}\n\n${ask(0)}`);
    }
    if (app.step < QUESTIONS.length) {
      if (!text) return reply(ask(app.step));
      app.answers[app.step] = text;
      app.step++;
      if (app.step < QUESTIONS.length) return reply(ask(app.step));
      app.doneAt = now.toISOString();
      const name = app.answers[0]!.split(/\s+/)[0];
      return [
        { to: from, body: `Thanks, ${name}! I've sent your answers to ${landlordName(state)}. They'll reach out to you directly.` },
        ...toLandlords(
          state,
          `New application for ${listing?.place ?? "your listing"}:\n${summary(app)}\n\nEvery applicant gets the same questions; these are their answers as written. Text APPLICANTS to see everyone.`,
        ),
      ];
    }
    // Done already: pass anything else straight to the landlord.
    return [
      { to: from, body: `Thanks! I've passed that to ${landlordName(state)}.` },
      ...toLandlords(state, `${app.answers[0]} (applicant, ${listing?.place ?? "your listing"}, ${app.phone}) says: "${text}"`),
    ];
  }

  const listings = open(state);
  if (!listings.length) return null;
  if (!INTERESTED.test(text)) {
    return reply("Sorry, this number isn't set up. Please text your landlord directly. If you're asking about a place for rent, reply APPLY.");
  }
  const one = listings.length === 1 ? listings[0]! : undefined;
  state.applications = [
    ...(state.applications ?? []),
    { phone: from, listingId: one?.id ?? 0, answers: [], step: 0, at: now.toISOString() },
  ];
  return one ? reply(`${intro(state, one.place)}\n\n${ask(0)}`) : reply(`Hi! Which place are you asking about? ${placeList(state)} (reply with the number)`);
}

function intro(state: State, place: string): string {
  return `Hi! Thanks for your interest in ${place}. I'll ask ${QUESTIONS.length} quick questions for ${landlordName(state)}; everyone who applies gets the same ones. Reply STOP anytime to stop.`;
}

function ask(step: number): string {
  return `(${step + 1}/${QUESTIONS.length}) ${QUESTIONS[step]}`;
}

function placeList(state: State): string {
  return open(state).map((l, i) => `${i + 1}. ${l.place}`).join("  ");
}

function summary(app: NonNullable<State["applications"]>[number]): string {
  return [...LABELS.map((label, i) => `${label}: ${app.answers[i] ?? "(not answered)"}`), `Phone: ${app.phone}`].join("\n");
}

/**
 * The landlord's listing commands: LISTING <place> opens one, CLOSE LISTING 2
 * closes it, APPLICANTS shows everyone's answers in the order they came in.
 * Null when the text is none of these.
 */
export function listingCommand(state: State, landlord: Person, text: string, now: Date): Outbound[] | null {
  const reply = (body: string): Outbound[] => [{ to: landlord.phone, body }];
  const t = text.trim();

  const close = t.match(/^(?:close\s+listing|listing\s+close|close)\s*#?(\d+)?$/i);
  if (close && (/listing/i.test(t) || close[1])) {
    const listings = open(state);
    const target = close[1] ? listings.find((l) => l.id === Number(close[1])) : listings.length === 1 ? listings[0] : undefined;
    if (!target) return reply(listings.length ? `Which one? ${listings.map((l) => `CLOSE LISTING ${l.id} = ${l.place}`).join("; ")}` : "No listings are open.");
    target.open = false;
    return reply(`Closed listing ${target.id} (${target.place}). New texts about it won't start applications. The answers you have are kept.`);
  }

  const opening = t.match(/^listing\s+(.{3,})$/i);
  if (opening) {
    const place = opening[1]!.trim();
    const id = (state.listings ?? []).reduce((max, l) => Math.max(max, l.id), 0) + 1;
    state.listings = [...(state.listings ?? []), { id, place, open: true, openedAt: now.toISOString() }];
    return reply(
      `Applications are open for ${place} (listing ${id}). Put this in your ad: "Text APPLY to" and this number. ` +
        `Everyone gets the same ${QUESTIONS.length} questions and I send you their answers as written, without ranking anyone. ` +
        `Text APPLICANTS to see them, CLOSE LISTING ${id} once it's rented.`,
    );
  }

  if (/^applicants?$/i.test(t)) {
    const done = (state.applications ?? []).filter((a) => a.doneAt);
    if (!done.length) return reply(open(state).length ? "No finished applications yet." : "No listings are open. Text LISTING and the address to open one.");
    const blocks = (state.listings ?? [])
      .map((l) => {
        const apps = done.filter((a) => a.listingId === l.id);
        if (!apps.length) return null;
        return [`${l.place}${l.open ? "" : " (closed)"}, ${apps.length} applicant${apps.length > 1 ? "s" : ""}, in the order received:`, ...apps.map((a, i) => `\n#${i + 1}\n${summary(a)}`)].join("\n");
      })
      .filter(Boolean);
    return reply(`${blocks.join("\n\n")}\n\nSame questions for everyone; answers as written. Not ranked.`);
  }
  return null;
}
