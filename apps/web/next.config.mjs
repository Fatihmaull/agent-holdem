/** @type {import('next').NextConfig} */

/**
 * `@wagmi/connectors` bundles a Coinbase Base Account connector whose SDK
 * declares the x402 payment packages as optional peers. AgentHoldem only ever
 * talks to BNB testnet through injected/WalletConnect wallets, so that code
 * path is never reached — aliasing the specifiers to `false` keeps the build
 * green without pulling three unused packages into the tree.
 */
const UNUSED_OPTIONAL_PEERS = [
  '@x402/core/client',
  '@x402/evm',
  '@x402/evm/exact/client',
  '@x402/evm/upto/client',
  '@x402/svm/exact/client',
];

const nextConfig = {
  reactStrictMode: true,
  // The shared package ships TypeScript source rather than a build artifact,
  // so Next has to compile it alongside the app.
  transpilePackages: ['@agentholdem/shared'],
  eslint: { ignoreDuringBuilds: true },
  webpack: (config) => {
    // @agentholdem/shared is native ESM and imports siblings with explicit
    // `.js` specifiers (required by NodeNext). Webpack resolves those against
    // the real files on disk, which are `.ts`, so teach it the mapping.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };

    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      ...Object.fromEntries(UNUSED_OPTIONAL_PEERS.map((name) => [name, false])),
    };

    return config;
  },
};

export default nextConfig;
