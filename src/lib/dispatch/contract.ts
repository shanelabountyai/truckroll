import { z } from 'zod';

// Truckroll solver contract (PRD §5). Mirrors solver/contract.py field for field; fixtures/problems/*.json round-trip
// through both. All times are integer minutes after local midnight on `date`; all ids are strings.

export const SKILLS = ['install', 'repair', 'maintenance', 'refrigerant-certified', 'commercial'] as const;
export const PRIORITIES = ['emergency', 'standard', 'maintenance'] as const;
export const REASONS = ['no-skill', 'no-window-fit', 'over-capacity'] as const;
// D-37: why a set of pins can't all be honoured; judged in this order (src/lib/dispatch/pins.ts, solver/solve.py).
export const PIN_CONFLICT_CODES = [
  'no-skill',
  'position-over-capacity',
  'no-window-fit',
  'position-taken',
  'over-capacity',
  'infeasible-together',
  'search-limit',
] as const;
export const LUNCH_MINUTES = 30;

const minute = z.number().int().min(0).max(24 * 60);
const id = z.string().min(1).max(64);

export const Point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict();
export type Point = z.infer<typeof Point>;

export const Skill = z.enum(SKILLS);
export const Priority = z.enum(PRIORITIES);
export const Reason = z.enum(REASONS);
export type Skill = z.infer<typeof Skill>;
export type Priority = z.infer<typeof Priority>;
export type Reason = z.infer<typeof Reason>;

export const Tech = z
  .object({
    id,
    name: z.string().min(1).max(120),
    skills: z.array(Skill).min(1),
    shiftStart: minute,
    shiftEnd: minute,
    home: Point,
    lunch: z.object({ earliest: minute, latest: minute }).strict(),
    maxJobs: z.number().int().min(0).max(50),
    // Re-plan: where and when the tech is free (defaults: home at shiftStart). The route still ends at home.
    start: z.object({ point: Point, at: minute }).strict().optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.shiftEnd <= t.shiftStart) ctx.addIssue({ code: 'custom', message: 'shiftEnd must be after shiftStart' });
    if (t.lunch.latest < t.lunch.earliest) ctx.addIssue({ code: 'custom', message: 'lunch.latest before lunch.earliest' });
    if (t.lunch.earliest < t.shiftStart || t.lunch.latest + LUNCH_MINUTES > t.shiftEnd)
      ctx.addIssue({ code: 'custom', message: 'lunch window must sit inside the shift' });
    if (t.start && (t.start.at < t.shiftStart || t.start.at >= t.shiftEnd))
      ctx.addIssue({ code: 'custom', message: 'start.at must be inside the shift' });
  });
export type Tech = z.infer<typeof Tech>;

export const Job = z
  .object({
    id,
    customer: z.string().min(1).max(120),
    address: z.string().min(1).max(200),
    location: Point,
    windowStart: minute,
    windowEnd: minute,
    durationMin: z.number().int().min(1).max(12 * 60),
    skill: Skill,
    priority: Priority,
    pin: z.object({ techId: id, position: z.number().int().min(1).optional() }).strict().optional(),
  })
  .strict()
  .refine((j) => j.windowEnd >= j.windowStart, { message: 'windowEnd before windowStart' });
export type Job = z.infer<typeof Job>;

export const Problem = z
  .object({
    version: z.literal(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // No `maxLateMin` since D-36: windows are hard (a stop starts inside its window or the job is unassigned).
    techs: z.array(Tech).max(100),
    jobs: z.array(Job).max(1000),
  })
  .strict()
  .superRefine((p, ctx) => {
    const techIds = new Set<string>();
    for (const t of p.techs) {
      if (techIds.has(t.id)) ctx.addIssue({ code: 'custom', message: `duplicate tech id ${t.id}` });
      techIds.add(t.id);
    }
    const jobIds = new Set<string>();
    for (const j of p.jobs) {
      if (jobIds.has(j.id)) ctx.addIssue({ code: 'custom', message: `duplicate job id ${j.id}` });
      jobIds.add(j.id);
      if (j.pin && !techIds.has(j.pin.techId)) ctx.addIssue({ code: 'custom', message: `job ${j.id} pinned to unknown tech` });
    }
  });
export type Problem = z.infer<typeof Problem>;
export type ProblemInput = z.input<typeof Problem>;

export const SolveRequest = z.object({ problem: Problem, timeLimitMs: z.number().int().min(100).max(60_000) }).strict();
export type SolveRequest = z.infer<typeof SolveRequest>;

export const Stop = z
  .object({
    jobId: id,
    seq: z.number().int().min(1),
    driveMin: z.number().int().min(0),
    arrival: minute,
    start: minute,
    end: minute,
    slackMin: z.number().int().min(0),
    lateMin: z.number().int().min(0), // always 0 since D-36; kept for the wire format and Phase 2's columns
  })
  .strict();
export type Stop = z.infer<typeof Stop>;

export const Route = z
  .object({
    techId: id,
    stops: z.array(Stop),
    // `afterSeq`: lunch is taken after that stop (0 = before the first drive), before driving on.
    lunch: z.object({ start: minute, end: minute, afterSeq: z.number().int().min(0) }).strict().nullable(),
    returnDriveMin: z.number().int().min(0),
    returnAt: minute,
  })
  .strict();
export type Route = z.infer<typeof Route>;

export const Plan = z
  .object({
    version: z.literal(1),
    date: z.string(),
    routes: z.array(Route),
    unassigned: z.array(z.object({ jobId: id, reasons: z.array(Reason).min(1) }).strict()),
    objective: z
      .object({ unassignedEmergencies: z.number().int().min(0), lateMin: z.number().int().min(0), driveMin: z.number().int().min(0) })
      .strict(),
    // No 'time-limit': a clock-cut search returns no plan (D-18).
    stoppedBy: z.enum(['solution-limit', 'local-optimum', 'trivial']),
  })
  .strict();
export type Plan = z.infer<typeof Plan>;

// D-37: the solver's answer when the pins can't all be honoured (POST /solve 422, cli.py exit 4). There is no plan.
export const PinConflictCode = z.enum(PIN_CONFLICT_CODES);
export type PinConflictCode = z.infer<typeof PinConflictCode>;
export const PinConflictEntry = z.object({ code: PinConflictCode, jobId: id, techId: id }).strict();
export type PinConflictEntry = z.infer<typeof PinConflictEntry>;
export const PinConflictError = z
  .object({ error: z.literal('pin-conflict'), pins: z.array(PinConflictEntry).min(1), detail: z.string() })
  .strict();
export type PinConflictError = z.infer<typeof PinConflictError>;
