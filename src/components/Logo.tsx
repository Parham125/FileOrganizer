import { useId } from "react";

// The app mark: an indexed folder. Vector, so it stays crisp at any size and
// matches the desktop icon.
export default function Logo({
  className = "h-7 w-7",
}: {
  className?: string;
}) {
  const bg = useId();
  const body = useId();
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden="true">
      <defs>
        <linearGradient
          id={bg}
          x1="0"
          y1="0"
          x2="1024"
          y2="1024"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#357a65" />
          <stop offset="1" stopColor="#22503f" />
        </linearGradient>
        <linearGradient
          id={body}
          x1="272"
          y1="410"
          x2="512"
          y2="730"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#f7f4ee" />
          <stop offset="1" stopColor="#ece6da" />
        </linearGradient>
      </defs>
      <rect
        x="0"
        y="0"
        width="1024"
        height="1024"
        rx="232"
        fill={`url(#${bg})`}
      />
      <rect x="286" y="352" width="270" height="130" rx="36" fill="#cdbfa6" />
      <rect
        x="272"
        y="410"
        width="480"
        height="322"
        rx="48"
        fill={`url(#${body})`}
      />
      <rect x="330" y="486" width="372" height="44" rx="22" fill="#2f6f5e" />
      <rect x="330" y="560" width="300" height="44" rx="22" fill="#2f6f5e" />
      <rect x="330" y="634" width="200" height="44" rx="22" fill="#b7791f" />
    </svg>
  );
}
