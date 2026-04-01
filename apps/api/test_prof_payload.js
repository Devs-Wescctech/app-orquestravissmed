const https = require('https');
const fs = require('fs');

https.get('https://app.vissmed.com.br/api-vissmed-4/api/v1.0/profissionais-by-idempresagestora?idempresagestora=268', { rejectUnauthorized: false }, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            fs.writeFileSync('vismed_profissionais.json', JSON.stringify(json.slice(0, 3), null, 2));
            console.log('Saved 3 professionals to vismed_profissionais.json');
        } catch (e) {
            console.error('Parse error:', e, 'Data:', data.substring(0, 200));
        }
    });
}).on('error', e => console.error(e));
