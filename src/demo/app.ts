/**
 * The always-on demo (npm run demo:publish → landlordlinedemo.pages.dev).
 *
 * The real bot, running in the visitor's browser: same engine, same
 * wording, sample data (landlord Pat), no AI, sample search results. The
 * visitor is Pat; Maria (tenant) and John (plumber) are played by the page,
 * so tapping the link is the whole setup. Nothing is sent anywhere.
 */

import { receive } from "../interpret.js";
import type { Found, Outbound, State } from "../types.js";
import seed from "../../data/demo.json" with { type: "json" };

const PAT = "+1 203 555 0101";
const MARIA = "+1 203 555 0201";
const KEVIN = "+1 860 555 0202";
const JOHN = "+1 203 555 0302";
const ROB = "+1 860 555 0303";
const NAMES: Record<string, string> = { [PAT]: "Pat", [MARIA]: "Maria", [KEVIN]: "Kevin", [JOHN]: "John", [ROB]: "Rob" };
const digits = (p: string) => p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const nameOf = (p: string) => NAMES[Object.keys(NAMES).find((k) => digits(k) === digits(p)) ?? ""] ?? "Someone";

type Msg = { from: string; to: string; body: string; at: Date };

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
let johnSaidNo: boolean;
let busy = Promise.resolve();

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One text into the bot; the replies go into the log, and the page's people answer theirs. */
function text(from: string, body: string) {
  busy = busy.then(async () => {
    log.push({ from, to: "line", body, at: new Date() });
    const { out } = await receive(state, from, body, new Date(), ai, false, async (early) => record(early));
    record(out);
    render();
    await actors(out);
  });
  return busy;
}

function record(out: Outbound[]) {
  for (const o of out) log.push({ from: "line", to: o.to, body: o.body, at: new Date() });
  render();
}

/** Maria and John answer the way people do, a moment later. */
async function actors(out: Outbound[]) {
  for (const o of out) {
    const to = digits(o.to);
    if (to === digits(MARIA) || to === digits(KEVIN)) {
      if (/Will you be home then\?/.test(o.body)) {
        await wait(1800);
        void text(o.to, "yeah I'll be here");
      }
    } else if (to === digits(JOHN) || to === digits(ROB)) {
      if (/When could you go\?/.test(o.body)) {
        await wait(2000);
        const first = to === digits(JOHN) && !johnSaidNo;
        if (first) johnSaidNo = true;
        void text(o.to, first ? "no sorry, booked today" : "tomorrow 10am");
      }
    }
  }
}

/* -------------------------------- page -------------------------------- */

function chipsFor(last: string | undefined): string[] {
  if (!last) return [];
  if (/tell me who you booked/i.test(last)) return ["1, tomorrow 8am", "2, tomorrow 9am"];
  if (/Let me know once it's in/i.test(last)) return ["Got it", "Not yet", "600 so far"];
  if (/\?$/.test(last.trim())) return ["Yes", "No"];
  return [];
}

function bubble(m: Msg, me: string) {
  const el = document.createElement("div");
  const mine = digits(m.from) === digits(me);
  el.className = `msg ${mine ? "out" : "in"}`;
  el.textContent = m.body;
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
    ...chipsFor(last).map((label) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.onclick = () => void text(PAT, label);
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
      row.querySelector("span")!.textContent = m.body;
      return row;
    }),
  );
}

async function start() {
  state = structuredClone(seed) as State;
  log = [];
  johnSaidNo = false;
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
$("#rent").addEventListener("click", () => void text(KEVIN, "sent the rent on zelle"));

void start();
