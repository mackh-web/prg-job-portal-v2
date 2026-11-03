import { Link } from "react-router-dom";
import { StatusChip, JobStatusPill } from "@/components/StatusChip";
import { formatDate } from "@/lib/date";
import { Calendar, Truck, User as UserIcon } from "@phosphor-icons/react";
export default function JobCard({ job, showIndicators = true, testId }) {
  const ind = job.indicators;
  const chiefs = (job.crew || []).filter((c) => c.is_crew_chief).map((c) => c.user_name).join(", ");
  return (
    <Link
      to={`/jobs/${job.id}`}
      data-testid={testId || `job-card-${job.id}`}
      className="group block relative overflow-hidden bg-card border border-border rounded-card p-5 hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(0,0,0,0.4)] transition-[transform,box-shadow] duration-200"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] text-muted-foreground tracking-widest mb-1">{job.winhits_number}</div>
          <h3 className="font-display font-bold text-lg leading-tight truncate group-hover:text-prg-red transition-colors">{job.name}</h3>
        </div>
        <JobStatusPill status={job.status} />
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-muted-foreground mb-4">
        <div className="flex items-center gap-1.5"><Calendar size={12} /> Prep {formatDate(job.prep_date)}</div>
        <div className="flex items-center gap-1.5"><Truck size={12} /> Ship {formatDate(job.ship_date)}</div>
        {job.project_manager && <div className="flex items-center gap-1.5"><UserIcon size={12} /> PM {job.project_manager}</div>}
        {chiefs && <div className="flex items-center gap-1.5"><UserIcon size={12} /> CC {chiefs}</div>}
      </div>
      {showIndicators && ind && (
        <div className="flex flex-wrap gap-1.5 pt-3 border-t border-border">
          <StatusChip label="Crew" state={ind.crew} testId={`ind-crew-${job.id}`} />
          <StatusChip label="Docs" state={ind.documents} testId={`ind-docs-${job.id}`} />
          <StatusChip label="Prep Adds" state={ind.prep_adds} testId={`ind-prep-${job.id}`} />
          <StatusChip label="Ideal" state={ind.ideal_prep} testId={`ind-ideal-${job.id}`} />
          <StatusChip label="Faults" state={ind.faults} testId={`ind-faults-${job.id}`} />
          <StatusChip label="Travel" state={ind.travel} testId={`ind-travel-${job.id}`} />
        </div>
      )}
    </Link>
  );
}