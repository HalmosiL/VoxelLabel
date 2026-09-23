import { describe, expect, it } from "vitest";

import { withoutImages } from "./ScreenSnapshot";

describe("withoutImages", () => {
  it("adds the hiding style inside the head, leaving the pictures in the document", () => {
    const doc = '<!doctype html><html><head><style>.a{}</style></head><body><img data-vl-shot="" src="data:image/webp;base64,AA" style="width:1px;"></body></html>';
    const out = withoutImages(doc);
    expect(out.indexOf("img[data-vl-shot]")).toBeLessThan(out.indexOf("</head>"));
    expect(out).toContain('src="data:image/webp;base64,AA"');
    expect(withoutImages("<body></body>").startsWith("<style>")).toBe(true);
  });
});
