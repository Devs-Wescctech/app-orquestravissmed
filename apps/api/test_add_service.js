const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';

async function run() {
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
        body: 'grant_type=client_credentials&scope=integration'
    });
    const { access_token } = await tokenRes.json();
    const headers = { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' };

    const facilityId = '140548';
    const docId = '1396868'; // Aaron - Cardiologia
    const addrId = '1750984';

    // Try different service IDs that might map to "Primeira consulta Cardiologia"
    // From the first catalog fetch, we saw IDs like 10965, 10966, etc
    // The format in doctoralia is "Primeira consulta <specialty>"
    // Let's try to add a service by searching with POST

    // First, let's try the existing service IDs we know from the DB
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const existingServices = await prisma.doctoraliaService.findMany();
    console.log('Existing services in DB:');
    existingServices.forEach(s => console.log('  ID: ' + s.doctoraliaServiceId + ' - ' + s.name));

    // Let's try to add one of these as a POST
    for (const svc of existingServices) {
        console.log('\nTrying to add service ' + svc.name + ' (ID: ' + svc.doctoraliaServiceId + ') to doctor Aaron...');
        const postRes = await fetch(
            `https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}/services`,
            {
                method: 'POST',
                headers,
                body: JSON.stringify({ item_id: parseInt(svc.doctoraliaServiceId) })
            }
        );
        console.log('POST Status:', postRes.status);
        const text = await postRes.text();
        console.log('Response:', text.substring(0, 300));
        break; // Just test one
    }

    await prisma.$disconnect();
}

run().catch(console.error);
