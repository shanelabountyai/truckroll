// Seeded random problems for the reason-verification property test: small, crowded days so the solver has to leave
// jobs out, with pins, positions, re-plan starts and tight windows mixed in.
import { PRIORITIES, SKILLS, type ProblemInput } from '@/lib/dispatch/contract';

export function randomProblem(seed: number): ProblemInput {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const pt = () => ({ lat: 35.55 + rnd() * 0.5, lng: -95.55 + rnd() * 0.7 });
  const nt = 1 + Math.floor(rnd() * 3);
  const techs: ProblemInput['techs'] = Array.from({ length: nt }, (_, i) => {
    const shiftStart = 420 + Math.floor(rnd() * 90);
    const t: ProblemInput['techs'][number] = {
      id: `T${i}`,
      name: `Tech ${i}`,
      skills: [...new Set([pick(SKILLS), pick(SKILLS), 'repair' as const])],
      shiftStart,
      shiftEnd: shiftStart + 480 + Math.floor(rnd() * 120),
      home: pt(),
      lunch: { earliest: 690, latest: 750 + Math.floor(rnd() * 60) },
      maxJobs: 1 + Math.floor(rnd() * 5),
    };
    if (rnd() < 0.2) t.start = { point: pt(), at: shiftStart + 60 + Math.floor(rnd() * 300) };
    return t;
  });
  const nj = 4 + Math.floor(rnd() * 10);
  const pins = new Map<string, number[]>(); // per tech: the positions pinned so far (0 = no position)
  const jobs: ProblemInput['jobs'] = Array.from({ length: nj }, (_, i) => {
    const ws = 450 + Math.floor(rnd() * 480);
    const j: ProblemInput['jobs'][number] = {
      id: `J${String(i).padStart(2, '0')}`,
      customer: `Customer ${i}`,
      address: `${i} Main St`,
      location: pt(),
      windowStart: ws,
      windowEnd: ws + pick([0, 30, 60, 120, 240]),
      durationMin: pick([30, 45, 60, 90, 120, 180]),
      skill: pick(SKILLS),
      priority: pick(PRIORITIES),
    };
    if (rnd() < 0.2) {
      const t = pick(techs);
      // Pins as a dispatcher would set them (D-37: a pin that can't be honoured is a pin-conflict, not a plan, so
      // careless pins would leave few days with a plan): only to a tech with the skill, never more pins than maxJobs,
      // never two on one position, positions within maxJobs. Windows can still make a pin impossible; those days come
      // back as pin-conflicts and are checked as such. Every kind of pin conflict is covered in pins.test.ts.
      const mine = pins.get(t.id) ?? [];
      const position = 1 + Math.floor(rnd() * Math.min(3, t.maxJobs));
      if (t.skills.includes(j.skill) && mine.length < t.maxJobs) {
        const positioned = rnd() < 0.4 && !mine.includes(position);
        j.pin = { techId: t.id, ...(positioned ? { position } : {}) };
        pins.set(t.id, [...mine, positioned ? position : 0]);
      }
    }
    return j;
  });
  return { version: 1, date: '2026-11-16', techs, jobs };
}
