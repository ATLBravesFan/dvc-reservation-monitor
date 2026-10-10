import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const REQUIRED = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "BREVO_API_KEY",
  "EMAIL_TO",
  "EMAIL_FROM",
  "DVC_MONITOR_INGEST_TOKEN",
  "GITHUB_DISPATCH_TOKEN",
];
const missing = REQUIRED.filter(name => !process.env[name]?.trim());
if (missing.length) throw new Error(`Missing GitHub Actions secrets: ${missing.join(", ")}`);

const account = process.env.CLOUDFLARE_ACCOUNT_ID.trim();
if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error("Invalid CLOUDFLARE_ACCOUNT_ID");

const DB_NAME = "dvc-reservation-monitor";
const API_ROOT = `https://api.cloudflare.com/client/v4/accounts/${account}`;

async function cf(path, options = {}) {
  const response = await fetch(API_ROOT + path, {
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
    const codes = (body.errors || []).map(error => error.code).join(",");
    throw new Error(`Cloudflare API failed: HTTP ${response.status}${codes ? ` (codes: ${codes})` : ""}`);
  }
  return body;
}

let database = null;
for (let page = 1; ; page += 1) {
  const body = await cf(`/d1/database?per_page=100&page=${page}`);
  const matches = (body.result || []).filter(row => row.name === DB_NAME);
  if (matches.length > 1 || (database && matches.length)) throw new Error(`Multiple D1 databases named ${DB_NAME}`);
  database ||= matches[0] || null;
  if ((body.result || []).length < 100) break;
}

if (!database) {
  database = (await cf("/d1/database", {
    method: "POST",
    body: JSON.stringify({ name: DB_NAME, primary_location_hint: "enam" }),
  })).result;
  console.log(`Created D1 database ${DB_NAME}`);
} else {
  console.log(`Using existing D1 database ${DB_NAME}`);
}

if (!database?.uuid) throw new Error("Cloudflare did not return a D1 database UUID");

const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
config.account_id = account;
config.workers_dev = true;
config.d1_databases = [{
  binding: "DB",
  database_name: DB_NAME,
  database_id: database.uuid,
}];

const tempDir = mkdtempSync(join(tmpdir(), "dvc-monitor-deploy-"));
const deployConfig = join(tempDir, "wrangler.deploy.json");
const secretsFile = join(tempDir, "secrets.json");

const secrets = {
  BREVO_API_KEY: process.env.BREVO_API_KEY,
  EMAIL_TO: process.env.EMAIL_TO,
  EMAIL_FROM: process.env.EMAIL_FROM,
  INGEST_TOKEN: process.env.DVC_MONITOR_INGEST_TOKEN,
  GITHUB_DISPATCH_TOKEN: process.env.GITHUB_DISPATCH_TOKEN,
  ADMIN_TOKEN: process.env.DVC_MONITOR_ADMIN_TOKEN || randomBytes(32).toString("hex"),
};

try {
  writeFileSync(deployConfig, JSON.stringify(config, null, 2), { mode: 0o600 });
  writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });

  run("npx", ["--no-install", "wrangler", "d1", "execute", DB_NAME, "--remote", "--file", "schema.sql", "--config", deployConfig]);
  run("npx", ["--no-install", "wrangler", "deploy", "--config", deployConfig, "--secrets-file", secretsFile]);

  console.log("DVC monitor deployed with D1. Keep ChangeDetection enabled while the new monitor establishes baselines and is verified for 48 hours.");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
  }
}
