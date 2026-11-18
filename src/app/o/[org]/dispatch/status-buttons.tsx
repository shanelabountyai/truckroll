import { ActionForm } from '@/core/ui/action-form';
import { NEXT_STATUS, type JobStatus } from '@/lib/dispatch/replan';
import { C } from '@/app/ui/theme';
import { setJobStatus } from './actions';

export { StatusBadge } from './look';

// The technician's status buttons for one stop (PRD §2; D-44): only the moves allowed from the job's current status.
// The artboards' 2×2 grid of 64 px buttons (MyDay.dc.html, StopDetail.dc.html). Server-rendered; each button is its own
// form so a refusal shows next to it.

const BUTTON: Partial<Record<JobStatus, string>> = { en_route: 'En route', on_site: 'On site', done: 'Done', cant_complete: 'Can’t complete' };
const big = { width: '100%', minHeight: 64, borderRadius: 12, font: 'inherit', fontSize: 18, fontWeight: 700, cursor: 'pointer' } as const;
const primary = { ...big, border: `2px solid ${C.blue}`, background: C.blue, color: '#FFFFFF' } as const;
const outline = { ...big, border: `2px solid ${C.blue}`, background: '#FFFFFF', color: C.blue } as const;
const caution = { ...big, fontSize: 16, border: `2px solid ${C.amberMid}`, background: '#FFFFFF', color: C.amberText } as const;
const cell = { flex: '1 1 calc(50% - 5px)', minWidth: 0 } as const;

export function StatusButtons({ slug, jobId, jobRef, status, back }: { slug: string; jobId: string; jobRef: string; status: JobStatus; back: 'my-day' | 'stop' | 'board' }) {
  const next = NEXT_STATUS[status];
  if (!next.length) return null;
  const action = setJobStatus.bind(null, slug);
  const moves = next.filter((s) => s !== 'cant_complete');
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
      {moves.map((s, i) => (
        <div key={s} style={cell}>
          <ActionForm action={action}>
            <input type="hidden" name="id" value={jobId} />
            <input type="hidden" name="status" value={s} />
            <input type="hidden" name="back" value={back} />
            {/* The first allowed move is the expected one (en route, then on site, then done): filled; the rest outlined. */}
            <button type="submit" style={i === 0 ? primary : outline} aria-label={`${BUTTON[s]}: job ${jobRef}`}>{BUTTON[s]}</button>
          </ActionForm>
        </div>
      ))}
      {next.includes('cant_complete') && (
        <details className="tr-cc" style={cell}>
          <summary style={{ ...caution, display: 'flex', justifyContent: 'center', boxSizing: 'border-box', listStyle: 'none' }}>Can’t complete…</summary>
          <ActionForm action={action}>
            <input type="hidden" name="id" value={jobId} />
            <input type="hidden" name="status" value="cant_complete" />
            <input type="hidden" name="back" value={back} />
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '10px 0 8px', fontSize: 14, fontWeight: 600 }}>
              Why? (the office reads this)
              <input name="note" required maxLength={500} style={{ width: '100%', boxSizing: 'border-box', fontSize: 16, padding: '0 10px' }} aria-label={`Why job ${jobRef} can’t be completed`} />
            </label>
            <button type="submit" style={{ ...caution, minHeight: 48, width: 'auto', padding: '0 18px' }} aria-label={`Can’t complete: job ${jobRef}`}>Mark can’t complete</button>
          </ActionForm>
        </details>
      )}
    </div>
  );
}
