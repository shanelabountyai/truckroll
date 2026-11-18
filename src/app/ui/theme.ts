// The design pass's colours (docs/design/*.dc.html, D-60): one place for the inline styles the pages use. theme.css
// carries the same values as CSS custom properties for what inline styles can't do (hover, focus, media queries).
// Every text pair here is at least 4.5:1 and every control border at least 3:1 on the surface it sits on.

export const C = {
  ink: '#13202B', // body text; the header's navy
  page: '#F3F5F7', // page background
  card: '#FFFFFF',
  cardEdge: '#D5DCE3', // card outlines (decorative)
  rule: '#E3E8ED', // dividers
  ruleSoft: '#EDF0F3',
  text2: '#3F4D5A', // secondary text (8.7:1 on white)
  text3: '#52606D', // captions (6.5:1 on white, 5.9:1 on the page)
  control: '#6F7F8F', // input / outline-button borders (4.1:1 on white, 3.8:1 on the page)
  blue: '#1F4E8A', // actions, standard jobs, links
  blueDark: '#163A68',
  red: '#B42A0E', // emergencies, the now line
  redDark: '#8A1E08',
  redTint: '#FFE3DB',
  amber: '#F2A33A', // the brand mark and the active nav underline (on navy only)
  amberText: '#6B4600', // en route, can't complete (8.4:1 on white)
  amberMid: '#8A5A00', // ETA draft label, can't-complete border (5.9:1 on white)
  grey: '#E3E8ED', // maintenance block fill
  greyEdge: '#8696A6', // block outlines on white (3.0:1)
  headMuted: '#B9C4CF', // small text on the navy header
  headLink: '#D3DBE3',
} as const;

export const font = "system-ui, -apple-system, 'Segoe UI', sans-serif";

export const card = { background: C.card, border: `1px solid ${C.cardEdge}`, borderRadius: 12 } as const;
export const cardPad = { ...card, padding: '14px 16px' } as const;

/** Buttons: 44 px minimum (WCAG 2.5.5 target size), the artboards' three kinds. */
export const btn = {
  primary: { minHeight: 44, padding: '0 16px', borderRadius: 8, border: `2px solid ${C.blue}`, background: C.blue, color: '#FFFFFF', font: 'inherit', fontWeight: 700, cursor: 'pointer' },
  secondary: { minHeight: 44, padding: '0 14px', borderRadius: 8, border: `1px solid ${C.control}`, background: '#FFFFFF', color: C.ink, font: 'inherit', fontWeight: 600, cursor: 'pointer' },
  outline: { minHeight: 44, padding: '0 14px', borderRadius: 8, border: `2px solid ${C.blue}`, background: '#FFFFFF', color: C.blue, font: 'inherit', fontWeight: 700, cursor: 'pointer' },
  danger: { minHeight: 44, padding: '0 16px', borderRadius: 8, border: `2px solid ${C.redDark}`, background: C.red, color: '#FFFFFF', font: 'inherit', fontWeight: 700, cursor: 'pointer' },
  caution: { minHeight: 44, padding: '0 16px', borderRadius: 8, border: `2px solid ${C.amberMid}`, background: '#FFFFFF', color: C.amberText, font: 'inherit', fontWeight: 700, cursor: 'pointer' },
} as const;

export const input = { minHeight: 44, boxSizing: 'border-box', border: `1px solid ${C.control}`, borderRadius: 8, padding: '0 8px', font: 'inherit', background: '#FFFFFF', color: C.ink } as const;

/** A field: label text above its control. */
export const field = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600 } as const;

export const th = { textAlign: 'left', padding: '8px 10px 8px 0', color: C.text2, fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' } as const;
export const td = { textAlign: 'left', padding: '9px 10px 9px 0', verticalAlign: 'top', borderTop: `1px solid ${C.ruleSoft}` } as const;
