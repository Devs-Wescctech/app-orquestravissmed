async function main() {
    try {
        console.log('Testing HTTPS fetch to Doctoralia...');
        const res = await fetch('https://www.doctoralia.com.br/oauth/v2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=client_credentials&scope=integration'
        });
        console.log('HTTP STATUS: ' + res.status);
        const text = await res.text();
        console.log('RESPONSE: ' + text.substring(0, 200));
    } catch (e) {
        console.log('FETCH ERROR: ' + e.message);
        console.log('ERROR CODE: ' + e.code);
    }
}
main();
