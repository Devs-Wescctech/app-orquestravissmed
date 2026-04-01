const getDocplannerData = async () => {
    try {
        const credentials = Buffer.from('17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck:4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4').toString('base64');
        console.log('Fetching Docplanner Auth Token...');
        const authRes = await fetch('https://www.doctoralia.com.br/oauth/v2/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials&scope=integration'
        });
        const authData = await authRes.json();

        if (!authData.access_token) {
            console.error('Failed Auth', authData);
            return;
        }
        console.log('Got Token! Fetching Facilities...');

        const facRes = await fetch('https://www.doctoralia.com.br/api/v3/integration/facilities', {
            headers: { 'Authorization': `Bearer ${authData.access_token}` }
        });
        const facData = await facRes.json();

        console.log('FACILITIES:', JSON.stringify(facData, null, 2));

        if (facData._items && facData._items.length > 0) {
            const facId = facData._items[0].id;
            console.log(`Fetching Doctors for Facility ${facId}...`);
            const docRes = await fetch(`https://www.doctoralia.com.br/api/v3/integration/facilities/${facId}/doctors`, {
                headers: { 'Authorization': `Bearer ${authData.access_token}` }
            });
            const docData = await docRes.json();
            console.log('DOCTORS:', JSON.stringify(docData, null, 2));
        }

    } catch (e) {
        console.error(e);
    }
};

getDocplannerData();
