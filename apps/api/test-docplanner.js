const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';

async function fetchRealData() {
    try {
        const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const tokenRes = await fetch(`https://www.${DOMAIN}/oauth/v2/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${basicAuth}`
            },
            body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'integration' }).toString()
        });

        const { access_token } = await tokenRes.json();
        console.log('Got Access Token!\n');

        const headers = { 'Authorization': `Bearer ${access_token}` };

        console.log('--- Fetching Facilities ---');
        const facRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities`, { headers });
        const facilities = await facRes.json();
        console.log(JSON.stringify(facilities, null, 2));

        if (facilities._items && facilities._items.length > 0) {
            const facilityId = facilities._items[0].id;
            console.log(`\n--- Fetching Doctors for Facility ${facilityId} ---`);
            const docRes = await fetch(`https://www.${DOMAIN}/api/v3/integration/facilities/${facilityId}/doctors`, { headers });
            const doctors = await docRes.json();
            console.log(JSON.stringify(doctors, null, 2));
        }

    } catch (e) {
        console.error('Test Failed:', e);
    }
}

fetchRealData();
