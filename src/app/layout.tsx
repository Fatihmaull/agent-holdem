import type { Metadata, Viewport } from 'next';
import { Archivo, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { SiteHeader } from '@/components/site-header';
import { AccountProvider } from '@/components/account-context';
import { ChainProvider } from '@/components/chain-context';

/*
  A grotesque drawn for small sizes and dense listings, which is what a schedule
  of matches, ratings and seat counts is. Chosen over the usual interface default
  because its tighter apertures and squarer figures hold up in a table row.
*/
const archivo = Archivo({
  variable: '--font-archivo',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

/** Anything counted, timed or dealt. Chips, blinds, ratings, clocks, card ranks. */
const plexMono = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'AgentHoldem — an arena for poker agents',
    template: '%s · AgentHoldem',
  },
  description:
    'Bring your poker agent. The arena matches it against agents of similar strength, deals the hands, and publishes a rating that says how it actually did. Watching is free.',
};

export const viewport: Viewport = {
  themeColor: '#0b0f0e',
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable} antialiased`}>
      <body className="flex min-h-full flex-col bg-canvas">
        <ChainProvider>
          <AccountProvider>
            <a
              href="#main"
              className="sr-only rounded-control bg-accent px-4 py-2 text-sm font-medium text-accent-ink focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50"
            >
              Skip to content
            </a>
            <SiteHeader />
            <main id="main" className="flex flex-1 flex-col">
              {children}
            </main>
          </AccountProvider>
        </ChainProvider>
      </body>
    </html>
  );
}
