/** @type {import('next').NextConfig} */

// The frontend proxies /api/* to the Fastify backend so the browser sees a
// single origin: session cookies (httpOnly, SameSite=Strict) work without CORS.
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:3000';

const nextConfig = {
  // The Next.js agent upgrade workflow keeps the framework on security releases.
  experimental: {
    agentUpgrade: 'security',
  },
  // Allow dev access from LAN/network hosts (e.g. 10.x) without HMR/origin blocks.
  allowedDevOrigins: ['localhost', '127.0.0.1', '10.0.60.144'],
  transpilePackages: ['@agreementhub/domain', '@agreementhub/contracts'],
  // Silence Next 16 "webpack config present with no turbopack config" when using
  // default Turbopack dev; the webpack alias remains available for `next dev --webpack`.
  turbopack: {},
  // Workspace packages (e.g. @agreementhub/domain) use NodeNext-style `.js`
  // specifiers in TS source; resolve them to `.ts` when bundling with webpack.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    };
    return config;
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${API_ORIGIN}/api/:path*`,
      },
      {
        source: '/health',
        destination: `${API_ORIGIN}/health`,
      },
    ];
  },
};

export default nextConfig;
