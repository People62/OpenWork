// Serves the built interface and audits it in headless Chrome.
//
// The reference drives the running Electron app through its DevTools endpoint.
// Tauri uses the system webview — WebKitGTK here, WKWebView and WebView2
// elsewhere — and none of them speak CDP. But the interface is a static export,
// so the same CSS and the same components can be audited in a browser. What is
// measured is the stylesheet, and that is identical either way.
//
//   bun run audit                    # audits every route
//   bun run audit -- /diagnostics    # one route
//
// Exits non-zero when something is short of WCAG AA, so it can gate a change.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "out");

const routes = process.argv.slice(2).filter((a) => a.startsWith("/"));
const wanted = routes.length > 0 ? routes : ["/", "/diagnostics"];

// Both themes, every time.
//
// The design notes say dark mode is where the shortfalls actually happen — it
// once read its muted text from a scale step meant for hovered backgrounds.
// Auditing only the theme the machine happens to prefer would have missed it.
const themes = ["light", "dark"];

// Reaching the screen that matters.
//
// The workspace opens on an empty state, which is seven text nodes and none of
// the interface anyone uses. Clicking through to a conversation is what puts the
// message list, the composer and the session list on screen where they can be
// measured.
const REACH = {
  "/": `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const first = (sel) => document.querySelector(sel);
    first("aside ul li button")?.click();
    await wait(400);
    const lists = document.querySelectorAll("aside ul");
    lists[1]?.querySelector("li button")?.click();
    await wait(400);
  })()`,
};

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function serve() {
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = join(outDir, path);
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    } catch {
      // trailingSlash: true means /route is on disk as /route/index.html.
      file = join(outDir, path, "index.html");
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
}

function launchChrome(port) {
  return spawn(
    "google-chrome",
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--no-sandbox",
      "--disable-gpu",
      "--window-size=1440,900",
      "--disable-dev-shm-usage",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
}

const { server, port } = await serve();
const cdpPort = 9222 + Math.floor(Math.random() * 100);
const chrome = launchChrome(cdpPort);

const stop = () => {
  chrome.kill();
  server.close();
};
process.on("exit", stop);

// Wait for Chrome's endpoint.
let ready = false;
for (let i = 0; i < 60; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    if (r.ok) {
      ready = true;
      break;
    }
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 250));
}
if (!ready) {
  console.error("audit: Chrome never opened a DevTools endpoint");
  stop();
  process.exit(1);
}

let failed = false;
for (const route of wanted) {
  for (const theme of themes) {
    const url = `http://127.0.0.1:${port}${route}`;
    console.log(`\n── ${route}  ${theme} ──`);
    const argv = [
      join(here, "contrast-audit.mjs"),
      "--cdp",
      `http://127.0.0.1:${cdpPort}`,
      "--url",
      url,
      "--stub-tauri",
      "1",
      "--theme",
      theme,
      "--settle",
      "1500",
    ];
    if (REACH[route] && !process.env.AUDIT_NO_REACH) argv.push("--eval", REACH[route]);
    const child = spawn(process.execPath, argv, { stdio: "inherit" });
    const code = await new Promise((r) => child.on("exit", r));
    if (code !== 0) failed = true;
  }
}

stop();
process.exit(failed ? 1 : 0);
