const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const conn = await prisma.integrationConnection.findFirst({
        where: { clinicId: '36749174-fb55-4ef6-94de-2f24ea97dc57', provider: 'doctoralia' }
    });

    if (!conn) return console.log('No clinic');

    const basicAuth = Buffer.from(`${conn.clientId}:${conn.clientSecret}`).toString('base64');

    // Auth
    let token = '';
    try {
        const authRes = await axios.post(`https://www.${conn.domain}/oauth/v2/token`, 'grant_type=client_credentials&scope=integration', {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${basicAuth}`
            }
        });
        token = authRes.data.access_token;
        console.log('Authed seamlessly.');
    } catch (e) {
        return console.log('Auth failed:', e.response?.data);
    }

    // Facilities
    let facId = '';
    try {
        const facRes = await axios.get(`https://www.${conn.domain}/api/v3/integration/facilities`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        facId = facRes.data._items[0].id;
        console.log('Facility:', facId);
    } catch (e) {
        return console.log('Fac failed:', e.response?.data);
    }

    // Services
    try {
        const srvRes = await axios.get(`https://www.${conn.domain}/api/v3/integration/facilities/${facId}/services`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log('\n--- FIRST SERVICE ---');
        console.log(JSON.stringify(srvRes.data._items[0] || srvRes.data, null, 2));
    } catch (e) {
        console.log('Services failed:', e.response?.data);
    }

    // Insurances
    try {
        const insRes = await axios.get(`https://www.${conn.domain}/api/v3/integration/facilities/${facId}/insurances`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log('\n--- FIRST INSURANCE ---');
        console.log(JSON.stringify(insRes.data._items[0] || insRes.data, null, 2));
    } catch (e) {
        console.log('Insurances failed:', e.response?.data);
    }
}

main().finally(() => prisma.$disconnect());
