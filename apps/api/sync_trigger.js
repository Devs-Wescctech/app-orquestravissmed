const http = require('http');

const options = {
    hostname: 'localhost',
    port: 3333,
    path: '/sync/36749174-fb55-4ef6-94de-2f24ea97dc57/run',
    method: 'POST'
};

const req = http.request(options, res => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => console.log('Doctoralia Sync:', data));
});
req.end();

const options2 = {
    hostname: 'localhost',
    port: 3333,
    path: '/sync/36749174-fb55-4ef6-94de-2f24ea97dc57/vismed/run',
    method: 'POST'
};

const req2 = http.request(options2, res => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => console.log('VisMed Sync:', data));
});
req2.end();
