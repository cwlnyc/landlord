import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { makeAi } from "./ai.js";
import { tick } from "./engine.js";
import { receive } from "./interpret.js";
import type { Outbound, State } from "./types.js";

/**
 * The simulator: a local page with three phones (landlord, tenant, repair
 * person) driving the real engine. No texts leave this machine. It keeps a
 * fake clock you can fast-forward, so reminders can be tested in seconds.
 *
 * Starts from data/real.json if it exists (gitignored, for your own
 * rentals), else data/example.json.
 */

// Keys live in .env.local (gitignored), never in the code.
try {
  process.loadEnvFile(new URL("../.env.local", import.meta.url));
} catch {
  // No .env.local: the AI stays off and FIND returns sample results.
}
const ai = makeAi();

const PORT = Number(process.env.PORT ?? 4300);
const STATE_FILE = new URL("../data/state.json", import.meta.url);
const SEED_FILE = existsSync(new URL("../data/real.json", import.meta.url))
  ? new URL("../data/real.json", import.meta.url)
  : new URL("../data/example.json", import.meta.url);
const PAGE = new URL("../public/index.html", import.meta.url);

type LogEntry = { at: string; from: string; to: string; body: string };
type Saved = { state: State; log: LogEntry[]; clockOffsetMs: number };

function seed(): Saved {
  return { state: JSON.parse(readFileSync(SEED_FILE, "utf8")), log: [], clockOffsetMs: 0 };
}
function load(): Saved {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : seed();
}
let saved = load();
const save = () => writeFileSync(STATE_FILE, JSON.stringify(saved, null, 2));
const now = () => new Date(Date.now() + saved.clockOffsetMs);
const BOT = "repair line";

function record(out: Outbound[]) {
  for (const o of out) saved.log.push({ at: now().toISOString(), from: BOT, to: o.to, body: o.body });
}

async function body(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

createServer(async (req, res) => {
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(PAGE));
    return;
  }
  if (req.method === "GET" && req.url === "/api/state") {
    return json({ ...saved, now: now().toISOString(), ai: ai.live });
  }
  if (req.method === "POST" && req.url === "/api/text") {
    const { from, text } = await body(req);
    if (typeof from !== "string" || typeof text !== "string" || !text.trim()) {
      return json({ error: "from and text are required" }, 400);
    }
    saved.log.push({ at: now().toISOString(), from, to: BOT, body: text });
    const { out, understoodAs } = await receive(saved.state, from, text, now(), ai);
    // In the terminal only: the bot's reply already shows what it understood.
    if (understoodAs) console.log(`AI read "${text}" as: ${understoodAs}`);
    record(out);
    record(tick(saved.state, now()));
    save();
    return json({ ok: true });
  }
  if (req.method === "POST" && req.url === "/api/clock") {
    const { hours } = await body(req);
    saved.clockOffsetMs += Number(hours ?? 0) * 60 * 60 * 1000;
    record(tick(saved.state, now()));
    save();
    return json({ ok: true });
  }
  if (req.method === "POST" && req.url === "/api/reset") {
    saved = seed();
    save();
    return json({ ok: true });
  }
  json({ error: "not found" }, 404);
}).listen(PORT, () => {
  console.log(`Repair line simulator: http://localhost:${PORT}`);
  console.log(`Data from ${SEED_FILE.pathname.split("/").slice(-2).join("/")}`);
  console.log(ai.live ? "AI on (Claude API)" : "AI off: add ANTHROPIC_API_KEY to .env.local. FIND shows sample results.");
});
