// The glyph in front of a result group. "proof" is for sets the app compared
// and can vouch for; "guess" draws the front card as a dashed ochre outline,
// because a name match is a lead the user still has to check.
export default function Stack({
  n,
  variant = "proof",
}: {
  n: number;
  variant?: "proof" | "guess";
}) {
  const layers = Math.min(n, 3);
  const front =
    variant === "guess"
      ? "border-dashed border-ochre bg-ochre-soft"
      : "border-teal-line bg-teal-soft";
  return (
    <span className="relative block h-9 w-9 shrink-0">
      {Array.from({ length: layers }).map((_, i) => (
        <span
          key={i}
          className={
            "absolute h-7 w-6 rounded-[3px] border " +
            (i === layers - 1 ? front : "border-line-strong bg-surface-2")
          }
          style={{ left: i * 4, top: i * 3, zIndex: i }}
        />
      ))}
    </span>
  );
}
