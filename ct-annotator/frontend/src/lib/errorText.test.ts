import { describe, expect, it } from "vitest";

import { ApiError } from "../api/client";
import { errorText } from "./errorText";

describe("errorText (K7)", () => {
  it("says a lost connection in words, never 'TypeError: Failed to fetch'", () => {
    expect(errorText(new TypeError("Failed to fetch"))).toBe("Lost the connection to the server -- check your network and try again.");
    expect(errorText(new TypeError("NetworkError when attempting to fetch resource."))).toMatch(/^Lost the connection/);
  });

  it("gives the service's own reason, not the raw body", () => {
    expect(errorText(new ApiError(503, JSON.stringify({ detail: "File storage is unavailable right now -- try again in a minute." })))).toBe(
      "File storage is unavailable right now -- try again in a minute."
    );
    expect(errorText(new ApiError(404, JSON.stringify({ detail: "Case not found" })))).toBe("Case not found");
    expect(errorText(new ApiError(500, "Internal Server Error"))).toBe("The server had a problem -- try again in a minute.");
  });

  it("keeps a plain message", () => {
    expect(errorText(new Error("This case has no imaging series to view."))).toBe("This case has no imaging series to view.");
  });
});
