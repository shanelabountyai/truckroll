import Link from 'next/link';

// public: renders no data. The app's 404 in the design look (TR-05 answers another tech's stop with this same page).
export default function NotFound() {
  return (
    <main style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 48 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Not found</h1>
      <p style={{ margin: 0 }}>There is nothing here, or it isn&apos;t yours to see. Stops of other technicians and other shops look the same as pages that don&apos;t exist.</p>
      <p style={{ margin: 0 }}><Link href="/onboarding">Go to your orgs</Link></p>
    </main>
  );
}
