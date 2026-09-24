import { API, assetUrl } from "../config";
import { ImageIcon } from "./icons";

/** A study/series/instance preview image -- data-service hands its
 * thumbnails out as signed links to its own API (see assetUrl). */
export default function Thumbnail({ url, label }: { url: string | null; label?: string }) {
  const src = assetUrl(API.data, url);
  return (
    <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg bg-gray-100">
      {src ? (
        <img src={src} alt={label ?? ""} className="h-full w-full object-cover" />
      ) : (
        <ImageIcon className="h-8 w-8 text-gray-300" />
      )}
    </div>
  );
}
