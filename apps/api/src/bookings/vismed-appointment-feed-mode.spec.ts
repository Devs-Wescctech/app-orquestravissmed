import {
    canonicalizeVismedBaseUrl,
    resolveVismedAppointmentFeedContract,
    VISMED_APPOINTMENT_FEED_REGISTRY,
} from './vismed-appointment-feed-mode';

describe('Vissmed appointment feed instance registry', () => {
    it('is versioned and contains only unique, supported entries', () => {
        expect(VISMED_APPOINTMENT_FEED_REGISTRY.version).toBe(2);
        expect(new Set(VISMED_APPOINTMENT_FEED_REGISTRY.entries.map(e => e.instanceId)).size)
            .toBe(VISMED_APPOINTMENT_FEED_REGISTRY.entries.length);
        expect(new Set(VISMED_APPOINTMENT_FEED_REGISTRY.entries.map(e => e.canonicalBaseUrl)).size)
            .toBe(VISMED_APPOINTMENT_FEED_REGISTRY.entries.length);
        expect(VISMED_APPOINTMENT_FEED_REGISTRY.entries.every(
            e => e.appointmentFeedMode === 'LEGACY' || e.appointmentFeedMode === 'INCREMENTAL',
        )).toBe(true);
    });

    it.each([
        ['https://app.vissmed.com.br/api-docctor-3', 'vissmed-api-docctor-3'],
        ['https://app.vissmed.com.br/api-docctor-5', 'vissmed-api-docctor-5'],
        ['https://app.vissmed.com.br/api-docctor-5/api/v1.0/', 'vissmed-api-docctor-5'],
    ])('resolves confirmed incremental instance %s', (domain, instanceId) => {
        expect(resolveVismedAppointmentFeedContract(domain)).toMatchObject({
            contract: 'INCREMENTAL',
            instanceId,
            source: 'INSTANCE_REGISTRY',
        });
    });

    it('maps the São Leopoldo production URL to the canonical api-docctor-5 identity', () => {
        expect(resolveVismedAppointmentFeedContract(
            'https://app.vissmed.com.br/api-docctor-5/api/v1.0/',
        )).toMatchObject({
            contract: 'INCREMENTAL',
            instanceId: 'vissmed-api-docctor-5',
            canonicalBaseUrl: 'https://app.vissmed.com.br/api-docctor-5',
        });
    });

    it('resolves the documented api-vissmed-4 instance as legacy', () => {
        expect(resolveVismedAppointmentFeedContract(
            'https://app.vissmed.com.br/api-vissmed-4',
        )).toMatchObject({
            contract: 'LEGACY',
            instanceId: 'vissmed-api-vissmed-4',
        });
    });

    it.each([
        ['  https://APP.VISSMED.COM.BR/api-docctor-3/  ', 'https://app.vissmed.com.br/api-docctor-3'],
        ['https://app.vissmed.com.br:443/api-docctor-3', 'https://app.vissmed.com.br/api-docctor-3'],
        ['http://APP.VISSMED.COM.BR:80/api-docctor-3/', 'http://app.vissmed.com.br/api-docctor-3'],
    ])('canonicalizes only safe syntax differences', (domain, canonicalBaseUrl) => {
        expect(canonicalizeVismedBaseUrl(domain)).toEqual({ ok: true, canonicalBaseUrl });
    });

    it.each([
        [undefined, 'MISSING_DOMAIN'],
        ['', 'MISSING_DOMAIN'],
        ['not a URL', 'INVALID_URL'],
        ['ftp://app.vissmed.com.br/api-docctor-3', 'UNSUPPORTED_PROTOCOL'],
        ['https://user:pass@app.vissmed.com.br/api-docctor-3', 'EMBEDDED_CREDENTIALS'],
        ['https://app.vissmed.com.br/api-docctor-3?token=x', 'QUERY_NOT_ALLOWED'],
        ['https://app.vissmed.com.br/api-docctor-3?', 'QUERY_NOT_ALLOWED'],
        ['https://app.vissmed.com.br/api-docctor-3#x', 'FRAGMENT_NOT_ALLOWED'],
        ['https://app.vissmed.com.br/api-docctor-3#', 'FRAGMENT_NOT_ALLOWED'],
        ['HTTPS://app.vissmed.com.br/api-docctor-3', 'UNSUPPORTED_PROTOCOL'],
        ['https://app.vissmed.com.br/other/../api-docctor-3', 'INVALID_URL'],
        ['https://app.vissmed.com.br\\api-docctor-3', 'INVALID_URL'],
    ])('rejects ambiguous or unsafe domain %p', (domain, reason) => {
        expect(resolveVismedAppointmentFeedContract(domain)).toMatchObject({
            contract: 'UNCLASSIFIED',
            reason,
        });
    });

    it.each([
        'http://app.vissmed.com.br/api-docctor-3',
        'https://other.vissmed.com.br/api-docctor-3',
        'https://app.vissmed.com.br/api-docctor',
        'https://app.vissmed.com.br/api-docctor-30',
        'https://app.vissmed.com.br/api-docctor-3/extra',
        'https://app.vissmed.com.br/api-docctor-5/api/v1.0/extra',
    ])('requires an exact registry match after canonicalization: %s', domain => {
        expect(resolveVismedAppointmentFeedContract(domain)).toMatchObject({
            contract: 'UNCLASSIFIED',
            reason: 'INSTANCE_NOT_REGISTERED',
        });
    });

    it('registry prevails over a divergent legacy field', () => {
        expect(resolveVismedAppointmentFeedContract(
            'https://app.vissmed.com.br/api-docctor-3',
            'LEGACY',
        )).toMatchObject({
            contract: 'INCREMENTAL',
            legacyFieldDiverges: true,
        });
    });
});