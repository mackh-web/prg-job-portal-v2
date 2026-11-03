import { useEffect, useMemo, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { api, formatErr } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { hasAnyRole, ROLES } from "@/lib/permissions";
import { CaretLeft, CaretRight, CalendarBlank, Plus, X, Wrench, PencilSimple, Trash } from "@phosphor-icons/react";
import { toast } from "sonner";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const PREP_BAYS = [
  "Prep Bay 0", "Prep Bay 1", "Prep Bay 2", "Prep Bay 3",
  "Prep Bay 4 (Small GS)", "Prep Bay 5 (Small GS)",
  "Prep Bay 6", "Prep Bay 7", "Prep Bay 8", "Prep Bay 9",
  "Prep Bay 10 (Large GS)", "Prep Bay 11", "The Bridge",
];

const BAY_DEPARTMENTS = ["Lighting", "Video", "Rigging", "Automation"];

// Stable fallback avoids recreating empty arrays on each render.
const EMPTY_ARRAY = [];

// Colour by department, not by individual job — every bay booked for the
// same department shows the same colour, so patterns are visible at a glance.
const DEPT_COLOURS = {
  "Lighting": { bg: "hsl(38 90% 50% / 0.85)", border: "hsl(38 90% 32%)" },
  "Video": { bg: "hsl(212 85% 55% / 0.85)", border: "hsl(212 85% 35%)" },
  "Rigging": { bg: "hsl(265 70% 58% / 0.85)", border: "hsl(265 70% 38%)" },
  "Automation": { bg: "hsl(160 70% 42% / 0.85)", border: "hsl(160 70% 27%)" },
};
const NO_DEPT_COLOUR = { bg: "hsl(0 0% 55% / 0.75)", border: "hsl(0 0% 35%)" };

function deptColour(department) {
  return DEPT_COLOURS[department] || NO_DEPT_COLOUR;
}

function daysInMonth(year, monthIndex /* 0-based */) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function isoDate(year, monthIndex, day) {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export default function PrepBayCalendar() {
  const { user } = useAuth();
  const canBookBays = hasAnyRole(user, ROLES.ADMIN, ROLES.OPERATIONS_MANAGER);
  const today = useMemo(() => new Date(), []);
  const [year, setYear] = useState(today.getFullYear());
  const [monthIndex, setMonthIndex] = useState(today.getMonth()); // 0-based
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [showBooking, setShowBooking] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [editingBooking, setEditingBooking] = useState(null);

  const daysCount = daysInMonth(year, monthIndex);
  const days = Array.from({ length: daysCount }, (_, i) => i + 1);

  const load = async () => {
    setErr("");
    try {
      const { data } = await api.get("/prep-bays/bookings", { params: { year, month: monthIndex + 1 } });
      setData(data);
    } catch (e) {
      setErr(formatErr(e?.response?.data?.detail) || e.message);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setErr("");
      try {
        const { data } = await api.get("/prep-bays/bookings", { params: { year, month: monthIndex + 1 } });
        if (!cancelled) setData(data);
      } catch (e) {
        if (!cancelled) setErr(formatErr(e?.response?.data?.detail) || e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [year, monthIndex]);

  const prev = () => {
    if (monthIndex === 0) { setYear(year - 1); setMonthIndex(11); }
    else setMonthIndex(monthIndex - 1);
  };
  const next = () => {
    if (monthIndex === 11) { setYear(year + 1); setMonthIndex(0); }
    else setMonthIndex(monthIndex + 1);
  };
  const jumpToday = () => {
    setYear(today.getFullYear()); setMonthIndex(today.getMonth());
  };

  const bays = data?.bays ?? EMPTY_ARRAY;
  const bookings = data?.bookings ?? EMPTY_ARRAY;
  const manualBookings = data?.manual_bookings ?? EMPTY_ARRAY;

  const clipToMonth = useCallback((startStr, endStr) => {
    const start = new Date(startStr + "T00:00:00Z");
    const end = new Date(endStr + "T00:00:00Z");
    const firstOfMonth = new Date(Date.UTC(year, monthIndex, 1));
    const lastOfMonth = new Date(Date.UTC(year, monthIndex, daysCount));
    const clipStart = start < firstOfMonth ? firstOfMonth : start;
    const clipEnd = end > lastOfMonth ? lastOfMonth : end;
    if (clipStart > clipEnd) return null;
    return {
      startDay: clipStart.getUTCDate(), endDay: clipEnd.getUTCDate(),
      extendsLeft: start < firstOfMonth, extendsRight: end > lastOfMonth,
    };
  }, [year, monthIndex, daysCount]);

  // Build a map: bay -> array of bar descriptors (job or manual), each with department-based colour
  const barsByBay = useMemo(() => {
    const map = {};
    for (const bay of bays) map[bay] = [];
    for (const b of bookings) {
      for (const bay of b.prep_bays) {
        if (!(bay in map)) continue;
        const clip = clipToMonth(b.prep_date, b.ship_date);
        if (!clip) continue;
        const department = b.bay_departments?.[bay];
        map[bay].push({
          kind: "job", key: `job-${b.job_id}-${bay}`, ...clip,
          colour: deptColour(department), department,
          label: b.job_name, href: `/jobs/${b.job_id}`,
          title: `${b.job_name} · ${b.prep_date} → ${b.ship_date}${department ? ` · ${department}` : ""}`,
        });
      }
    }
    for (const m of manualBookings) {
      if (!(m.bay in map)) continue;
      const clip = clipToMonth(m.start_date, m.end_date);
      if (!clip) continue;
      map[m.bay].push({
        kind: "manual", key: `manual-${m.id}`, ...clip,
        colour: deptColour(m.department), department: m.department,
        label: m.label, id: m.id, bay: m.bay, start_date: m.start_date, end_date: m.end_date,
        title: `${m.label} (manual) · ${m.start_date} → ${m.end_date}${m.department ? ` · ${m.department}` : ""}${m.created_by_name ? ` · by ${m.created_by_name}` : ""}`,
      });
    }
    return map;
  }, [bays, bookings, manualBookings, clipToMonth]);

  const todayIso = today.toISOString().slice(0, 10);

  const deleteManualBooking = async (id) => {
    if (!canBookBays) return;
    if (!window.confirm("Remove this manual booking?")) return;
    try {
      await api.delete(`/prep-bays/manual-booking/${id}`);
      toast.success("Manual booking removed");
      load();
    } catch (e) { toast.error(formatErr(e?.response?.data?.detail)); }
  };

  return (
    <div className="space-y-6 overflow-x-hidden" data-testid="prep-bay-calendar-page">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">Prep bays</div>
          <h1 className="font-display font-black text-3xl">Bay booking calendar</h1>
          <p className="text-muted-foreground text-sm mt-1">Live view of every job that occupies a prep bay this month. Colour reflects department.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
          {canBookBays && (
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setShowBooking(true)} data-testid="book-bays-btn"
                className="h-9 px-3 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2">
                Book Bays <Plus size={14} />
              </button>
              <button onClick={() => setShowManual(true)} data-testid="manual-booking-btn"
                className="h-9 px-3 rounded-btn border border-border bg-secondary hover:border-prg-red text-xs font-bold uppercase tracking-widest inline-flex items-center gap-2">
                <Wrench size={14} /> Manual Booking
              </button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button onClick={prev} data-testid="calendar-prev" className="w-9 h-9 rounded-btn border border-border bg-secondary hover:border-prg-red flex items-center justify-center transition-colors shrink-0" aria-label="Previous month">
              <CaretLeft size={16} weight="bold" />
            </button>
            <div className="min-w-[140px] sm:min-w-[180px] text-center">
              <div className="font-display font-black text-lg sm:text-xl" data-testid="calendar-month-label">{MONTHS[monthIndex]} {year}</div>
              <button onClick={jumpToday} data-testid="calendar-today" className="text-[10px] uppercase tracking-widest text-muted-foreground hover:text-prg-red">Jump to today</button>
            </div>
            <button onClick={next} data-testid="calendar-next" className="w-9 h-9 rounded-btn border border-border bg-secondary hover:border-prg-red flex items-center justify-center transition-colors shrink-0" aria-label="Next month">
              <CaretRight size={16} weight="bold" />
            </button>
          </div>
        </div>
      </div>

      {err && <div className="text-sm text-red-400 border border-red-800 bg-red-500/10 rounded-input p-3">{err}</div>}
      {!data && !err && <div className="text-muted-foreground text-sm">Loading calendar…</div>}

      {data && (
        <div className="bg-card border border-border rounded-card overflow-hidden">
          <div className="overflow-x-auto scrollbar-slim">
            <div className="min-w-[1000px]">
              {/* Header row: day numbers */}
              <div className="grid" style={{ gridTemplateColumns: `160px repeat(${daysCount}, minmax(28px, 1fr))` }}>
                <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground bg-secondary border-b border-border">Bay</div>
                {days.map((d) => {
                  const iso = isoDate(year, monthIndex, d);
                  const isToday = iso === todayIso;
                  const weekday = new Date(Date.UTC(year, monthIndex, d)).getUTCDay(); // 0=Sun
                  const isWeekend = weekday === 0 || weekday === 6;
                  return (
                    <div key={d} className={`text-center py-2 text-[10px] font-semibold border-b border-l border-border ${isToday ? "bg-prg-red text-white" : isWeekend ? "bg-secondary/70 text-muted-foreground" : "bg-secondary text-foreground"}`}>
                      {d}
                    </div>
                  );
                })}
              </div>
              {/* Rows: one per bay */}
              {bays.map((bay, rowIdx) => (
                <div key={bay} className="grid relative" style={{ gridTemplateColumns: `160px repeat(${daysCount}, minmax(28px, 1fr))` }} data-testid={`calendar-row-${bay.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}>
                  <div className={`px-3 py-3 text-xs font-semibold border-b border-border sticky left-0 z-10 ${rowIdx % 2 === 0 ? "bg-card" : "bg-secondary"} truncate`}>{bay}</div>
                  {days.map((d) => {
                    const iso = isoDate(year, monthIndex, d);
                    const isToday = iso === todayIso;
                    const weekday = new Date(Date.UTC(year, monthIndex, d)).getUTCDay();
                    const isWeekend = weekday === 0 || weekday === 6;
                    return (
                      <div key={d} className={`h-10 border-b border-l border-border ${isToday ? "bg-prg-red/10" : isWeekend ? "bg-secondary" : ""}`} />
                    );
                  })}
                  {/* Absolute-positioned booking bars */}
                  {(barsByBay[bay] || []).map((b) => {
                    const totalDayCells = daysCount;
                    const startCol = b.startDay - 1;
                    const spanCols = b.endDay - b.startDay + 1;
                    const leftCalc = `calc(160px + (100% - 160px) * ${startCol} / ${totalDayCells})`;
                    const widthCalc = `calc((100% - 160px) * ${spanCols} / ${totalDayCells})`;
                    const style = {
                      left: leftCalc, width: widthCalc,
                      background: b.colour.bg,
                      border: b.kind === "manual" ? `1.5px dashed ${b.colour.border}` : `1px solid ${b.colour.border}`,
                      borderTopLeftRadius: b.extendsLeft ? 0 : 6,
                      borderBottomLeftRadius: b.extendsLeft ? 0 : 6,
                      borderTopRightRadius: b.extendsRight ? 0 : 6,
                      borderBottomRightRadius: b.extendsRight ? 0 : 6,
                    };
                    const className = "absolute top-1.5 h-7 rounded-md px-2 flex items-center text-[11px] font-semibold text-white overflow-hidden shadow-sm hover:brightness-110 transition-[filter]";
                    return b.kind === "job" ? (
                      <Link key={b.key} to={b.href} data-testid={`calendar-bar-${b.key}`} className={className} style={style} title={b.title}>
                        <span className="truncate">{b.label}</span>
                      </Link>
                    ) : (
                      <div key={b.key} data-testid={`calendar-bar-${b.key}`} className={className} style={style} title={b.title}>
                        <span className="truncate flex-1">{b.label}</span>
                        {canBookBays && (
                          <span className="flex items-center gap-1 shrink-0 ml-1">
                            <button
                              data-testid={`calendar-bar-edit-${b.id}`}
                              aria-label="Edit manual booking"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditingBooking(b); }}
                              className="p-0.5 rounded hover:bg-black/20"
                            >
                              <PencilSimple size={11} weight="bold" />
                            </button>
                            <button
                              data-testid={`calendar-bar-delete-${b.id}`}
                              aria-label="Delete manual booking"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); deleteManualBooking(b.id); }}
                              className="p-0.5 rounded hover:bg-black/20"
                            >
                              <Trash size={11} weight="bold" />
                            </button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {data && bookings.length === 0 && manualBookings.length === 0 && (
        <div className="bg-card border border-border rounded-card p-8 text-center text-muted-foreground text-sm inline-flex items-center gap-2">
          <CalendarBlank size={18} /> No prep bay bookings for {MONTHS[monthIndex]} {year}.
        </div>
      )}

      {data && (bookings.length > 0 || manualBookings.length > 0) && (
        <div className="bg-card border border-border rounded-card p-4 space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-2">Department colours</div>
            <div className="flex flex-wrap gap-2">
              {BAY_DEPARTMENTS.map((d) => (
                <span key={d} className="inline-flex items-center gap-2 text-xs bg-secondary border border-border rounded-btn px-2.5 h-8">
                  <span className="w-3 h-3 rounded-sm" style={{ background: deptColour(d).bg, border: `1px solid ${deptColour(d).border}` }} />
                  {d}
                </span>
              ))}
              <span className="inline-flex items-center gap-2 text-xs bg-secondary border border-border rounded-btn px-2.5 h-8">
                <span className="w-3 h-3 rounded-sm" style={{ background: NO_DEPT_COLOUR.bg, border: `1px solid ${NO_DEPT_COLOUR.border}` }} />
                No department
              </span>
              <span className="inline-flex items-center gap-2 text-xs bg-secondary border border-border rounded-btn px-2.5 h-8">
                <span className="w-3 h-3 rounded-sm border-2 border-dashed" style={{ borderColor: NO_DEPT_COLOUR.border }} />
                Manual booking (dashed border)
              </span>
            </div>
          </div>
          {bookings.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-2">Jobs this month</div>
              <div className="flex flex-wrap gap-2">
                {[...new Map(bookings.map((b) => [b.job_id, b])).values()].map((b) => (
                  <Link key={b.job_id} to={`/jobs/${b.job_id}`} data-testid={`calendar-legend-${b.job_id}`}
                    className="inline-flex items-center gap-2 text-xs bg-secondary border border-border rounded-btn px-2.5 h-8 hover:border-prg-red transition-colors">
                    <span className="font-semibold">{b.job_name}</span>
                    <span className="text-muted-foreground font-mono text-[10px]">{b.prep_date} → {b.ship_date}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {showBooking && (
        <BookBaysModal
          onClose={() => setShowBooking(false)}
          onSaved={() => { setShowBooking(false); load(); }}
        />
      )}

      {showManual && (
        <ManualBookingModal
          onClose={() => setShowManual(false)}
          onSaved={() => { setShowManual(false); load(); }}
        />
      )}

      {editingBooking && (
        <ManualBookingModal
          editing={editingBooking}
          onClose={() => setEditingBooking(null)}
          onSaved={() => { setEditingBooking(null); load(); }}
        />
      )}
    </div>
  );
}

/* ---------------- Book Bays modal (Admin / Ops Manager only) ---------------- */
function BookBaysModal({ onClose, onSaved }) {
  const [query, setQuery] = useState("");
  const [allJobs, setAllJobs] = useState([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [job, setJob] = useState(null);
  const [selection, setSelection] = useState({}); // { [bay]: department|null }
  const [availability, setAvailability] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      setLoadingJobs(true);
      try {
        const { data } = await api.get("/jobs", { params: { scope: "all" } });
        setAllJobs(data);
      } catch { setAllJobs([]); }
      finally { setLoadingJobs(false); }
    })();
  }, []);

  const q = query.trim().toLowerCase();
  const results = q
    ? allJobs.filter((j) => j.name?.toLowerCase().includes(q) || j.winhits_number?.toLowerCase().includes(q))
    : allJobs;

  const pickJob = async (j) => {
    setJob(j);
    setQuery("");
    setError("");
    const initial = {};
    for (const bay of j.prep_bays || []) initial[bay] = j.bay_departments?.[bay] || null;
    setSelection(initial);
    if (j.prep_date && j.ship_date) {
      try {
        const { data } = await api.get("/prep-bays/availability", {
          params: { prep_date: j.prep_date, ship_date: j.ship_date, exclude_job_id: j.id },
        });
        setAvailability(data);
      } catch { setAvailability([]); }
    }
  };

  const toggleBay = (bay) => {
    setSelection((s) => {
      const next = { ...s };
      if (bay in next) delete next[bay];
      else next[bay] = null;
      return next;
    });
  };

  const setBayDept = (bay, dept) => {
    setSelection((s) => ({ ...s, [bay]: dept || null }));
  };

  const save = async () => {
    if (!job) return;
    setSaving(true);
    setError("");
    try {
      await api.post("/prep-bays/booking", {
        job_id: job.id,
        bays: Object.entries(selection).map(([bay, department]) => ({ bay, department })),
      });
      toast.success(`Bays updated for ${job.name}`);
      onSaved();
    } catch (e) {
      setError(formatErr(e?.response?.data?.detail) || e.message);
    } finally {
      setSaving(false);
    }
  };

  const availabilityFor = (bay) => availability.find((a) => a.bay === bay);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" data-testid="book-bays-modal">
      <div className="w-full max-w-2xl bg-card border border-border rounded-modal p-6 space-y-4 animate-slide-up max-h-[90vh] overflow-y-auto scrollbar-slim">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">Prep bays</div>
            <h3 className="font-display font-black text-xl">Book Bays</h3>
          </div>
          <button onClick={onClose} data-testid="book-bays-close" className="p-2 rounded-btn hover:bg-secondary"><X size={16} /></button>
        </div>

        {!job ? (
          <div className="relative">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search or browse jobs by name or WinHits number…"
              data-testid="book-bays-job-search"
              className="w-full h-10 px-3 rounded-input bg-background border border-border text-sm focus:outline-none focus:border-prg-red"
            />
            <div className="mt-2 max-h-64 overflow-y-auto scrollbar-slim rounded-input border border-border divide-y divide-border">
              {loadingJobs && <div className="p-3 text-sm text-muted-foreground">Loading jobs…</div>}
              {!loadingJobs && results.length === 0 && <div className="p-3 text-sm text-muted-foreground">No jobs found.</div>}
              {!loadingJobs && results.map((r) => (
                <button key={r.id} onClick={() => pickJob(r)} data-testid={`book-bays-job-result-${r.id}`}
                  className="w-full text-left p-3 hover:bg-secondary text-sm">
                  <div className="font-semibold">{r.name}</div>
                  <div className="text-xs text-muted-foreground font-mono">{r.winhits_number} · {r.prep_date} → {r.ship_date}</div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="bg-background border border-border rounded-input p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold truncate">{job.name}</div>
                <div className="text-xs text-muted-foreground font-mono">{job.winhits_number} · {job.prep_date} → {job.ship_date}</div>
              </div>
              <button onClick={() => { setJob(null); setSelection({}); setAvailability([]); }} data-testid="book-bays-change-job"
                className="text-xs text-muted-foreground hover:text-prg-red shrink-0">Change job</button>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Bays</div>
              <div className="space-y-2">
                {PREP_BAYS.map((bay) => {
                  const selected = bay in selection;
                  const avail = availabilityFor(bay);
                  const conflict = avail?.conflicts?.[0];
                  const disabled = !selected && avail && !avail.available;
                  return (
                    <div key={bay} className={`flex items-center gap-2 rounded-btn border px-3 py-2 ${selected ? "border-prg-red bg-prg-red/5" : "border-border bg-background"}`}>
                      <button
                        type="button"
                        onClick={() => !disabled && toggleBay(bay)}
                        disabled={disabled}
                        data-testid={`book-bays-toggle-${bay.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}
                        title={conflict ? `Booked by ${conflict.job_name} (${conflict.prep_date} → ${conflict.ship_date})` : bay}
                        className={`flex-1 text-left text-sm font-semibold ${disabled ? "text-muted-foreground/50 line-through cursor-not-allowed" : ""}`}
                      >
                        {bay}
                      </button>
                      {selected && (
                        <select
                          value={selection[bay] || ""}
                          onChange={(e) => setBayDept(bay, e.target.value)}
                          data-testid={`book-bays-department-${bay.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}
                          className="h-8 px-2 rounded-btn bg-background border border-border text-xs"
                        >
                          <option value="">No department</option>
                          {BAY_DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="text-[10px] text-muted-foreground mt-1">Strikethrough = already booked by another job during this prep/ship window.</div>
            </div>

            {error && <div className="text-sm text-red-400 border border-red-800 bg-red-500/10 rounded-input p-3">{error}</div>}

            <div className="flex gap-2 pt-2">
              <button onClick={save} disabled={saving} data-testid="book-bays-save"
                className="h-9 px-4 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest disabled:opacity-60">
                {saving ? "Saving…" : "Save booking"}
              </button>
              <button onClick={onClose} className="h-9 px-4 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Manual Booking modal (Admin / Ops Manager only) ----------------
   Books a bay for a date range without linking it to a job — for maintenance,
   equipment testing, or other operational blocks. */
function ManualBookingModal({ onClose, onSaved, editing }) {
  const [label, setLabel] = useState(editing?.label || "");
  const [department, setDepartment] = useState(editing?.department || "");
  const [startDate, setStartDate] = useState(editing?.start_date || "");
  const [endDate, setEndDate] = useState(editing?.end_date || "");
  const [selectedBays, setSelectedBays] = useState(editing ? [editing.bay] : []);
  const [availability, setAvailability] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!startDate || !endDate) { setAvailability([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const params = { prep_date: startDate, ship_date: endDate };
        if (editing) params.exclude_manual_id = editing.id;
        const { data } = await api.get("/prep-bays/availability", { params });
        if (!cancelled) setAvailability(data);
      } catch { if (!cancelled) setAvailability([]); }
    })();
    return () => { cancelled = true; };
  }, [startDate, endDate, editing]);

  const toggleBay = (bay) => {
    if (editing) { setSelectedBays([bay]); return; } // editing operates on a single bay
    setSelectedBays((bs) => (bs.includes(bay) ? bs.filter((b) => b !== bay) : [...bs, bay]));
  };

  const availabilityFor = (bay) => availability.find((a) => a.bay === bay);

  const save = async () => {
    if (!label.trim()) { setError("Label is required"); return; }
    if (!startDate || !endDate) { setError("Start and end dates are required"); return; }
    if (selectedBays.length === 0) { setError("Select at least one bay"); return; }
    setSaving(true);
    setError("");
    try {
      if (editing) {
        await api.patch(`/prep-bays/manual-booking/${editing.id}`, {
          bay: selectedBays[0], label: label.trim(), department: department || null,
          start_date: startDate, end_date: endDate,
        });
        toast.success("Manual booking updated");
      } else {
        await api.post("/prep-bays/manual-booking", {
          bays: selectedBays, label: label.trim(), department: department || null,
          start_date: startDate, end_date: endDate,
        });
        toast.success("Manual booking created");
      }
      onSaved();
    } catch (e) {
      setError(formatErr(e?.response?.data?.detail) || e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" data-testid="manual-booking-modal">
      <div className="w-full max-w-2xl bg-card border border-border rounded-modal p-6 space-y-4 animate-slide-up max-h-[90vh] overflow-y-auto scrollbar-slim">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">Prep bays</div>
            <h3 className="font-display font-black text-xl">{editing ? "Edit Manual Booking" : "Manual Booking"}</h3>
            <p className="text-xs text-muted-foreground mt-1">{editing ? "Update this booking's details." : "Block a bay for maintenance, testing, or other operational purposes — not tied to a job."}</p>
          </div>
          <button onClick={onClose} data-testid="manual-booking-close" className="p-2 rounded-btn hover:bg-secondary"><X size={16} /></button>
        </div>

        <label className="block">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Label (required)</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Maintenance, Equipment Testing"
            data-testid="manual-booking-label" className="mt-1 w-full h-10 px-3 rounded-input bg-background border border-border text-sm focus:outline-none focus:border-prg-red" />
        </label>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Start date</span>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} data-testid="manual-booking-start"
              className="mt-1 w-full h-9 px-2 rounded-btn bg-background border border-border text-sm" />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">End date</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} data-testid="manual-booking-end"
              className="mt-1 w-full h-9 px-2 rounded-btn bg-background border border-border text-sm" />
          </label>
          <label className="block col-span-2 sm:col-span-1">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Department (optional)</span>
            <select value={department} onChange={(e) => setDepartment(e.target.value)} data-testid="manual-booking-department"
              className="mt-1 w-full h-9 px-2 rounded-btn bg-background border border-border text-sm">
              <option value="">None</option>
              {BAY_DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Bays</div>
          {!startDate || !endDate ? (
            <div className="text-sm text-muted-foreground">Set both dates to see bay availability.</div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {PREP_BAYS.map((bay) => {
                const selected = selectedBays.includes(bay);
                const avail = availabilityFor(bay);
                const conflict = avail?.conflicts?.[0];
                const disabled = !selected && avail && !avail.available;
                return (
                  <button
                    key={bay}
                    type="button"
                    onClick={() => !disabled && toggleBay(bay)}
                    disabled={disabled}
                    data-testid={`manual-booking-bay-${bay.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}
                    title={conflict ? `Booked by ${conflict.job_name} (${conflict.prep_date} → ${conflict.ship_date})` : bay}
                    className={`text-left px-3 py-2 rounded-btn border text-sm font-semibold transition-colors ${
                      selected ? "bg-prg-red text-white border-prg-red"
                        : disabled ? "border-border bg-background/50 text-muted-foreground/50 line-through cursor-not-allowed"
                        : "border-border bg-background hover:border-prg-red"
                    }`}
                  >
                    {bay}
                  </button>
                );
              })}
            </div>
          )}
          <div className="text-[10px] text-muted-foreground mt-1">Strikethrough = already booked (by a job or another manual booking) during this window.</div>
        </div>

        {error && <div className="text-sm text-red-400 border border-red-800 bg-red-500/10 rounded-input p-3">{error}</div>}

        <div className="flex gap-2 pt-2">
          <button onClick={save} disabled={saving} data-testid="manual-booking-save"
            className="h-9 px-4 rounded-btn bg-prg-red text-white text-xs font-bold uppercase tracking-widest disabled:opacity-60">
            {saving ? "Saving…" : editing ? "Save changes" : "Create booking"}
          </button>
          <button onClick={onClose} className="h-9 px-4 rounded-btn border border-border text-xs font-bold uppercase tracking-widest">Cancel</button>
        </div>
      </div>
    </div>
  );
}