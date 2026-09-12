import { describe, expect, it, vi } from "vitest";

vi.mock("../keycloak", () => ({ default: { token: "t" } }));

import { ApiError, describeApiError } from "./client";

describe("describeApiError", () => {
  it("keeps the backend's specific detail for a 409", () => {
    expect(describeApiError(new ApiError(409, JSON.stringify({ detail: "You cannot remove your own admin membership" })))).toBe(
      "You cannot remove your own admin membership"
    );
  });
  it("turns a bare 403 into a permission sentence", () => {
    expect(describeApiError(new ApiError(403, JSON.stringify({ detail: "Insufficient study role" })))).toMatch(/permission/);
  });
  it("unwraps a proxied (nested) detail", () => {
    const nested = JSON.stringify({ detail: JSON.stringify({ detail: "inner reason" }) });
    expect(describeApiError(new ApiError(422, nested))).toBe("Invalid request: inner reason");
  });
  it("joins pydantic validation errors", () => {
    const body = JSON.stringify({ detail: [{ msg: "field required" }, { msg: "too short" }] });
    expect(describeApiError(new ApiError(422, body))).toBe("Invalid request: field required; too short");
  });
  it("explains a network failure and a 5xx plainly", () => {
    expect(describeApiError(new TypeError("Failed to fetch"))).toMatch(/reach the server/);
    expect(describeApiError(new ApiError(502, "{}"))).toMatch(/HTTP 502/);
  });
});
