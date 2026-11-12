import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { FindPlan, HelpRequest } from "./engine.js";
import { TRADE_LABELS } from "./match.js";
import { ModelRouter, costOf } from "./router.js";
import type { Found } from "./types.js";

/**
 * The two slow, paid things the engine can't do itself:
 *
 * - understand: turn a messy text ("cant tmrw, thurs after 2 ok?") into the
 *   fixed reply the engine reads ("11/12 2:00pm"). Returns null when it
 *   can't tell; the engine then asks the sender to reply in a set format.
 * - find: search the web for repair people near a rental, for the landlord
 *   to call. The bot never texts what it finds.
 *
 * Both use the Claude API when ANTHROPIC_API_KEY is set (in .env.local),
 * cheapest model first (router.ts): Haiku reads texts and picks trades, and
 * Opus answers when Haiku isn't sure or its answer doesn't check out;
 * Sonnet runs web searches. Each call's cost is logged with a running total.
 * Without it, understand is off and find returns clearly labelled samples,
 * so the simulator still runs end to end.
 */

export type Understand = (
  req: HelpRequest & {
    text: string;
    now: Date;
    /** Whether an answer is one the line can act on; a cheap answer that isn't goes to the strong model. */
    valid?: (command: string) => boolean;
    /** Whether two answers mean the same ("11/12 2pm" and "11/12 2:00pm"), for spot checks. */
    same?: (a: string, b: string) => boolean;
  },
) => Promise<string | null>;
export type Finder = (plan: FindPlan) => Promise<Found[]>;
/** Which trade a repair needs, when the keywords can't tell. */
export type TradeReader = (problem: string) => Promise<string | null>;
export type Ai = { understand: Understand | null; find: Finder; live: boolean; trade?: TradeReader | null };

// Each job tries the cheap model first and keeps its answer only when it's
// sure and the answer checks out; otherwise the strong model answers (see
// router.ts). REPAIR_MODEL puts every job on one model instead.
const ONE_MODEL = process.env.REPAIR_MODEL?.trim();
const CHEAP = ONE_MODEL || process.env.AI_CHEAP_MODEL?.trim() || "claude-haiku-5-5";
const STRONG = ONE_MODEL || process.env.AI_STRONG_MODEL?.trim() || "claude-opus-5-5";
// Web search with filtering needs Sonnet or Opus; Sonnet is the cheaper one.
const SEARCH = ONE_MODEL || process.env.AI_SEARCH_MODEL?.trim() || "claude-sonnet-5-5";
// Retry on another model if this one declines; routing is Anthropic's default.
const FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default" as const,
};

export function makeAi(apiKey = process.env.ANTHROPIC_API_KEY, log: (line: string) => void = console.log): Ai {
  if (!apiKey) return { understand: null, find: sampleFind, live: false };
  const client = new Anthropic({ apiKey });
  const router = new ModelRouter({ log });
  return {
    understand: claudeUnderstand(client, router),
    find: claudeFind(client, router, log),
    trade: claudeTrade(client, router),
    live: true,
  };
}

/** The cheap model also says whether it's sure; the strong one's answer stands. */
const sureField = { sure: z.boolean() };
const SURE_RULE =
  "Also say whether you're sure. Say sure only if the message clearly says this; any doubt, say not sure.";

/* ---------------------------- understand ---------------------------- */

const RULES: Record<HelpRequest["role"], string> = {
  tenant: [
    'Answer "1" if they mean yes, they will be home for that visit.',
    'Answer "2" if they mean no, or they ask for a different time.',
    "Answer null if the text is not an answer to that question (for example, they are reporting a new problem).",
  ].join("\n"),
  vendor: [
    'Answer "NO" if they can\'t do the job.',
    'If they offer one specific visit time, answer it as "M/D h:mmam" or "M/D h:mmpm" using the calendar below, e.g. "11/12 2:00pm". For a range like "after 2" or "morning", use its start ("2:00pm", "9:00am").',
    'Answer null if they give no usable day and time (e.g. "sometime this week", a question back).',
  ].join("\n"),
  landlord: [
    "Rewrite it as exactly one of these commands, or null if you can't tell which:",
    "YES [repair number]  (agree to send the repair person the bot suggested)",
    "NO [repair number]  (don't send the suggested person)",
    "SEND <CODE> [repair number]  (text that repair person, using the code exactly as listed)",
    "FIND <trade> [repair number]  (search the web for a repair person, e.g. FIND plumber 3)",
    'BOOKED <result number or CODE> <M/D h:mmam> [#repair number]  (they booked someone by phone, e.g. "BOOKED 2 11/12 9:00am")',
    "PAID <tenant first name> [amount] [how]  (their rent came in, e.g. PAID MARIA 600 cash)",
    "RENT  (who has paid rent this month)",
    "RENT <tenant first name> <amount> [DUE <day>]  (set their monthly rent, e.g. RENT MARIA 1450 DUE 1)",
    "LIST | DONE <repair number> | CANCEL <repair number> | HELP",
  ].join("\n"),
};

function calendar(now: Date): string {
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { weekday: "long", month: "numeric", day: "numeric" });
  const days = Array.from({ length: 8 }, (_, i) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + i));
  return `Now: ${fmt(now)}, ${now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.\nNext days: ${days.map(fmt).join("; ")}.`;
}

const UNDERSTAND_SYSTEM =
  "You read text messages sent to a landlord's repair line and turn each one into the exact short reply the system understands. Read each message as a reply to the last text the line sent that person, when it fits: a one-word answer to a question means that question's answer. Never invent details the message doesn't say: when unsure, answer null and the person will be asked to rephrase.";

function claudeUnderstand(client: Anthropic, router: ModelRouter): Understand {
  return async ({ role, context, text, now, valid, same }) => {
    const prompt = `The sender is a ${role}.\n${context}\n${calendar(now)}\n\n${RULES[role]}\n\nTheir message:\n<message>${text}</message>`;
    const ask = async (model: string, cheap: boolean) => {
      const schema = cheap ? z.object({ command: z.string().nullable(), ...sureField }) : z.object({ command: z.string().nullable() });
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 1024,
        ...FALLBACK,
        output_config: { effort: "low", format: betaZodOutputFormat(schema) },
        system: cheap ? `${UNDERSTAND_SYSTEM} ${SURE_RULE}` : UNDERSTAND_SYSTEM,
        messages: [{ role: "user", content: prompt }],
      });
      const out = response.stop_reason === "refusal" ? null : response.parsed_output;
      const command = out?.command?.trim() || null;
      return {
        value: command,
        sure: !cheap || (out as { sure?: boolean } | null)?.sure === true,
        costUsd: costOf(model, response.usage),
        model,
      };
    };
    return router.run(
      `read ${role} text`,
      () => ask(CHEAP, CHEAP !== STRONG),
      () => ask(STRONG, false),
      (command) => command !== null && (!valid || valid(command)),
      (a, b) => a === b || (a !== null && b !== null && !!same?.(a, b)),
    );
  };
}

/* ------------------------------- trade ------------------------------- */

const tradeField = { trade: z.enum(TRADE_LABELS as [string, ...string[]]).nullable() };
const TRADE_SYSTEM =
  "A tenant texted their landlord about a problem in their rental. Pick the one kind of repair person who should come first. Use handyman for small general jobs (doors, shelves, patching). Answer null if it isn't a repair, or you truly can't tell.";

function claudeTrade(client: Anthropic, router: ModelRouter): TradeReader {
  return async (problem) => {
    const ask = async (model: string, cheap: boolean) => {
      const schema = cheap ? z.object({ ...tradeField, ...sureField }) : z.object(tradeField);
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 1024,
        ...FALLBACK,
        output_config: { effort: "low", format: betaZodOutputFormat(schema) },
        system: cheap ? `${TRADE_SYSTEM} ${SURE_RULE}` : TRADE_SYSTEM,
        messages: [{ role: "user", content: `<message>${problem}</message>` }],
      });
      const out = response.stop_reason === "refusal" ? null : response.parsed_output;
      return {
        value: out?.trade ?? null,
        sure: !cheap || (out as { sure?: boolean } | null)?.sure === true,
        costUsd: costOf(model, response.usage),
        model,
      };
    };
    return router.run(
      "pick a trade",
      () => ask(CHEAP, CHEAP !== STRONG),
      () => ask(STRONG, false),
      (trade) => trade !== null,
    );
  };
}

/* ------------------------------- find ------------------------------- */

const Business = z.object({
  name: z.string(),
  phone: z.string(),
  rating: z.number().nullable(),
  reviews: z.number().nullable(),
  note: z.string().nullable(),
});
const Report = z.object({ businesses: z.array(Business) });

const REPORT_TOOL = {
  name: "report_businesses",
  description: "Report the businesses found, best first. Call once, at the end.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      businesses: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            phone: { type: "string", description: "As listed, e.g. (203) 555-0199" },
            rating: { type: ["number", "null"], description: "Google or Yelp stars, if shown" },
            reviews: { type: ["number", "null"], description: "Number of reviews, if shown" },
            note: {
              type: ["string", "null"],
              description: 'At most a few words that matter for this job, e.g. "24/7 emergency service"',
            },
          },
          required: ["name", "phone", "rating", "reviews", "note"],
          additionalProperties: false,
        },
      },
    },
    required: ["businesses"],
    additionalProperties: false,
  },
};

function claudeFind(client: Anthropic, router: ModelRouter, log: (line: string) => void): Finder {
  // Sonnet searches first; if it finds nothing, Opus tries once.
  return async (plan) => {
    const first = await search(client, router, log, SEARCH, plan);
    if (first.length > 0 || SEARCH === STRONG) return first;
    log("AI search: nothing found, trying the strong model");
    return search(client, router, log, STRONG, plan);
  };
}

async function search(
  client: Anthropic,
  router: ModelRouter,
  log: (line: string) => void,
  model: string,
  plan: FindPlan,
): Promise<Found[]> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: [
        `A landlord needs a ${plan.trade} for a rental in ${plan.town}, Connecticut. The tenant reported: "${plan.problem}".`,
        "Search the web for up to 3 local, currently operating businesses that do this work in or near that town and list a phone number.",
        `They're needed ${plan.when}. Only include businesses whose listed hours or service cover that time: check the days and hours on their listing, and skip any that are closed then.${plan.urgent ? " This is urgent: prefer 24/7 or same-day emergency service." : ""}`,
        "Prefer high ratings with many reviews.",
        'In each note, say when they\'re available, e.g. "24/7 emergency service" or "Mon-Sat 7am-6pm".',
        "Only report a phone number you saw on a page; never guess one. Skip lead-generation sites and national call centers.",
        "Then call report_businesses with what you found (an empty list if nothing fits).",
      ].join("\n"),
    },
  ];

  let cost = 0;
  let searches = 0;
  const done = (found: Found[]) => {
    router.add(cost);
    log(
      `AI search: ${model}, ${searches} web search${searches === 1 ? "" : "es"}, $${cost.toFixed(4)} in tokens (plus search fees) · total $${router.totalUsd.toFixed(2)}`,
    );
    return found;
  };

  for (let turn = 0; turn < 4; turn++) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      ...FALLBACK,
      output_config: { effort: "medium" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }, REPORT_TOOL],
      messages,
    });
    cost += costOf(model, response.usage);
    searches += response.usage.server_tool_use?.web_search_requests ?? 0;
    if (response.stop_reason === "refusal") return done([]);

    const call = response.content.find(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === "report_businesses",
    );
    if (call) {
      const parsed = Report.safeParse(call.input);
      return done(parsed.success ? parsed.data.businesses.slice(0, 3) : []);
    }
    messages.push({ role: "assistant", content: response.content });
    // pause_turn: resend as is and the server resumes the search.
    if (response.stop_reason !== "pause_turn") {
      messages.push({ role: "user", content: "Now call report_businesses with what you found." });
    }
  }
  return done([]);
}

/** Stand-in results so FIND works in the simulator without a key. */
export const sampleFind: Finder = async (plan) => {
  const trade = plan.trade.replace(/\b\w/g, (c) => c.toUpperCase());
  return plan.urgent
    ? [
        { name: `${plan.town} ${trade} Pros (sample)`, phone: "(203) 555-0191", rating: 4.9, reviews: 190, note: "24/7 emergency service" },
        { name: `Nutmeg ${trade} (sample)`, phone: "(203) 555-0193", rating: 4.6, reviews: 310, note: "same-day, 7 days a week" },
      ]
    : [
        { name: `${plan.town} ${trade} Pros (sample)`, phone: "(203) 555-0191", rating: 4.9, reviews: 190, note: "Mon-Sat 7am-6pm" },
        { name: `Valley ${trade} Co (sample)`, phone: "(203) 555-0192", rating: 4.8, reviews: 85, note: "Mon-Fri 8am-5pm" },
        { name: `Nutmeg ${trade} (sample)`, phone: "(203) 555-0193", rating: 4.6, reviews: 310, note: "same-day, 7 days a week" },
      ];
};
