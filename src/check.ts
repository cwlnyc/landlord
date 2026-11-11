import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, statSync } from "node:fs";
import { digits } from "./engine.js";
import { toE164 } from "./twilio.js";
import type { State } from "./types.js";

/**
 * npm run check: everything `npm run live` needs, checked in one go, with
 * what to do about each problem. Never prints a key or token.
 *
 * Run it before a test. If `npm run live` and the tunnel are running, it
 * also checks that a text can actually reach the line.
 */

let failed = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const bad = (msg: string, fix: string) => {
  failed++;
  console.log(`  ✗ ${msg}\n      → ${fix}`);
};
const warn = (msg: string, fix: string) => console.log(`  ! ${msg}\n      → ${fix}`);
const section = (title: string) => console.log(`\n${title}`);

const ENV = new URL("../.env.local", import.meta.url);
const REAL = new URL("../data/real.json", import.meta.url);
const LIVE_STATE = new URL("../data/live-state.json", import.meta.url);
const looksFake = (v: string) => /\.\.\.|something|YOUR|MOMS|DADS|NUMBER|xxx/i.test(v);

/* ------------------------------ settings ------------------------------ */

section("Settings (.env.local)");
if (!existsSync(ENV)) {
  bad(".env.local doesn't exist", "cp .env.example .env.local, then fill it in (open -e .env.local)");
} else {
  process.loadEnvFile(ENV);
}
const env = (name: string) => process.env[name]?.trim() ?? "";
for (const name of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_NUMBER", "PUBLIC_URL"]) {
  const v = env(name);
  if (!v) bad(`${name} is empty`, `open -e .env.local and fill in ${name}, then save (Cmd+S)`);
  else if (looksFake(v)) bad(`${name} still looks like a placeholder`, `replace it with the real value from Twilio / the tunnel`);
  else ok(`${name} is set`);
}
if (env("TWILIO_ACCOUNT_SID") && !/^AC[0-9a-f]{32}$/i.test(env("TWILIO_ACCOUNT_SID"))) {
  bad("TWILIO_ACCOUNT_SID doesn't look right", "it starts with AC followed by 32 letters/numbers (Twilio console, Account Info)");
}
if (env("PUBLIC_URL").endsWith("/sms")) {
  bad("PUBLIC_URL ends with /sms", "remove /sms from PUBLIC_URL; the line adds it");
}
if (env("ANTHROPIC_API_KEY")) ok("ANTHROPIC_API_KEY is set (AI on)");
else warn("ANTHROPIC_API_KEY is empty: AI off", "fine for a test; people must reply in exact formats (YES, TUE 9AM, 1/2)");

/* -------------------------------- people -------------------------------- */

section("People (data/real.json)");
let state: State | undefined;
if (!existsSync(REAL)) {
  bad("data/real.json doesn't exist", "cp data/example.json data/real.json, then put in the real people");
} else {
  const raw = readFileSync(REAL, "utf8");
  try {
    state = JSON.parse(raw);
    ok("data/real.json is valid");
  } catch (error) {
    // The most common slip: a comma right before ] or }. Find its line.
    const comma = raw.search(/,\s*[\]}]/);
    const at = comma >= 0 ? comma : Number(String(error).match(/position (\d+)/)?.[1]);
    const line = Number.isFinite(at) ? raw.slice(0, at).split("\n").length : undefined;
    bad(
      `data/real.json has a typo${line ? ` around line ${line}` : ""}`,
      "usually a comma before ] or }, or a missing quote. The last item in a list has no comma after it.",
    );
  }
}

const people: { role: string; name: string; phone: string }[] = state
  ? [
      ...state.landlords.map((p) => ({ role: "landlord", name: p.name, phone: p.phone })),
      ...state.units.map((u) => ({ role: "tenant", name: u.tenant.name, phone: u.tenant.phone })),
      ...state.vendors.filter((v) => v.textable !== false).map((v) => ({ role: "repair person", name: v.name, phone: v.phone })),
    ]
  : [];

if (state) {
  if (state.landlords.length === 0) bad("no landlords", "add at least one under \"landlords\"");
  for (const p of people) {
    const d = digits(p.phone);
    if (d.length !== 10) bad(`${p.name} (${p.role}) has a phone number that isn't 10 digits`, "use +1 then the 10-digit number");
    else if (/^\d{3}5550/.test(d) || looksFake(p.phone)) bad(`${p.name} (${p.role}) still has a made-up 555 number`, "replace it with a real number, or delete them");
  }
  const seen = new Map<string, string>();
  for (const p of people) {
    const d = digits(p.phone);
    const before = seen.get(d);
    if (before) bad(`${p.name} (${p.role}) has the same number as ${before}`, "each person needs their own number; the line tells people apart by number");
    else seen.set(d, `${p.name} (${p.role})`);
  }
  if (people.length) ok(`${people.length} people: ${people.map((p) => `${p.name} (${p.role})`).join(", ")}`);
}

const allow = env("ALLOW_ONLY").split(",").map(digits).filter(Boolean);
if (!state) {
  // Nothing to compare ALLOW_ONLY against until real.json reads.
} else if (allow.length === 0) {
  warn("ALLOW_ONLY is empty: the line will text everyone in data/real.json", "fine once you're live; for a test, list your family's numbers");
} else {
  const missing = people.filter((p) => !allow.includes(digits(p.phone)));
  if (missing.length) {
    warn(
      `test mode: these won't get texts (shown in the live terminal instead): ${missing.map((p) => p.name).join(", ")}`,
      "expected on a trial account; add their numbers to ALLOW_ONLY when they can receive",
    );
  } else ok("test mode: everyone in data/real.json can get texts");
}

if (existsSync(LIVE_STATE) && existsSync(REAL) && statSync(REAL).mtimeMs > statSync(LIVE_STATE).mtimeMs) {
  warn(
    "data/real.json changed after the line last saved, so the line is still using the OLD people",
    "rm data/live-state.json, then restart npm run live",
  );
}

/* -------------------------------- Twilio -------------------------------- */

section("Twilio");
const sid = env("TWILIO_ACCOUNT_SID");
const token = env("TWILIO_AUTH_TOKEN");
const auth = `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
const webhook = `${env("PUBLIC_URL").replace(/\/+$/, "")}/sms`;

if (sid && token) {
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, { headers: { authorization: auth } });
    if (res.status === 401) {
      bad("Twilio rejected the SID or Auth Token", "copy both again from the Twilio console (Live credentials, not Test)");
    } else if (!res.ok) {
      bad(`Twilio answered ${res.status}`, "try again in a minute");
    } else {
      const account = (await res.json()) as { status: string; type: string };
      ok(`signed in to Twilio (${account.type === "Trial" ? "trial account" : "paid account"}, ${account.status})`);
      if (account.type === "Trial") {
        warn("trial: texts only reach verified numbers and start with \"Sent from your Twilio trial account\"", "normal for testing");
      }

      const number = toE164(env("TWILIO_NUMBER"));
      const list = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`,
        { headers: { authorization: auth } },
      );
      const found = list.ok
        ? ((await list.json()) as { incoming_phone_numbers: { sms_url: string; sms_method: string }[] }).incoming_phone_numbers[0]
        : undefined;
      if (!found) {
        bad(`${number} isn't a number on this Twilio account`, "check TWILIO_NUMBER against Phone Numbers → Active numbers");
      } else {
        ok(`${number} belongs to this account`);
        if (found.sms_url === webhook && found.sms_method === "POST") ok("its webhook points at this line");
        else
          bad(
            `its webhook is ${found.sms_url ? `"${found.sms_url}"` : "not set"}${found.sms_url && found.sms_method !== "POST" ? ` (${found.sms_method})` : ""}`,
            `in Twilio: the number → Configure → A message comes in → Webhook, ${webhook}, HTTP POST, Save`,
          );
      }
    }
  } catch {
    bad("couldn't reach Twilio", "check your internet connection");
  }
}

/* --------------------------------- AI --------------------------------- */

if (env("ANTHROPIC_API_KEY")) {
  section("AI (Claude)");
  try {
    await new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") }).models.list({ limit: 1 });
    ok("the API key works");
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) bad("the API key was rejected", "make a new key in the Claude Console and put it in .env.local");
    else if (error instanceof Anthropic.PermissionDeniedError) bad("the key isn't allowed to use the API", "check the Claude Console account (billing, credits)");
    else bad("couldn't reach the Claude API", "check your internet connection");
  }
}

/* ----------------------------- is it running ----------------------------- */

section("Running");
const local = await fetch("http://localhost:4301/health").then((r) => r.ok, () => false);
if (!local) {
  warn("npm run live isn't running", "start it in its own terminal tab, then run npm run check again");
} else {
  ok("npm run live is running");
  const remote = env("PUBLIC_URL")
    ? await fetch(`${env("PUBLIC_URL").replace(/\/+$/, "")}/health`).then((r) => r.ok, () => false)
    : false;
  if (remote) ok("the tunnel reaches it: texts can get in");
  else
    bad(
      "the tunnel doesn't reach it",
      "start the tunnel (~/bin/cloudflared tunnel --url http://localhost:4301); if the address changed, update PUBLIC_URL, restart npm run live and the Twilio webhook",
    );
}

console.log(failed ? `\n${failed} thing(s) to fix before testing.\n` : "\nAll set. Text the number.\n");
process.exit(failed ? 1 : 0);
