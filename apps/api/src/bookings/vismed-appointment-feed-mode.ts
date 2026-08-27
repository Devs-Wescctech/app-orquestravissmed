export type VismedAppointmentFeedMode = 'LEGACY' | 'INCREMENTAL';
export type VismedAppointmentFeedContract = VismedAppointmentFeedMode | 'UNCLASSIFIED';

export type VismedAppointmentFeedInstance = Readonly<{
    instanceId: string;
    canonicalBaseUrl: string;
    acceptedBaseUrls?: readonly string[];
    appointmentFeedMode: VismedAppointmentFeedMode;
}>;

export type VismedBaseUrlCanonicalization =
    | { ok: true; canonicalBaseUrl: string }
    | {
        ok: false;
        reason:
            | 'MISSING_DOMAIN'
            | 'INVALID_URL'
            | 'UNSUPPORTED_PROTOCOL'
            | 'EMBEDDED_CREDENTIALS'
            | 'QUERY_NOT_ALLOWED'
            | 'FRAGMENT_NOT_ALLOWED';
    };

type VismedUnclassifiedReason =
    | 'MISSING_DOMAIN'
    | 'INVALID_URL'
    | 'UNSUPPORTED_PROTOCOL'
    | 'EMBEDDED_CREDENTIALS'
    | 'QUERY_NOT_ALLOWED'
    | 'FRAGMENT_NOT_ALLOWED'
    | 'INSTANCE_NOT_REGISTERED';

export type VismedAppointmentFeedResolution =
    | {
        contract: VismedAppointmentFeedMode;
        source: 'INSTANCE_REGISTRY';
        instanceId: string;
        canonicalBaseUrl: string;
        reason: 'REGISTERED_INSTANCE';
        legacyFieldDiverges: boolean;
    }
    | {
        contract: 'UNCLASSIFIED';
        source: 'INSTANCE_REGISTRY';
        instanceId: null;
        canonicalBaseUrl: string | null;
        reason: VismedUnclassifiedReason;
        legacyFieldDiverges: false;
    };

const REGISTRY_VERSION = 2;

const REGISTRY_ENTRIES = [
    {
        instanceId: 'vissmed-api-docctor-3',
        canonicalBaseUrl: 'https://app.vissmed.com.br/api-docctor-3',
        appointmentFeedMode: 'INCREMENTAL',
    },
    {
        instanceId: 'vissmed-api-docctor-5',
        canonicalBaseUrl: 'https://app.vissmed.com.br/api-docctor-5',
        acceptedBaseUrls: ['https://app.vissmed.com.br/api-docctor-5/api/v1.0'],
        appointmentFeedMode: 'INCREMENTAL',
    },
    {
        instanceId: 'vissmed-api-vissmed-4',
        canonicalBaseUrl: 'https://app.vissmed.com.br/api-vissmed-4',
        appointmentFeedMode: 'LEGACY',
    },
] as const satisfies readonly VismedAppointmentFeedInstance[];

function buildRegistry(entries: readonly VismedAppointmentFeedInstance[]) {
    const ids = new Set<string>();
    const urls = new Set<string>();
    const byCanonicalBaseUrl = new Map<string, VismedAppointmentFeedInstance>();

    for (const entry of entries) {
        if (ids.has(entry.instanceId)) {
            throw new Error(`Duplicate Vissmed appointment feed instanceId: ${entry.instanceId}`);
        }
        if (entry.appointmentFeedMode !== 'LEGACY' && entry.appointmentFeedMode !== 'INCREMENTAL') {
            throw new Error(`Invalid Vissmed appointment feed contract for: ${entry.instanceId}`);
        }
        ids.add(entry.instanceId);
        for (const baseUrl of [entry.canonicalBaseUrl, ...(entry.acceptedBaseUrls ?? [])]) {
            if (urls.has(baseUrl)) {
                throw new Error(`Duplicate Vissmed appointment feed URL: ${baseUrl}`);
            }
            urls.add(baseUrl);
            byCanonicalBaseUrl.set(baseUrl, Object.freeze({ ...entry }));
        }
    }

    return byCanonicalBaseUrl;
}

const REGISTRY_BY_CANONICAL_BASE_URL = buildRegistry(REGISTRY_ENTRIES);

export const VISMED_APPOINTMENT_FEED_REGISTRY = Object.freeze({
    version: REGISTRY_VERSION,
    entries: Object.freeze(REGISTRY_ENTRIES.map(entry => Object.freeze({ ...entry }))),
});

export function canonicalizeVismedBaseUrl(domain: unknown): VismedBaseUrlCanonicalization {
    if (typeof domain !== 'string' || domain.trim() === '') {
        return { ok: false, reason: 'MISSING_DOMAIN' };
    }

    const rawUrl = domain.trim();
    if (rawUrl.includes('?')) return { ok: false, reason: 'QUERY_NOT_ALLOWED' };
    if (rawUrl.includes('#')) return { ok: false, reason: 'FRAGMENT_NOT_ALLOWED' };
    if (rawUrl.includes('\\')) return { ok: false, reason: 'INVALID_URL' };

    const rawParts = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/.exec(rawUrl);
    if (!rawParts) {
        if (/^[a-z][a-z\d+.-]*:/i.test(rawUrl)) {
            return { ok: false, reason: 'UNSUPPORTED_PROTOCOL' };
        }
        return { ok: false, reason: 'INVALID_URL' };
    }

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return { ok: false, reason: 'INVALID_URL' };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, reason: 'UNSUPPORTED_PROTOCOL' };
    }
    if (!parsed.hostname) return { ok: false, reason: 'INVALID_URL' };
    if (parsed.username || parsed.password) {
        return { ok: false, reason: 'EMBEDDED_CREDENTIALS' };
    }

    const rawAuthority = rawParts[2].toLowerCase();
    const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
    if (rawAuthority !== parsed.host && rawAuthority !== `${parsed.host}:${defaultPort}`) {
        return { ok: false, reason: 'INVALID_URL' };
    }

    const rawPathname = rawParts[3] ?? '/';
    if (rawPathname !== parsed.pathname) {
        return { ok: false, reason: 'INVALID_URL' };
    }

    const pathname = rawPathname === '/' ? '' : rawPathname.replace(/\/$/, '');
    return {
        ok: true,
        canonicalBaseUrl: `${parsed.protocol}//${parsed.host}${pathname}`,
    };
}

export function resolveVismedAppointmentFeedContract(
    domain: unknown,
    legacyFieldValue?: unknown,
): VismedAppointmentFeedResolution {
    const canonicalization = canonicalizeVismedBaseUrl(domain);
    if (canonicalization.ok === false) {
        return {
            contract: 'UNCLASSIFIED',
            source: 'INSTANCE_REGISTRY',
            instanceId: null,
            canonicalBaseUrl: null,
            reason: canonicalization.reason,
            legacyFieldDiverges: false,
        };
    }

    const instance = REGISTRY_BY_CANONICAL_BASE_URL.get(canonicalization.canonicalBaseUrl);
    if (!instance) {
        return {
            contract: 'UNCLASSIFIED',
            source: 'INSTANCE_REGISTRY',
            instanceId: null,
            canonicalBaseUrl: canonicalization.canonicalBaseUrl,
            reason: 'INSTANCE_NOT_REGISTERED',
            legacyFieldDiverges: false,
        };
    }

    return {
        contract: instance.appointmentFeedMode,
        source: 'INSTANCE_REGISTRY',
        instanceId: instance.instanceId,
        canonicalBaseUrl: instance.canonicalBaseUrl,
        reason: 'REGISTERED_INSTANCE',
        legacyFieldDiverges:
            legacyFieldValue !== null
            && legacyFieldValue !== undefined
            && legacyFieldValue !== instance.appointmentFeedMode,
    };
}