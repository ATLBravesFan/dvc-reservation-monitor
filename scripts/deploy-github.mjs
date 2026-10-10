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

// Optional delivery addresses are kept only in GitHub/Cloudflare secrets.
// When configured, inject them into the Worker source in this ephemeral
// Actions checkout before deployment. The addresses are never committed.
if (process.env.PUSHOVER_EMAIL?.trim() || process.env.DVC_NOTIFY_EMAIL?.trim()) {
  const original = readFileSync(workerMain, "utf8");
  const needle = "      to: [{ email: env.EMAIL_TO }],";
  const replacement = `      to: [{ email: env.EMAIL_TO }, ...(env.DVC_NOTIFY_EMAIL ? [{ email: env.DVC_NOTIFY_EMAIL }] : [])],\n      ...(env.PUSHOVER_EMAIL ? { bcc: [{ email: env.PUSHOVER_EMAIL }] } : {}),`;
  if (!original.includes(needle)) throw new Error("Could not locate Brevo recipient block for optional-recipient injection");
  writeFileSync(workerMain, original.replace(needle, replacement));
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
if (process.env.DVC_NOTIFY_EMAIL?.trim()) workerSecrets.DVC_NOTIFY_EMAIL = process.env.DVC_NOTIFY_EMAIL.trim();
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

try {
  run("npx", ["--no-install", "wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", tempConfig]);
  const deploy = run("npx", ["--no-install", "wrangler", "deploy", "--config", tempConfig, "--secrets-file", secretsPath]);
  const combined = `${deploy.stdout || ""}\n${deploy.stderr || ""}`;
  const url = combined.match(/https:\/\/[A-Za-z0-9.-]+\.workers\.dev\/?/)?.[0] || null;
  console.log(`D1 database UUID: ${database.uuid}`);
  if (url) console.log(`DVC_MONITOR_BASE_URL=${url}`);
  console.log(`Pushover e-mail gateway: ${process.env.PUSHOVER_EMAIL?.trim() ? "enabled" : "not configured"}`);
  console.log(`Dedicated Gmail alert recipient: ${process.env.DVC_NOTIFY_EMAIL?.trim() ? "enabled" : "not configured"}`);
  console.log("Deployment complete. Keep ChangeDetection enabled until the 48-hour parallel verification is complete.");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
