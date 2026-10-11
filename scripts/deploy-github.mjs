import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const required = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "BREVO_API_KEY",
  "EMAIL_TO",
  "EMAIL_FROM",
  "DVC_MONITOR_INGEST_TOKEN",
  "DVC_MONITOR_ADMIN_TOKEN",
  "DVC_GITHUB_DISPATCH_TOKEN",
];
const missing = required.filter(name => !process.env[name]?.trim());
if (missing.length) throw new Error("Missing GitHub Actions secrets: " + missing.join(", "));

const account = process.env.CLOUDFLARE_ACCOUNT_ID.trim();
if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error("Invalid CLOUDFLARE_ACCOUNT_ID");

const repoRoot = process.cwd();
const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
if (config.name !== "dvc-reservation-monitor") throw new Error("Unexpected Worker name");

// The generated Wrangler config is written into a temporary directory so it
// never exposes the account/database IDs in the repository. Wrangler resolves
// relative paths from the config file location, so make repo paths absolute
// before writing that temporary config.
const workerMain = join(repoRoot, config.main);
config.main = workerMain;

// Bargain alerts that include any Friday, Saturday, or Sunday date in the
// displayed reservation range receive extra exclamation emphasis around the
// existing flame subject. The check intentionally includes the checkout date,
// matching the date range the user sees in the reservation alert.
const weekendHelper = [
  "function reservationIncludesWeekend(listing) {",
  "  const start = Date.parse(String(listing?.checkIn || \"\") + \"T00:00:00Z\");",
  "  const end = Date.parse(String(listing?.checkOut || \"\") + \"T00:00:00Z\");",
  "  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;",
  "  for (let time = start; time <= end; time += 86400000) {",
  "    const day = new Date(time).getUTCDay();",
  "    if (day === 0 || day === 5 || day === 6) return true;",
  "  }",
  "  return false;",
  "}",
  "",
  "function decorateWeekendBargainSubject(subject, events, isBargain) {",
  "  if (!isBargain || !events.some(event => reservationIncludesWeekend(event.listing))) return subject;",
  "  return `‼️ ${subject} ‼️`;",
  "}",
  "",
].join("\n");

// EMAIL_TO is the notification-only Gmail account. EMAIL_FROM is the primary
// Gmail address already used by the monitor as its sender identity. During
// deployment, add the primary address as a CC whenever the two addresses differ,
// so every DVC alert is stored in the primary inbox while the notification-only
// Gmail account can be the only Gmail account with iPhone push enabled.
// Keep Pushover as a BCC backup without ever committing its gateway address.
{
  const notificationModule = join(repoRoot, "src", "index.js");
  const original = readFileSync(notificationModule, "utf8");
  const helperNeedle = "function alertKey(source, listing) {";
  const subjectNeedle = '  const subject = priorityBargainSubject(title, events, subjectBits) || `${title} — ${subjectBits.join(", ")}`;';
  const subjectReplacement = [
    "  const prioritySubject = priorityBargainSubject(title, events, subjectBits);",
    "  const subject = decorateWeekendBargainSubject(",
    '    prioritySubject || `${title} — ${subjectBits.join(", ")}`,',
    "    events,",
    "    Boolean(prioritySubject),",
    "  );",
  ].join("\n");
  const recipientNeedle = "      to: [{ email: env.EMAIL_TO }],";
  const recipientReplacement = `${recipientNeedle}\n      ...(env.EMAIL_FROM && env.EMAIL_FROM.trim().toLowerCase() !== env.EMAIL_TO.trim().toLowerCase() ? { cc: [{ email: env.EMAIL_FROM.trim() }] } : {}),\n      ...(env.PUSHOVER_EMAIL ? { bcc: [{ email: env.PUSHOVER_EMAIL }] } : {}),`;

  if (!original.includes(helperNeedle)) throw new Error("Could not locate standard alert helper insertion point");
  if (!original.includes(subjectNeedle)) throw new Error("Could not locate standard bargain subject line");
  if (!original.includes(recipientNeedle)) throw new Error("Could not locate standard Brevo recipient block for dual-Gmail routing");

  const modified = original
    .replace(helperNeedle, `${weekendHelper}${helperNeedle}`)
    .replace(subjectNeedle, subjectReplacement)
    .replace(recipientNeedle, recipientReplacement);
  writeFileSync(notificationModule, modified);
}

// Rare Finds has its own mail helper and already contains the Pushover BCC.
// Apply the same weekend-bargain subject emphasis and primary-Gmail copy there.
{
  const rareFindsModule = join(repoRoot, "src", "rare-finds.js");
  const original = readFileSync(rareFindsModule, "utf8");
  const helperNeedle = "function bargainSubject(events, bits) {";
  const subjectNeedle = '    const subject = bargainSubject(claimed, bits) || `DVCReservations Rare Finds — ${bits.join(", ")}`;';
  const subjectReplacement = [
    "    const prioritySubject = bargainSubject(claimed, bits);",
    "    const subject = decorateWeekendBargainSubject(",
    '      prioritySubject || `DVCReservations Rare Finds — ${bits.join(", ")}`,',
    "      claimed,",
    "      Boolean(prioritySubject),",
    "    );",
  ].join("\n");
  const recipientNeedle = "      to: [{ email: env.EMAIL_TO }],";
  const recipientReplacement = `${recipientNeedle}\n      ...(env.EMAIL_FROM && env.EMAIL_FROM.trim().toLowerCase() !== env.EMAIL_TO.trim().toLowerCase() ? { cc: [{ email: env.EMAIL_FROM.trim() }] } : {}),`;

  if (!original.includes(helperNeedle)) throw new Error("Could not locate Rare Finds bargain helper insertion point");
  if (!original.includes(subjectNeedle)) throw new Error("Could not locate Rare Finds bargain subject line");
  if (!original.includes(recipientNeedle)) throw new Error("Could not locate Rare Finds Brevo recipient block for dual-Gmail routing");

  const modified = original
    .replace(helperNeedle, `${weekendHelper}${helperNeedle}`)
    .replace(subjectNeedle, subjectReplacement)
    .replace(recipientNeedle, recipientReplacement);
  writeFileSync(rareFindsModule, modified);
}

const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${account}`;
async function api(path, options = {}) {
  const response = await fetch(apiRoot + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(`Cloudflare API failed: HTTP ${response.status} (codes: ${(body.errors || []).map(e => e.code).join(",")})`);
  }
  return body;
}

const databaseName = "dvc-monitor-state";
let database = null;
for (let page = 1; ; page += 1) {
  const body = await api(`/d1/database?name=${encodeURIComponent(databaseName)}&per_page=100&page=${page}`);
  const matches = (body.result || []).filter(row => row.name === databaseName);
  if (matches.length > 1 || (database && matches.length)) throw new Error("Ambiguous D1 database name");
  database ||= matches[0] || null;
  if ((body.result || []).length < 100) break;
}

if (!database) {
  database = (await api("/d1/database", {
    method: "POST",
    body: JSON.stringify({ name: databaseName }),
  })).result;
  console.log(`Created D1 database ${databaseName}.`);
} else {
  console.log(`Using existing D1 database ${databaseName}.`);
}

if (!database?.uuid) throw new Error("Cloudflare did not return a D1 database UUID");
config.d1_databases = [{
  binding: "DB",
  database_name: databaseName,
  database_id: database.uuid,
  migrations_dir: join(repoRoot, "migrations"),
}];
config.account_id = account;
config.workers_dev = true;

const tempDir = mkdtempSync(join(tmpdir(), "dvc-deploy-"));
const tempConfig = join(tempDir, "wrangler.deploy.json");
const secretsPath = join(tempDir, "secrets.json");
writeFileSync(tempConfig, JSON.stringify(config, null, 2));
const workerSecrets = {
  BREVO_API_KEY: process.env.BREVO_API_KEY,
  EMAIL_TO: process.env.EMAIL_TO,
  EMAIL_FROM: process.env.EMAIL_FROM,
  INGEST_TOKEN: process.env.DVC_MONITOR_INGEST_TOKEN,
  ADMIN_TOKEN: process.env.DVC_MONITOR_ADMIN_TOKEN,
  GITHUB_DISPATCH_TOKEN: process.env.DVC_GITHUB_DISPATCH_TOKEN,
};
if (process.env.PUSHOVER_EMAIL?.trim()) workerSecrets.PUSHOVER_EMAIL = process.env.PUSHOVER_EMAIL.trim();
writeFileSync(secretsPath, JSON.stringify(workerSecrets), { mode: 0o600 });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    ...options,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return result;
}

// Validate the generated production source after all deploy-time notification
// routing and weekend-bargain transformations have been applied.
run("node", ["--check", "src/index.js"]);
run("node", ["--check", "src/rare-finds.js"]);

try {
  run("npx", ["--no-install", "wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", tempConfig]);
  const deploy = run("npx", ["--no-install", "wrangler", "deploy", "--config", tempConfig, "--secrets-file", secretsPath]);
  const combined = `${deploy.stdout || ""}\n${deploy.stderr || ""}`;
  const url = combined.match(/https:\/\/[A-Za-z0-9.-]+\.workers\.dev\/?/)?.[0] || null;
  console.log(`D1 database UUID: ${database.uuid}`);
  if (url) console.log(`DVC_MONITOR_BASE_URL=${url}`);
  console.log(`Primary Gmail copy: ${process.env.EMAIL_FROM?.trim() && process.env.EMAIL_FROM.trim().toLowerCase() !== process.env.EMAIL_TO.trim().toLowerCase() ? "enabled" : "same as notification inbox"}`);
  console.log(`Pushover e-mail gateway: ${process.env.PUSHOVER_EMAIL?.trim() ? "enabled" : "not configured"}`);
  console.log("Weekend bargain subject emphasis: enabled for Friday/Saturday/Sunday date ranges");
  console.log("Deployment complete. Keep ChangeDetection enabled until the 48-hour parallel verification is complete.");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
