const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
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
    const facRes = await axios.get(`https://www.${conn.domain}/api/v3/integration/facilities`, { headers: { 'Authorization': `Bearer ${token}` } });
    const facId = facRes.data._items[0].id;
    const docRes = await axios.get(`https://www.${conn.domain}/api/v3/integration/facilities/${facId}/doctors`, { headers: { 'Authorization': `Bearer ${token}` } });

    if (docRes.data._items.length > 0) {
        const docId = docRes.data._items[0].id;
        const addRes = await axios.get(`https://www.${conn.domain}/api/v3/integration/facilities/${facId}/doctors/${docId}/addresses`, { headers: { 'Authorization': `Bearer ${token}` } });
        const addressId = addRes.data._items[0].id;

        try {
            const servRes = await axios.get(`https://www.${conn.domain}/api/v3/integration/facilities/${facId}/doctors/${docId}/addresses/${addressId}/services`, { headers: { 'Authorization': `Bearer ${token}` } });
            fs.writeFileSync('doc_services.json', JSON.stringify(servRes.data, null, 2));
        } catch (e) { console.log('No services'); }

        try {
            const insRes = await axios.get(`https://www.${conn.domain}/api/v3/integration/facilities/${facId}/doctors/${docId}/addresses/${addressId}/insurances`, { headers: { 'Authorization': `Bearer ${token}` } });
            fs.writeFileSync('doc_insurances.json', JSON.stringify(insRes.data, null, 2));
        } catch (e) { console.log('No insurances: ', e.response?.data); }
    }
}
main().finally(() => prisma.$disconnect());
