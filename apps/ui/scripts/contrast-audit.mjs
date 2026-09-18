// Measures text contrast in the running desktop app and fails when it is short
// of WCAG AA.
//
// This check found 144 real shortfalls the day it was written, none of which
// any test or typecheck had anything to say about: dark mode read its muted
// text from a scale step meant for hovered backgrounds, and 132 places across
// the app coloured text with steps meant for solid backgrounds. Both looked
// entirely reasonable in the source. Only the ratio gave them away.
//
//   node scripts/contrast-audit.mjs
//   node scripts/contrast-audit.mjs --eval 'window.dispatchEvent(new Event("openwork:native-menu:open-settings"))'
//
// It reads whatever screen the app is on, so reach the screen first with --url,
// --eval, or run it once per screen.
//
// Carried over from OpenWork with one change: a --url option, because here the
// auditor opens the route itself rather than driving an already-running app.
// scripts/audit.mjs drives it against the built export in headless Chrome —
// Tauri uses the system webview and none of the three speak CDP, but what is
// measured is the stylesheet, and that is the same either way.
//
// Exits non-zero when something is short, so it can gate a change.

import { readFile } from "node:fs/promises";
import { connect, discoverEndpoint, sleep, waitForPage } from "./cdp.mjs";

// Runs inside the page. Written as one expression because that is what
// Runtime.evaluate takes, and in ES5 because it is not going through the build.
const AUDIT = `(function () {
  // The theme is built from oklab and color-mix, which no hand-written parser
  // survives. Painting a colour onto a canvas and reading the pixel back asks
  // the browser to resolve it instead.
  var canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  var ctx = canvas.getContext("2d", { willReadFrequently: true });
  var cache = {};
  function toRgba(value) {
    if (cache[value]) return cache[value];
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    var d = ctx.getImageData(0, 0, 1, 1).data;
    return (cache[value] = [d[0], d[1], d[2], d[3] / 255]);
  }
  function hex(c) {
    return "#" + [c[0], c[1], c[2]].map(function (v) {
      return Math.round(v).toString(16).padStart(2, "0");
    }).join("");
  }
  function luminance(c) {
    var a = [c[0], c[1], c[2]].map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  // Walk up until something actually paints; a transparent parent is not the
  // colour the text sits on.
  function backdrop(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      var c = toRgba(getComputedStyle(node).backgroundColor);
      if (c[3] > 0.85) return c;
      node = node.parentElement;
    }
    return toRgba(getComputedStyle(document.body).backgroundColor);
  }

  var failures = [];
  var checked = 0;

  document.querySelectorAll("*").forEach(function (el) {
    if (el.children.length) return;
    var text = (el.textContent || "").trim();
    if (!text || text.length < 3) return;
    var box = el.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) return;

    var style = getComputedStyle(el);
    var opacity = parseFloat(style.opacity);
    if (style.visibility === "hidden" || opacity < 0.15) return;

    // A placeholder is meant to read as absent; holding it to body-text
    // contrast would make it look like a filled-in value.
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;

    // A disabled control is exempt. This is WCAG 2.1 SC 1.4.3 itself, which
    // excludes "text or images of text that are part of an inactive user
    // interface component", not a convenience added to make a number go green.
    //
    // It is enforced narrowly on purpose: only a control the browser reports as
    // disabled, or one that says so through aria. Skipping by class name or by
    // opacity would quietly exempt anything faint.
    var control = el.closest("button, input, select, textarea, fieldset, [aria-disabled]");
    if (control && (control.disabled === true || control.getAttribute("aria-disabled") === "true")) {
      return;
    }

    checked += 1;
    var fg = toRgba(style.color);
    var bg = backdrop(el);
    var alpha = fg[3] * (isNaN(opacity) ? 1 : opacity);
    var blended = [0, 1, 2].map(function (i) { return fg[i] * alpha + bg[i] * (1 - alpha); });

    var l1 = luminance(blended);
    var l2 = luminance(bg);
    var ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

    var size = parseFloat(style.fontSize);
    var weight = parseInt(style.fontWeight, 10) || 400;
    // AA relaxes for large text: 24px, or 18.66px when bold.
    var need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;

    if (ratio < need) {
      failures.push({
        text: text.slice(0, 40),
        ratio: Math.round(ratio * 100) / 100,
        need: need,
        size: size,
        weight: weight,
        color: hex(blended),
      });
    }
  });

  failures.sort(function (a, b) { return a.ratio - b.ratio; });

  return {
    title: document.title,
    theme: document.documentElement.dataset.theme || "(follows the system)",
    background: hex(toRgba(getComputedStyle(document.body).backgroundColor)),
    checked: checked,
    failures: failures,
  };
})()`;

// Stand-in data for the audit. Shaped like what the commands really return, so
// the screens render the way they do in the application — long names, real
// timestamps, several rows — rather than in a tidy empty state that hides how
// the layout behaves once it has something in it.
// Stand-in data for the audit, read from the same fixtures the dev mock uses.
//
// Two sets of pretend data drift apart, and then the thing being audited is not
// the thing being looked at.
const TAURI_STUB = `
(function () {
  var answers = ${await readFile(new URL("../app/dev-fixtures.json", import.meta.url), "utf8")};
  var now = Date.now();
  (function fix(v) {
    if (Array.isArray(v)) return v.forEach(fix);
    if (v && typeof v === "object") {
      for (var k in v) {
        if (typeof v[k] === "number" && /At$/.test(k)) v[k] = now + v[k];
        else fix(v[k]);
      }
    }
  })(answers);
  window.__TAURI_INTERNALS__ = {
    transformCallback: function (cb) { return cb; },
    invoke: function (cmd) {
      return Promise.resolve(
        Object.prototype.hasOwnProperty.call(answers, cmd) ? answers[cmd] : null,
      );
    }
  };
})();
`;

const args = parseArgs(process.argv.slice(2));
const settleMs = Number(args.settle ?? 4000);
const limit = Number(args.limit ?? 20);

const endpoint = args.cdp ?? (await discoverEndpoint());
const target = await waitForPage(endpoint);
const client = await connect(target.webSocketDebuggerUrl);

try {
  // Added for this repository: a stand-in for Tauri, installed before the page
  // loads.
  //
  // Without it the audit is nearly worthless. Outside Tauri every screen falls
  // back to "This page is open in an ordinary browser", and the first run
  // checked six text nodes — none of them part of the interface anyone uses. The
  // stand-in answers the commands with plausible data so the real screens render
  // and can be measured.
  //
  // It has to go in before the document runs, not after: the page decides
  // whether it is inside Tauri while it mounts.
  if (args["stub-tauri"]) {
    await client.send("Page.enable");
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source: TAURI_STUB });
  }

  // The reference drives an already-running app, so it never needed to navigate.
  // Here the auditor opens each route itself.
  if (args.url) {
    await client.send("Page.enable");
    await client.send("Page.navigate", { url: args.url });
    await sleep(1500);
  }
  // The theme is forced rather than left to the machine's preference, so a run
  // on a light laptop and a run on a dark CI runner measure the same thing.
  if (args.theme) {
    await client.send("Runtime.evaluate", {
      expression: `document.documentElement.dataset.theme = ${JSON.stringify(args.theme)};
                   document.documentElement.style.colorScheme = ${JSON.stringify(args.theme)};`,
    });
  }

  if (args.eval) {
    await client.send("Runtime.evaluate", { expression: args.eval, awaitPromise: true, returnByValue: true });
  }
  await sleep(settleMs);

  const { result, exceptionDetails } = await client.send("Runtime.evaluate", {
    expression: AUDIT,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text);

  const report = result.value;
  console.log(`screen: ${report.title}   theme: ${report.theme}   background: ${report.background}`);
  console.log(`${report.checked} text nodes checked, ${report.failures.length} short of AA`);

  for (const row of report.failures.slice(0, limit)) {
    console.log(
      `  ${String(row.ratio).padStart(5)}:1 (needs ${row.need})  ${row.size}px/${row.weight}  ${row.color}  ${JSON.stringify(row.text)}`,
    );
  }
  if (report.failures.length > limit) {
    console.log(`  … and ${report.failures.length - limit} more`);
  }

  process.exitCode = report.failures.length === 0 ? 0 : 1;
} finally {
  client.close();
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) args[arg.slice(2)] = argv[++i];
    else args._.push(arg);
  }
  return args;
}
