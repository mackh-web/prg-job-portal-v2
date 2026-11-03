import { cn } from "@/lib/utils";

const COLORS = {
  grey: "bg-neutral-500/20 text-neutral-300 border-neutral-700",
  amber: "bg-amber-500/15 text-amber-400 border-amber-800",
  green: "bg-emerald-500/15 text-emerald-400 border-emerald-800",
  red: "bg-red-500/15 text-red-400 border-red-800",
};

const DOTS = { grey: "bg-neutral-400", amber: "bg-amber-400", green: "bg-emerald-400", red: "bg-red-500" };

export function StatusChip({ label, state = "grey", testId }) {
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-[0.14em]",
        COLORS[state] || COLORS.grey
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", DOTS[state])} />
      {label}
    </span>
  );
}

export function JobStatusPill({ status }) {
  const map = {
    Order: "bg-prg-red text-white",
    Quote: "bg-amber-500/80 text-black",
    Reservation: "bg-blue-500/80 text-white",
    Complete: "bg-emerald-600/80 text-white",
    Cancelled: "bg-neutral-500/60 text-white",
  };
  return (
    <span className={cn("px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest", map[status] || map.Reservation)}>
      {status}
    </span>
  );
}
