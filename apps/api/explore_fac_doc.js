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

    console.log('--- FACILITY INFO ---');
    const facRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}`, { headers });
    const fac = await facRes.json();
    console.log(JSON.stringify(fac, null, 2));

    console.log('\n--- LIST ALL ADDRESSES FOR ONE DOCTOR ---');
    const docId = '1396868';
    const addrsRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors/${docId}/addresses`, { headers });
    const addrs = await addrsRes.json();
    console.log(JSON.stringify(addrs, null, 2));
}

test().catch(console.error);
