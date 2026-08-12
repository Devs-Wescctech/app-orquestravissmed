'use strict';
/**
 * Certificado TLS exclusivamente de teste (autoassinado, SAN=localhost/127.0.0.1).
 * Nunca é usado fora do harness. O processo da API filho confia nele via
 * NODE_EXTRA_CA_CERTS (validação TLS permanece TOTALMENTE ativa).
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function ensureTestCert(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const keyPath = path.join(dir, 'loadtest-key.pem');
    const certPath = path.join(dir, 'loadtest-cert.pem');
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        execFileSync('openssl', [
            'req', '-x509', '-newkey', 'rsa:2048',
            '-keyout', keyPath, '-out', certPath,
            '-days', '3', '-nodes',
            '-subj', '/CN=loadtest-local-mock',
            '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
        ], { stdio: 'pipe' });
    }
    return { keyPath, certPath, key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

module.exports = { ensureTestCert };
