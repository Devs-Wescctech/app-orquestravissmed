const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';

async function test() {
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

    // Get current address to see the actual insurance_support value
    const getRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`, { headers });
    const addr = await getRes.json();
    console.log('Current insurance_support:', addr.insurance_support);
    console.log('Current name:', addr.name);
    console.log('Current street:', addr.street);

    // Test with correct snake_case field
    const payload = {
        name: 'VISSMed CLINIC Test',
        street: 'Rua de Teste, 123 - Sala 201 (Centro)',
        city_name: 'São Paulo',
        post_code: '01000-000',
        insurance_support: addr.insurance_support || 'private'
    };

    console.log('\nPATCH payload:', JSON.stringify(payload, null, 2));
    const patchRes = await fetch(
        `https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`,
        { method: 'PATCH', headers, body: JSON.stringify(payload) }
    );
    console.log('PATCH Status:', patchRes.status);
    const text = await patchRes.text();
    console.log('Response:', text.substring(0, 500));
}

test().catch(console.error);
