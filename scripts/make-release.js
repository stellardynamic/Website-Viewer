#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist");
const RELEASE_DIR = path.join(DIST_DIR, "Website-Viewer-release");
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const RELEASE_ZIP = path.join(DIST_DIR, `Website-Viewer-v${PACKAGE.version}.zip`);

const EXCLUDED = new Set([
  ".git",
  ".wv2-data",
  "dist",
  "node_modules",
]);

const SECRET_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".yarnrc",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);

const SECRET_EXTENSIONS = [
  ".cer",
  ".crt",
  ".key",
  ".p12",
  ".pem",
  ".pfx",
];

function shouldCopy(src) {
  const name = path.basename(src);
  const lower = name.toLowerCase();
  if (EXCLUDED.has(name)) return false;
  if (SECRET_FILE_NAMES.has(name) || lower.startsWith(".env.")) return false;
  if (SECRET_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false;
  if (name === ".DS_Store") return false;
  if (lower.endsWith(".zip")) return false;
  if (lower.endsWith(".log")) return false;
  return true;
}

function copyTree(srcDir, destDir) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    if (!shouldCopy(src)) continue;

    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyTree(src, dest);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
    }
  }
}

function commandExists(command) {
  const lookup = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  const result = childProcess.spawnSync(lookup, args, { stdio: "ignore", shell: process.platform !== "win32" });
  return result.status === 0;
}

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    stdio: options.stdio || "inherit",
    shell: Boolean(options.shell),
  });
  return result.status === 0;
}

function createZip() {
  for (const entry of fs.readdirSync(DIST_DIR, { withFileTypes: true })) {
    if (entry.isFile() && /^Website-Viewer-v.+\.zip$/i.test(entry.name)) {
      fs.rmSync(path.join(DIST_DIR, entry.name), { force: true });
    }
  }

  if (process.platform === "win32") {
    const command = commandExists("powershell.exe") ? "powershell.exe" : (commandExists("pwsh") ? "pwsh" : null);
    if (command) {
      const psCommand = [
        "Compress-Archive",
        "-Path", JSON.stringify(path.join(RELEASE_DIR, "*")),
        "-DestinationPath", JSON.stringify(RELEASE_ZIP),
        "-Force",
      ].join(" ");
      if (run(command, ["-NoProfile", "-Command", psCommand])) return true;
    }
  } else if (commandExists("zip")) {
    if (run("zip", ["-qr", RELEASE_ZIP, path.basename(RELEASE_DIR)], { cwd: DIST_DIR })) return true;
  }

  return false;
}

const shouldZip = process.argv.includes("--zip") || process.argv.includes("--archive");

fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
fs.mkdirSync(RELEASE_DIR, { recursive: true });
copyTree(ROOT, RELEASE_DIR);

console.log(`Release folder created: ${RELEASE_DIR}`);
console.log("It excludes node_modules, dist, git data, zip/log files, common env/key/cert files, and old runtime folders.");

if (shouldZip) {
  if (createZip()) {
    console.log(`Release archive created: ${RELEASE_ZIP}`);
  } else {
    console.log("Release archive was not created because no zip tool was available. The release folder is ready to upload manually.");
  }
}
