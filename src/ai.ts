import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { FindPlan, HelpRequest } from "./engine.js";
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
 * Both use the Claude API when ANTHROPIC_API_KEY is set (in .env.local).
 * Without it, understand is off and find returns clearly labelled samples,
 * so the simulator still runs end to end.
 */

export type Understand = (req: HelpRequest & { text: string; now: Date }) => Promise<string | null>;
export type Finder = (plan: FindPlan) => Promise<Found[]>;
export type Ai = { understand: Understand | null; find: Finder; live: boolean };

const MODEL = process.env.REPAIR_MODEL || "claude-opus-5-5";
// Retry on another model if this one declines; routing is Anthropic's default.
const FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default" as const,
};

export function makeAi(apiKey = process.env.ANTHROPIC_API_KEY): Ai {
  if (!apiKey) return { understand: null, find: sampleFind, live: false };
  const client = new Anthropic({ apiKey });
  return { understand: claudeUnderstand(client), find: claudeFind(client), live: true };
}

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
    "LIST | DONE <repair number> | CANCEL <repair number> | HELP",
  ].join("\n"),
};

function calendar(now: Date): string {
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { weekday: "long", month: "numeric", day: "numeric" });
  const days = Array.from({ length: 8 }, (_, i) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + i));
  return `Now: ${fmt(now)}, ${now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.\nNext days: ${days.map(fmt).join("; ")}.`;
}

const Answer = z.object({ command: z.string().nullable() });

function claudeUnderstand(client: Anthropic): Understand {
  return async ({ role, context, text, now }) => {
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 1024,
      ...FALLBACK,
      output_config: { effort: "low", format: betaZodOutputFormat(Answer) },
      system:
        "You read text messages sent to a landlord's repair line and turn each one into the exact short reply the system understands. Never invent details the message doesn't say: when unsure, answer null and the person will be asked to rephrase.",
      messages: [
        {
          role: "user",
          content: `The sender is a ${role}.\n${context}\n${calendar(now)}\n\n${RULES[role]}\n\nTheir message:\n<message>${text}</message>`,
        },
      ],
    });
    if (response.stop_reason === "refusal") return null;
    const command = response.parsed_output?.command?.trim();
    return command ? command : null;
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

function claudeFind(client: Anthropic): Finder {
  return async (plan) => {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      {
        role: "user",
        content: [
          `A landlord needs a ${plan.trade} for a rental in ${plan.town}, Connecticut. The tenant reported: "${plan.problem}".`,
          "Search the web for up to 3 local, currently operating businesses that do this work in or near that town and list a phone number.",
          "Prefer high ratings with many reviews, and same-day or 24/7 emergency service if the problem sounds urgent (no heat, no water, a leak).",
          "Only report a phone number you saw on a page; never guess one. Skip lead-generation sites and national call centers.",
          "Then call report_businesses with what you found (an empty list if nothing fits).",
        ].join("\n"),
      },
    ];

    for (let turn = 0; turn < 4; turn++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        ...FALLBACK,
        output_config: { effort: "medium" },
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }, REPORT_TOOL],
        messages,
      });
      if (response.stop_reason === "refusal") return [];

      const call = response.content.find(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === "report_businesses",
      );
      if (call) {
        const parsed = Report.safeParse(call.input);
        return parsed.success ? parsed.data.businesses.slice(0, 3) : [];
      }
      messages.push({ role: "assistant", content: response.content });
      // pause_turn: resend as is and the server resumes the search.
      if (response.stop_reason !== "pause_turn") {
        messages.push({ role: "user", content: "Now call report_businesses with what you found." });
      }
    }
    return [];
  };
}

/** Stand-in results so FIND works in the simulator without a key. */
export const sampleFind: Finder = async (plan) => {
  const trade = plan.trade.replace(/\b\w/g, (c) => c.toUpperCase());
  return [
    { name: `${plan.town} ${trade} Pros (sample)`, phone: "(203) 555-0191", rating: 4.9, reviews: 190, note: "24/7 emergency service" },
    { name: `Valley ${trade} Co (sample)`, phone: "(203) 555-0192", rating: 4.8, reviews: 85, note: null },
    { name: `Nutmeg ${trade} (sample)`, phone: "(203) 555-0193", rating: 4.6, reviews: 310, note: "same-day visits" },
  ];
};
