/** @type {import('next').NextConfig} */
const nextConfig = {
    eslint: {
        ignoreDuringBuilds: true,
    },
    typescript: {
        ignoreBuildErrors: true,
    },
    webpack: (config) => {
        config.module.rules.push({
            test: /\.md$/,
            type: 'asset/source',
        });
        return config;
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
