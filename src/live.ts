import { createServer } from "node:http";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { makeAi } from "./ai.js";
import { digits, tick } from "./engine.js";
import { receive } from "./interpret.js";
import { findCloudflared, startTunnel } from "./tunnel.js";
import { EMPTY_TWIML, isFromTwilio, readInbound, sendSms, setWebhook, toE164, type TwilioConfig } from "./twilio.js";
import type { Outbound, State } from "./types.js";

/**
 * The real repair line: Twilio posts each text to /sms, the same engine as
 * the simulator decides what to send, and the replies go out as real
 * texts. Reminders are checked every minute.
 *
 *   npm run live
 *
 * Needs in .env.local: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER.
 * With PUBLIC_URL empty it starts its own Cloudflare quick tunnel and points
 * the Twilio webhook at it, so nothing is copied by hand; set PUBLIC_URL
 * only when the line has a fixed address (a host, or a tunnel you run). Starts from
 * data/real.json; keeps its state in data/live-state.json. Both gitignored.
 *
 * While testing, set ALLOW_ONLY to a comma-separated list of numbers: texts
 * to anyone else are logged instead of sent.
 */

try {
  process.loadEnvFile(new URL("../.env.local", import.meta.url));
} catch {
  // Checked below.
}

function need(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name} in .env.local. See .env.example.`);
    process.exit(1);
  }
  return value;
}

const cfg: TwilioConfig = {
  accountSid: need("TWILIO_ACCOUNT_SID"),
  authToken: need("TWILIO_AUTH_TOKEN"),
  from: toE164(need("TWILIO_NUMBER")),
};
// Set before the server listens: from PUBLIC_URL, or from the tunnel below.
let WEBHOOK_URL = "";
const PORT = Number(process.env.PORT ?? 4301);
const ALLOW_ONLY = (process.env.ALLOW_ONLY ?? "")
  .split(",")
  .map((p) => digits(p))
  .filter(Boolean);

const SEED = new URL("../data/real.json", import.meta.url);
const STATE = new URL("../data/live-state.json", import.meta.url);
if (!existsSync(STATE) && !existsSync(SEED)) {
  console.error("Missing data/real.json: copy data/example.json and fill in the real units, tenants and repair people.");
  process.exit(1);
}
let state: State = JSON.parse(readFileSync(existsSync(STATE) ? STATE : SEED, "utf8"));

function save() {
  // Write then rename, so a crash mid-write never leaves half a file.
  const tmp = new URL("../data/live-state.json.tmp", import.meta.url);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE);
}

const ai = makeAi();

/** Every number the line may text: landlords, tenants, saved repair people. */
function known(phone: string): boolean {
  const d = digits(phone);
  return (
    state.landlords.some((l) => digits(l.phone) === d) ||
    state.units.some((u) => digits(u.tenant.phone) === d) ||
    state.vendors.some((v) => v.textable !== false && digits(v.phone) === d)
  );
}

async function deliver(out: Outbound[]) {
  for (const o of out) {
    if (!known(o.to)) {
      console.warn(`Not sent (unknown number ${o.to}): ${o.body}`);
      continue;
    }
    if (ALLOW_ONLY.length && !ALLOW_ONLY.includes(digits(o.to))) {
      console.log(`[ALLOW_ONLY, not sent] to ${o.to}: ${o.body}`);
      continue;
    }
    try {
      await sendSms(cfg, o.to, o.body);
      console.log(`-> ${o.to}: ${o.body.split("\n")[0]}`);
    } catch (error) {
      console.error(String(error));
    }
  }
}

// One text at a time, so two arriving together can't trip over each other.
let queue = Promise.resolve();
const serial = (job: () => Promise<void>) => {
  queue = queue.then(job).catch((error) => console.error("Failed:", error));
  return queue;
};

// Carrier and Twilio keywords. Twilio handles opting out and back in;
// they must not become a "repair" or a command.
const KEYWORDS = /^(stop|stopall|unsubscribe|cancel|end|quit|start|unstop|help|info)$/i;

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method !== "POST" || req.url?.split("?")[0] !== "/sms") {
    res.writeHead(404).end();
    return;
  }

  let raw = "";
  for await (const chunk of req) raw += chunk;
  const params = Object.fromEntries(new URLSearchParams(raw));
  const signature = req.headers["x-twilio-signature"];
  if (!isFromTwilio(cfg.authToken, WEBHOOK_URL, params, typeof signature === "string" ? signature : undefined)) {
    console.warn("Rejected a request that wasn't signed by Twilio (the Twilio webhook must be exactly " + WEBHOOK_URL + ").");
    res.writeHead(403).end();
    return;
  }
  // Answer Twilio right away; the work and the replies happen after.
  res.writeHead(200, { "content-type": "text/xml" }).end(EMPTY_TWIML);

  await serial(async () => {
    const { from, text } = await readInbound(cfg, params);
    console.log(`<- ${from}: ${text.split("\n")[0]}`);
    if (KEYWORDS.test(text.trim())) return;
    const { out, understoodAs } = await receive(state, from, text, new Date(), ai);
    if (understoodAs) console.log(`   AI read it as: ${understoodAs}`);
    save();
    await deliver(out);
  });
});

const fixedUrl = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "").replace(/\/sms$/, "");
if (fixedUrl) {
  WEBHOOK_URL = `${fixedUrl}/sms`;
  console.log(`Using PUBLIC_URL. Twilio webhook must be: ${WEBHOOK_URL} (A message comes in -> Webhook, HTTP POST)`);
} else {
  const bin = findCloudflared();
  if (!bin) {
    console.error("No cloudflared found (looked in ~/bin and the usual places). Download it (see README), or set PUBLIC_URL.");
    process.exit(1);
  }
  console.log("Starting a tunnel...");
  try {
    const tunnel = await startTunnel(bin, PORT);
    WEBHOOK_URL = `${tunnel.url}/sms`;
    tunnel.child.on("exit", () => {
      console.error("\nThe tunnel stopped, so texts can't reach the line. Restart npm run live.");
      process.exit(1);
    });
    process.on("exit", () => tunnel.child.kill());
    await setWebhook(cfg, WEBHOOK_URL);
    console.log(`Tunnel up and Twilio webhook set to ${WEBHOOK_URL}`);
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}
process.on("SIGINT", () => process.exit(0));

server.listen(PORT, () => {
  console.log(`Repair line LIVE on port ${PORT}, number ${cfg.from}`);
  console.log(ai.live ? "AI on" : "AI off (no ANTHROPIC_API_KEY)");
  if (ALLOW_ONLY.length) console.log(`Test mode: only texting ${ALLOW_ONLY.length} allowed number(s).`);
});

setInterval(() => {
  void serial(async () => {
    const out = tick(state, new Date());
    if (out.length) {
      save();
      await deliver(out);
    }
  });
}, 60_000);
