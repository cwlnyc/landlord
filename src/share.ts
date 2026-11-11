import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { findCloudflared, startTunnel } from "./tunnel.js";

/**
 * npm run share: the simulator on everyone's phones, for a family test with
 * no phone number, no Twilio and no cost. Starts its own copy of the
 * simulator (separate saved data, data/share-state.json), opens a tunnel to
 * it, and prints one link to send everyone. Each person picks who they are
 * and gets their own texting screen. Nothing is texted to a real phone.
 *
 * The link carries a random key; without it the tunnel answers 403. Ctrl+C
 * ends the test and the link stops working.
 */

const PORT = 4310;
const key = randomBytes(9).toString("base64url");

const bin = findCloudflared();
if (!bin) {
  console.error("No cloudflared found. Download it to ~/bin first (see README, Going live, step 4).");
  process.exit(1);
}

const server = spawn("npx", ["tsx", "src/server.ts"], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, TZ: "America/New_York", PORT: String(PORT), SHARE_KEY: key, SIM_STATE: "../data/share-state.json" },
});
// Show the server's own log lines (AI readings and so on) after the link.
let ready = false;
server.stdout.on("data", (chunk: Buffer) => {
  const text = chunk.toString();
  if (!ready && text.includes("simulator")) ready = true;
  else if (ready) process.stdout.write(text);
});

const stop = () => {
  server.kill();
  process.exit(0);
};
process.on("SIGINT", stop);

for (let i = 0; i < 60 && !(await fetch(`http://localhost:${PORT}/api/state`).then((r) => r.ok, () => false)); i++) {
  await new Promise((r) => setTimeout(r, 250));
}

try {
  const { url, child } = await startTunnel(bin, PORT);
  child.on("exit", () => {
    console.error("\nThe tunnel stopped. Run npm run share again for a new link.");
    stop();
  });
  process.on("exit", () => child.kill());
  console.log("\nSend everyone this link (it may take ~20 seconds to start working):\n");
  console.log(`  ${url}/phone?key=${key}\n`);
  console.log("Each person opens it, taps who they are, and texts like normal.");
  console.log("The laptop view (clock buttons, every phone at once) is http://localhost:" + PORT);
  console.log("Ctrl+C ends the test; the link stops working.\n");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  stop();
}
