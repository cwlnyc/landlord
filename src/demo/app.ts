/**
 * The always-on demo (npm run demo:publish → landlordlinedemo.pages.dev).
 *
 * The real bot, running in the visitor's browser: same engine, same
 * wording, sample data (landlord Pat), no AI, sample search results. The
 * visitor is Pat; Maria (tenant) and John (plumber) are played by the page,
 * so tapping the link is the whole setup. Nothing is sent anywhere.
 */

import { prepareOutbound } from "../compliance.js";
import { receive } from "../interpret.js";
import { currentPeriod, tickRent } from "../rent.js";
import type { Found, Outbound, State } from "../types.js";
import seed from "../../data/demo.json" with { type: "json" };
import { SAMPLE_PHOTO } from "../sample-photo.js";

const PHOTO = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SAMPLE_PHOTO)}`;

const PAT = "+1 203 555 0101";
const MARIA = "+1 203 555 0201";
const KEVIN = "+1 860 555 0202";
const JOHN = "+1 203 555 0302";
const ROB = "+1 860 555 0303";
const NAMES: Record<string, string> = { [PAT]: "Pat", [MARIA]: "Maria", [KEVIN]: "Kevin", [JOHN]: "John", [ROB]: "Rob" };
const digits = (p: string) => p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const nameOf = (p: string) => NAMES[Object.keys(NAMES).find((k) => digits(k) === digits(p)) ?? ""] ?? "Someone";

type Msg = { from: string; to: string; body: string; at: Date; media?: string[] };

// Sample businesses: obviously sample, so nobody calls a made-up number.
const sampleFind = async (plan: { trade: string; town: string; urgent: boolean }): Promise<Found[]> => {
  const t = plan.trade.replace(/\b\w/g, (c) => c.toUpperCase());
  return plan.urgent
    ? [
        { name: `${plan.town} ${t} Pros (sample)`, phone: "(203) 555-0191", rating: 4.9, reviews: 190, note: "24/7 emergency service" },
        { name: `Nutmeg ${t} (sample)`, phone: "(203) 555-0193", rating: 4.6, reviews: 310, note: "same-day, 7 days a week" },
      ]
    : [
        { name: `${plan.town} ${t} Pros (sample)`, phone: "(203) 555-0191", rating: 4.9, reviews: 190, note: "Mon-Sat 7am-6pm" },
        { name: `Valley ${t} Co (sample)`, phone: "(203) 555-0192", rating: 4.8, reviews: 85, note: "Mon-Fri 8am-5pm" },
      ];
};
const ai = { understand: null, find: sampleFind, live: false };

let state: State;
let log: Msg[];
let robSaidNo: boolean;
let busy = Promise.resolve();

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One text into the bot; the replies go into the log, and the page's people answer theirs. */
function text(from: string, body: string, media: string[] = []) {
  busy = busy.then(async () => {
    log.push({ from, to: "line", body, at: new Date(), ...(media.length ? { media } : {}) });
    const { out } = await receive(state, from, body, new Date(), ai, false, async (early) => record(early), media);
    record(out);
    render();
    await actors(out);
  });
  return busy;
}

function record(out: Outbound[]) {
  for (const o of out) log.push({ from: "line", to: o.to, body: o.body, at: new Date(), ...(o.media?.length ? { media: o.media } : {}) });
  render();
}

/**
 * The tenants and repair people answer the way they really do, a moment
 * later. John works like Mom's plumber: he asks for a picture first, then
 * offers two times. Rob can't come, which is when the search helps.
 */
async function actors(out: Outbound[]) {
  for (const o of out) {
    const to = digits(o.to);
    if (to === digits(MARIA) || to === digits(KEVIN)) {
      if (/Will you be home then\?/.test(o.body)) {
        await wait(1800);
        void text(o.to, "yeah I'll be here");
      } else if (/asks: /.test(o.body)) {
        await wait(2200);
        void text(o.to, "here, it's dripping under the sink", [PHOTO]);
      } else if (/Which works for you\?/.test(o.body)) {
        await wait(1800);
        void text(o.to, "wed works");
      } else if (/isn't marked paid yet/.test(o.body)) {
        await wait(2200);
        void text(o.to, "oh sorry! sending the rent tonight");
      }
    } else if (to === digits(JOHN)) {
      if (/Job at .*When could you go\?/.test(o.body)) {
        await wait(2000);
        void text(o.to, "what's the issue? can I see a pic?");
      } else if (/When could you go to /.test(o.body)) {
        await wait(2400);
        void text(o.to, "ok I see it, just a loose fitting. I can do tue 9am or wed 2pm");
      }
    } else if (to === digits(ROB)) {
      if (/When could you go\?/.test(o.body)) {
        await wait(2000);
        const first = !robSaidNo;
        robSaidNo = true;
        void text(o.to, first ? "no sorry, booked today" : "tomorrow 10am");
      }
    }
  }
}

/* -------------------------------- page -------------------------------- */

/** A bank's Zelle alert, as Pat would forward it from their banking app. */
const ALERT = "BofA: KEVIN SMITH sent you $1,200.00 with Zelle(R).";

/** Quick replies: what the chip says, and what it sends (the same unless shown shorter). */
function chipsFor(last: string | undefined): (string | [label: string, text: string])[] {
  if (!last) return [];
  if (/tell me who you booked/i.test(last)) return ["1, tomorrow 8am", "2, tomorrow 9am"];
  if (/Rent not marked paid/i.test(last)) return [["📩 Forward Kevin's bank alert", ALERT], "Kevin paid"];
  if (/Let me know once it's in/i.test(last)) return [["📩 Forward Kevin's bank alert", ALERT], "Not yet", "600 so far"];
  if (/\?$/.test(last.trim())) return ["Yes", "No"];
  return [];
}

function bubble(m: Msg, me: string) {
  const el = document.createElement("div");
  const mine = digits(m.from) === digits(me);
  el.className = `msg ${mine ? "out" : "in"}`;
  el.textContent = m.body;
  for (const src of m.media ?? []) el.append(Object.assign(document.createElement("img"), { src, alt: "Photo" }));
  const t = document.createElement("time");
  t.textContent = m.at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  el.append(t);
  return el;
}

function render() {
  const mine = log.filter((m) => digits(m.to) === digits(PAT) || digits(m.from) === digits(PAT));
  const thread = $("#thread");
  if (mine.length) thread.replaceChildren(...mine.map((m) => bubble(m, PAT)));
  else {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Nothing yet. Tap a tenant button above to have them text in.";
    thread.replaceChildren(hint);
  }
  thread.scrollTop = thread.scrollHeight;

  const last = [...mine].reverse().find((m) => m.from === "line")?.body;
  $("#chips").replaceChildren(
    ...chipsFor(last).map((chip) => {
      const [label, said] = typeof chip === "string" ? [chip, chip] : chip;
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.onclick = () => void text(PAT, said);
      return b;
    }),
  );

  // Behind the scenes: everyone else's texts with the line.
  const others = log.filter((m) => digits(m.to) !== digits(PAT) && digits(m.from) !== digits(PAT));
  $("#others").replaceChildren(
    ...others.map((m) => {
      const row = document.createElement("p");
      const who = m.from === "line" ? `Line → ${nameOf(m.to)}` : `${nameOf(m.from)} → Line`;
      row.innerHTML = "<b></b> <span></span>";
      row.querySelector("b")!.textContent = who + ":";
      row.querySelector("span")!.textContent = m.body + (m.media?.length ? " [photo]" : "");
      return row;
    }),
  );
}

async function start() {
  state = structuredClone(seed) as State;
  log = [];
  robSaidNo = false;
  busy = Promise.resolve();
  render();
}

$("#send").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("#input");
  const body = input.value.trim();
  if (!body) return;
  input.value = "";
  void text(PAT, body);
});
$("#restart").addEventListener("click", () => void start());
$("#water").addEventListener("click", () => void text(MARIA, "my water is not working"));
$("#door").addEventListener("click", () => void text(KEVIN, "bedroom door won't close"));
$("#rent").addEventListener("click", () => void rentDay());

/**
 * Rent the way it really goes (Mom): tenants don't text "I paid", the money
 * just shows up in the bank. Five days after it's due, the line tells the
 * landlord whose rent isn't marked yet and nudges that tenant. Here Maria and
 * Priya's came in, Kevin's didn't.
 */
function rentDay() {
  busy = busy.then(async () => {
    const kevin = state.units.find((u) => digits(u.tenant.phone) === digits(KEVIN))!;
    const { period, due } = currentPeriod(kevin, new Date());
    const lateCheck = new Date(due.getFullYear(), due.getMonth(), due.getDate() + 5, 9);
    state.rentSince = new Date(due.getTime() - 86_400_000).toISOString();
    state.payments = (state.payments ?? []).filter((p) => p.period !== period);
    for (const u of state.units) {
      if (u.id !== kevin.id && u.rent) state.payments.push({ unitId: u.id, period, amount: u.rent, method: "bank", at: due.toISOString() });
    }
    const out = prepareOutbound(state, tickRent(state, lateCheck), new Date());
    record(out);
    await actors(out);
  });
  return busy;
}

void start();
