// Fetches the OpenCode engine and places it where Tauri expects a sidecar.
//
// OpenCode is ~176 MB unpacked and is not in the repository, so a clean checkout
// has no engine. Its absence once cost three CI rounds in Rantai, because the
// error message named a signal instead of a missing file.
//
// **Every archive is verified against a pinned sha256.** The reference
// implementation computes a hash and records it afterwards, but never compares
// it against a known value — so the download is verified against nothing but the
// URL it came from. A mismatch here stops the build.
//
// The engine ships as a Tauri *resource*, not as an `externalBin`, and that is a
// decision made by running both.
//
// As an externalBin it lands in `usr/bin` beside the application — and
// linuxdeploy, building the AppImage, runs patchelf over every ELF it finds
// there. That corrupts OpenCode: the copy in the AppDir dumped core, and
// linuxdeploy aborted with "Failed to run ldd". As a resource it lands in the
// resource directory, which linuxdeploy does not touch that way, and both the
// .deb and the AppImage ship an engine that actually runs.
//
// So the file written here is simply `binaries/opencode` — resources carry no
// target-triple suffix.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const config = JSON.parse(readFileSync(join(desktopDir, "opencode.json"), "utf8"));

/// Where Tauri looks for external binaries, per `tauri.conf.json`.
const binariesDir = join(desktopDir, "src-tauri", "binaries");

/// The Rust target triple we are packaging for. Read from the environment so CI
/// can be explicit; otherwise inferred from this machine.
function targetTriple() {
  const explicit = process.env.RANTAI_TARGET_TRIPLE?.trim();
  if (explicit) return explicit;

  const { platform, arch } = process;
  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "linux") {
    return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  if (platform === "win32") {
    return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  return null;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fail(message) {
  console.error(`prepare-sidecar: ${message}`);
  process.exit(1);
}

const triple = targetTriple();
if (!triple) {
  fail(`unsupported platform: ${process.platform}/${process.arch}`);
}

const asset = config.assets[triple];
if (!asset) {
  fail(
    `no OpenCode asset pinned for ${triple}. Pinned targets: ${Object.keys(config.assets).join(", ")}`,
  );
}

const isWindows = triple.includes("windows");
const binaryName = isWindows ? "opencode.exe" : "opencode";
const destination = join(binariesDir, binaryName);

if (existsSync(destination) && !process.env.RANTAI_SIDECAR_FORCE) {
  console.log(`prepare-sidecar: ${destination} already exists — nothing to do`);
  process.exit(0);
}

const url = `https://github.com/${config.repo}/releases/download/${config.version}/${asset.file}`;
const work = mkdtempSync(join(tmpdir(), "rantai-sidecar-"));
const archive = join(work, asset.file);

try {
  console.log(`prepare-sidecar: fetching ${url}`);
  execFileSync("curl", ["-fsSL", "--retry", "3", "-o", archive, url], {
    stdio: ["ignore", "inherit", "inherit"],
  });

  const actual = sha256(archive);

  if (process.env.RANTAI_SIDECAR_PRINT_HASH) {
    console.log(`prepare-sidecar: sha256 for ${triple} is ${actual}`);
  }

  if (actual !== asset.sha256) {
    fail(
      `sha256 mismatch for ${asset.file}\n` +
        `  expected ${asset.sha256}\n` +
        `  actual   ${actual}\n` +
        `The archive is not the one this repository pins. It is refused rather than used.`,
    );
  }
  console.log(`prepare-sidecar: sha256 verified against the pinned value`);

  if (asset.file.endsWith(".zip")) {
    execFileSync("unzip", ["-q", archive, "-d", work], { stdio: "inherit" });
  } else if (asset.file.endsWith(".tar.gz")) {
    execFileSync("tar", ["-xzf", archive, "-C", work], { stdio: "inherit" });
  } else {
    fail(`unknown archive format: ${asset.file}`);
  }

  // The archives place the binary somewhere under the extraction directory; find
  // it rather than assuming a layout that can change between releases.
  const found = findBinary(work, binaryName);
  if (!found) {
    fail(`${binaryName} was not found inside ${asset.file}`);
  }

  mkdirSync(binariesDir, { recursive: true });
  renameSync(found, destination);
  if (!isWindows) chmodSync(destination, 0o755);

  const megabytes = (statSync(destination).size / 1024 / 1024).toFixed(0);
  console.log(`prepare-sidecar: wrote ${destination} (${megabytes} MB)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function findBinary(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const deeper = findBinary(path, name);
      if (deeper) return deeper;
    } else if (entry.name === name) {
      return path;
    }
  }
  return null;
}
