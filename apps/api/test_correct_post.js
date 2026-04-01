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

    // 1. Try dictionary endpoint - with different URLs
    const urls = [
        `/facilities/140548/services`,
        `/services`
    ];

    for (const path of urls) {
        const url = `https://www.${DOMAIN}/api/v3/integration${path}`;
        console.log('GET ' + url);
        const res = await fetch(url, { headers });
        console.log('Status:', res.status);
        if (res.ok) {
            const data = await res.json();
            const items = data._items || [];
            console.log('Items: ' + items.length);
            // Show first 5
            items.slice(0, 5).forEach(i => console.log('  ID:' + i.id + ' - ' + i.name));
            if (items.length > 5) console.log('  ... and ' + (items.length - 5) + ' more');
        }
        console.log('');
    }

    // 2. Try POST with service_id (correct field from docs)
    const facilityId = '140548';
    const docId = '1396868';
    const addrId = '1750984';

    // Use one of the existing service IDs
    // "Primeira consulta Cirurgia Cardiovascular" has doctoraliaServiceId from our DB
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const svc = await prisma.doctoraliaService.findFirst();

    if (svc) {
        console.log('Testing POST with service_id: ' + svc.doctoraliaServiceId + ' (' + svc.name + ')');
        const postUrl = `https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}/services`;
        const body = {
            service_id: svc.doctoraliaServiceId,
            is_price_from: false,
            price: 200,
            is_visible: true,
            default_duration: 30
        };
        console.log('Body:', JSON.stringify(body));
        const postRes = await fetch(postUrl, { method: 'POST', headers, body: JSON.stringify(body) });
        console.log('POST Status:', postRes.status);
        console.log('Response:', await postRes.text());
    }

    await prisma.$disconnect();
}

run().catch(console.error);
