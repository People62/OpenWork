// Tests written alongside the feature, not after it.
//
// These parsers are the part of the Den sign-in testable without a window,
// without Tauri, and without Den. Shrinking the untestable part as far as it
// will go is the whole strategy of this phase — what is left is two native
// touches.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DEN,
  normalizeDenBaseUrl,
  parseAuthLink,
  parseManualPaste,
} from "./links";

describe("parseAuthLink", () => {
  test("parses an openwork://den-auth deep link", () => {
    expect(
      parseAuthLink(
        "openwork://den-auth?grant=abc123def456&denBaseUrl=https://den.example.com",
      ),
    ).toEqual({ grant: "abc123def456", denBaseUrl: "https://den.example.com" });
  });

  test("accepts the development scheme, so dev builds do not fight over registration", () => {
    expect(parseAuthLink("openwork-dev://den-auth?grant=abc123def456")).toEqual({
      grant: "abc123def456",
      denBaseUrl: DEFAULT_DEN,
    });
  });

  test("recognises den-auth as a path, not only as a host", () => {
    // The shape differs by scheme: on openwork:// it is the host, on https:// it
    // is the path.
    expect(parseAuthLink("https://app.example.com/den-auth?grant=abc123def456")).toEqual({
      grant: "abc123def456",
      denBaseUrl: DEFAULT_DEN,
    });
  });

  test("a link without a grant is useless", () => {
    expect(parseAuthLink("openwork://den-auth")).toBeNull();
    expect(parseAuthLink("openwork://den-auth?grant=")).toBeNull();
  });

  test("other routes are ignored", () => {
    expect(parseAuthLink("openwork://connect-remote?grant=abc123def456")).toBeNull();
  });

  test("foreign schemes are refused", () => {
    expect(parseAuthLink("javascript://den-auth?grant=abc123def456")).toBeNull();
    expect(parseAuthLink("file://den-auth?grant=abc123def456")).toBeNull();
  });

  test("input that is not a URL does not throw", () => {
    expect(parseAuthLink("not a url at all")).toBeNull();
    expect(parseAuthLink("")).toBeNull();
  });

  test("a nonsensical denBaseUrl falls back to the default instead of being passed through", () => {
    // If this were passed through, the application would send the grant wherever
    // an attacker decided.
    expect(
      parseAuthLink("openwork://den-auth?grant=abc123def456&denBaseUrl=javascript:alert(1)")
        ?.denBaseUrl,
    ).toBe(DEFAULT_DEN);
  });
});

describe("parseManualPaste", () => {
  test("accepts a whole pasted link", () => {
    expect(parseManualPaste("  openwork://den-auth?grant=abc123def456  ")).toEqual({
      grant: "abc123def456",
      denBaseUrl: DEFAULT_DEN,
    });
  });

  test("accepts a bare code", () => {
    expect(parseManualPaste("a-code-long-enough")).toEqual({
      grant: "a-code-long-enough",
      denBaseUrl: DEFAULT_DEN,
    });
  });

  test("refuses an accidental keystroke that is too short", () => {
    expect(parseManualPaste("short")).toBeNull();
    expect(parseManualPaste("   ")).toBeNull();
  });

  test("an unrecognised URL is refused rather than treated as a code", () => {
    // A user who pastes the wrong URL should be told, not handed a bogus grant
    // as long as that URL.
    expect(parseManualPaste("https://example.com/the-wrong-page")).toBeNull();
  });
});

describe("normalizeDenBaseUrl", () => {
  test("drops the trailing slash", () => {
    expect(normalizeDenBaseUrl("https://den.example.com/")).toBe("https://den.example.com");
    expect(normalizeDenBaseUrl("https://den.example.com/base/")).toBe(
      "https://den.example.com/base",
    );
  });

  test("refuses schemes other than http and https", () => {
    expect(normalizeDenBaseUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeDenBaseUrl("file:///etc/passwd")).toBeNull();
  });

  test("refuses input that is not a URL", () => {
    expect(normalizeDenBaseUrl("not a url")).toBeNull();
    expect(normalizeDenBaseUrl("")).toBeNull();
  });
});
