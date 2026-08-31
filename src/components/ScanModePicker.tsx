import type { ScanMode } from "../types";
import Segmented from "./Segmented";

export default function ScanModePicker({
  value,
  onChange,
  disabled,
}: {
  value: ScanMode;
  onChange: (m: ScanMode) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={
        "space-y-1.5" + (disabled ? " pointer-events-none opacity-60" : "")
      }
    >
      <Segmented<ScanMode>
        ariaLabel="How the scan reads the disk"
        value={value}
        onChange={onChange}
        options={[
          { value: "auto", label: "Auto" },
          { value: "sequential", label: "One at a time" },
        ]}
      />
      <p className="max-w-xs text-xs leading-relaxed text-ink-soft">
        {value === "auto"
          ? "Reads many files at once. Right for an internal SSD."
          : "Reads one file at a time. Usually much faster on an external or spinning hard drive."}
      </p>
    </div>
  );
}
