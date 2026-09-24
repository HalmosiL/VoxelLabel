import { describe, expect, it } from "vitest";

import { assetUrl } from "./config";

describe("assetUrl", () => {
  it("puts the API's base in front of a signed-link path and leaves absolute URLs alone", () => {
    expect(assetUrl("https://api.example.org/data-api/", "/data/objects?key=k&exp=1&sig=s")).toBe("https://api.example.org/data-api/data/objects?key=k&exp=1&sig=s");
    expect(assetUrl("http://localhost:8002", "/data/objects?key=k")).toBe("http://localhost:8002/data/objects?key=k");
    expect(assetUrl("http://localhost:8002", "http://minio:9000/b/k?X-Amz=1")).toBe("http://minio:9000/b/k?X-Amz=1");
    expect(assetUrl("http://localhost:8002", null)).toBeNull();
  });
});
