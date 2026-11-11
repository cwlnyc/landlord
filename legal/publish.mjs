// npm run legal:publish: builds the legal pages and puts them on Cloudflare
// Pages at https://<pagesProject>.pages.dev, a fixed address for Twilio's
// registration form. Needs `npx --yes wrangler login` once on this computer.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

execFileSync(process.execPath, [new URL("./build.mjs", import.meta.url).pathname], { stdio: "inherit" });
const { pagesProject } = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const site = new URL("../legal-site", import.meta.url).pathname;

// Creating the project fails harmlessly when it already exists.
spawnSync("npx", ["--yes", "wrangler", "pages", "project", "create", pagesProject, "--production-branch", "main"], { stdio: "ignore" });
const deploy = spawnSync("npx", ["--yes", "wrangler", "pages", "deploy", site, "--project-name", pagesProject, "--branch", "main"], {
  stdio: "inherit",
});
if (deploy.status !== 0) {
  console.error("\nUpload failed. If it mentions logging in: npx --yes wrangler login, then try again.");
  process.exit(1);
}
console.log(`\nLive at https://${pagesProject}.pages.dev`);
console.log(`For Twilio's registration:\n  Privacy policy: https://${pagesProject}.pages.dev/privacy.html\n  Terms: https://${pagesProject}.pages.dev/terms.html\n  Opt-in description: https://${pagesProject}.pages.dev/opt-in.html`);
