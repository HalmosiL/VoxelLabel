import { afterEach, describe, expect, it, vi } from "vitest";

// G-14: a failed load of the practice scan stuck until a full page reload
// (the rejected promise was cached), and a slow one showed no progress.
describe("loading the practice scan", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("tries again after a failure instead of keeping the failure", async () => {
    const { loadTutorialVolume } = await import("./tutorialSlice");
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(new Response(new Int16Array([1, 2, 3]).buffer));
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadTutorialVolume()).rejects.toThrow();
    const vol = await loadTutorialVolume();
    expect(Array.from(vol)).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports how much of the download has arrived", async () => {
    const { loadTutorialVolume } = await import("./tutorialSlice");
    const bytes = new Int16Array([5, 6, 7, 8]).buffer;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } })));
    const seen: [number, number][] = [];
    const vol = await loadTutorialVolume((loaded, total) => seen.push([loaded, total]));
    expect(Array.from(vol)).toEqual([5, 6, 7, 8]);
    expect(seen[seen.length - 1]).toEqual([8, 8]);
  });
});
