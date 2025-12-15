const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");

const DEFAULT_VAULT_PLUGINS_DIR =
  "C:\\Users\\daniel\\Developer\\Obsidian Plugins\\Plugin-Testing-Vault\\.obsidian\\plugins";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(srcPath, destPath) {
  fs.copyFileSync(srcPath, destPath);
}

function main() {
  const vaultPluginsDir =
    process.env.OBSIDIAN_VAULT_PLUGINS_DIR || DEFAULT_VAULT_PLUGINS_DIR;

  const manifestPath = path.join(REPO_ROOT, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json not found: ${manifestPath}`);
  }

  const manifest = readJson(manifestPath);
  const pluginId = manifest?.id;
  if (!pluginId) {
    throw new Error('manifest.json is missing required field "id"');
  }

  const pluginDestDir = path.join(vaultPluginsDir, pluginId);
  ensureDir(pluginDestDir);

  const artifacts = ["main.js", "manifest.json", "styles.css"];
  for (const filename of artifacts) {
    const src = path.join(REPO_ROOT, filename);
    if (!fs.existsSync(src)) {
      throw new Error(
        `Build artifact not found: ${src}. Did you run the build first?`
      );
    }
    const dest = path.join(pluginDestDir, filename);
    copyFile(src, dest);
  }
}

main();
