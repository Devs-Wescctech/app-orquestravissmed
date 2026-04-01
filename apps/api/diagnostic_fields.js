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

    const payloads = [
        {
            label: "Update City with 'city' field",
            body: { city: "Porto Alegre", insurance_support: "private" }
        },
        {
            label: "Update City with 'city_name' field",
            body: { city_name: "Porto Alegre", insurance_support: "private" }
        },
        {
            label: "Update Street with 'address' field",
            body: { address: "RUA OURO PRETO, 681", insurance_support: "private" }
        }
    ];

    for (const p of payloads) {
        console.log(`\n--- ${p.label} ---`);
        const res = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses/${addrId}`, {
            method: 'PATCH', headers, body: JSON.stringify(p.body)
        });
        console.log('Status:', res.status);
        const data = await res.json();
        console.log('Response City:', data.city || data.city_name);
        console.log('Response Street:', data.street || data.address);
    }
}

test().catch(console.error);
