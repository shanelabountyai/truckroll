'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// A header link that marks itself as the current page (aria-current + the amber underline in theme.css). `match` is
// the path prefix that counts as "here"; `exact` matches only that path.
export function NavLink({ href, match, exact, children }: { href: string; match?: string; exact?: boolean; children: React.ReactNode }) {
  const path = usePathname() ?? '';
  const m = match ?? href;
  const here = exact ? path === m : path === m || path.startsWith(`${m}/`);
  return (
    <Link href={href} aria-current={here ? 'page' : undefined} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0 2px', boxSizing: 'border-box' }}>
      {children}
    </Link>
  );
}
