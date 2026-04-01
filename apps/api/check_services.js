const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fetch = global.fetch;

async function test() {
    const conn = await prisma.integrationConnection.findFirst({
        where: { provider: 'doctoralia' }
    });
    const domain = conn.domain || 'doctoralia.com.br';
    const clientId = conn.clientId;
    const clientSecret = conn.clientSecret;
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const authRes = await fetch(`https://${domain}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` },
        body: 'grant_type=client_credentials&scope=integration'
    });
    const { access_token } = await authRes.json();

    const facilityId = '140548';
    const doctorId = '1396868';
    const addressId = '1750984';
    
    const url = `https://www.doctoralia.com.br/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/services`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${access_token}` } });
    const data = await res.json();
    console.log('Services:', JSON.stringify(data));
    
    await prisma.$disconnect();
}
test();
