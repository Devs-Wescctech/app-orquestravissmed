/**
 * Task 141 — Parsing e normalização de registros profissionais (CRM etc.)
 * para o match "camada 0" entre médicos VisMed e Doctoralia.
 *
 * Regras:
 *  - Número normalizado = apenas dígitos, sem pontuação, ignorando zeros à esquerda.
 *  - Conselho (CRM, CRP, CRO, OAB, ...) faz parte da identidade: tipos diferentes nunca casam.
 *  - UF, quando presente ("CRM/SP 12345", "12345-RJ"), é extraída e faz parte da chave.
 */

export interface ParsedLicense {
    /** Sigla do conselho profissional (CRM, CRP, ...), ou null se não identificável. */
    council: string | null;
    /** UF brasileira (SP, RJ, ...), ou null se ausente/não confiável. */
    uf: string | null;
    /** Número normalizado: apenas dígitos, sem zeros à esquerda. Sempre não-vazio. */
    digits: string;
}

export type ShadowLicenseStatus = 'PARSED' | 'AMBIGUOUS' | 'UNPARSEABLE' | 'ABSENT';

export interface ShadowLicenseCredential {
    council: string;
    uf: string | null;
    regional: string | null;
    number: string;
}

export interface ShadowLicenseResult {
    /** Exact input reference/value; never trimmed or persisted. */
    raw: string | null | undefined;
    status: ShadowLicenseStatus;
    credential: ShadowLicenseCredential | null;
    rqes: string[];
    reason: string;
    observations: Array<'crm_rj_52_prefix' | 'embedded_rqe' | 'separate_rqe' | 'crn_numeric_region'>;
}

export type LicenseShadowCounter =
    | 'parsed' | 'absent' | 'ambiguous' | 'unparseable'
    | 'crm_rj_52_prefix' | 'embedded_rqe' | 'separate_rqe' | 'crn_numeric_region'
    | 'legacy_parseable_conservative_blocked'
    | 'legacy_unparseable_conservative_parsed';

const LICENSE_SHADOW_COUNTERS: Record<LicenseShadowCounter, number> = {
    parsed: 0,
    absent: 0,
    ambiguous: 0,
    unparseable: 0,
    crm_rj_52_prefix: 0,
    embedded_rqe: 0,
    separate_rqe: 0,
    crn_numeric_region: 0,
    legacy_parseable_conservative_blocked: 0,
    legacy_unparseable_conservative_parsed: 0,
};

const MAX_SHADOW_LICENSE_LENGTH = 256;

function shadowResult(
    raw: string | null | undefined,
    status: ShadowLicenseStatus,
    reason: string,
    credential: ShadowLicenseCredential | null = null,
    rqes: string[] = [],
    observations: ShadowLicenseResult['observations'] = [],
): ShadowLicenseResult {
    return { raw, status, credential, rqes, reason, observations };
}

function normalizeShadowNumber(value: string): string | null {
    if (!/^[0-9]+(?:[.][0-9]+)*$/.test(value)) return null;
    const digits = value.replace(/[.]/g, '').replace(/^0+/, '');
    return digits || null;
}

/**
 * Conservative parser used only for shadow observation. It intentionally accepts
 * a small set of anchored ASCII grammars and fails closed for everything else.
 */
export function parseLicenseStringConservative(
    raw?: string | null,
    councilHint?: string | null,
): ShadowLicenseResult {
    if (raw == null) return shadowResult(raw, 'ABSENT', 'absent');
    if (raw.length > MAX_SHADOW_LICENSE_LENGTH) return shadowResult(raw, 'UNPARSEABLE', 'input_too_long');
    if (/[^\x20-\x7Eº°]/.test(raw)) return shadowResult(raw, 'UNPARSEABLE', 'non_ascii_character');
    const value = raw.trim().toUpperCase();
    if (value === '') return shadowResult(raw, 'ABSENT', 'absent');
    const hint = normalizeCouncil(councilHint);
    const rqePattern = /(?:^|[\s,;])(RQE(?:\s+([0-9]+)|:\s*([0-9]+)|\s+N[º°]:\s*([0-9]+)))(?=$|[\s,;])/g;
    const rqeTokens = Array.from(value.matchAll(rqePattern));
    const valueWithoutRecognizedRqe = rqeTokens.reduce((remaining, token) => remaining.replace(token[1], ''), value);
    if (/[º°]/.test(valueWithoutRecognizedRqe)) {
        return shadowResult(raw, 'UNPARSEABLE', 'non_ascii_character');
    }
    const malformedRqe = /(?:^|[\s,;])RQE(?:$|[\s,;:])/.test(value) && rqeTokens.length === 0;
    if (malformedRqe) return shadowResult(raw, 'UNPARSEABLE', 'malformed_rqe');
    if (rqeTokens.length > 1) return shadowResult(raw, 'AMBIGUOUS', 'multiple_rqes');

    const rqes = rqeTokens.map(token => (token[2] || token[3] || token[4]).replace(/^0+/, ''));
    if (rqes.some(rqe => rqe === '')) {
        return shadowResult(raw, 'UNPARSEABLE', 'zero_rqe', null, [], [
            value.startsWith('RQE') ? 'separate_rqe' : 'embedded_rqe',
        ]);
    }
    let main = value;
    if (rqeTokens.length === 1) {
        main = value.replace(rqeTokens[0][0], '').trim().replace(/[,;]$/, '').trim();
        if (!main) return shadowResult(raw, 'UNPARSEABLE', 'rqe_without_primary', null, rqes, ['separate_rqe']);
    }
    const observations: ShadowLicenseResult['observations'] = rqes.length ? ['embedded_rqe'] : [];

    if (hint === 'CRM' && /^52-/.test(main)) {
        const remainder = main.slice(3);
        const crmRjNumber = /^([0-9]+)(?:-([0-9]))?$/.exec(remainder);
        if (!crmRjNumber) return shadowResult(raw, 'UNPARSEABLE', 'invalid_crm_rj_52_number', null, rqes);
        const number = normalizeShadowNumber(crmRjNumber[1] + (crmRjNumber[2] || ''));
        if (!number || number.length < 2) return shadowResult(raw, 'UNPARSEABLE', 'invalid_crm_rj_52_number', null, rqes);
        return shadowResult(raw, 'PARSED', 'crm_rj_52_prefix', {
            council: 'CRM', uf: 'RJ', regional: null, number,
        }, rqes, [...observations, 'crm_rj_52_prefix']);
    }
    if (/^52[- ]/.test(main) || main.includes(' 52-')) {
        return shadowResult(raw, 'UNPARSEABLE', 'unsupported_52_prefix', null, rqes);
    }

    const crn = /^CRN(?:-?([0-9]+))?\/([0-9]+(?:[.][0-9]+)*)$/.exec(main);
    if (crn) {
        if (hint && hint !== 'CRN') return shadowResult(raw, 'AMBIGUOUS', 'council_contradicts_document_type', null, rqes);
        const number = normalizeShadowNumber(crn[2]);
        if (!number) return shadowResult(raw, 'UNPARSEABLE', 'zero_number', null, rqes);
        const obs = crn[1] ? [...observations, 'crn_numeric_region' as const] : observations;
        return shadowResult(raw, 'PARSED', crn[1] ? 'crn_numeric_region' : 'explicit_council', {
            council: 'CRN', uf: null, regional: crn[1] || null, number,
        }, rqes, obs);
    }

    const explicit = /^(CREFITO|CRBIO|COREN|CRESS|CRFA|CRMV|CRBM|CREF|CRTR|CRM|CRP|CRO|CRN|CRF|CRQ|OAB|CFM)(?:\/?([A-Z]{2}))?[\s/]+([0-9]+(?:[.][0-9]+)*)$/.exec(main)
        || /^(CREFITO|CRBIO|COREN|CRESS|CRFA|CRMV|CRBM|CREF|CRTR|CRM|CRP|CRO|CRN|CRF|CRQ|OAB|CFM)([A-Z]{2})\s+([0-9]+(?:[.][0-9]+)*)$/.exec(main);
    if (explicit) {
        const council = explicit[1];
        const uf = explicit[2] || null;
        if (hint && hint !== council) return shadowResult(raw, 'AMBIGUOUS', 'council_contradicts_document_type', null, rqes);
        if (uf && !BR_UFS.has(uf)) return shadowResult(raw, 'UNPARSEABLE', 'unknown_uf', null, rqes);
        const number = normalizeShadowNumber(explicit[3]);
        if (!number) return shadowResult(raw, 'UNPARSEABLE', 'zero_number', null, rqes);
        return shadowResult(raw, 'PARSED', 'explicit_council', { council, uf, regional: null, number }, rqes, observations);
    }

    if (/^[0-9]+(?:[.][0-9]+)*$/.test(main)) {
        if (!hint || !KNOWN_COUNCILS.includes(hint)) return shadowResult(raw, 'UNPARSEABLE', 'number_without_known_document_type', null, rqes);
        const number = normalizeShadowNumber(main);
        if (!number) return shadowResult(raw, 'UNPARSEABLE', 'zero_number', null, rqes);
        return shadowResult(raw, 'PARSED', 'document_type_with_number', {
            council: hint, uf: null, regional: null, number,
        }, rqes, observations);
    }

    if (/\d+\s+\d+/.test(main)) return shadowResult(raw, 'AMBIGUOUS', 'multiple_unlabelled_numbers', null, rqes);
    return shadowResult(raw, 'UNPARSEABLE', 'unsupported_grammar', null, rqes);
}

export function isLicenseShadowModeEnabled(envValue = process.env.LICENSE_NORMALIZER_SHADOW): boolean {
    return envValue === '1' || envValue?.toLowerCase() === 'true';
}

export function observeLicenseShadow(raw?: string | null, councilHint?: string | null): void {
    const result = parseLicenseStringConservative(raw, councilHint);
    LICENSE_SHADOW_COUNTERS[result.status.toLowerCase() as Lowercase<ShadowLicenseStatus>]++;
    for (const observation of result.observations) LICENSE_SHADOW_COUNTERS[observation]++;
    const old = parseLicenseString(raw, councilHint);
    if (old && result.status !== 'PARSED') LICENSE_SHADOW_COUNTERS.legacy_parseable_conservative_blocked++;
    if (!old && result.status === 'PARSED') LICENSE_SHADOW_COUNTERS.legacy_unparseable_conservative_parsed++;
}

export function getLicenseShadowCounters(): Readonly<Record<LicenseShadowCounter, number>> {
    return { ...LICENSE_SHADOW_COUNTERS };
}

export function resetLicenseShadowCounters(): void {
    for (const key of Object.keys(LICENSE_SHADOW_COUNTERS) as LicenseShadowCounter[]) LICENSE_SHADOW_COUNTERS[key] = 0;
}

const BR_UFS = new Set([
    'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS',
    'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC',
    'SP', 'SE', 'TO',
]);

// Ordem importa: siglas mais longas primeiro para o caso de token colado (ex.: "CREFITOSP").
const KNOWN_COUNCILS = [
    'CREFITO', 'CRBIO', 'COREN', 'CRESS', 'CRFA', 'CRMV', 'CRBM', 'CREF',
    'CRTR', 'CRM', 'CRP', 'CRO', 'CRN', 'CRF', 'CRQ', 'OAB', 'CFM',
];

function normalizeToken(s: string): string {
    return (s || '')
        .toUpperCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

/** Normaliza a sigla do conselho (só letras, maiúsculas). Retorna null se vazio. */
export function normalizeCouncil(raw?: string | null): string | null {
    if (!raw) return null;
    const letters = normalizeToken(raw).replace(/[^A-Z]/g, '');
    return letters.length >= 2 ? letters : null;
}

/**
 * Faz o parse de uma string livre de registro profissional
 * (ex.: "CRM/SP 21.212.112", "21212112", "CRM-RJ 52123", "CRMSP 12345").
 *
 * @param raw string livre com o registro
 * @param councilHint sigla do conselho conhecida por fora (ex.: documentType do VisMed)
 * @returns ParsedLicense ou null quando não há número utilizável.
 */
export function parseLicenseString(raw?: string | null, councilHint?: string | null): ParsedLicense | null {
    const hint = normalizeCouncil(councilHint);
    const norm = normalizeToken(raw || '');
    // Tokeniza separando qualquer coisa que não seja letra/dígito
    const tokens = norm.split(/[^A-Z0-9]+/).filter(Boolean);

    let council: string | null = null;
    let uf: string | null = null;
    let digits = '';

    for (const tok of tokens) {
        if (/^\d+$/.test(tok)) {
            digits += tok;
            continue;
        }
        if (/^[A-Z]+$/.test(tok)) {
            if (!council) {
                const known = KNOWN_COUNCILS.find(c => tok === c || tok.startsWith(c));
                if (known) {
                    council = known;
                    const rest = tok.slice(known.length);
                    if (!uf && BR_UFS.has(rest)) uf = rest;
                    continue;
                }
            }
            if (!uf && BR_UFS.has(tok)) { uf = tok; continue; }
            continue;
        }
        // Token misto (ex.: "CRM12345", "SP12345")
        const letters = tok.replace(/[^A-Z]/g, '');
        const nums = tok.replace(/[^0-9]/g, '');
        if (!council) {
            const known = KNOWN_COUNCILS.find(c => letters === c || letters.startsWith(c));
            if (known) {
                council = known;
                const rest = letters.slice(known.length);
                if (!uf && BR_UFS.has(rest)) uf = rest;
            } else if (!uf && BR_UFS.has(letters)) {
                uf = letters;
            }
        } else if (!uf && BR_UFS.has(letters)) {
            uf = letters;
        }
        digits += nums;
    }

    // Zeros à esquerda são ignorados na normalização
    digits = digits.replace(/^0+/, '');
    if (!digits) return null;

    return { council: hint || council, uf, digits };
}

/**
 * Compatibilidade de conselho: iguais → compatível; um dos lados desconhecido →
 * compatível apenas via regra conservadora (unicidade) aplicada pelo chamador;
 * conselhos DIFERENTES conhecidos (ex.: CRM × CRP) → nunca compatíveis.
 */
export function councilsCompatible(a: string | null, b: string | null): boolean {
    if (a && b) return a === b;
    return true;
}

/**
 * Extrai as strings de license numbers de um item de médico retornado pela
 * API da Doctoralia (extensão `?with[]=doctor.license_numbers`).
 *
 * A extensão referencia a relação ANINHADA `doctor.license_numbers`, então o
 * payload pode vir como `item.doctor.license_numbers` OU achatado em
 * `item.license_numbers`; a lista pode ainda vir envelopada em `{ _items: [...] }`
 * (padrão de coleções da API v3). Cada entrada pode ser string livre
 * ("CRM/SP 12345") ou objeto com campos separados (type/council, region/uf/state,
 * number/license_number) — nesses casos os campos são preservados na string
 * composta para o parser (`parseLicenseString`) extrair conselho/UF/número.
 * Lista ausente ou vazia é tolerada (retorna []).
 */
export function extractDoctoraliaLicenseStrings(doc: any): string[] {
    let raw =
        doc?.doctor?.license_numbers ??
        doc?.doctor?.licenseNumbers ??
        doc?.license_numbers ??
        doc?.licenseNumbers ??
        [];
    // Coleções da API v3 podem vir envelopadas em { _items: [...] }
    if (raw && !Array.isArray(raw) && Array.isArray(raw._items)) raw = raw._items;
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) {
        if (typeof item === 'string') {
            if (item.trim()) out.push(item.trim());
        } else if (typeof item === 'number') {
            out.push(String(item));
        } else if (item && typeof item === 'object') {
            const direct = item.license_number ?? item.licenseNumber ?? item.number ?? item.value;
            if (typeof direct === 'string' || typeof direct === 'number') {
                // Preserva conselho e UF quando vêm em campos separados
                const type = [item.type, item.council, item.kind].find(v => typeof v === 'string') ?? '';
                const region = [item.region, item.uf, item.state, item.province].find(v => typeof v === 'string') ?? '';
                const s = `${type} ${region} ${direct}`.replace(/\s+/g, ' ').trim();
                if (s) out.push(s);
            } else {
                const s = Object.values(item)
                    .filter(v => typeof v === 'string' || typeof v === 'number')
                    .join(' ')
                    .trim();
                if (s) out.push(s);
            }
        }
    }
    return out;
}

/**
 * Monta os dados de create/update do upsert de DoctoraliaDoctor a partir do
 * item cru da listagem de médicos (com a extensão doctor.license_numbers).
 * Único ponto de verdade usado pelos dois caminhos de sync (processor e direto).
 */
export function buildDoctoraliaDoctorUpsertData(doc: any, facilityId: string): {
    create: { doctoraliaDoctorId: string; doctoraliaFacilityId: string; name: string; licenseNumbers: string[]; syncedAt: Date };
    update: { name: string; licenseNumbers: string[]; syncedAt: Date };
} {
    const docId = String(doc.id);
    const name = doc.surname ? `${doc.name} ${doc.surname}` : (doc.name || doc.title || `Doctor #${docId}`);
    const licenseNumbers = extractDoctoraliaLicenseStrings(doc);
    const syncedAt = new Date();
    return {
        create: { doctoraliaDoctorId: docId, doctoraliaFacilityId: facilityId, name, licenseNumbers, syncedAt },
        update: { name, licenseNumbers, syncedAt },
    };
}
