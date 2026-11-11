// npm run legal: builds the legal pages into legal-site/ from legal/config.json.
//
// Pages: privacy policy, terms of service (for landlords), SMS terms (for
// everyone who gets texts), and how people opt in, with the real sample
// messages. Twilio's business-texting registration asks for the privacy
// policy and opt-in description at a fixed web address; carriers reject
// campaigns without them.
//
// Templates, not legal advice: have a lawyer review before charging anyone.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const { productName: P, operator: OP, contactEmail: EMAIL, state: STATE, effectiveDate: DATE } = config;

const missing = Object.entries(config).filter(([k, v]) => !k.startsWith("_") && /TODO/.test(String(v)));
if (missing.length && !process.argv.includes("--draft")) {
  console.error(`Fill in legal/config.json first: ${missing.map(([k]) => k).join(", ")}`);
  console.error("(npm run legal -- --draft builds a preview anyway, marked DRAFT.)");
  process.exit(1);
}
const draft = missing.length > 0;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(P)}</title>
<style>
  :root { --fg:#1d1b18; --muted:#5f5a52; --bg:#fbfaf7; --line:#e6e1d8; --accent:#b4532a; }
  @media (prefers-color-scheme: dark) { :root { --fg:#ece9e4; --muted:#a39d93; --bg:#171614; --line:#33312d; --accent:#e08a62; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:17px/1.6 system-ui,-apple-system,sans-serif; }
  main { max-width:720px; margin:0 auto; padding:32px 16px 64px; }
  nav { display:flex; flex-wrap:wrap; gap:16px; font-size:15px; margin-bottom:24px; }
  a { color:var(--accent); }
  h1 { font-size:30px; line-height:1.2; margin:0 0 4px; }
  h2 { font-size:20px; margin:32px 0 8px; }
  .meta { color:var(--muted); font-size:15px; }
  .draft { background:#fde68a; color:#1d1b18; padding:8px 12px; border-radius:8px; font-weight:600; }
  blockquote { margin:12px 0; padding:10px 14px; border-left:3px solid var(--accent); background:color-mix(in srgb, var(--fg) 4%, transparent); }
  li { margin:4px 0; }
</style></head><body><main>
<nav><a href="index.html">${esc(P)}</a><a href="privacy.html">Privacy</a><a href="sms-terms.html">SMS terms</a><a href="terms.html">Terms</a><a href="opt-in.html">How people opt in</a></nav>
${draft ? `<p class="draft">DRAFT: not yet filled in. Do not use for registration.</p>` : ""}
<h1>${esc(title)}</h1>
<p class="meta">${esc(P)}, operated by ${esc(OP)}. Effective ${esc(DATE)}.</p>
${body}
<h2>Contact</h2>
<p>Questions, or requests to see or delete your information: <a href="mailto:${esc(EMAIL)}">${esc(EMAIL)}</a>.</p>
</main></body></html>`;
}

// The real first text and examples, matching src/compliance.ts and src/engine.ts.
const samples = {
  welcome:
    "Hi Maria, this is Pat's repair and rent line. You'll get texts here about repairs and rent at 12 Oak St, Unit 1. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.",
  repair: "Sam (HVAC) can come Mon, Nov 9, 8:00 AM about: \"heat not working\". Reply 1 if you'll be home, 2 if not.",
  rent: "Hi Maria, a reminder from Pat: December rent ($1,450) is due Tue, Dec 1. Thanks!",
  vendor:
    "Hi Sam, this is the repair line for Pat. Job at 12 Oak St, Unit 1: \"heat not working\". When can you go? Reply with a day and time like TUE 9AM, or NO if you can't.",
  stop: "You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe.",
  help: "Pat's repair and rent line. Text a problem with your home to report it, or reply to the texts you get. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.",
};

const pages = {
  "index.html": page(
    P,
    `<p>${esc(P)} is a text-message assistant for landlords. Tenants text one number to report repairs; the landlord picks a repair person; the repair person replies with a time; the tenant confirms. It can also send rent reminders. It only tracks rent: it never collects or moves money.</p>
<p>Messages go only to a landlord's own tenants and repair contacts, who agreed to receive them. Anyone can reply <strong>STOP</strong> at any time to stop all texts, or <strong>HELP</strong> for help.</p>
<ul><li><a href="privacy.html">Privacy policy</a></li><li><a href="sms-terms.html">SMS terms</a></li><li><a href="terms.html">Terms of service</a></li><li><a href="opt-in.html">How people opt in</a></li></ul>`,
  ),

  "privacy.html": page(
    "Privacy policy",
    `<p>This policy explains what ${esc(P)} collects, why, and who sees it. It covers landlords who use the service and the tenants and repair contacts who get texts from it.</p>

<h2>What we collect</h2>
<ul>
<li><strong>Contact details</strong> a landlord enters or shares: names, mobile phone numbers, and the addresses of their rental units.</li>
<li><strong>Messages</strong> sent to and from the ${esc(P)} number, and the times they were sent.</li>
<li><strong>Repair details</strong>: what was reported, who was asked to fix it, and the visit time.</li>
<li><strong>Rent records</strong> a landlord enters: rent amount, due day, and what the landlord marked as paid. We never collect bank, card or payment account details, and no money passes through the service.</li>
<li><strong>Opt-in and opt-out records</strong>: when someone was added, when they first got a text, and when they replied STOP or START.</li>
</ul>

<h2>How we use it</h2>
<p>Only to run the service: to pass messages between a landlord, their tenants and their repair contacts, to send reminders the landlord set up, to keep the landlord's records, and to honor opt-outs. We do not use it for advertising.</p>

<h2>Who we share it with</h2>
<ul>
<li><strong>The landlord</strong> who added you sees the messages and records about their rentals.</li>
<li><strong>Service providers</strong> that run the service for us, only as needed: Twilio (sends and receives the texts), Anthropic (its AI reads the wording of some messages so the service understands normal replies), Cloudflare (web hosting), and our hosting provider. Each is bound by its own terms and privacy commitments.</li>
<li><strong>When required by law</strong>, such as a valid court order.</li>
</ul>
<p><strong>We do not sell personal information.</strong> No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging originator opt-in data and consent will not be shared with any third parties, except the service providers above, who use it only to deliver the service.</p>

<h2>How long we keep it</h2>
<p>For as long as the landlord uses the service, then up to 12 months so records can be retrieved, unless the law requires longer. Opt-out records are kept as long as needed to make sure we never text someone who opted out.</p>

<h2>Your choices</h2>
<ul>
<li>Reply <strong>STOP</strong> to any text to stop all messages from that number. Reply <strong>START</strong> to resume.</li>
<li>Email us to see the information we hold about you, correct it, or delete it. We'll answer within 30 days. If you're a tenant, we may need to involve your landlord, since the records are theirs.</li>
</ul>

<h2>Security</h2>
<p>Information is stored with access limited to the people who run the service, and credentials are kept out of our code. No system is perfectly secure; if we learn of a breach that affects you, we'll tell you as the law requires.</p>

<h2>Children</h2>
<p>The service is for adult landlords, tenants and contractors. We don't knowingly collect information from children under 13.</p>

<h2>Changes</h2>
<p>If we change this policy, we'll update the date at the top. Significant changes will be sent to landlords before they take effect.</p>`,
  ),

  "sms-terms.html": page(
    "SMS terms",
    `<p>These terms apply to text messages from ${esc(P)}, a service landlords use to coordinate repairs and rent with their tenants and repair contacts.</p>

<h2>The program</h2>
<p><strong>${esc(P)}</strong>: repair coordination and rent reminder texts between a landlord, their tenants and their repair contacts. Tenants get texts about repairs and rent at their rental. Repair contacts get texts about jobs they're asked to do. Landlords get updates about their rentals.</p>

<h2>How you joined</h2>
<p>Your landlord (or the landlord you do repair work for) added your number after you agreed to get these texts, or you texted the number yourself. See <a href="opt-in.html">how people opt in</a>.</p>

<h2>What to expect</h2>
<ul>
<li><strong>Message frequency varies</strong> with repairs and rent, usually a few messages a month.</li>
<li><strong>Message and data rates may apply</strong>, depending on your mobile plan.</li>
<li>Reply <strong>STOP</strong> (or UNSUBSCRIBE, CANCEL, END, QUIT) to stop all texts. You'll get one message confirming it, then nothing more. Reply <strong>START</strong> to resume.</li>
<li>Reply <strong>HELP</strong> for help, or email <a href="mailto:${esc(EMAIL)}">${esc(EMAIL)}</a>.</li>
<li>No automatic texts are sent between 9pm and 8am. Replies to a message you just sent may come at any time.</li>
</ul>

<h2>Not for emergencies</h2>
<p>Texts can be delayed or fail. <strong>For fire, gas leaks, flooding or anything dangerous, call 911 or your utility company first</strong>, then your landlord.</p>

<h2>Carriers</h2>
<p>Mobile carriers are not liable for delayed or undelivered messages.</p>

<p>Our <a href="privacy.html">privacy policy</a> explains how your information is used.</p>`,
  ),

  "terms.html": page(
    "Terms of service",
    `<p>These terms are between ${esc(OP)} ("we") and each landlord who uses ${esc(P)} ("you"). By using the service you agree to them.</p>

<h2>What the service does</h2>
<p>${esc(P)} passes text messages between you, your tenants and your repair contacts, suggests and finds repair people, and sends rent reminders you set up. It keeps records of repairs and of rent <em>you</em> mark as paid. It never collects, holds or moves money.</p>

<h2>Your responsibilities</h2>
<ul>
<li><strong>Consent.</strong> Only add people who have agreed to get texts from this service, after you've told them what they'll get (see <a href="opt-in.html">how people opt in</a> for a notice you can give them). You're responsible for having their agreement.</li>
<li><strong>Accurate information.</strong> Enter correct names, numbers, addresses and rent amounts.</li>
<li><strong>Lawful use.</strong> Use the service only for repair and rent communication with your own tenants and contractors. No advertising, marketing, debt collection or anything unlawful, harassing or discriminatory. Rent reminders are friendly reminders, not legal notices: follow the law for any formal notice.</li>
<li><strong>Opt-outs.</strong> When someone texts STOP, the service stops texting them; don't add them back without their new agreement.</li>
<li><strong>Check what matters.</strong> The service uses automated tools, including AI, to read replies and search the web for repair businesses. It can misread a message or show outdated business details. Confirm visit times, prices and anyone you hire yourself.</li>
</ul>

<h2>Not for emergencies</h2>
<p>Texts can be delayed or fail. The service is not an emergency system. Make sure your tenants know to call 911 or the utility company for dangerous situations.</p>

<h2>Repair people</h2>
<p>Repair people you use, or find through the service, are independent. We don't employ, vet, license or guarantee them, and we're not responsible for their work or charges.</p>

<h2>Fees</h2>
<p>Any fees are agreed with you before you're charged. You can stop using the service at any time.</p>

<h2>No guarantee</h2>
<p>The service is provided "as is". We work to keep it running but don't promise it will always be available or error-free.</p>

<h2>Limit of liability</h2>
<p>To the extent the law allows, we're not liable for indirect or consequential losses, and our total liability is limited to the fees you paid us in the 3 months before the claim.</p>

<h2>Ending</h2>
<p>You can stop at any time. We may suspend the service if it's being misused, for example texting people who didn't agree.</p>

<h2>Law</h2>
<p>These terms are governed by the laws of the State of ${esc(STATE)}.</p>`,
  ),

  "opt-in.html": page(
    "How people opt in",
    `<p>${esc(P)} only texts people who agreed to it. Here is how each kind of person joins, and the exact messages they get.</p>

<h2>Tenants and repair contacts</h2>
<ol>
<li>The landlord tells them about the repair and rent line and asks if they agree to get texts from it: in person, by phone, in writing, or with the notice below. Only people who say yes are added.</li>
<li>The landlord adds them (or they text the number themselves, which also counts as agreeing).</li>
<li>Their <strong>first text</strong> from the line says who it's from, what it's for, how often, that rates may apply, and how to get help or stop:
<blockquote>${esc(samples.welcome)}</blockquote></li>
<li>They can reply STOP at any time. They get one confirmation and nothing more:
<blockquote>${esc(samples.stop)}</blockquote></li>
</ol>

<h2>Landlords</h2>
<p>Landlords sign up for the service themselves, agree to the <a href="terms.html">terms</a>, and get a first text with HELP and STOP instructions.</p>

<h2>Notice a landlord can give tenants</h2>
<blockquote>We now use a text line for repairs and rent. You can text it to report a repair and you'll get texts about repair visits and rent reminders for your home. Message frequency varies, and message and data rates may apply. Reply STOP at any time to stop, or HELP for help. Details: privacy policy and SMS terms at this website. Do you agree to get these texts? (Yes / No)</blockquote>

<h2>Sample messages</h2>
<ul>
<li>Repair visit: <blockquote>${esc(samples.repair)}</blockquote></li>
<li>Rent reminder: <blockquote>${esc(samples.rent)}</blockquote></li>
<li>To a repair contact: <blockquote>${esc(samples.vendor)}</blockquote></li>
<li>HELP reply: <blockquote>${esc(samples.help)}</blockquote></li>
</ul>

<p>No marketing messages are sent. Opt-in information is never shared with third parties for marketing. See the <a href="privacy.html">privacy policy</a> and <a href="sms-terms.html">SMS terms</a>.</p>`,
  ),
};

const out = new URL("../legal-site/", import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [name, html] of Object.entries(pages)) writeFileSync(new URL(name, out), html);
console.log(`Built ${Object.keys(pages).length} pages in legal-site/${draft ? " (DRAFT: fill in legal/config.json)" : ""}`);
