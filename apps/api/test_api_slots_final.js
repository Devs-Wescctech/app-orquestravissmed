const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fetch = global.fetch;

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
    const authRes = await fetch(`https://${domain}/oauth/v2/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${basicAuth}`
        },
        body: 'grant_type=client_credentials&scope=integration'
    });
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

    const tryUrl = async (name, params) => {
        const url = `https://${cleanDomain}/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/slots?${params}`;
        console.log(`Trying ${name}: ${url}`);
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${access_token}` }
        });
        console.log(`Status: ${res.status}`);
        const text = await res.text();
        console.log(`Body: ${text.substring(0, 500)}`);
    };

    const tryServiceUrl = async (params) => {
        const serviceId = '5934355'; // Managed previously
        const url = `https://${cleanDomain}/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/services/${serviceId}/slots?${params}`;
        console.log(`Trying Service URL: ${url}`);
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${access_token}` }
        });
        console.log(`Status: ${res.status}`);
        const text = await res.text();
        console.log(`Body: ${text.substring(0, 500)}`);
    };

    await tryServiceUrl(`start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    const tryNoWww = async (params) => {
        const url = `https://doctoralia.com.br/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/slots?${params}`;
        console.log(`Trying No-WWW: ${url}`);
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${access_token}` } });
        console.log(`Status: ${res.status}`);
        const text = await res.text();
        console.log(`Body: ${text.substring(0, 500)}`);
    };

    await tryUrl('Unix Timestamp', `start=1710644400&end=1710730800`);
    await tryUrl('ISO but no timezone', `start=2026-03-17T00:00:00&end=2026-03-17T23:59:59`);
    
    await prisma.$disconnect();
}

test();
