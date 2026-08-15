import { ImageIcon } from "./icons";

export default function Thumbnail({ url, label }: { url: string | null; label?: string }) {
  return (
    <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg bg-gray-100">
      {url ? (
        <img src={url} alt={label ?? ""} className="h-full w-full object-cover" />
      ) : (
        <ImageIcon className="h-8 w-8 text-gray-300" />
      )}
    </div>
  );
}
