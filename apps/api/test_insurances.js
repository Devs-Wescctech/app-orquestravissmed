const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const conn = await prisma.integrationConnection.findFirst({
        where: { clinicId: '36749174-fb55-4ef6-94de-2f24ea97dc57', provider: 'doctoralia' }
    });
    const basicAuth = Buffer.from(`${conn.clientId}:${conn.clientSecret}`).toString('base64');
    const authRes = await axios.post(`https://www.${conn.domain}/oauth/v2/token`, 'grant_type=client_credentials&scope=integration', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` }
    });
    const token = authRes.data.access_token;

    try {
        const facRes = await axios.get(`https://www.${conn.domain}/api/v3/integration/facilities`, { headers: { 'Authorization': `Bearer ${token}` } });
        const facId = facRes.data._items[0].id;

        console.log('Testing /insurance-providers...');
        const insRes = await axios.get(`https://www.${conn.domain}/api/v3/integration/facilities/${facId}/insurance-providers`, { headers: { 'Authorization': `Bearer ${token}` } });
        console.log('Got providers:', insRes.data._items?.length);
    } catch (e) { console.log('Providers Failed:', e.response?.status, e.response?.data); }
}
main().finally(() => prisma.$disconnect());
