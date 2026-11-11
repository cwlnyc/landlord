import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTunnel, tunnelUrlIn } from "./tunnel.js";

it("finds the address in cloudflared's banner", () => {
  const banner = [
    "2026-11-11T12:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...",
    "2026-11-11T12:00:02Z INF +--------------------------------------------------------------------------------------------+",
    "2026-11-11T12:00:02Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
    "2026-11-11T12:00:02Z INF |  https://quiet-river-banana-tool.trycloudflare.com                                         |",
  ].join("\n");
  // Not the "on trycloudflare.com..." line: only a full https address counts.
  expect(tunnelUrlIn(banner)).toBe("https://quiet-river-banana-tool.trycloudflare.com");
  expect(tunnelUrlIn("Requesting new quick Tunnel on trycloudflare.com...")).toBeNull();
});

function fake(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-cloudflared-"));
  const bin = join(dir, "cloudflared");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

it("starts the tunnel and returns its address", async () => {
  const bin = fake('echo "INF |  https://test-words.trycloudflare.com  |" >&2; sleep 5');
  const { url, child } = await startTunnel(bin, 4301);
  expect(url).toBe("https://test-words.trycloudflare.com");
  child.kill();
});

it("says so when cloudflared fails", async () => {
  const bin = fake('echo "ERR failed to request quick Tunnel" >&2; exit 1');
  await expect(startTunnel(bin, 4301)).rejects.toThrow(/stopped.*failed to request quick Tunnel/s);
});
