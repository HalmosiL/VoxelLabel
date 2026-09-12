import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ShareQrModal from "./ShareQrModal";

describe("ShareQrModal", () => {
  it("encodes this page's own origin as a QR image and prints the address", async () => {
    render(<ShareQrModal onClose={() => {}} />);
    // jsdom's origin is http://localhost:3000 -- the modal reads it live,
    // nothing is configured.
    expect(screen.getByTestId("share-url").textContent).toBe(`${window.location.origin}/`);
    const img = await waitFor(() => screen.getByTestId("share-qr") as HTMLImageElement);
    expect(img.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(img.alt).toContain(window.location.origin);
  });

  it("warns that a localhost address is not reachable from a tablet", () => {
    render(<ShareQrModal onClose={() => {}} />);
    expect(screen.getByText(/only this computer can open it/)).toBeInTheDocument();
  });
});
