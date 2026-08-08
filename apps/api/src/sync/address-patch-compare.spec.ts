import { normalizeAddressField, canSkipAddressPatch, COMPARABLE_ADDRESS_FIELDS } from './address-patch-compare';

// ────────────────────────────────────────────────────────────────
// normalizeAddressField
// ────────────────────────────────────────────────────────────────

describe('normalizeAddressField', () => {
    describe('post_code', () => {
        it('removes hyphens from CEP', () => {
            expect(normalizeAddressField('post_code', '12345-678')).toBe('12345678');
        });

        it('removes spaces from CEP', () => {
            expect(normalizeAddressField('post_code', '12345 678')).toBe('12345678');
        });

        it('keeps all-numeric CEP unchanged', () => {
            expect(normalizeAddressField('post_code', '12345678')).toBe('12345678');
        });
    });

    describe('insurance_support', () => {
        it('lowercases enum value', () => {
            expect(normalizeAddressField('insurance_support', 'PRIVATE_AND_INSURANCE')).toBe('private_and_insurance');
        });

        it('trims and lowercases', () => {
            expect(normalizeAddressField('insurance_support', '  Private  ')).toBe('private');
        });
    });

    describe('city_name and other strings', () => {
        it('trims whitespace', () => {
            expect(normalizeAddressField('city_name', '  São Paulo  ')).toBe('São Paulo');
        });

        it('trims street field', () => {
            expect(normalizeAddressField('street', '  Rua A  ')).toBe('Rua A');
        });
    });

    describe('null / undefined / empty → empty string', () => {
        it('normalizes null to empty string', () => {
            expect(normalizeAddressField('city_name', null)).toBe('');
        });

        it('normalizes undefined to empty string', () => {
            expect(normalizeAddressField('city_name', undefined)).toBe('');
        });

        it('normalizes empty string to empty string', () => {
            expect(normalizeAddressField('city_name', '')).toBe('');
        });

        // (f) null vs "" tratados como iguais após normalização
        it('null and empty string normalize to the same value', () => {
            expect(normalizeAddressField('city_name', null)).toBe(normalizeAddressField('city_name', ''));
        });
    });
});

// ────────────────────────────────────────────────────────────────
// canSkipAddressPatch
// ────────────────────────────────────────────────────────────────

describe('canSkipAddressPatch', () => {
    // (a) todos os campos iguais → PATCH não enviado
    it('skips PATCH when all comparable fields are equal', () => {
        const payload = {
            insurance_support: 'private_and_insurance',
            city_name: 'São Paulo',
            post_code: '01001000',
        };
        const remote = {
            insurance_support: 'private_and_insurance',
            city_name: 'São Paulo',
            post_code: '01001000',
        };
        const { skip } = canSkipAddressPatch(payload, remote);
        expect(skip).toBe(true);
    });

    // (b) insurance_support diferente → PATCH enviado
    it('sends PATCH when insurance_support differs', () => {
        const payload = { insurance_support: 'private_and_insurance' };
        const remote  = { insurance_support: 'private' };
        const { skip } = canSkipAddressPatch(payload, remote);
        expect(skip).toBe(false);
    });

    // (c) post_code "12345-678" vs "12345678" → normalizados como iguais → PATCH não enviado
    it('skips PATCH when post_code differs only by hyphen', () => {
        const payload = { post_code: '12345-678' };
        const remote  = { post_code: '12345678' };
        const { skip } = canSkipAddressPatch(payload, remote);
        expect(skip).toBe(true);
    });

    // (d) string com espaços extras → trim → igual → PATCH não enviado
    it('skips PATCH when city_name differs only by surrounding whitespace', () => {
        const payload = { city_name: 'Campinas' };
        const remote  = { city_name: '  Campinas  ' };
        const { skip } = canSkipAddressPatch(payload, remote);
        expect(skip).toBe(true);
    });

    // (e) campo não-comparável (street) sempre força PATCH
    it('sends PATCH when payload contains non-comparable field (street)', () => {
        const payload = {
            insurance_support: 'private_and_insurance',
            city_name: 'São Paulo',
            street: 'Rua A, 123',   // não-comparável
        };
        const remote = {
            insurance_support: 'private_and_insurance',
            city_name: 'São Paulo',
            street: 'Rua A, 123',   // mesmo valor, mas campo excluído da comparação
        };
        const { skip, reason } = canSkipAddressPatch(payload, remote);
        expect(skip).toBe(false);
        expect(reason).toMatch(/street/);
    });

    // (f) null vs "" tratados como iguais após normalização
    it('treats null remote field as equal to empty-string payload field', () => {
        const payload = { city_name: '' };
        const remote  = { city_name: null as any };
        const { skip } = canSkipAddressPatch(payload, remote);
        expect(skip).toBe(true);
    });

    it('treats missing remote field as equal to empty-string payload field', () => {
        const payload = { city_name: '' };
        const remote  = {};
        const { skip } = canSkipAddressPatch(payload, remote);
        expect(skip).toBe(true);
    });

    // insurance_support enum: case-insensitive comparison
    it('skips PATCH when insurance_support differs only by case', () => {
        const payload = { insurance_support: 'private_and_insurance' };
        const remote  = { insurance_support: 'PRIVATE_AND_INSURANCE' };
        const { skip } = canSkipAddressPatch(payload, remote);
        expect(skip).toBe(true);
    });

    // Campo ausente no payload → não comparado, não bloqueia skip
    it('skips PATCH when a comparable field is absent from payload but remote differs', () => {
        // post_code absent in payload → omission is deliberate, not compared
        const payload = { insurance_support: 'private', city_name: 'Recife' };
        const remote  = { insurance_support: 'private', city_name: 'Recife', post_code: '99999999' };
        const { skip } = canSkipAddressPatch(payload, remote);
        expect(skip).toBe(true);
    });

    // payload vazio → skip (nenhum campo a comparar)
    it('skips PATCH when payload is empty', () => {
        const { skip } = canSkipAddressPatch({}, { insurance_support: 'private' });
        expect(skip).toBe(true);
    });

    // post_code com espaços e hífen no remoto
    it('normalizes post_code on both sides before comparing', () => {
        const payload = { post_code: '01310 100' };   // espaço
        const remote  = { post_code: '01310-100' };   // hífen
        const { skip } = canSkipAddressPatch(payload, remote);
        expect(skip).toBe(true);
    });

    // skip=false deve conter razão legível
    it('includes human-readable reason when PATCH is required', () => {
        const payload = { insurance_support: 'private' };
        const remote  = { insurance_support: 'private_and_insurance' };
        const { skip, reason } = canSkipAddressPatch(payload, remote);
        expect(skip).toBe(false);
        expect(reason).toContain('insurance_support');
    });

    // skip=true deve conter razão legível
    it('includes human-readable reason when PATCH is skipped', () => {
        const payload = { insurance_support: 'private' };
        const remote  = { insurance_support: 'private' };
        const { skip, reason } = canSkipAddressPatch(payload, remote);
        expect(skip).toBe(true);
        expect(reason.length).toBeGreaterThan(0);
    });
});

// ────────────────────────────────────────────────────────────────
// COMPARABLE_ADDRESS_FIELDS: sanity check
// ────────────────────────────────────────────────────────────────

describe('COMPARABLE_ADDRESS_FIELDS', () => {
    it('includes insurance_support, city_name, post_code', () => {
        expect(COMPARABLE_ADDRESS_FIELDS).toContain('insurance_support');
        expect(COMPARABLE_ADDRESS_FIELDS).toContain('city_name');
        expect(COMPARABLE_ADDRESS_FIELDS).toContain('post_code');
    });

    it('does NOT include street (excluded because format is not provably equivalent)', () => {
        expect(COMPARABLE_ADDRESS_FIELDS).not.toContain('street');
    });
});
