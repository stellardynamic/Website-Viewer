#!/usr/bin/env node

const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SERVER_FILE = path.join(ROOT, "server.js");
const PACKAGE_FILE = path.join(ROOT, "package.json");
const DEFAULT_PORT = Number(process.env.PORT || 4174);
const MAX_PORT_TRIES = 20;

function exitWith(message, code = 1) {
  console.error(`\n${message}\n`);
  process.exit(code);
}

function checkNodeVersion() {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 18) {
    exitWith(
      `Website Viewer needs Node.js 18 or newer. This computer has Node.js ${process.versions.node}.\n` +
      "Install the current LTS version from https://nodejs.org/, close this window, and run the launcher again."
    );
  }
}

function dependencyNames() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_FILE, "utf8"));
  return Object.keys(pkg.dependencies || {});
}

function missingDependencies() {
  return dependencyNames().filter((name) => {
    return !fs.existsSync(path.join(ROOT, "node_modules", name, "package.json"));
  });
}

function ensureDependencies() {
  const missing = missingDependencies();
  if (!missing.length) return;

  console.log("First-time setup: installing Website Viewer dependencies.");
  console.log("This can take a few minutes because the screenshot engine includes a browser.\n");

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = childProcess.spawnSync(npm, ["install"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    exitWith(
      `Could not run npm install: ${result.error.message}\n` +
      "Install Node.js from https://nodejs.org/ and try again."
    );
  }
  if (result.status !== 0) {
    exitWith(
      "Dependency installation failed.\n" +
      "Check that this computer is online and that your company network allows npm downloads, then run this launcher again."
    );
  }
}

function hasScreenshotBrowser() {
  try {
    const puppeteer = require(path.join(ROOT, "node_modules", "puppeteer"));
    const browserPath = puppeteer.executablePath();
    return Boolean(browserPath && fs.existsSync(browserPath));
  } catch {
    return false;
  }
}

function ensureScreenshotBrowser() {
  if (hasScreenshotBrowser()) return;

  console.log("Installing the browser used for website thumbnails.");
  console.log("This is usually only needed the first time this user runs Website Viewer.\n");

  const installer = path.join(ROOT, "node_modules", "puppeteer", "install.mjs");
  const result = childProcess.spawnSync(process.execPath, [installer], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    exitWith(`Could not install the screenshot browser: ${result.error.message}`);
  }
  if (result.status !== 0) {
    exitWith(
      "Screenshot browser installation failed.\n" +
      "Check that this computer is online and that security software is not blocking the download, then run this launcher again."
    );
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function getHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({
      host: "127.0.0.1",
      port,
      path: "/api/health",
      headers: {
        "Sec-Fetch-Site": "same-origin",
        "Origin": `http://127.0.0.1:${port}`,
      },
      timeout: 900,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          resolve(Boolean(json && json.ok && json.app === "Website Viewer"));
        } catch {
          resolve(false);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function choosePort() {
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + MAX_PORT_TRIES; port++) {
    if (await getHealth(port)) {
      return { port, alreadyRunning: true };
    }
    if (await isPortFree(port)) {
      return { port, alreadyRunning: false };
    }
  }
  exitWith(
    `No open local port found from ${DEFAULT_PORT} to ${DEFAULT_PORT + MAX_PORT_TRIES - 1}.\n` +
    "Close other Website Viewer windows and try again."
  );
}

function openBrowser(url) {
  let command;
  let args;

  if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  const child = childProcess.spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    console.log(`Open this address in your browser: ${url}`);
  });
  child.unref();
}

function startServer(port) {
  const child = childProcess.spawn(process.execPath, [SERVER_FILE], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) process.exit(0);
    process.exit(code || 0);
  });

  const stop = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  return child;
}

async function waitForServer(port, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await getHealth(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
}

async function main() {
  checkNodeVersion();
  ensureDependencies();
  ensureScreenshotBrowser();

  const { port, alreadyRunning } = await choosePort();
  const url = `http://localhost:${port}/`;

  if (alreadyRunning) {
    console.log(`Website Viewer is already running at ${url}`);
    openBrowser(url);
    return;
  }

  console.log(`Starting Website Viewer at ${url}`);
  const server = startServer(port);
  const ready = await waitForServer(port);

  if (!ready) {
    server.kill("SIGTERM");
    exitWith(
      "Website Viewer did not finish starting.\n" +
      "Check the messages above. If this keeps happening, restart the computer and run the launcher again."
    );
  }

  openBrowser(url);
  console.log("\nReady. Keep this window open while using Website Viewer.");
  console.log("When you close all Website Viewer browser tabs, this local server will shut down automatically after a few minutes.");
  console.log("You can also press Ctrl+C in this window to stop it right away.\n");
}

main().catch((err) => exitWith(err.stack || err.message || String(err)));
