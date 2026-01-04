#!/usr/bin/env node

/**
 * prepare-release.js
 *
 * Bumps version files, commits, and pushes a git tag for a new release.
 *
 * This script will:
 * - Verify the working tree is clean
 * - Update versions in:
 *   - manifest.json
 *   - package.json
 *   - package-lock.json (if present)
 *   - versions.json
 * - Commit and push the version bump
 * - Create and push a git tag to trigger GitHub Actions
 *
 * A GitHub Actions workflow should listen to tag pushes and:
 * - build the plugin
 * - create a DRAFT GitHub release
 * - upload main.js, manifest.json, styles.css as release assets
 *
 * Usage:
 *   npm run pre-release 2.1.1
 *   npm run pre-release v2.1.1
 *
 *   # If your npm doesn't forward args without `--`:
 *   npm run pre-release -- 2.1.1
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function getVersionArg() {
  if (process.argv[2]) return process.argv[2];

  // Some npm versions require `--` to forward args. As a fallback, try to read the
  // original argv from npm's env var.
  const npmArgv = process.env.npm_config_argv;
  if (npmArgv) {
    try {
      const parsed = JSON.parse(npmArgv);
      const remain = parsed?.remain;
      if (Array.isArray(remain) && remain[0]) return remain[0];
    } catch {
      // ignore
    }
  }

  return null;
}

const versionArg = getVersionArg();

if (!versionArg) {
  console.error("❌ Please provide a version number: npm run pre-release X.Y.Z");
  console.error("   (If args aren't forwarded on your npm version: npm run pre-release -- X.Y.Z)");
  process.exit(1);
}

// Support both formats: 1.2.3 and v1.2.3
const versionRegex = /^v?\d+\.\d+\.\d+$/;
if (!versionRegex.test(versionArg)) {
  console.error("❌ Version must be in format X.Y.Z or vX.Y.Z");
  process.exit(1);
}

const cleanVersion = versionArg.replace(/^v/, "");
const tagName = cleanVersion; // use `v${cleanVersion}` if you prefer v-prefixed tags

const REPO_ROOT = process.cwd();

function detectIndent(text) {
  return text.includes("\t") ? "\t" : "  ";
}

function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function readJson(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return {
    content,
    json: JSON.parse(content),
    indent: detectIndent(content),
    eol: detectEol(content),
  };
}

function writeJson(filePath, json, indent, eol) {
  fs.writeFileSync(filePath, JSON.stringify(json, null, indent) + eol);
}

function runGit(command, opts = {}) {
  const out = execSync(`git ${command}`, opts);
  return out ? out.toString() : "";
}

const manifestPath = path.join(REPO_ROOT, "manifest.json");
const packageJsonPath = path.join(REPO_ROOT, "package.json");
const packageLockPath = path.join(REPO_ROOT, "package-lock.json");
const versionsPath = path.join(REPO_ROOT, "versions.json");

try {
  // Ensure clean working tree
  const status = runGit("status --porcelain");
  if (status.trim()) {
    console.error("⚠️  You have uncommitted changes. Please commit or stash them first.");
    console.error("\nUncommitted files:");
    console.error(status);
    process.exit(1);
  }

  const currentBranch = runGit("branch --show-current").trim();
  if (!currentBranch) {
    console.error("❌ Unable to determine current branch (detached HEAD?).");
    process.exit(1);
  }

  // Ensure tag doesn't already exist locally
  try {
    runGit(`rev-parse ${tagName}`, { stdio: "pipe" });
    console.error(`❌ Tag ${tagName} already exists locally.`);
    console.error(`   To delete it: git tag -d ${tagName}`);
    process.exit(1);
  } catch {
    // ok
  }

  // Ensure tag doesn't already exist on remote
  try {
    const remoteTag = execSync(`git ls-remote --tags origin refs/tags/${tagName}`, {
      stdio: "pipe",
    })
      .toString()
      .trim();

    if (remoteTag) {
      console.error(`❌ Tag ${tagName} already exists on remote.`);
      console.error("   This version has already been released.");
      process.exit(1);
    }
  } catch {
    // If origin isn't reachable, let later steps fail with a clear message.
  }

  // Fetch latest refs and require we're not behind remote
  console.log("📡 Fetching latest from remote...");
  runGit("fetch", { stdio: "inherit" });

  const remoteBranch = `origin/${currentBranch}`;
  try {
    const behind = runGit(`rev-list HEAD..${remoteBranch} --count`).trim();
    if (behind !== "0") {
      console.error(`❌ Your branch is ${behind} commits behind ${remoteBranch}.`);
      console.error("   Please pull/rebase first, then try again.");
      process.exit(1);
    }
  } catch {
    // If remote branch doesn't exist, allow git push to surface the error.
  }

  // Read current versions (for display)
  const manifestMeta = readJson(manifestPath);
  const packageMeta = readJson(packageJsonPath);
  const lockMeta = fs.existsSync(packageLockPath) ? readJson(packageLockPath) : null;
  const versionsMeta = fs.existsSync(versionsPath) ? readJson(versionsPath) : null;

  console.log(`\n📦 Current versions:`);
  console.log(`- manifest.json: ${manifestMeta.json.version}`);
  console.log(`- package.json:  ${packageMeta.json.version}`);
  if (lockMeta) console.log(`- package-lock.json: ${lockMeta.json.version}`);

  console.log(`\n✍️  Bumping version to ${cleanVersion}...`);

  // Update versions
  manifestMeta.json.version = cleanVersion;
  packageMeta.json.version = cleanVersion;
  if (lockMeta) {
    lockMeta.json.version = cleanVersion;
    if (lockMeta.json.packages && lockMeta.json.packages[""]) {
      lockMeta.json.packages[""].version = cleanVersion;
    }
  }

  const minAppVersion = manifestMeta.json.minAppVersion || "0.15.0";
  const nextVersions = versionsMeta ? versionsMeta.json : {};
  nextVersions[cleanVersion] = minAppVersion;

  // Write files back (preserve indentation + EOL style per file)
  writeJson(manifestPath, manifestMeta.json, manifestMeta.indent, manifestMeta.eol);
  writeJson(packageJsonPath, packageMeta.json, packageMeta.indent, packageMeta.eol);
  if (lockMeta) {
    writeJson(packageLockPath, lockMeta.json, lockMeta.indent, lockMeta.eol);
  }
  if (versionsMeta) {
    writeJson(versionsPath, nextVersions, versionsMeta.indent, versionsMeta.eol);
  } else {
    // If versions.json doesn't exist yet, match manifest's EOL/indent.
    writeJson(versionsPath, nextVersions, manifestMeta.indent, manifestMeta.eol);
  }

  // Commit version bump
  const filesToStage = ["manifest.json", "package.json", "versions.json"];
  if (fs.existsSync(packageLockPath)) filesToStage.push("package-lock.json");

  runGit(`add ${filesToStage.join(" ")}`, { stdio: "inherit" });

  try {
    runGit(`commit -m "Release: bump version to ${cleanVersion}"`, {
      stdio: "inherit",
    });
  } catch (e) {
    console.error("❌ Failed to commit version bump. Is your git user.name/email configured?");
    throw e;
  }

  console.log("\n📤 Pushing version bump commit...");
  runGit(`push origin ${currentBranch}`, { stdio: "inherit" });

  // Create annotated tag and push it to trigger GitHub Actions
  runGit(`tag -a ${tagName} -m "Release ${cleanVersion}"`, { stdio: "inherit" });
  console.log(`✅ Created tag ${tagName}`);

  console.log("\n📤 Pushing tag to remote...");
  runGit(`push origin ${tagName}`, { stdio: "inherit" });
  console.log(`✅ Pushed tag ${tagName} to remote`);

  console.log(`\n🎉 Release ${tagName} prepared successfully!`);
  console.log("\n📝 Next steps:");
  console.log("1) GitHub Actions will build and create a DRAFT release");
  console.log("2) Review the draft release assets (main.js, manifest.json, styles.css)");
  console.log("3) Publish the release when you're happy");
} catch (error) {
  console.error("\n❌ Error during release preparation:", error?.message || error);

  // Cleanup local tag if it was created
  try {
    execSync(`git tag -d ${tagName}`, { stdio: "pipe" });
    console.log("🧹 Cleaned up local tag");
  } catch {
    // ignore
  }

  process.exit(1);
}
