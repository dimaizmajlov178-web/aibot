import {
  cpSync,
  mkdtempSync,
  symlinkSync,
  readdirSync,
  renameSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const skill = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(skill, "../../..");
const assets = join(skill, "assets/nextjs");
assert.ok(
  existsSync(join(assets, "lib/auth/core.ts.template")),
  "Ready OAuth implementation must exist"
);
const fixture = mkdtempSync(join(tmpdir(), "yandex-assets-"));
for (const name of [
  "app",
  "components",
  "lib",
  "tsconfig.json",
  "next.config.ts",
  "eslint.config.mjs",
  "postcss.config.mjs",
]) {
  cpSync(join(root, name), join(fixture, name), { recursive: true });
}
cpSync(assets, fixture, { recursive: true });
writeFileSync(
  join(fixture, "next-env.d.ts"),
  '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n'
);
function materialize(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const source = join(directory, item.name);
    if (item.isDirectory()) materialize(source);
    else if (source.endsWith(".template"))
      renameSync(source, source.slice(0, -9));
  }
}
materialize(fixture);
symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(
  join(fixture, "package.json"),
  JSON.stringify({ ...pkg, type: "module" })
);
const serverFile = join(fixture, "lib/auth/server.ts");
writeFileSync(
  serverFile,
  readFileSync(serverFile, "utf8")
    .replace("__CALLBACK_PATH__", "/api/oauth/yandex/callback-v2")
    .replace("__CLIENT_ID_ENV__", "VIBE_YA_ID")
    .replace("__CLIENT_SECRET_ENV__", "VIBE_YA_SECRET")
    .replace("__AUTH_TABLE_NAME__", "yandex_auth")
);
for (const [name, route] of Object.entries({
  start: "auth/yandex/start",
  callback: "oauth/yandex/callback-v2",
  session: "auth/session",
  logout: "auth/logout",
})) {
  const directory = join(fixture, "app/api", route);
  mkdirSync(directory, { recursive: true });
  cpSync(join(fixture, "routes", `${name}.ts`), join(directory, "route.ts"));
}
// Exercise the documented schema and UI integration in the temporary application.
const schemaFile = join(fixture, "lib/schema.ts");
const schema = readFileSync(schemaFile, "utf8");
assert.ok(
  schema.includes("export const TableName = {") &&
    schema.includes(
      "export const TABLE_SCHEMAS: Record<TableName, TableSchema> = {"
    ),
  "Update fixture schema integration for the new template layout"
);
writeFileSync(
  schemaFile,
  schema
    .replace(
      "export const TableName = {",
      'export const TableName = {\n  YANDEX_AUTH: "yandex_auth",'
    )
    .replace(
      "export const TABLE_SCHEMAS: Record<TableName, TableSchema> = {",
      'export const TABLE_SCHEMAS: Record<TableName, TableSchema> = {\n  [TableName.YANDEX_AUTH]: { name: TableName.YANDEX_AUTH, keySchema: [{ AttributeName: "id", KeyType: "HASH" }], attributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }] },'
    )
);
const layoutFile = join(fixture, "app/layout.tsx");
const layout = readFileSync(layoutFile, "utf8");
assert.ok(
  layout.includes("<BridgeProvider />"),
  "Update fixture UI integration for the new template layout"
);
writeFileSync(
  layoutFile,
  'import { YandexLogin } from "@/components/yandex-login";\n' +
    layout.replace("<BridgeProvider />", "<BridgeProvider /><YandexLogin />")
);
const tests = readdirSync(join(fixture, "tests"))
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => join(fixture, "tests", name));
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...tests],
  { cwd: fixture, stdio: "inherit" }
);
console.log(`Materialized fixture: ${fixture}`);
if (result.status !== 0) process.exit(result.status ?? 1);
for (const args of [
  ["tsc", "--noEmit", "--incremental", "false"],
  [
    "eslint",
    "lib/auth",
    "components/yandex-login.tsx",
    "components/ui/skeleton.tsx",
    "tests",
    "app/api/auth",
    "app/api/oauth",
  ],
]) {
  const check = spawnSync(
    join(root, "node_modules/.bin", args[0]),
    args.slice(1),
    { cwd: fixture, stdio: "inherit" }
  );
  if (check.status !== 0) process.exit(check.status ?? 1);
}
if (process.argv.includes("--build")) {
  const build = spawnSync(
    join(root, "node_modules/.bin/next"),
    ["build", "--webpack"],
    {
      cwd: fixture,
      stdio: "inherit",
      env: { ...process.env, USE_DATABASE: "false" },
    }
  );
  process.exit(build.status ?? 1);
}
