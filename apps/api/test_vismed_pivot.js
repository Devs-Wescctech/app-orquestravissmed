const https = require('https');

const pathsToTest = [
    'profissional-especialidades-by-idempresagestora',
    'profissional-especialidade-by-idempresagestora',
    'profissionais-especialidades-by-idempresagestora',
    'profissionais-especialidade-by-idempresagestora',
    'especialidades-profissional-by-idempresagestora'
];

async function testPath(path) {
    return new Promise(resolve => {
        https.get(`https://app.vissmed.com.br/api-vissmed-4/api/v1.0/${path}?idempresagestora=268`, { rejectUnauthorized: false }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ path, status: res.statusCode, data: data.substring(0, 100) }));
        }).on('error', () => resolve({ path, error: true }));
    });
}

async function main() {
    for (const path of pathsToTest) {
        const res = await testPath(path);
        console.log(`${res.path} -> HTTP ${res.status}: ${res.data}`);
    }
}
main();
