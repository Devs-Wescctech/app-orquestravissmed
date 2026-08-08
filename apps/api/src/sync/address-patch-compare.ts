/**
 * Utilitários para comparação de payload de endereço com estado remoto do
 * GET /addresses, permitindo omitir PATCHes desnecessários.
 *
 * Apenas campos com equivalência de formato COMPROVADA entre o payload local e a
 * resposta da Doctoralia participam da comparação (COMPARABLE_ADDRESS_FIELDS).
 * Campos excluídos são sempre enviados no PATCH (comportamento conservador).
 */

/**
 * Normaliza um valor de campo de endereço antes da comparação.
 *
 * Regras por campo:
 *   - 'post_code': remove caracteres não-numéricos ("12345-678" == "12345678")
 *   - 'insurance_support': lowercase após trim (enum)
 *   - demais strings: trim simples
 *   - null / undefined / string vazia: normalizados para '' (equivalentes)
 */
export function normalizeAddressField(field: string, value: string | null | undefined): string {
    if (value === null || value === undefined) return '';
    const s = String(value).trim();
    if (field === 'post_code') return s.replace(/\D/g, '');
    if (field === 'insurance_support') return s.toLowerCase();
    return s;
}

/**
 * Campos cujo formato de resposta do GET /addresses foi confirmado como
 * equivalente ao payload local, habilitando comparação condicional.
 *
 * EXCLUÍDOS da comparação (comportamento conservador — sempre enviados no PATCH):
 *   - 'street': o payload local é uma string concatenada
 *     (addressStreet + ", " + addressNumber + " - " + complement + " (" + neighborhood + ")")
 *     com separadores aplicados localmente. O GET /addresses devolve um campo único
 *     cujo formato pode diferir (separadores, capitalização, espaços extras, ordenação).
 *     Sem garantia de equivalência → excluído da comparação para evitar PATCH permanente
 *     por diferença meramente cosmética.
 */
export const COMPARABLE_ADDRESS_FIELDS: ReadonlyArray<string> = [
    'insurance_support', // enum; normalizado para lowercase
    'city_name',         // string simples; trim suficiente
    'post_code',         // CEP; remove não-numéricos antes de comparar
];

/**
 * Decide se o PATCH /addresses pode ser omitido.
 *
 * Retorna `true` somente quando:
 *   1. Todos os campos do `desiredPayload` estão na lista de comparáveis, E
 *   2. Para cada campo comparável presente no payload, o valor normalizado é
 *      igual ao valor remoto normalizado.
 *
 * Se o payload contiver qualquer campo não-comparável (ex.: 'street'), retorna
 * `false` imediatamente (comportamento conservador).
 *
 * Campos ausentes do payload (enviados como undefined / não incluídos) são
 * ignorados: omissão deliberada não é "igual" nem "diferente" do remoto.
 *
 * @param desiredPayload  Campos que seriam enviados no PATCH
 * @param remoteAddress   Objeto retornado pelo GET /addresses para este endereço
 */
export function canSkipAddressPatch(
    desiredPayload: Record<string, any>,
    remoteAddress: Record<string, any>,
): { skip: boolean; reason: string } {
    // Campos do payload que não constam na lista comparável.
    const nonComparable = Object.keys(desiredPayload).filter(
        f => !(COMPARABLE_ADDRESS_FIELDS as string[]).includes(f),
    );

    if (nonComparable.length > 0) {
        return {
            skip: false,
            reason: `campo(s) não-comparável(is) no payload: ${nonComparable.join(', ')} — PATCH obrigatório (conservador)`,
        };
    }

    // Compara cada campo comparável presente no payload.
    for (const field of COMPARABLE_ADDRESS_FIELDS) {
        if (!(field in desiredPayload)) continue; // omissão deliberada → não comparar

        const localNorm = normalizeAddressField(field, desiredPayload[field]);
        const remoteNorm = normalizeAddressField(field, remoteAddress[field]);

        if (localNorm !== remoteNorm) {
            return {
                skip: false,
                reason: `campo "${field}" diverge: local="${localNorm}" remote="${remoteNorm}"`,
            };
        }
    }

    return { skip: true, reason: 'todos os campos comparáveis já estão corretos no remoto' };
}
