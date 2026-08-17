/**
 * WP2 — Parser determinístico do período de bloqueio VisMed
 *
 * ─── PRINCÍPIO FUNDAMENTAL ────────────────────────────────────────────────────
 * Nenhum período pode ser inventado ou deduzido pela ausência de disponibilidade
 * no scheduleDay. O scheduleDay é disponibilidade LÍQUIDA: um "buraco" nele não
 * prova que corresponde ao bloqueio sendo analisado. O scheduleDay entra APENAS
 * como sinal auxiliar de consistência (ver `checkScheduleDayConsistency`), NUNCA
 * como árbitro ou fonte de since/till.
 *
 * ─── NORMALIZAÇÕES PERMITIDAS (lista FECHADA) ─────────────────────────────────
 * Somente correções com reconstrução ÚNICA e COMPROVÁVEL. Qualquer formato fora
 * desta lista retorna null imediatamente, sem tentar inferir.
 *
 * N1 · Standard HH:MM
 *   Padrão: `^\d{1,2}:\d{2}$`, hora ∈ [0,23], minuto ∈ [0,59].
 *   Saída:  HH:MM com zero-pad em ambos os campos.
 *   Por que é unívoco: o formato canônico não admite interpretação alternativa.
 *
 * N2 · Hora com 3 dígitos iniciando em '0' + minuto único '0'
 *   Padrão: `^0(\d{1,2}):0$`
 *   Exemplos reais de produção: "011:0" → "11:00" | "012:0" → "12:00"
 *   Reconstrução do campo hora: o '0' inicial é zero de preenchimento —
 *     a única interpretação válida dos 2 dígitos restantes é valor ∈ [0,23].
 *     Se esses 2 dígitos formarem valor > 23, a reconstrução é impossível → null.
 *   Reconstrução do campo minuto: o dígito único '0' representa exatamente zero
 *     minutos. Um único '0' tem apenas uma leitura possível (zero); um único dígito
 *     diferente de zero seria ambíguo (ex.: '1' poderia ser 1 min ou 10 min) e
 *     portanto cai na regra N_AMBIG abaixo.
 *   Por que é unívoco: hora → uma só intepretação possível ≤ 23; minuto '0' → uma
 *     só interpretação possível (0).
 *
 * N_AMBIG · Dígito único de minuto ≠ '0'
 *   Ex.: "011:1" → null (AMBIGUOUS_SINGLE_DIGIT_MINUTE)
 *   Não entra na lista de normalizações permitidas porque "1" pode ser 1 ou 10.
 *
 * N_OVERFLOW · Hora de 3 dígitos onde os 2 dígitos restantes > 23
 *   Ex.: "099:0" → null (HOUR_OVERFLOW_IN_3DIGIT)
 *
 * ─── CRITÉRIOS DE SANIDADE PÓS-NORMALIZAÇÃO ──────────────────────────────────
 * Mesmo após normalização com sucesso, o par (since, till) é rejeitado se:
 *   • till ≤ since   → null  (END_NOT_AFTER_START)
 *   • date inválida  → null  (INVALID_DATE)
 *
 * ─── ARQUIVO PURO — SEM EFEITOS COLATERAIS ───────────────────────────────────
 * Este módulo não importa Prisma, loggers externos, nem qualquer serviço NestJS.
 * Toda a persistência de auditoria é responsabilidade do chamador via resultado.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Tipos públicos
// ──────────────────────────────────────────────────────────────────────────────

export interface BlockPeriodRaw {
    /** Identificador único do bloqueio para fins de auditoria (opcional) */
    blockId?: string | number;
    /** Data do bloqueio no formato "YYYY-MM-DD" */
    date: string;
    /** horarioagendamento (início) — exatamente como vindo da API VisMed */
    startRaw: string;
    /** horarioagendamentofinal (fim) — exatamente como vindo da API VisMed */
    endRaw: string;
}

export interface BlockPeriod {
    /** Início do bloqueio (Date em hora local — sem conversão de fuso) */
    since: Date;
    /** Fim do bloqueio (Date em hora local — sem conversão de fuso) */
    till: Date;
    /** HH:MM canônico do início */
    sinceHHMM: string;
    /** HH:MM canônico do fim */
    tillHHMM: string;
}

export type NormalizeFailReason =
    | 'EMPTY'                           // campo vazio ou nulo
    | 'FORMAT_UNRECOGNIZED'             // não cabe em nenhuma regra permitida
    | 'HOUR_OUT_OF_RANGE'               // hora fora de [0,23]
    | 'MINUTE_OUT_OF_RANGE'             // minuto fora de [0,59]
    | 'AMBIGUOUS_SINGLE_DIGIT_MINUTE'   // dígito único de minuto ≠ '0'
    | 'HOUR_OVERFLOW_IN_3DIGIT'         // 3 dígitos com hora > 23
    | 'END_NOT_AFTER_START'             // till ≤ since
    | 'INVALID_DATE';                   // data não forma um Date válido

export type ParseBlockPeriodResult =
    | { ok: true; period: BlockPeriod }
    | {
          ok: false;
          /** Campo que disparou a falha: 'start', 'end', ou 'period' (par inválido) */
          failField: 'start' | 'end' | 'period' | 'date';
          failReason: NormalizeFailReason;
          rawStart: string;
          rawEnd: string;
          date: string;
      };

// ──────────────────────────────────────────────────────────────────────────────
// Validador de data calendária (puro)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Retorna true somente se `dateStr` for uma data de calendário válida no
 * formato YYYY-MM-DD, sem overflow de componentes (ex.: Feb-30 → false).
 *
 * Por que não confiar em `new Date(string)`:
 *   engines JavaScript podem normalizar datas inválidas (ex.: "2025-02-30"
 *   → 2 de março) em vez de retornar NaN. A validação por round-trip dos
 *   componentes detecta esse overflow de forma determinística.
 */
function isValidCalendarDate(dateStr: string): boolean {
    // Passo 1: formato YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
    // Passo 2: componentes numéricos
    const parts = dateStr.split('-');
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    // Passo 3: round-trip — construir Date local e verificar se os componentes batem.
    // Se "2025-02-30" fosse normalizado para "2025-03-02", o .getDate() retornaria 2 ≠ 30.
    const check = new Date(y, m - 1, d);
    return (
        check.getFullYear() === y &&
        check.getMonth() + 1 === m &&
        check.getDate() === d
    );
}

// ──────────────────────────────────────────────────────────────────────────────
// Normalizador interno (puro, sem efeitos colaterais)
// ──────────────────────────────────────────────────────────────────────────────

interface NormalizeResult {
    ok: true;
    hhmm: string;
}
interface NormalizeFail {
    ok: false;
    reason: NormalizeFailReason;
}
type NormalizeHHMMResult = NormalizeResult | NormalizeFail;

/**
 * Tenta normalizar um campo de horário VisMed para HH:MM canônico.
 *
 * Aplica APENAS as regras N1 e N2 documentadas acima.
 * Qualquer outra sequência retorna falha imediatamente — sem inferência.
 */
export function normalizeHHMM(raw: string | null | undefined): NormalizeHHMMResult {
    // ── Guard: vazio / nulo ────────────────────────────────────────────────────
    const s = (raw ?? '').trim();
    if (!s) return { ok: false, reason: 'EMPTY' };

    // ── Regra N1: formato padrão (\d{1,2}:\d{2}) ─────────────────────────────
    const m1 = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m1) {
        const h = parseInt(m1[1], 10);
        const min = parseInt(m1[2], 10);
        if (h < 0 || h > 23) return { ok: false, reason: 'HOUR_OUT_OF_RANGE' };
        if (min < 0 || min > 59) return { ok: false, reason: 'MINUTE_OUT_OF_RANGE' };
        const hhmm = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
        return { ok: true, hhmm };
    }

    // ── Regra N2: hora com 3 dígitos iniciando em '0' + minuto único '0' ─────
    // Exemplo real: "011:0" → "11:00" | "012:0" → "12:00"
    const m2 = s.match(/^0(\d{1,2}):(\d)$/);
    if (m2) {
        const hourStr = m2[1]; // os 2 dígitos remanescentes após o '0' espúrio
        const minStr = m2[2];  // dígito único de minuto

        // Minuto: somente '0' é reconstrução inequívoca
        // Qualquer outro dígito único é ambíguo (N_AMBIG): '1' = 01 ou 10?
        if (minStr !== '0') {
            return { ok: false, reason: 'AMBIGUOUS_SINGLE_DIGIT_MINUTE' };
        }

        const h = parseInt(hourStr, 10);
        if (h > 23) return { ok: false, reason: 'HOUR_OVERFLOW_IN_3DIGIT' };

        const hhmm = `${String(h).padStart(2, '0')}:00`;
        return { ok: true, hhmm };
    }

    // ── Nenhuma regra se aplica → irrecuperável ────────────────────────────────
    return { ok: false, reason: 'FORMAT_UNRECOGNIZED' };
}

// ──────────────────────────────────────────────────────────────────────────────
// Parser principal (puro, determinístico)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Deriva o par (since, till) de um registro de bloqueio VisMed bruto.
 *
 * Determinismo garantido: mesma entrada → mesma saída, sempre.
 * Sem efeitos colaterais, sem acesso a banco, sem consulta ao scheduleDay.
 *
 * Quando retorna `ok: false`, o chamador é responsável por persistir um evento
 * de auditoria e tratar o bloqueio como "não sincronizável".
 */
export function parseBlockPeriod(raw: BlockPeriodRaw): ParseBlockPeriodResult {
    const { date, startRaw, endRaw } = raw;

    // ── Normaliza início ───────────────────────────────────────────────────────
    const startResult = normalizeHHMM(startRaw);
    if (startResult.ok === false) {
        return {
            ok: false,
            failField: 'start',
            failReason: startResult.reason,
            rawStart: startRaw,
            rawEnd: endRaw,
            date,
        };
    }

    // ── Normaliza fim ──────────────────────────────────────────────────────────
    const endResult = normalizeHHMM(endRaw);
    if (endResult.ok === false) {
        return {
            ok: false,
            failField: 'end',
            failReason: endResult.reason,
            rawStart: startRaw,
            rawEnd: endRaw,
            date,
        };
    }

    // ── Valida a data estritamente antes de construir Date objects ────────────
    // Nota: JavaScript pode NORMALIZAR datas de calendário inválidas em vez de
    // retornar NaN (ex.: "2025-02-30" → March 2 em algumas engines). Por isso
    // fazemos validação em dois passos:
    //   1. Formato YYYY-MM-DD via regex
    //   2. Round-trip dos componentes: se os dígitos do mês/dia não batem após
    //      construção via `new Date(y, m-1, d)`, a data foi normalizada → inválida.
    if (!isValidCalendarDate(date)) {
        return {
            ok: false,
            failField: 'date',
            failReason: 'INVALID_DATE',
            rawStart: startRaw,
            rawEnd: endRaw,
            date,
        };
    }

    // ── Constrói Date objects ─────────────────────────────────────────────────
    // Usamos o formato "YYYY-MM-DDTHH:MM:00" sem sufixo de fuso para que o
    // interpretador local (America/Sao_Paulo no servidor) trate como hora local.
    // Consistente com como o resto do sistema constrói datas VisMed.
    const sinceDate = new Date(`${date}T${startResult.hhmm}:00`);
    const tillDate  = new Date(`${date}T${endResult.hhmm}:00`);

    // Guard NaN residual (ex.: string de data bem formatada mas semanticamente inválida
    // em algum engine específico).
    if (isNaN(sinceDate.getTime()) || isNaN(tillDate.getTime())) {
        return {
            ok: false,
            failField: 'date',
            failReason: 'INVALID_DATE',
            rawStart: startRaw,
            rawEnd: endRaw,
            date,
        };
    }

    // ── Sanidade: fim deve ser estritamente após início ────────────────────────
    if (tillDate.getTime() <= sinceDate.getTime()) {
        return {
            ok: false,
            failField: 'period',
            failReason: 'END_NOT_AFTER_START',
            rawStart: startRaw,
            rawEnd: endRaw,
            date,
        };
    }

    return {
        ok: true,
        period: {
            since: sinceDate,
            till: tillDate,
            sinceHHMM: startResult.hhmm,
            tillHHMM: endResult.hhmm,
        },
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Verificador auxiliar de consistência com scheduleDay (NÃO-ÁRBITRO)
// ──────────────────────────────────────────────────────────────────────────────

export interface ScheduleDayRange {
    start: string; // "HH:MM"
    end: string;   // "HH:MM"
}

export type ConsistencySignal =
    | { consistent: true }
    | {
          consistent: false;
          /** Resumo legível da anomalia detectada */
          reason: string;
          /** Período normalizado do bloqueio */
          blockSinceHHMM: string;
          blockTillHHMM: string;
          /** Ranges disponíveis do scheduleDay para o dia */
          scheduleDayRanges: ScheduleDayRange[];
      };

/**
 * Verifica se o período normalizado do bloqueio coincide com uma ausência de
 * disponibilidade no scheduleDay do dia correspondente.
 *
 * ⚠ ESTA FUNÇÃO NUNCA ALTERA O RESULTADO DO PARSER.
 * É puramente um emissor de sinal de anomalia — chame-a após `parseBlockPeriod`
 * e use o resultado apenas para logging/alertas. O período retornado por
 * `parseBlockPeriod` é sempre a fonte de verdade.
 *
 * Lógica: se os ranges do scheduleDay cobrem integralmente [sinceHHMM, tillHHMM],
 * significa que o período do bloqueio ainda aparece como disponível — o que é
 * anômalo (pode indicar que o scheduleDay ainda não refletiu o bloqueio, ou que
 * há uma dessincronização). Isso é sinal de anomalia, não prova de erro.
 *
 * @param period Período normalizado retornado por parseBlockPeriod (ok: true)
 * @param scheduleDayRanges Faixas disponíveis do scheduleDay para o dia do bloqueio
 */
export function checkScheduleDayConsistency(
    period: BlockPeriod,
    scheduleDayRanges: ScheduleDayRange[],
): ConsistencySignal {
    if (scheduleDayRanges.length === 0) {
        // Nenhuma disponibilidade no dia → scheduleDay confirma bloqueio (consistente)
        return { consistent: true };
    }

    function toMin(hhmm: string): number {
        const [h, m] = hhmm.split(':').map(Number);
        return h * 60 + m;
    }

    const blockStart = toMin(period.sinceHHMM);
    const blockEnd   = toMin(period.tillHHMM);

    // Verifica se algum range do scheduleDay cobre integralmente o período do bloqueio
    // (ou seja, o período "não foi bloqueado" segundo o scheduleDay → anomalia)
    for (const r of scheduleDayRanges) {
        const rStart = toMin(r.start);
        const rEnd   = toMin(r.end);
        if (rStart <= blockStart && rEnd >= blockEnd) {
            return {
                consistent: false,
                reason: `scheduleDay ainda mostra disponibilidade em [${r.start}, ${r.end}] cobrindo o bloqueio [${period.sinceHHMM}, ${period.tillHHMM}] — pode ser latência do cron`,
                blockSinceHHMM: period.sinceHHMM,
                blockTillHHMM: period.tillHHMM,
                scheduleDayRanges,
            };
        }
    }

    // scheduleDay não cobre o período → confirmação implícita de bloqueio (consistente)
    return { consistent: true };
}
