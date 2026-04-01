const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';

async function testShortUrl() {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
        const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` },
            body: 'grant_type=client_credentials&scope=integration'
        });
        const { access_token } = await tokenRes.json();
        const headers = { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' };

        const facilityId = '140548';
        const docId = '1396868';
        const addrId = '1750984';

        console.log(`--- TESTING SHORT URL: /api/v3/integration/addresses/${addrId} ---`);
        const payload = {
            name: "Vismed Clinica Test",
            street: "Rua Nova, 123",
            insurance_support: "private"
        };

        const res = await fetch(`https://www.${DOMAIN}/api/v3/integration/addresses/${addrId}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify(payload)
        });

        console.log('Status:', res.status);
        const data = await res.json();
        console.log('Updated Object:', JSON.stringify(data, null, 2));

        if (data.name === "Vismed Clinica Test" || data.street === "Rua Nova, 123") {
            console.log('\nSUCCESS! Short URL works for PATCH.');
        } else {
            console.log('\nFAILED! Short URL also ignored changes or this is not the right endpoint.');
        }

    } catch (e) {
        console.error(e);
    }
}

testShortUrl();
