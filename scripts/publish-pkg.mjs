#!/usr/bin/env node
// Publish a workspace package to npm WITH provenance — but SKIP if that exact version is already on
// the registry. The release workflow publishes the versions currently in the manifests; some of them
// are usually already live (only the bumped package is new). Without this guard, `pnpm publish` errors
// on the first already-published package and the whole tagged release dies before reaching the new one.
//
// Usage: node scripts/publish-pkg.mjs @countersign/<pkg>
// Requires NODE_AUTH_TOKEN in the environment (the workflow injects it from the NPM_TOKEN secret).
import { execSync } from "node:child_process";

const name = process.argv[2];
if (!name) {
  console.error("usage: node scripts/publish-pkg.mjs <package-name>");
  process.exit(1);
}

const capture = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Local manifest version. The --filter runs the command inside the package's own directory, so
// ./package.json is that package's manifest. Take the last non-empty line to ignore any pnpm prefix.
const version = capture(`pnpm --filter ${name} exec node -p "require('./package.json').version"`)
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .pop();

let alreadyPublished = false;
try {
  capture(`npm view ${name}@${version} version`);
  alreadyPublished = true; // a hit means this exact version is on the registry
} catch {
  alreadyPublished = false; // 404 => not published yet
}

if (alreadyPublished) {
  console.log(`skip ${name}@${version} — already on npm`);
  process.exit(0);
}

console.log(`publish ${name}@${version} (provenance)`);
execSync(`pnpm --filter ${name} publish --provenance --access public --no-git-checks`, {
  stdio: "inherit",
});
