#!/usr/bin/env node
// Freeze engine/libgen.py into a self-contained executable with PyInstaller,
// so installed builds ship LibGen search without asking users to install
// Python. At runtime engine/sources.js runs engine/bin/<binary> whenever the
// project's .venv is absent (packaged installs have no .venv).
//
//   npm run freeze                        freeze for the machine you are on
//   node scripts/freeze-engine.mjs win    skip unless run on Windows
//
// Interpreter resolution mirrors the runtime (engine/sources.js):
// PAPERBACK_PYTHON, the project's .venv, then system Python — building the
// .venv (with engine/requirements.txt) when only a bare system Python exists.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_DIR = path.join(ROOT, "engine");
const BIN_DIR = path.join(ENGINE_DIR, "bin");
const SCRIPT = path.join(ENGINE_DIR, "libgen.py");
const REQUIREMENTS = path.join(ENGINE_DIR, "requirements.txt");
const VENV_DIR = path.join(ROOT, ".venv");
const isWin = process.platform === "win32";

function fail(message) {
  console.error(`[freeze] ${message}`);
  process.exit(1);
}

/* engine/bin must only ever hold the engine for the platform being packaged
 * (electron-builder has no per-platform negation that survives a global files
 * whitelist), so drop binaries frozen for any other platform. They are
 * build artifacts — the next `npm run freeze` rebuilds whatever is missing. */
function cleanEngineBin(platformName) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  for (const entry of fs.readdirSync(BIN_DIR)) {
    if (entry.startsWith("libgen-") && !entry.startsWith(`libgen-${platformName}-`)) {
      fs.rmSync(path.join(BIN_DIR, entry), { force: true, recursive: true });
      console.log(`[freeze] Removed ${entry} (not for ${platformName}).`);
    }
  }
}

if (process.env.PAPERBACK_SKIP_FREEZE === "1") {
  console.warn("[freeze] PAPERBACK_SKIP_FREEZE=1: building without the bundled engine.");
  process.exit(0);
}

/* PyInstaller can only freeze for the platform it runs on. Cross-building the
 * Windows installer on Linux keeps working, just without the bundled engine
 * (the app then falls back to the user's Python, as before). */
if (process.argv[2] === "win" && !isWin) {
  cleanEngineBin("win32");
  console.warn("[freeze] Not on Windows: skipping the engine bundle for this build.");
  process.exit(0);
}

const run = (cmd, args, opts) =>
  spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...opts });

const venvPython = () =>
  path.join(VENV_DIR, isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");

function pipInstall(python, what) {
  const res = run(python.cmd, [...python.args, "-m", "pip", "install", ...what], {
    stdio: "inherit"
  });
  if (res.status !== 0) fail(`Could not install ${what.join(" ")} with ${python.cmd}.`);
}

function hasLibgen(python) {
  return run(python.cmd, [...python.args, "-c", "import libgen_api_enhanced"]).status === 0;
}

let python = null;

if (process.env.PAPERBACK_PYTHON) {
  const cmd = process.env.PAPERBACK_PYTHON;
  const probe = run(cmd, ["-c", "import libgen_api_enhanced"]);
  if (probe.error) fail(`PAPERBACK_PYTHON (${cmd}) was not found.`);
  if (probe.status !== 0) {
    fail(
      `PAPERBACK_PYTHON (${cmd}) is missing libgen-api-enhanced — ` +
        "install engine/requirements.txt into it first."
    );
  }
  python = { cmd, args: [] };
} else {
  const venv = venvPython();
  if (fs.existsSync(venv)) {
    python = { cmd: venv, args: [] };
  } else {
    const candidates = isWin ? [["py", "-3"], ["python"]] : [["python3"], ["python"]];
    const base = candidates.find(([cmd, ...args]) =>
      !run(cmd, [...args, "--version"]).error
    );
    if (!base) {
      fail(
        "No Python 3 found: install Python to bundle the LibGen engine, " +
          "or set PAPERBACK_SKIP_FREEZE=1 to build without it."
      );
    }
    console.log(`[freeze] Creating .venv with ${base.join(" ")}...`);
    if (run(base[0], [...base.slice(1), "-m", "venv", VENV_DIR], { stdio: "inherit" }).status !== 0) {
      fail("Could not create the project's .venv.");
    }
    python = { cmd: venvPython(), args: [] };
  }
  if (!hasLibgen(python)) {
    console.log("[freeze] Installing engine/requirements.txt into .venv...");
    pipInstall(python, ["-r", REQUIREMENTS]);
  }
}

const pyi = run(python.cmd, [...python.args, "-m", "PyInstaller", "--version"]);
if (pyi.status !== 0) {
  console.log("[freeze] Installing PyInstaller...");
  pipInstall(python, ["pyinstaller"]);
}

const name = `libgen-${process.platform}-${process.arch}`;
const binary = path.join(BIN_DIR, name + (isWin ? ".exe" : ""));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "paperback-freeze-"));

fs.mkdirSync(BIN_DIR, { recursive: true });
console.log(`[freeze] Building ${path.relative(ROOT, binary)}...`);

const build = run(
  python.cmd,
  [
    ...python.args,
    "-m",
    "PyInstaller",
    "--onefile",
    "--clean",
    "--noconfirm",
    `--name=${name}`,
    `--distpath=${BIN_DIR}`,
    `--workpath=${work}`,
    `--specpath=${work}`,
    SCRIPT
  ],
  { stdio: "inherit" }
);

if (build.status !== 0 || !fs.existsSync(binary)) fail("PyInstaller build failed.");

/* The frozen engine must behave exactly like libgen.py over stdin/stdout:
 * a request it must reject should come back as JSON on stdout, exit 1. */
const smoke = spawnSync(binary, {
  input: JSON.stringify({ action: "resolve", md5: "", mirrors: [] }),
  encoding: "utf8"
});
if (smoke.status !== 1 || !/"error"/.test(smoke.stdout || "")) {
  fail("The frozen engine does not answer like libgen.py.");
}

console.log(
  `[freeze] OK: ${path.relative(ROOT, binary)} (${(fs.statSync(binary).size / 1e6).toFixed(1)} MB)`
);

cleanEngineBin(process.platform);
