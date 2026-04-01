const fs = require('fs');
const CLIENT_ID = '17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck';
const CLIENT_SECRET = '4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4';
const DOMAIN = 'doctoralia.com.br';
const BASE = 'https://www.' + DOMAIN + '/api/v3/integration';

async function test() {
    const output = [];
    const log = (msg) => { output.push(msg); };

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

    // Calendar
    const calRes = await fetch(BASE + '/facilities/' + facId + '/doctors/' + docId + '/addresses/' + addrId + '/calendar', { headers: h });
    log('CALENDAR status: ' + calRes.status);
    const calBody = await calRes.text();
    log('CALENDAR body:\n' + calBody);

    // Bookings with datetime format
    const bRes1 = await fetch(BASE + '/facilities/' + facId + '/doctors/' + docId + '/addresses/' + addrId + '/bookings?start=2026-02-26%2000:00:00&end=2026-03-31%2023:59:59', { headers: h });
    log('\nBOOKINGS datetime-encoded status: ' + bRes1.status);
    const bBody1 = await bRes1.text();
    log('BOOKINGS body:\n' + bBody1);

    // Slots with datetime format
    const sRes1 = await fetch(BASE + '/facilities/' + facId + '/doctors/' + docId + '/addresses/' + addrId + '/slots?start=2026-02-26%2000:00:00&end=2026-03-31%2023:59:59', { headers: h });
    log('\nSLOTS datetime-encoded status: ' + sRes1.status);
    const sBody1 = await sRes1.text();
    log('SLOTS body:\n' + sBody1);

    // Try booking with ISO 8601
    const bRes2 = await fetch(BASE + '/facilities/' + facId + '/doctors/' + docId + '/addresses/' + addrId + '/bookings?start=2025-01-01T00:00:00&end=2026-12-31T23:59:59', { headers: h });
    log('\nBOOKINGS ISO status: ' + bRes2.status);
    const bBody2 = await bRes2.text();
    log('BOOKINGS ISO body:\n' + bBody2);

    fs.writeFileSync('api_final.txt', output.join('\n'));
    console.log('Saved to api_final.txt');
}
test().catch(e => console.error(e));
