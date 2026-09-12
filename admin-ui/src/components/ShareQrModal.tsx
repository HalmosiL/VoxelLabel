import { useEffect, useState } from "react";
import QRCode from "qrcode";

import Modal from "./Modal";

/** A QR code of this deployment's own address, so a tablet (or a phone)
 * gets to the same place by scanning instead of typing a long tunnel /
 * server URL. The address is simply where this page is served from --
 * behind the ngrok launcher that's the public tunnel URL, on a test
 * server its hostname, locally http://localhost:5173 -- nothing is
 * configured or stored anywhere. Rendered client-side (the `qrcode`
 * package), so the address never leaves the browser. */
export default function ShareQrModal({ onClose, path = "/" }: { onClose: () => void; path?: string }) {
  const url = `${window.location.origin}${path}`;
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, { width: 288, margin: 1, errorCorrectionLevel: "M", color: { dark: "#111827", light: "#ffffff" } })
      .then((d) => {
        if (!cancelled) setDataUrl(d);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused (insecure context, permissions)
      // -- the address is printed right below the code either way.
    }
  }

  return (
    <Modal title="Open on a tablet or phone" onClose={onClose}>
      <p className="hint mb-4">Scan this with the tablet&apos;s camera -- it opens this same VoxelLabel at its current address.</p>
      <div className="flex flex-col items-center gap-3">
        {dataUrl ? (
          <img src={dataUrl} alt={`QR code for ${url}`} width={288} height={288} className="rounded-xl border border-gray-100 bg-white p-2 shadow-sm" data-testid="share-qr" />
        ) : (
          <div className="flex h-[288px] w-[288px] items-center justify-center rounded-xl border border-gray-100 text-sm text-gray-400">Generating…</div>
        )}
        <code className="code-chip max-w-full break-all text-center text-sm" data-testid="share-url">
          {url}
        </code>
        <button type="button" onClick={copy} className="btn-secondary btn-sm">
          {copied ? "Copied" : "Copy address"}
        </button>
        {/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url) && (
          <p className="hint text-center">
            This is a localhost address -- only this computer can open it. Start the system with <code className="code-chip">scripts/run-with-ngrok.sh</code> (or on a server) to get an address a tablet can reach.
          </p>
        )}
      </div>
    </Modal>
  );
}
