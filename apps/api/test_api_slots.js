const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function test() {
    const conn = await prisma.integrationConnection.findFirst({
        where: { provider: 'doctoralia' }
    });
    if (!conn) throw new Error('No connection found');

    const domain = conn.domain || 'doctoralia.com.br';
    const clientId = conn.clientId;
    const clientSecret = conn.clientSecret;
    
    // Auth
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const data = await authRes.json();
    const access_token = data.access_token;
    if (!access_token) {
        console.error('Auth failed:', JSON.stringify(data));
        process.exit(1);
    }
    console.log('Token obtained.');

    const facilityId = '140548';
    const doctorId = '1396868'; // Aaron
    const addressId = '1750984';

    const cleanDomain = domain.replace(/^https?:\/\//, '');
    const start = '2026-03-17T00:00:00-0300';
    const end = '2026-03-17T23:59:59-0300';

    const tryUrl = async (params) => {
        const url = `https://${cleanDomain}/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/slots?${params}`;
        console.log(`Trying: ${url}`);
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${access_token}` }
        });
        console.log(`Status: ${res.status}`);
        const text = await res.text();
        console.log(`Body: ${text.substring(0, 500)}`);
    };

    await tryUrl(`start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    await tryUrl(`range_start=${encodeURIComponent(start)}&range_end=${encodeURIComponent(end)}`);
}

test();
