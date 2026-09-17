// Takes pictures of the built interface, the same way audit.mjs measures it.
//
// Design changes are the one kind of change a test suite cannot check. In the
// reference, three of them reached main before anyone looked at the result —
// and the last turned out to have almost no effect at all, because the heading
// token pointed at a real typeface that nothing on screen ever asked for.
//
//   bun run shot                 # every route, both themes, into .shots/
//
// The pictures are of the export in headless Chrome, not of the Tauri window.
// What differs between them is the webview, not the stylesheet.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, waitForPage, sleep } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "out");
const shotDir = join(here, "..", ".shots");

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


const routes = ["/", "/diagnostics"];
const themes = ["light", "dark"];

// Pulled from the auditor so the screens are populated the same way.
const stubSource = (await readFile(join(here, "contrast-audit.mjs"), "utf8"))
  .split("const TAURI_STUB = `")[1]
  .split("`;")[0];

// Rows are found by `data-row` so a change of shape cannot quietly take the
// pictures of an empty screen instead.
const REACH = {
  "/": `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-row="workspace"]')?.click();
    await wait(400);
    document.querySelector('[data-row="session"]')?.click();
    await wait(400);
  })()`,
};

await mkdir(shotDir, { recursive: true });
const target = await waitForPage(`http://127.0.0.1:${cdpPort}`);
const client = await connect(target.webSocketDebuggerUrl);
await client.send("Page.enable");
await client.send("Page.addScriptToEvaluateOnNewDocument", { source: stubSource });

for (const route of routes) {
  for (const theme of themes) {
    await client.send("Page.navigate", { url: `http://127.0.0.1:${port}${route}` });
    await sleep(1500);
    await client.send("Runtime.evaluate", {
      expression: `document.documentElement.dataset.theme=${JSON.stringify(theme)};
                   document.documentElement.style.colorScheme=${JSON.stringify(theme)};`,
    });
    if (REACH[route]) {
      await client.send("Runtime.evaluate", {
        expression: REACH[route],
        awaitPromise: true,
      });
    }
    await sleep(600);
    const { data } = await client.send("Page.captureScreenshot", { format: "png" });
    const name = `${route === "/" ? "workspace" : route.slice(1)}-${theme}.png`;
    await writeFile(join(shotDir, name), Buffer.from(data, "base64"));
    console.log(`  ${name}`);
  }
}

stop();
process.exit(0);
