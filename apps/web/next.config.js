/** @type {import('next').NextConfig} */
const nextConfig = {
    eslint: {
        ignoreDuringBuilds: true,
    },
    typescript: {
        ignoreBuildErrors: true,
    },
    async rewrites() {
        return [
            {
                source: '/api/:path*',
                destination: `http://localhost:${process.env.VISMED_API_PORT || '3000'}/:path*`,
            },
        ];
    },
};

module.exports = nextConfig;
