const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';
const { PrismaClient } = require('@prisma/client');

async function test() {
    const prisma = new PrismaClient();
    const clinic = await prisma.clinic.findFirst();
    console.log('=== CLINIC ADDRESS CONFIG ===');
    console.log('Name:', clinic.name);
    console.log('Street:', clinic.addressStreet);
    console.log('Number:', clinic.addressNumber);
    console.log('Complement:', clinic.addressComplement);
    console.log('Neighborhood:', clinic.addressNeighborhood);
    console.log('City:', clinic.addressCity);
    console.log('State:', clinic.addressState);
    console.log('ZipCode:', clinic.addressZipCode);

    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
        body: 'grant_type=client_credentials&scope=integration'
    });
    const { access_token } = await tokenRes.json();
    const headers = { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' };

    const facilityId = '140548';
    const docId = '1396868';
    const addrId = '1750984';

    // Build address payload from clinic config
    let street = clinic.addressStreet || '';
    if (clinic.addressNumber) street += `, ${clinic.addressNumber}`;
    if (clinic.addressComplement) street += ` - ${clinic.addressComplement}`;
    if (clinic.addressNeighborhood) street += ` (${clinic.addressNeighborhood})`;

    const payload = {
        name: clinic.name || 'VisMed Clinic',
        street: street || undefined,
        city_name: clinic.addressCity || undefined,
        post_code: clinic.addressZipCode || undefined,
        insurance_support: 'private'
    };

    // Clean undefined fields
    Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

    console.log('\n=== PATCH PAYLOAD ===');
    console.log(JSON.stringify(payload, null, 2));

    const patchRes = await fetch(
        `https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`,
        { method: 'PATCH', headers, body: JSON.stringify(payload) }
    );
    console.log('\nPATCH Status:', patchRes.status);
    const respText = await patchRes.text();
    try {
        const resp = JSON.parse(respText);
        console.log('Response name:', resp.name);
        console.log('Response street:', resp.street);
        console.log('Response city:', resp.city_name);
        console.log('Response post_code:', resp.post_code);
    } catch {
        console.log('Response:', respText.substring(0, 300));
    }

    await prisma.$disconnect();
}

test().catch(console.error);
