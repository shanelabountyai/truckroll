import { ActionForm } from '@/core/ui/action-form';
import { NEXT_STATUS, STATUS_LABEL, type JobStatus } from '@/lib/dispatch/replan';
import { setJobStatus } from './actions';

// The technician's status buttons for one stop (PRD §2; D-44): only the moves allowed from the job's current status.
// Big touch targets for a phone. Server-rendered; each button is its own form so a refusal shows next to it.

const BUTTON: Partial<Record<JobStatus, string>> = { en_route: 'En route', on_site: 'On site', done: 'Done', cant_complete: 'Can’t complete' };
const big = { minHeight: 44, minWidth: 96, fontSize: 16, padding: '8px 14px', borderRadius: 8, border: '1px solid #888', background: '#fff' } as const;
const primary = { ...big, background: '#1565c0', color: '#fff', border: '1px solid #1565c0' } as const;

export const STATUS_COLORS: Record<JobStatus, string> = {
  unscheduled: '#757575',
  scheduled: '#455a64',
  en_route: '#ef6c00',
  on_site: '#1565c0',
  done: '#2e7d32',
  cant_complete: '#c62828',
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: STATUS_COLORS[status], color: '#fff', fontSize: 13, whiteSpace: 'nowrap' }}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function StatusButtons({ slug, jobId, jobRef, status, back }: { slug: string; jobId: string; jobRef: string; status: JobStatus; back: 'my-day' | 'stop' | 'board' }) {
  const next = NEXT_STATUS[status];
  if (!next.length) return null;
  const action = setJobStatus.bind(null, slug);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
      {next.filter((s) => s !== 'cant_complete').map((s) => (
        <ActionForm key={s} action={action}>
          <input type="hidden" name="id" value={jobId} />
          <input type="hidden" name="status" value={s} />
          <input type="hidden" name="back" value={back} />
          <button type="submit" style={s === 'done' || s === 'on_site' ? primary : big} aria-label={`${BUTTON[s]}: job ${jobRef}`}>{BUTTON[s]}</button>
        </ActionForm>
      ))}
      {next.includes('cant_complete') && (
        <details style={{ flexBasis: '100%' }}>
          <summary style={{ minHeight: 32, cursor: 'pointer' }}>Can’t complete…</summary>
          <ActionForm action={action}>
            <input type="hidden" name="id" value={jobId} />
            <input type="hidden" name="status" value="cant_complete" />
            <input type="hidden" name="back" value={back} />
            <label style={{ display: 'block', margin: '6px 0' }}>
              Why? <input name="note" required maxLength={500} style={{ width: '100%', boxSizing: 'border-box', fontSize: 16, padding: 6 }} aria-label={`Why job ${jobRef} can’t be completed`} />
            </label>
            <button type="submit" style={big} aria-label={`Can’t complete: job ${jobRef}`}>Can’t complete</button>
          </ActionForm>
        </details>
      )}
    </div>
  );
}
