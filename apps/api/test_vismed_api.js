const https = require('https');
const fs = require('fs');

const endpoints = [
    { name: 'profissionais', url: 'https://app.vissmed.com.br/api-vissmed-4/api/v1.0/profissionais-by-idempresagestora?idempresagestora=286' },
    { name: 'unidades', url: 'https://app.vissmed.com.br/api-vissmed-4/api/v1.0/unidade-by-idempresagestora?idempresagestora=286' },
    { name: 'especialidades', url: 'https://app.vissmed.com.br/api-vissmed-4/api/v1.0/especialidades-by-idempresagestora?idempresagestora=286' }
];

async function fetchAmostra(endpoint) {
    return new Promise((resolve, reject) => {
        https.get(endpoint.url, { rejectUnauthorized: false }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const sample = Array.isArray(json) ? json[0] : json;
                    const output = `\n--- Amostra de ${endpoint.name.toUpperCase()} ---\n` + JSON.stringify(sample, null, 2) + '\n';
                    fs.appendFileSync('vismed_samples.txt', output);
                    resolve();
                } catch (e) {
                    console.error(e);
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function run() {
    if (fs.existsSync('vismed_samples.txt')) fs.unlinkSync('vismed_samples.txt');
    for (const ep of endpoints) {
        await fetchAmostra(ep);
    }
}

run().catch(console.error);
