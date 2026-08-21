import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Aarati Sagar | मराठी आरती संग्रह',
  description: 'A living library of Marathi aarati, preserved and shared by the community.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="mr"><body>{children}</body></html>;
}
