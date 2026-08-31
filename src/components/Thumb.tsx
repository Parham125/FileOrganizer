import { useState } from "react";
import { isImage } from "../thumbs";

// The preview slot for one row. The box is drawn at its final size straight
// away and the picture fades in on top of it, so a list never reflows as
// thumbnails arrive and a preview that never comes just stays a quiet box.
export default function Thumb({
  src,
  className,
  // Leading previews are cropped to a square so a column of them lines up.
  // The comparison grid keeps the whole frame instead, because a crop is
  // exactly the difference the reader is there to spot.
  fit = "cover",
}: {
  src: string | null | undefined;
  className: string;
  fit?: "cover" | "contain";
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span
      aria-hidden="true"
      // The caller owns the box: its size, its edge and its corners. Only the
      // neutral ground and the clipping belong to every preview.
      className={"block shrink-0 overflow-hidden bg-surface-2 " + className}
    >
      {src && (
        <img
          src={src}
          alt=""
          decoding="async"
          onLoad={() => setLoaded(true)}
          className={
            "h-full w-full transition-opacity duration-200 " +
            (fit === "cover" ? "object-cover " : "object-contain ") +
            (loaded ? "opacity-100" : "opacity-0")
          }
        />
      )}
    </span>
  );
}

// The leading preview in a row list. A list that mixes photos with everything
// else keeps one straight edge, and a row that can never have a preview holds
// the space open rather than showing an empty frame that suggests it might.
export function ThumbSlot({
  path,
  src,
  size,
  dim,
}: {
  path: string;
  src: string | null | undefined;
  size: string;
  dim?: boolean;
}) {
  if (!isImage(path))
    return <span aria-hidden="true" className={"block shrink-0 " + size} />;
  return (
    <Thumb
      src={src}
      className={
        size + " rounded-[4px] border border-line" + (dim ? " opacity-40" : "")
      }
    />
  );
}
