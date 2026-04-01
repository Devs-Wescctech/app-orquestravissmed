const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';

const FACILITY_ID = '140548';
const DOCTOR_ID = '1396872';
const ADDRESS_ID = '1750988';

async function testToggle() {
    try {
        const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${basicAuth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials&scope=integration'
        });

        const tokenData = await tokenRes.json();
        const accessToken = tokenData.access_token;
        console.log('Token ready');

        const url = `https://www.${DOMAIN}/api/v3/integration/facilities/${FACILITY_ID}/doctors/${DOCTOR_ID}/addresses/${ADDRESS_ID}/calendar-status`;
        
        console.log('GET', url);
        const getRes = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        console.log('GET Status:', getRes.status);
        console.log(await getRes.text());

        console.log('\nPOST (disabled)', url);
        const postRes = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ status: 'disabled' })
        });
        console.log('POST Status:', postRes.status);
        console.log(await postRes.text());

    } catch (e) {
        console.error(e);
    }
}

testToggle();
