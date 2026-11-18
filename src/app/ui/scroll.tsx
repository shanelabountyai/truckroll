// A sideways-scrolling box for a wide table or the timeline. Keyboard users can focus it and scroll with the arrow
// keys (axe scrollable-region-focusable, WCAG 2.1.1), and it is announced by name.
export function Scroll({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} style={{ overflowX: 'auto', ...style }}>
      {children}
    </div>
  );
}
