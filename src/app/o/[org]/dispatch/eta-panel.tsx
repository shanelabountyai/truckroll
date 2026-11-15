import { ActionForm } from '@/core/ui/action-form';
import { approveEtas, discardEta, draftEtas, editEta } from './actions';

export type EtaRow = {
  id: string;
  jobRef: string;
  customer: string;
  phone: string | null;
  body: string;
  source: string;
  fallbackReason: string | null;
  status: 'draft' | 'sent' | 'discarded';
  editedAt: Date | null;
  sentAt: Date | null;
  approvedBy: string | null;
};

const card = { border: '1px solid #ccc', borderRadius: 6, padding: '8px 12px', margin: '8px 0' } as const;

// PRD §3 "ETA texts" on the board (Phase 4): draft, review, edit, approve and send. "Sent" means the captured-message
// store; no real SMS in v1 (D-05). Nothing is sent without the dispatcher pressing Approve (TR-06).
export function EtaPanel({ slug, date, rows, aiConfigured, flash }: { slug: string; date: string; rows: EtaRow[]; aiConfigured: boolean; flash: string | null }) {
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, slug);
  const drafts = rows.filter((r) => r.status === 'draft');
  const sent = rows.filter((r) => r.status === 'sent');
  const sendable = drafts.filter((r) => r.phone);
  return (
    <section id="eta" aria-label="ETA texts" style={{ margin: '1rem 0', padding: '8px 12px', border: '1px solid #ccc', borderRadius: 6 }}>
      <h2 style={{ marginTop: 0 }}>Customer ETA texts</h2>
      {flash && <p role="status">{flash}</p>}
      <ActionForm action={bind(draftEtas)}>
        <input type="hidden" name="date" value={date} />
        <button type="submit">{rows.length ? 'Draft ETA texts again' : 'Draft ETA texts'}</button>{' '}
        <small>
          {aiConfigured ? 'Drafted by Claude within the AI spending limit; a draft that fails the checks uses the standard template.' : 'No AI key is set, so every draft uses the standard template.'}{' '}
          Drafts are never sent until you approve them. Sending puts them in the captured-message store; no real SMS is sent.
        </small>
      </ActionForm>

      {drafts.length > 0 && (
        <>
          <h3>Drafts ({drafts.length})</h3>
          {sendable.length > 0 && (
            <ActionForm action={bind(approveEtas)}>
              {sendable.map((r) => <input key={r.id} type="hidden" name="ids[]" value={r.id} />)}
              <button type="submit">Approve and send all {sendable.length}</button>
            </ActionForm>
          )}
          <ul aria-label="ETA drafts" style={{ listStyle: 'none', padding: 0 }}>
            {drafts.map((r) => (
              <li key={r.id} aria-label={`ETA draft ${r.jobRef}`} style={card}>
                <strong>Job {r.jobRef}</strong> · {r.customer} · {r.phone ?? <em>no phone number</em>} ·{' '}
                <small>{r.source === 'llm' ? 'drafted by Claude' : 'template'}{r.editedAt ? ', edited' : ''}</small>
                {r.fallbackReason && <p><small>{r.fallbackReason}</small></p>}
                <p style={{ whiteSpace: 'pre-wrap' }} aria-label={`ETA text for ${r.jobRef}`}>{r.body}</p>
                <details>
                  <summary>Edit</summary>
                  <ActionForm action={bind(editEta)}>
                    <input type="hidden" name="id" value={r.id} />
                    <textarea name="body" defaultValue={r.body} rows={4} style={{ width: '100%', maxWidth: 560 }} aria-label={`Edit ETA text for ${r.jobRef}`} />
                    <br />
                    <button type="submit" aria-label={`Save ETA text for ${r.jobRef}`}>Save</button>
                  </ActionForm>
                </details>
                <span style={{ display: 'inline-flex', gap: 8, marginTop: 6 }}>
                  {r.phone && (
                    <ActionForm action={bind(approveEtas)}>
                      <input type="hidden" name="ids[]" value={r.id} />
                      <button type="submit" aria-label={`Approve and send ${r.jobRef}`}>Approve and send</button>
                    </ActionForm>
                  )}
                  <ActionForm action={bind(discardEta)}>
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit" aria-label={`Discard ETA text for ${r.jobRef}`}>Discard</button>
                  </ActionForm>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {sent.length > 0 && (
        <>
          <h3>Sent ({sent.length})</h3>
          <ul aria-label="Sent ETA texts" style={{ listStyle: 'none', padding: 0 }}>
            {sent.map((r) => (
              <li key={r.id} aria-label={`Sent ETA ${r.jobRef}`} style={card}>
                <strong>Job {r.jobRef}</strong> · {r.phone} · sent {r.sentAt?.toISOString().slice(11, 16)} UTC · approved by {r.approvedBy ?? 'a former member'}
                <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{r.body}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
