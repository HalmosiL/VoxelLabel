import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above the imports, so anything its factory uses
// has to be hoisted too.
const kc = vi.hoisted(() => ({ token: undefined as string | undefined, refreshToken: undefined as string | undefined, idToken: undefined as string | undefined }));
vi.mock("../keycloak", () => ({ default: kc }));

import { refreshViewerHandoffOnClick, withViewerHandoff } from "./viewerHandoff";

describe("withViewerHandoff", () => {
  beforeEach(() => {
    kc.token = "AT";
    kc.refreshToken = "RT";
    kc.idToken = "IT";
  });

  it("puts the three tokens in the fragment, never the query string", () => {
    const url = withViewerHandoff("http://v/tutorial");
    const [base, frag] = url.split("#");
    expect(base).not.toContain("at=");
    const p = new URLSearchParams(frag);
    expect(p.get("at")).toBe("AT");
    expect(p.get("rt")).toBe("RT");
    expect(p.get("it")).toBe("IT");
  });

  it("adds the cache-buster once, before the fragment, and is idempotent", () => {
    const once = withViewerHandoff("http://v/viewer/series/1?studyId=s");
    expect(once.split("#")[0]).toMatch(/\?studyId=s&cb=[\w-]+$/);
    const twice = withViewerHandoff(once.split("#")[0]);
    expect(twice.split("#")[0].match(/cb=/g)).toHaveLength(1);
  });

  it("falls back to the bare (busted) URL when there is no session", () => {
    kc.idToken = undefined;
    const url = withViewerHandoff("http://v/tutorial");
    expect(url).not.toContain("#");
    expect(url).toContain("?cb=");
  });

  it("refreshes a stale href at click time", () => {
    const a = document.createElement("a");
    a.href = withViewerHandoff("http://v/tutorial");
    kc.token = "AT2";
    refreshViewerHandoffOnClick({ currentTarget: a } as unknown as React.MouseEvent<HTMLAnchorElement>);
    expect(new URLSearchParams(a.href.split("#")[1]).get("at")).toBe("AT2");
    expect(a.href.split("#")[0].match(/cb=/g)).toHaveLength(1);
  });
});
