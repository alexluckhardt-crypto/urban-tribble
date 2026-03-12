import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      { protocol: 'https', hostname: '*.creatomate.com' },
      { protocol: 'https', hostname: 'cdn.creatomate.com' },
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '500mb',
    },
  },
  // Allow large bodies on API routes too
  api: {
    bodyParser: false,
    responseLimit: false,
  },
}

export default nextConfig
