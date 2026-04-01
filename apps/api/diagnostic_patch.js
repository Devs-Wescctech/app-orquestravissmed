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

    console.log('--- GET CURRENT ---');
    const getRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`, { headers });
    const current = await getRes.json();
    console.log('Current Name:', current.name);
    console.log('Current Street:', current.street);

    // Try to update with a very simple payload
    const payload = {
        name: "CLINICA VISMED - " + new Date().getTime(),
        street: "RUA DE TESTE, 999",
        insurance_support: "private"
    };

    console.log('\n--- PATCH ATTEMPT ---');
    console.log('Payload:', JSON.stringify(payload, null, 2));

    const patchRes = await fetch(
        `https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`,
        { method: 'PATCH', headers, body: JSON.stringify(payload) }
    );

    console.log('PATCH Status:', patchRes.status);
    const updated = await patchRes.json();
    console.log('Updated Name:', updated.name);
    console.log('Updated Street:', updated.street);

    if (updated.name === current.name) {
        console.log('\nFAILED: Name did not change despite 200 status.');
    } else {
        console.log('\nSUCCESS: Name changed!');
    }
}

test().catch(console.error);
