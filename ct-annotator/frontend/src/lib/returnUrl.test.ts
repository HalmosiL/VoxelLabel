import { describe, expect, it } from "vitest";

import { safeReturnUrl, returnUrlForCase } from "./returnUrl";

const HERE = "https://viewer.example.org";
const ADMIN = "https://ct.example.org";

describe("safeReturnUrl", () => {
  it("keeps our own places", () => {
    expect(safeReturnUrl("/viewer/series/1", HERE, ADMIN)).toBe("/viewer/series/1");
    expect(safeReturnUrl("https://ct.example.org/studies/1/cases/2?jobId=3", HERE, ADMIN)).toBe("https://ct.example.org/studies/1/cases/2?jobId=3");
    expect(safeReturnUrl("https://viewer.example.org/", HERE, ADMIN)).toBe("https://viewer.example.org/");
  });

  it("drops script, other sites and protocol-relative tricks", () => {
    for (const bad of [
      "javascript:alert(document.domain)",
      " JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "https://evil.example.com/studies/1",
      "https://ct.example.org.evil.com/",
      "//evil.example.com/x",
      "/\\evil.example.com",
      "vbscript:x",
      "not a url",
    ]) {
      expect(safeReturnUrl(bad, HERE, ADMIN), bad).toBeNull();
    }
    expect(safeReturnUrl(null, HERE, ADMIN)).toBeNull();
  });
});

describe("returnUrlForCase", () => {
  it("follows the case on screen (D-07)", () => {
    expect(returnUrlForCase("http://ui/studies/s1/cases/c1?jobId=j1", "c1", "c2")).toBe("http://ui/studies/s1/cases/c2?jobId=j1");
  });
  it("keeps any other target", () => {
    expect(returnUrlForCase("http://ui/my-jobs/j1", "c1", "c2")).toBe("http://ui/my-jobs/j1");
    expect(returnUrlForCase(null, "c1", "c2")).toBeNull();
  });
});
