import { ActionForm } from '@/core/ui/action-form';
import { C, btn } from '@/app/ui/theme';
import { wall } from './look';
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

const item = { display: 'flex', flexDirection: 'column', gap: 8, borderTop: `1px solid ${C.ruleSoft}`, paddingTop: 10, margin: 0 } as const;
const list = { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 } as const;
const textBox = { margin: 0, fontSize: 14, background: C.page, borderRadius: 8, padding: '8px 10px', whiteSpace: 'pre-wrap' } as const;

// PRD §3 "ETA texts" on the board (Phase 4), as the "ETA texts to approve" card of docs/design/Main.dc.html: draft,
// review, edit, approve and send. "Sent" means the captured-message store; no real SMS in v1 (D-05). Nothing is sent
// without the dispatcher pressing Approve (TR-06).
export function EtaPanel({ slug, date, rows, aiConfigured, flash }: { slug: string; date: string; rows: EtaRow[]; aiConfigured: boolean; flash: string | null }) {
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, slug);
  const drafts = rows.filter((r) => r.status === 'draft');
  const sent = rows.filter((r) => r.status === 'sent');
  const sendable = drafts.filter((r) => r.phone);
  return (
    <section id="eta" aria-label="ETA texts" style={{ background: C.card, border: `1px solid ${C.cardEdge}`, borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>ETA texts to approve ({drafts.length})</h2>
      {flash && <p role="status" style={{ margin: 0, fontSize: 14, borderLeft: `4px solid ${C.blue}`, background: C.page, padding: '6px 10px', borderRadius: 4 }}>{flash}</p>}
      <ActionForm action={bind(draftEtas)}>
        <input type="hidden" name="date" value={date} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button type="submit" style={{ ...(rows.length ? btn.secondary : btn.primary), alignSelf: 'flex-start' }}>{rows.length ? 'Draft ETA texts again' : 'Draft ETA texts'}</button>
          <small style={{ fontSize: 13, color: C.text2 }}>
            {aiConfigured ? 'Drafted by Claude within the AI spending limit; a draft that fails the checks uses the standard template.' : 'No AI key is set, so every draft uses the standard template.'}{' '}
            Drafts are never sent until you approve them. Sending puts them in the captured-message store; no real SMS is sent.
          </small>
        </div>
      </ActionForm>

      {drafts.length > 0 && (
        <>
          <ul aria-label="ETA drafts" style={list}>
            {drafts.map((r) => (
              <li key={r.id} aria-label={`ETA draft ${r.jobRef}`} style={item}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600 }}>To: {r.customer} · Job {r.jobRef}</span>
                  <span style={{ color: C.amberMid, fontWeight: 700 }}><span aria-hidden="true">✎ </span>Draft</span>
                </div>
                <div style={{ fontSize: 13, color: C.text2 }}>
                  {r.phone ?? <em>no phone number</em>} · {r.source === 'llm' ? 'drafted by Claude' : 'template'}{r.editedAt ? ', edited' : ''}
                </div>
                {r.fallbackReason && <p style={{ margin: 0, fontSize: 13, color: C.text2 }}>{r.fallbackReason}</p>}
                <p role="group" style={textBox} aria-label={`ETA text for ${r.jobRef}`}>{r.body}</p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  {r.phone ? (
                    <ActionForm action={bind(approveEtas)}>
                      <input type="hidden" name="ids[]" value={r.id} />
                      <button type="submit" style={btn.primary} aria-label={`Approve and send ${r.jobRef}`}>Approve and send</button>
                    </ActionForm>
                  ) : (
                    <span style={{ fontSize: 13, color: C.text2, alignSelf: 'center' }}>Can’t be sent without a phone number.</span>
                  )}
                  <ActionForm action={bind(discardEta)}>
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit" style={btn.secondary} aria-label={`Discard ETA text for ${r.jobRef}`}>Discard</button>
                  </ActionForm>
                </div>
                <details>
                  <summary style={{ fontWeight: 600, color: C.blue }}>Edit</summary>
                  <ActionForm action={bind(editEta)}>
                    <input type="hidden" name="id" value={r.id} />
                    <textarea name="body" defaultValue={r.body} rows={4} style={{ width: '100%', fontSize: 14 }} aria-label={`Edit ETA text for ${r.jobRef}`} />
                    <button type="submit" style={{ ...btn.secondary, marginTop: 6 }} aria-label={`Save ETA text for ${r.jobRef}`}>Save</button>
                  </ActionForm>
                </details>
              </li>
            ))}
          </ul>
          {sendable.length > 0 && (
            <ActionForm action={bind(approveEtas)}>
              {sendable.map((r) => <input key={r.id} type="hidden" name="ids[]" value={r.id} />)}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: `1px solid ${C.ruleSoft}`, paddingTop: 10 }}>
                <span style={{ fontSize: 13, color: C.text2 }}>Read every draft above first: this approves and sends all of them that have a phone number.</span>
                <button type="submit" style={{ ...btn.secondary, alignSelf: 'flex-start' }}>Approve and send all {sendable.length}</button>
              </div>
            </ActionForm>
          )}
        </>
      )}

      {sent.length > 0 && (
        <>
          <h3 style={{ margin: '4px 0 0', fontSize: 14 }}>Sent ({sent.length})</h3>
          <ul aria-label="Sent ETA texts" style={list}>
            {sent.map((r) => (
              <li key={r.id} aria-label={`Sent ETA ${r.jobRef}`} style={item}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
                  <span>{r.customer} · Job {r.jobRef} · {r.phone}</span>
                  <span style={{ color: C.blue, fontWeight: 700 }}><span aria-hidden="true">✓ </span>Sent {wall(r.sentAt)}, approved by {r.approvedBy ?? 'a former member'}</span>
                </div>
                <p style={{ ...textBox, background: 'transparent', padding: 0, color: C.text2 }}>{r.body}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
