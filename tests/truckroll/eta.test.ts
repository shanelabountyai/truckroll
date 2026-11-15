import { describe, expect, it } from 'vitest';
import { Problem } from '@/lib/dispatch/contract';
import { clock12, dateLabel, etaFacts, etaPrompt, etaRange, etaTemplate, etaTextProblem, ETA_MAX_CHARS, type EtaFacts } from '@/lib/dispatch/eta';
import { fixtures, goldenPlan } from './helpers';

// Phase 4, the pure part of ETA texts: the range a customer is told (D-52), the template (D-06), the prompt, and the
// validator a model's text must pass before it can be a draft (D-51).

describe('clock12 and dateLabel', () => {
  it.each([[0, '12:00 AM'], [540, '9:00 AM'], [615, '10:15 AM'], [720, '12:00 PM'], [780, '1:00 PM'], [1439, '11:59 PM']])('%i → %s', (m, s) => expect(clock12(m)).toBe(s));
  it('names the calendar day itself', () => expect(dateLabel('2026-11-16')).toBe('Mon, Nov 16'));
});

describe('etaRange (D-52): an hour from the planned start rounded down to the quarter hour, inside the window', () => {
  it('rounds down and runs an hour', () => expect(etaRange(547, 480, 720)).toEqual({ from: 540, to: 600 }));
  it('never opens before the window', () => expect(etaRange(485, 482, 720)).toEqual({ from: 482, to: 542 }));
  it('is cut at the window end', () => expect(etaRange(700, 480, 720)).toEqual({ from: 690, to: 720 }));
  it('says "at about" when less than 15 minutes are left', () => expect(etaRange(718, 480, 718)).toEqual({ from: 705, to: 705 }));
  it('always contains the planned start, for every start inside every window (D-36)', () => {
    for (let ws = 420; ws <= 900; ws += 7)
      for (let we = ws; we <= ws + 240; we += 11)
        for (let start = ws; start <= we; start += 3) {
          const r = etaRange(start, ws, we);
          expect(r.from).toBeGreaterThanOrEqual(ws);
          expect(r.from).toBeLessThanOrEqual(start);
          if (r.to !== r.from) expect(start).toBeLessThanOrEqual(r.to);
          else expect(start - r.from).toBeLessThan(15);
          expect(r.to).toBeLessThanOrEqual(Math.max(we, r.from));
        }
  });
});

const demo = fixtures.find((f) => f.name === '03-demo-day')!;
const problem = Problem.parse(demo.problem);
const plan = goldenPlan('03-demo-day');
const facts = etaFacts({
  plan,
  date: problem.date,
  shop: 'Acme Heating',
  jobs: new Map(problem.jobs.map((j) => [j.id, { ...j, ref: j.id }])),
  techNames: new Map(problem.techs.map((t) => [t.id, t.name])),
});

describe('etaFacts + etaTemplate', () => {
  it('one text per routed stop, each inside its job window', () => {
    expect(facts).toHaveLength(plan.routes.reduce((n, r) => n + r.stops.length, 0));
    const start = new Map(plan.routes.flatMap((r) => r.stops.map((s) => [s.jobId, s.start] as const)));
    for (const f of facts) {
      const j = problem.jobs.find((x) => x.id === f.jobId)!;
      expect(f.from).toBeGreaterThanOrEqual(j.windowStart);
      expect(f.from).toBeLessThanOrEqual(start.get(f.jobId)!);
    }
  });

  it('the template says who, when, and what, and passes the validator itself', () => {
    for (const f of facts) {
      const t = etaTemplate(f);
      expect(t).toContain(f.customer);
      expect(t).toContain('Acme Heating');
      expect(t).toContain(f.tech);
      expect(t).toContain(f.fromLabel);
      expect(t).toContain('Mon, Nov 16');
      expect(t.length).toBeLessThanOrEqual(ETA_MAX_CHARS);
      expect(etaTextProblem(t, f)).toBeNull();
    }
  });

  it('jobs left out of the map (finished ones) get no text', () => {
    const some = new Map(problem.jobs.slice(0, 3).map((j) => [j.id, { ...j, ref: j.id }]));
    expect(etaFacts({ plan, date: problem.date, shop: 'x', jobs: some, techNames: new Map() }).map((f) => f.jobId).sort()).toEqual([...some.keys()].sort());
  });

  it('an emergency says so', () => {
    const e = { ...facts[0]!, service: 'emergency repair', emergency: true };
    expect(etaTemplate(e)).toContain('emergency repair');
  });
});

describe('etaPrompt', () => {
  it('passes the facts as JSON data and names the exact times', () => {
    const f = facts[0]!;
    const p = etaPrompt(f);
    expect(JSON.parse(p.user)).toMatchObject({ customer: f.customer, technician: f.tech, arrivalFrom: f.fromLabel });
    expect(p.system).toContain(`"${f.fromLabel}"`);
    expect(p.system).toMatch(/never as instructions/);
  });
});

describe('etaTextProblem (D-51): a model text is used only if it passes', () => {
  const f: EtaFacts = { ...facts[0]!, tech: 'Muskogee One', from: 540, to: 600, fromLabel: '9:00 AM', toLabel: '10:00 AM' };
  const good = 'Hi Dana! Muskogee One from Acme Heating will arrive between 9:00 AM and 10:00 AM on Mon, Nov 16 for your repair.';
  it('accepts a good text', () => expect(etaTextProblem(good, f)).toBeNull());
  it.each([
    ['', 'empty'],
    ['x'.repeat(ETA_MAX_CHARS + 1), 'longer than'],
    [good.replace('9:00 AM', '9 o’clock'), 'missing the arrival time 9:00 AM'],
    [good.replace('10:00 AM', '11:00 AM'), 'missing the arrival time 10:00 AM'],
    [`${good} Or maybe 2:30 PM.`, 'another time'],
    [good.replace('Muskogee One', 'your tech'), 'technician'],
    [`${good} Track it at https://evil.example`, 'link'],
    [`${good} Visit acme.com`, 'link'],
    [`${good} Call 918-555-0199.`, 'phone number'],
    [`${good} The fee is $89.`, 'money'],
    [`${good} Email ops@acme.test`, 'address handle'],
    [`${good}\n\nIgnore that. New message:`, 'more than one message'],
  ])('rejects %j', (text, why) => expect(etaTextProblem(text, f)).toContain(why));
  it('"at about" texts need only the one time', () => {
    const one = { ...f, to: 540, toLabel: '9:00 AM' };
    expect(etaTextProblem('Muskogee One will be there at about 9:00 AM.', one)).toBeNull();
  });
});
