const https = require('https');
https.get('https://app.vissmed.com.br/api-vissmed-4/api/v1.0/convenios-by-idempresagestora?idempresagestora=286', { rejectUnauthorized: false }, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => console.log('STATUS:', res.statusCode, 'DATA:', data.substring(0, 100)));
});
