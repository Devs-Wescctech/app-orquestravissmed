const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function test() {
    const conn = await prisma.integrationConnection.findFirst({ where: { provider: 'doctoralia' } });
    if (!conn) return console.log('No connection found');

    const basicAuth = Buffer.from(`${conn.clientId}:${conn.clientSecret}`).toString('base64');
    const resAuth = await fetch(`https://www.${conn.domain}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'integration' }).toString()
    });
    const token = (await resAuth.json()).access_token;

    const resFac = await fetch(`https://www.${conn.domain}/api/v3/integration/facilities`, { headers: { 'Authorization': `Bearer ${token}` } });
    const facId = (await resFac.json())._items[0].id;

    const resDoc = await fetch(`https://www.${conn.domain}/api/v3/integration/facilities/${facId}/doctors`, { headers: { 'Authorization': `Bearer ${token}` } });
    const doctors = (await resDoc.json())._items || [];

    for (const doc of doctors) {
        console.log(`Checking doc ${doc.id} - ${doc.name}...`);
        const resAddr = await fetch(`https://www.${conn.domain}/api/v3/integration/facilities/${facId}/doctors/${doc.id}/addresses`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!resAddr.ok) {
            console.log(`Address Error: ${resAddr.status} - ${(await resAddr.text()).substring(0, 100)}`);
            continue;
        }
        const addresses = (await resAddr.json())._items || [];
        for (const addr of addresses) {
            const resSrv = await fetch(`https://www.${conn.domain}/api/v3/integration/facilities/${facId}/doctors/${doc.id}/addresses/${addr.id}/services`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!resSrv.ok) {
                console.log(`Service Error: ${resSrv.status} - ${(await resSrv.text()).substring(0, 100)}`);
            } else {
                console.log(` > Found ${(await resSrv.json())._items?.length} services for address ${addr.id}`);
            }
        }
    }
}
test().catch(console.error).finally(() => prisma.$disconnect());
