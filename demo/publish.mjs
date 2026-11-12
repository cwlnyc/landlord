// npm run demo:publish: builds the always-on demo and puts it on Cloudflare
// Pages at https://<project>.pages.dev. Needs `npx --yes wrangler login` once.
import { execFileSync, spawnSync } from "node:child_process";

const project = process.env.DEMO_PROJECT || "landlordlinedemo";
execFileSync("npm", ["run", "demo:build"], { stdio: "inherit" });
spawnSync("npx", ["--yes", "wrangler", "pages", "project", "create", project, "--production-branch", "main"], { stdio: "ignore" });
const site = new URL("../demo-site", import.meta.url).pathname;
const r = spawnSync("npx", ["--yes", "wrangler", "pages", "deploy", site, "--project-name", project, "--branch", "main"], { stdio: "inherit" });
if (r.status !== 0) {
  console.error("\nUpload failed. If it mentions logging in: npx --yes wrangler login, then try again.");
  process.exit(1);
}
console.log(`\nThe demo is live at https://${project}.pages.dev (it can take a minute the first time).`);
