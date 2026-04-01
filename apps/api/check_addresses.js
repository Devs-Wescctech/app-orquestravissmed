const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fetch = global.fetch;

async function test() {
    const conn = await prisma.integrationConnection.findFirst({
        where: { provider: 'doctoralia' }
    });
    const { access_token } = await (await fetch(`https://${conn.domain}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${Buffer.from(`${conn.clientId}:${conn.clientSecret}`).toString('base64')}` },
        body: 'grant_type=client_credentials&scope=integration'
    })).json();

    const facilityId = '140548';
    const doctorId = '1396868';
    
    const url = `https://www.doctoralia.com.br/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${access_token}` } });
    console.log('Addresses:', await res.text());
    
    await prisma.$disconnect();
}
test();
