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
