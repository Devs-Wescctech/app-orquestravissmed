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
    const docId = '1396868'; // Aaron
    const addrId = '1750984';

    // 1. First get current address details
    console.log('=== CURRENT ADDRESS ===');
    const getRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`, { headers });
    const addr = await getRes.json();
    console.log(JSON.stringify(addr, null, 2));
    console.log('\ninsurance flag:', addr.booking_extra_fields?.insurance);

    // 2. Try PATCH with only name and street (no insurance)
    console.log('\n=== TESTING PATCH (name + street only) ===');
    const patchPayload = {
        name: 'Clínica VisMed Test',
        street: 'Rua de Teste, 123',
        city: 'São Paulo',
        post_code: '01000-000'
    };
    console.log('Payload:', JSON.stringify(patchPayload));

    const patchRes = await fetch(
        `https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`,
        { method: 'PATCH', headers, body: JSON.stringify(patchPayload) }
    );
    console.log('PATCH Status:', patchRes.status);
    const patchText = await patchRes.text();
    console.log('Response:', patchText.substring(0, 500));
}

test().catch(console.error);
