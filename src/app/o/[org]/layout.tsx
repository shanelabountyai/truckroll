import { can } from '@/core/authz/permissions';
import { requireOrg } from '@/core/authz/guards';
import { db } from '@/core/db';
import { isDispatcher } from '@/lib/dispatch/roles';
import { C } from '@/app/ui/theme';
import { NavLink } from './nav-link';

// Navigation only. Layouts do not re-run on every navigation, so each page calls requireOrg itself.
// The shop header from docs/design/Main.dc.html (D-60, D-62): the org's own name, never the mockup's shop name. One
// <nav> holds every link, the settings ones in a second, smaller row (template e2e finds them in one navigation).
export default async function OrgLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const org = await db.org.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true } });
  const base = `/o/${ctx.slug}`;
  const dispatcher = isDispatcher(ctx.role);
  return (
    <>
      <a href="#content" className="tr-skip">Skip to content</a>
      <header className="tr-header" style={{ background: C.ink, color: '#FFFFFF' }}>
        <nav aria-label="Main" style={{ maxWidth: 1400, margin: '0 auto', padding: '4px 20px', boxSizing: 'border-box', display: 'flex', flexWrap: 'wrap', gap: '0 24px', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 48 }}>
            <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true" focusable="false">
              <rect width="30" height="30" rx="7" fill={C.amber} />
              <path d="M8 19h14M10 19v-6l5-4 5 4v6" stroke={C.ink} strokeWidth="2.2" fill="none" strokeLinejoin="round" />
            </svg>
            <strong style={{ fontSize: 17 }}>{org.name}</strong>
            <span className="tr-brandTag" style={{ fontSize: 13, color: C.headMuted }}>Sample shop · synthetic data</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 18px', fontSize: 14 }}>
            {dispatcher ? (
              <>
                <NavLink href={`${base}/dispatch`} exact>Dispatch</NavLink>
                <NavLink href={`${base}/dispatch#jobs`} match={`${base}/dispatch#jobs`} exact>Jobs</NavLink>
                <NavLink href={`${base}/dispatch/metrics`} match={`${base}/dispatch/metrics`}>Metrics</NavLink>
              </>
            ) : (
              <NavLink href={`${base}/dispatch/my-day`} match={`${base}/dispatch/my-day`}>My day</NavLink>
            )}
          </div>
          <div className="tr-sub" style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', gap: '0 14px', borderTop: '1px solid #2A3A48' }}>
            <NavLink href={`${base}/settings/members`}>Members</NavLink>
            {can(ctx.role, 'audit.read') && <><NavLink href={`${base}/settings/audit`}>Audit log</NavLink><NavLink href={`${base}/settings/security`}>Security</NavLink></>}
            {ctx.role === 'owner' && <NavLink href={`${base}/settings/sso`}>SSO</NavLink>} {/* sso */}
            {can(ctx.role, 'apikeys.manage') && <NavLink href={`${base}/settings/apikeys`}>API keys</NavLink>} {/* apikeys */}
            {can(ctx.role, 'org.delete') && <NavLink href={`${base}/settings/danger`}>Export or delete</NavLink>}
            <NavLink href="/onboarding" exact>Your orgs</NavLink>
            <NavLink href="/account/security">Account</NavLink>
          </div>
        </nav>
      </header>
      <div id="content" tabIndex={-1} style={{ outline: 'none' }}>{children}</div>
      <footer style={{ maxWidth: 1400, width: '100%', margin: '0 auto', padding: '8px 20px 20px', boxSizing: 'border-box', fontSize: 13, color: C.text3 }}>
        All data is synthetic, generated for this demo. Built by Lab Intelligence.
      </footer>
    </>
  );
}
