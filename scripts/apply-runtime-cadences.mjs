import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file = join(process.cwd(), "src", "index.js");
const original = readFileSync(file, "utf8");

const everyMinuteNeedle = '    ["dvcShop", () => pollDvcShop(env, store)],\n';
const fiveMinuteBlockNeedle = '  if (fiveMinuteCycle) {\n';
const fiveMinuteDvcShop = '    jobs.push(["dvcShop", () => pollDvcShop(env, store)]);\n';

if (original.includes(fiveMinuteDvcShop)) {
  console.log("DVC Shop already scheduled on the five-minute cycle.");
  process.exit(0);
}

if (!original.includes(everyMinuteNeedle)) {
  throw new Error("Could not locate the every-minute DVC Shop scheduler entry");
}
if (!original.includes(fiveMinuteBlockNeedle)) {
  throw new Error("Could not locate the five-minute scheduler block");
}

const modified = original
  .replace(everyMinuteNeedle, "")
  .replace(fiveMinuteBlockNeedle, `${fiveMinuteBlockNeedle}${fiveMinuteDvcShop}`);

writeFileSync(file, modified);
console.log("Applied production cadence policy: DVC Shop every 5 minutes.");
