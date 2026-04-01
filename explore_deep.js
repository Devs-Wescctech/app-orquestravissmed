const fs = require('fs');
const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';
const BASE = 'https://www.' + DOMAIN + '/api/v3/integration';

async function deepExplore() {
    const out = [];
    const log = (msg) => { out.push(msg); console.log(msg); };

    const basicAuth = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
    const tokenRes = await fetch('https://www.' + DOMAIN + '/oauth/v2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + basicAuth },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'integration' }).toString()
    });
    const { access_token } = await tokenRes.json();
    const h = { 'Authorization': 'Bearer ' + access_token };

    const facId = '140548';
    const docId = '1396868';
    const addrId = '1750984';

    // 1. Services via address
    log('=== SERVICES VIA ADDRESS ===');
    const svcRes = await fetch(BASE + `/facilities/${facId}/doctors/${docId}/addresses/${addrId}/services`, { headers: h });
    log('Status: ' + svcRes.status);
    const svcBody = await svcRes.text();
    log(svcBody.substring(0, 2000));

    // 2. Bookings with start parameter (today)
    const today = new Date().toISOString().split('T')[0];
    const pastDate = '2025-01-01';
    log('\n=== BOOKINGS (start=' + today + ') ===');
    const bookRes = await fetch(BASE + `/facilities/${facId}/doctors/${docId}/addresses/${addrId}/bookings?start=${today}`, { headers: h });
    log('Status: ' + bookRes.status);
    const bookBody = await bookRes.text();
    log(bookBody.substring(0, 2000));

    // 3. Bookings from past to see if any exist
    log('\n=== BOOKINGS (start=' + pastDate + ') ===');
    const bookRes2 = await fetch(BASE + `/facilities/${facId}/doctors/${docId}/addresses/${addrId}/bookings?start=${pastDate}`, { headers: h });
    log('Status: ' + bookRes2.status);
    const bookBody2 = await bookRes2.text();
    log(bookBody2.substring(0, 2000));

    // 4. Slots
    log('\n=== SLOTS (start=' + today + ') ===');
    const slotRes = await fetch(BASE + `/facilities/${facId}/doctors/${docId}/addresses/${addrId}/slots?start=${today}`, { headers: h });
    log('Status: ' + slotRes.status);
    const slotBody = await slotRes.text();
    log(slotBody.substring(0, 2000));

    // 5. Try for ALL doctors - addresses and bookings
    const allDocs = ['1396868', '1396869', '1396870', '1396871', '1396872'];
    for (const did of allDocs) {
        log('\n=== DOCTOR ' + did + ': ADDRESSES ===');
        const aRes = await fetch(BASE + `/facilities/${facId}/doctors/${did}/addresses`, { headers: h });
        const aBody = await aRes.json();
        for (const addr of (aBody._items || [])) {
            log(`  Address ${addr.id}: ${addr.name} - ${addr.city_name}`);
            // bookings for this address
            const bRes = await fetch(BASE + `/facilities/${facId}/doctors/${did}/addresses/${addr.id}/bookings?start=${pastDate}`, { headers: h });
            const bBody = await bRes.text();
            log(`  Bookings: ${bBody.substring(0, 300)}`);
        }
    }

    fs.writeFileSync('explore_deep.txt', out.join('\n'));
    log('\nSaved to explore_deep.txt');
}
deepExplore().catch(e => console.error(e));
