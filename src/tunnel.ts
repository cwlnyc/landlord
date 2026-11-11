import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A free Cloudflare "quick tunnel" to this computer, started and read
 * automatically, so `npm run live` needs no address copied by hand. Its
 * address is random and changes each start; live.ts points the Twilio
 * webhook at it every time.
 */

/** Where cloudflared is: $CLOUDFLARED, ~/bin/cloudflared, or on the PATH. */
export function findCloudflared(): string | null {
  const candidates = [process.env.CLOUDFLARED, join(homedir(), "bin", "cloudflared"), "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

/** The address a quick tunnel prints when it's ready. */
export function tunnelUrlIn(output: string): string | null {
  return output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;
}

export function startTunnel(bin: string, port: number, timeoutMs = 45_000): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let seen = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`cloudflared didn't give an address within ${timeoutMs / 1000}s:\n${seen.slice(-800)}`));
    }, timeoutMs);
    const read = (chunk: Buffer) => {
      seen += chunk.toString();
      const url = tunnelUrlIn(seen);
      if (url) {
        clearTimeout(timer);
        resolve({ url, child });
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared stopped (code ${code}):\n${seen.slice(-800)}`));
    });
  });
}
