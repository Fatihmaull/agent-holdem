import type { NextConfig } from 'next';

/**
 * The content policy.
 *
 * This page asks a wallet to sign things, so an injected script is not a
 * defacement, it is a prompt the reader has no reason to distrust. React
 * escapes what it renders, which is the first defence; this is the one that
 * still holds if that ever fails.
 *
 * `unsafe-inline` on scripts is not an oversight. The framework inlines its own
 * bootstrap, and removing it needs a per-request nonce threaded through
 * middleware. Keeping the directive still buys the thing that matters most:
 * `script-src 'self'` means an injected `<script src>` pointing anywhere else
 * does not load, and `connect-src 'self'` means nothing exfiltrates to another
 * origin. Wallets run as extensions and talk to their own nodes outside the
 * page, so neither is in this policy's way.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Nothing here is meant to be embedded, and a signing prompt inside somebody
  // else's frame is the whole shape of a clickjacking attack.
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

const nextConfig: NextConfig = {
  reactCompiler: true,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'content-security-policy', value: csp },
          { key: 'x-content-type-options', value: 'nosniff' },
          // Belt and braces with frame-ancestors, for anything that predates it.
          { key: 'x-frame-options', value: 'DENY' },
          // A wallet address in a path should not travel to another site.
          { key: 'referrer-policy', value: 'strict-origin-when-cross-origin' },
          { key: 'permissions-policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          {
            key: 'strict-transport-security',
            value: 'max-age=31536000; includeSubDomains',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
