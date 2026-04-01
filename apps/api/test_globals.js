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
        const insRes = await axios.get(`https://www.${conn.domain}/api/v3/integration/insurances`, { headers: { 'Authorization': `Bearer ${token}` } });
        console.log('Global Insurances:', insRes.data._items?.length);
    } catch (e) { console.log('Global Insurances Failed:', e.response?.status); }

    try {
        const servRes = await axios.get(`https://www.${conn.domain}/api/v3/integration/services`, { headers: { 'Authorization': `Bearer ${token}` } });
        console.log('Global Services:', servRes.data._items?.length);
    } catch (e) { console.log('Global Services Failed:', e.response?.status); }
}
main().finally(() => prisma.$disconnect());
