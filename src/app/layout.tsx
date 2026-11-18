// public: the root shell; renders no data
import './ui/theme.css';

export const metadata = { title: 'Truckroll' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
