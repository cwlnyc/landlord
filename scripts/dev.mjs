// npm run dev: the simulator, kept up to date by itself.
//
// - Restarts when code changes (tsx watch).
// - Every 30 seconds, pulls new commits from GitHub. Only fast-forwards:
//   if you have edits of your own, it leaves them alone and says so once.
// - If a pull changes package.json, runs npm install before restarting.
//
// Start it once and leave the terminal open. Ctrl+C stops it.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const EVERY_MS = 30_000;
const env = { ...process.env, TZ: "America/New_York" };

let server;
function start() {
  server = spawn("npx", ["tsx", "watch", "--clear-screen=false", "src/server.ts"], { stdio: "inherit", env });
}

let warned = false;
async function pull() {
  try {
    const before = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
    await run("git", ["pull", "--ff-only", "--quiet"]);
    const after = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
    warned = false;
    if (before === after) return;

    const { stdout: log } = await run("git", ["log", "--format=  - %s", `${before}..${after}`]);
    console.log(`\nUpdated from GitHub:\n${log}`);
    const { stdout: files } = await run("git", ["diff", "--name-only", before, after]);
    if (/^package(-lock)?\.json$/m.test(files)) {
      console.log("New packages: running npm install...");
      await run("npm", ["install", "--no-audit", "--no-fund"]);
      server.kill();
      start();
    }
    // Code changes restart through tsx watch; refresh the page for page changes.
  } catch (error) {
    if (!warned) {
      warned = true;
      console.log(
        "\nCouldn't pull updates (no internet, or you have your own changes). " +
          "Still running the version you have.\n" + String(error.stderr || error.message).trim(),
      );
    }
  }
}

start();
pull();
setInterval(pull, EVERY_MS);
process.on("SIGINT", () => {
  server?.kill();
  process.exit(0);
});
