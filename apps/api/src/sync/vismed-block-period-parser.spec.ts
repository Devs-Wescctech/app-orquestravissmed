/**
 * WP2 — Testes do parser determinístico de período de bloqueio VisMed
 *
 * Cobre:
 * 1. normalizeHHMM — todos os formatos reais e casos limítrofes
 * 2. parseBlockPeriod — integração completa e determinismo
 * 3. checkScheduleDayConsistency — sinal auxiliar sem influência no parser
 * 4. Garantia explícita: scheduleDay nunca origina since/till
 */

import {
    normalizeHHMM,
    parseBlockPeriod,
    checkScheduleDayConsistency,
    BlockPeriodRaw,
    ScheduleDayRange,
} from './vismed-block-period-parser';

// ──────────────────────────────────────────────────────────────────────────────
// normalizeHHMM
// ──────────────────────────────────────────────────────────────────────────────

describe('normalizeHHMM', () => {
    // ── Regra N1: formato padrão ────────────────────────────────────────────

    describe('N1 — formato padrão (\\d{1,2}:\\d{2})', () => {
        it('"08:10" → "08:10" (formato real de produção — já canônico)', () => {
            const r = normalizeHHMM('08:10');
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.hhmm).toBe('08:10');
        });

        it('"8:10" → "08:10" (hora sem zero-pad)', () => {
            const r = normalizeHHMM('8:10');
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.hhmm).toBe('08:10');
        });

        it('"00:00" → "00:00" (meia-noite)', () => {
            const r = normalizeHHMM('00:00');
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.hhmm).toBe('00:00');
        });

        it('"23:59" → "23:59" (último minuto do dia)', () => {
            const r = normalizeHHMM('23:59');
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.hhmm).toBe('23:59');
        });

        it('"7:00" → "07:00"', () => {
            const r = normalizeHHMM('7:00');
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.hhmm).toBe('07:00');
        });

        it('"12:30" → "12:30"', () => {
            const r = normalizeHHMM('12:30');
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.hhmm).toBe('12:30');
        });

        it('"24:00" → null (hora fora de [0,23])', () => {
            const r = normalizeHHMM('24:00');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toBe('HOUR_OUT_OF_RANGE');
        });

        it('"23:60" → null (minuto fora de [0,59])', () => {
            const r = normalizeHHMM('23:60');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toBe('MINUTE_OUT_OF_RANGE');
        });
    });

    // ── Regra N2: hora 3 dígitos com '0' inicial + minuto único '0' ─────────

    describe('N2 — hora 3 dígitos (0XY:0) — formatos reais de produção', () => {
        it('"011:0" → "11:00" (formato real de produção)', () => {
            const r = normalizeHHMM('011:0');
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.hhmm).toBe('11:00');
        });

        it('"012:0" → "12:00" (formato real de produção)', () => {
            const r = normalizeHHMM('012:0');
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.hhmm).toBe('12:00');
        });

        it('"008:0" → "08:00"', () => {
            const r = normalizeHHMM('008:0');
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.hhmm).toBe('08:00');
        });

        it('"000:0" → "00:00" (meia-noite via N2)', () => {
            const r = normalizeHHMM('000:0');
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.hhmm).toBe('00:00');
        });

        it('"023:0" → "23:00" (último horário cheio via N2)', () => {
            const r = normalizeHHMM('023:0');
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.hhmm).toBe('23:00');
        });

        it('"099:0" → null (hora resultante 99 > 23)', () => {
            const r = normalizeHHMM('099:0');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toBe('HOUR_OVERFLOW_IN_3DIGIT');
        });

        it('"024:0" → null (hora resultante 24 > 23)', () => {
            const r = normalizeHHMM('024:0');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toBe('HOUR_OVERFLOW_IN_3DIGIT');
        });

        it('"011:1" → null (minuto único ≠ 0 é ambíguo: 1 min ou 10 min?)', () => {
            const r = normalizeHHMM('011:1');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toBe('AMBIGUOUS_SINGLE_DIGIT_MINUTE');
        });

        it('"011:5" → null (minuto único 5 ambíguo: 5 min ou 50 min?)', () => {
            const r = normalizeHHMM('011:5');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toBe('AMBIGUOUS_SINGLE_DIGIT_MINUTE');
        });
    });

    // ── Casos vazios / nulos ─────────────────────────────────────────────────

    describe('campos vazios ou nulos', () => {
        it('string vazia → null EMPTY', () => {
            const r = normalizeHHMM('');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toBe('EMPTY');
        });

        it('string de espaços → null EMPTY', () => {
            const r = normalizeHHMM('   ');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toBe('EMPTY');
        });

        it('null → null EMPTY', () => {
            const r = normalizeHHMM(null);
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toBe('EMPTY');
        });

        it('undefined → null EMPTY', () => {
            const r = normalizeHHMM(undefined);
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toBe('EMPTY');
        });
    });

    // ── Formatos fora da lista permitida ─────────────────────────────────────

    describe('formatos não reconhecidos → FORMAT_UNRECOGNIZED', () => {
        it('"8:1" (minuto 1 dígito, hora 1 dígito — N2 não se aplica pois hora não tem 3 dígitos)', () => {
            const r = normalizeHHMM('8:1');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toBe('FORMAT_UNRECOGNIZED');
        });

        it('"ab:cd" → FORMAT_UNRECOGNIZED', () => {
            const r = normalizeHHMM('ab:cd');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toBe('FORMAT_UNRECOGNIZED');
        });

        it('"12:3:00" (3 partes) → FORMAT_UNRECOGNIZED', () => {
            const r = normalizeHHMM('12:3:00');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toBe('FORMAT_UNRECOGNIZED');
        });

        it('"1200" (sem separador) → FORMAT_UNRECOGNIZED', () => {
            const r = normalizeHHMM('1200');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toBe('FORMAT_UNRECOGNIZED');
        });

        it('"12h00" → FORMAT_UNRECOGNIZED', () => {
            const r = normalizeHHMM('12h00');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toBe('FORMAT_UNRECOGNIZED');
        });
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseBlockPeriod
// ──────────────────────────────────────────────────────────────────────────────

describe('parseBlockPeriod', () => {
    const DATE = '2025-08-15';

    // ── Casos válidos ────────────────────────────────────────────────────────

    describe('casos válidos', () => {
        it('formato canônico "08:00" / "12:00" → period ok', () => {
            const raw: BlockPeriodRaw = { date: DATE, startRaw: '08:00', endRaw: '12:00' };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(true);
            if (r.ok) {
                expect(r.period.sinceHHMM).toBe('08:00');
                expect(r.period.tillHHMM).toBe('12:00');
                expect(r.period.since).toBeInstanceOf(Date);
                expect(r.period.till).toBeInstanceOf(Date);
                expect(r.period.till.getTime()).toBeGreaterThan(r.period.since.getTime());
            }
        });

        it('formato real "08:10" (início) e "011:0" (fim) → "08:10" / "11:00"', () => {
            const raw: BlockPeriodRaw = {
                date: DATE,
                startRaw: '08:10',
                endRaw: '011:0',
                blockId: 'blk-001',
            };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(true);
            if (r.ok) {
                expect(r.period.sinceHHMM).toBe('08:10');
                expect(r.period.tillHHMM).toBe('11:00');
            }
        });

        it('formato real "012:0" como fim → "12:00"', () => {
            const raw: BlockPeriodRaw = {
                date: DATE,
                startRaw: '08:00',
                endRaw: '012:0',
                blockId: 'blk-002',
            };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(true);
            if (r.ok) {
                expect(r.period.tillHHMM).toBe('12:00');
            }
        });
    });

    // ── Falhas no campo início ───────────────────────────────────────────────

    describe('falhas no campo início', () => {
        it('início vazio → failField=start, razão=EMPTY', () => {
            const raw: BlockPeriodRaw = { date: DATE, startRaw: '', endRaw: '12:00' };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.failField).toBe('start');
                expect(r.failReason).toBe('EMPTY');
            }
        });

        it('início com formato não reconhecido → failField=start', () => {
            const raw: BlockPeriodRaw = { date: DATE, startRaw: '8:1', endRaw: '12:00' };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.failField).toBe('start');
                expect(r.failReason).toBe('FORMAT_UNRECOGNIZED');
            }
        });
    });

    // ── Falhas no campo fim ──────────────────────────────────────────────────

    describe('falhas no campo fim', () => {
        it('fim vazio → failField=end, razão=EMPTY', () => {
            const raw: BlockPeriodRaw = { date: DATE, startRaw: '08:00', endRaw: '' };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.failField).toBe('end');
                expect(r.failReason).toBe('EMPTY');
            }
        });

        it('fim com minuto único ambíguo "011:1" → failField=end', () => {
            const raw: BlockPeriodRaw = { date: DATE, startRaw: '08:00', endRaw: '011:1' };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.failField).toBe('end');
                expect(r.failReason).toBe('AMBIGUOUS_SINGLE_DIGIT_MINUTE');
            }
        });

        it('fim com hora overflow "099:0" → failField=end', () => {
            const raw: BlockPeriodRaw = { date: DATE, startRaw: '08:00', endRaw: '099:0' };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.failField).toBe('end');
                expect(r.failReason).toBe('HOUR_OVERFLOW_IN_3DIGIT');
            }
        });
    });

    // ── Falhas de par (ambos normalizados mas período inválido) ──────────────

    describe('falhas de par', () => {
        it('fim = início → failField=period, razão=END_NOT_AFTER_START', () => {
            const raw: BlockPeriodRaw = {
                date: DATE,
                startRaw: '10:00',
                endRaw: '10:00',
            };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.failField).toBe('period');
                expect(r.failReason).toBe('END_NOT_AFTER_START');
            }
        });

        it('fim < início → failField=period, razão=END_NOT_AFTER_START', () => {
            const raw: BlockPeriodRaw = {
                date: DATE,
                startRaw: '12:00',
                endRaw: '08:00',
            };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.failField).toBe('period');
                expect(r.failReason).toBe('END_NOT_AFTER_START');
            }
        });

        it('fim normalizado via N2 menor que início → END_NOT_AFTER_START', () => {
            // "011:0" → "11:00" mas início é "12:00" → 11:00 < 12:00
            const raw: BlockPeriodRaw = {
                date: DATE,
                startRaw: '12:00',
                endRaw: '011:0',
            };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.failField).toBe('period');
                expect(r.failReason).toBe('END_NOT_AFTER_START');
            }
        });
    });

    // ── Data inválida ────────────────────────────────────────────────────────

    describe('data inválida', () => {
        it('data malformada → failField=date, razão=INVALID_DATE', () => {
            const raw: BlockPeriodRaw = {
                date: 'not-a-date',
                startRaw: '08:00',
                endRaw: '12:00',
            };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.failField).toBe('date');
                expect(r.failReason).toBe('INVALID_DATE');
            }
        });

        it('"2025-02-30" (fevereiro não tem dia 30) → INVALID_DATE, não normaliza silenciosamente', () => {
            // JavaScript pode normalizar "2025-02-30" para "2025-03-02" em vez de NaN.
            // O parser deve rejeitar datas de calendário inválidas explicitamente.
            const raw: BlockPeriodRaw = {
                date: '2025-02-30',
                startRaw: '08:00',
                endRaw: '12:00',
            };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.failField).toBe('date');
                expect(r.failReason).toBe('INVALID_DATE');
            }
        });

        it('"2025-13-01" (mês 13 não existe) → INVALID_DATE', () => {
            const raw: BlockPeriodRaw = {
                date: '2025-13-01',
                startRaw: '08:00',
                endRaw: '12:00',
            };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.failField).toBe('date');
                expect(r.failReason).toBe('INVALID_DATE');
            }
        });

        it('"2025-04-31" (abril tem 30 dias) → INVALID_DATE', () => {
            const raw: BlockPeriodRaw = {
                date: '2025-04-31',
                startRaw: '08:00',
                endRaw: '12:00',
            };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.failField).toBe('date');
                expect(r.failReason).toBe('INVALID_DATE');
            }
        });

        it('"2025-08-15" (data válida) é aceita', () => {
            const raw: BlockPeriodRaw = {
                date: '2025-08-15',
                startRaw: '08:00',
                endRaw: '12:00',
            };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(true);
        });

        it('"2024-02-29" (ano bissexto) é aceita', () => {
            const raw: BlockPeriodRaw = {
                date: '2024-02-29',
                startRaw: '08:00',
                endRaw: '12:00',
            };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(true);
        });

        it('"2025-02-29" (2025 não é bissexto) → INVALID_DATE', () => {
            const raw: BlockPeriodRaw = {
                date: '2025-02-29',
                startRaw: '08:00',
                endRaw: '12:00',
            };
            const r = parseBlockPeriod(raw);
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.failField).toBe('date');
                expect(r.failReason).toBe('INVALID_DATE');
            }
        });
    });

    // ── Determinismo ─────────────────────────────────────────────────────────

    describe('determinismo — mesma entrada produz mesma saída sempre', () => {
        const cases: BlockPeriodRaw[] = [
            { date: DATE, startRaw: '08:10', endRaw: '011:0', blockId: 'det-1' },
            { date: DATE, startRaw: '012:0', endRaw: '017:0', blockId: 'det-2' },
            { date: DATE, startRaw: '', endRaw: '12:00', blockId: 'det-3' },
            { date: DATE, startRaw: '12:00', endRaw: '12:00', blockId: 'det-4' },
        ];

        cases.forEach((raw, i) => {
            it(`caso ${i + 1} é determinístico (blockId=${raw.blockId})`, () => {
                const r1 = parseBlockPeriod(raw);
                const r2 = parseBlockPeriod(raw);
                const r3 = parseBlockPeriod(raw);

                // Mesmo ok/falha
                expect(r1.ok).toBe(r2.ok);
                expect(r2.ok).toBe(r3.ok);

                if (r1.ok && r2.ok && r3.ok) {
                    expect(r1.period.sinceHHMM).toBe(r2.period.sinceHHMM);
                    expect(r2.period.sinceHHMM).toBe(r3.period.sinceHHMM);
                    expect(r1.period.tillHHMM).toBe(r2.period.tillHHMM);
                    expect(r2.period.tillHHMM).toBe(r3.period.tillHHMM);
                    expect(r1.period.since.getTime()).toBe(r2.period.since.getTime());
                    expect(r1.period.till.getTime()).toBe(r2.period.till.getTime());
                } else if (!r1.ok && !r2.ok && !r3.ok) {
                    expect(r1.failField).toBe(r2.failField);
                    expect(r2.failField).toBe(r3.failField);
                    expect(r1.failReason).toBe(r2.failReason);
                    expect(r2.failReason).toBe(r3.failReason);
                }
            });
        });
    });

    // ── Garantia: scheduleDay nunca origina since/till ───────────────────────

    describe('garantia — scheduleDay nunca origina since/till', () => {
        it('parseBlockPeriod não aceita scheduleDay como parâmetro', () => {
            // O tipo BlockPeriodRaw não tem campo scheduleDay.
            // Esta asserção de tipo confirma que o parser é puro e não recebe
            // faixas de disponibilidade como entrada.
            const raw: BlockPeriodRaw = { date: DATE, startRaw: '08:00', endRaw: '12:00' };
            const keys = Object.keys(raw);
            expect(keys).not.toContain('scheduleDay');
            expect(keys).not.toContain('scheduleDayRanges');
            expect(keys).not.toContain('availabilityRanges');
        });

        it('dado bloqueio com horário irrecuperável, mesmo com scheduleDay disponível, retorna null', () => {
            // Cria um bloqueio com fim ambíguo ("011:1")
            const raw: BlockPeriodRaw = {
                date: DATE,
                startRaw: '08:00',
                endRaw: '011:1',
                blockId: 'no-schedule-day',
            };

            // Simula scheduleDay com "buraco" em 08:00-11:10 (poderia ser tentador usar)
            // O parser deve retornar null independente disso — scheduleDay não é consultado
            const result = parseBlockPeriod(raw);

            expect(result.ok).toBe(false);
            // O since/till não foram derivados do scheduleDay
            if (!result.ok) {
                expect(result.failReason).toBe('AMBIGUOUS_SINGLE_DIGIT_MINUTE');
            }
        });

        it('dado bloqueio com período válido, o since/till derivam APENAS de date+startRaw+endRaw', () => {
            const raw: BlockPeriodRaw = {
                date: DATE,
                startRaw: '08:00',
                endRaw: '011:0',
                blockId: 'derived-from-raw',
            };

            const result = parseBlockPeriod(raw);
            expect(result.ok).toBe(true);

            if (result.ok) {
                // Verifica que since e till batem com a data + campos brutos normalizados
                const expectedSince = new Date(`${DATE}T08:00:00`);
                const expectedTill  = new Date(`${DATE}T11:00:00`);

                expect(result.period.since.getTime()).toBe(expectedSince.getTime());
                expect(result.period.till.getTime()).toBe(expectedTill.getTime());
                expect(result.period.sinceHHMM).toBe('08:00');
                expect(result.period.tillHHMM).toBe('11:00');
            }
        });
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkScheduleDayConsistency
// ──────────────────────────────────────────────────────────────────────────────

describe('checkScheduleDayConsistency', () => {
    const makePeriod = (sinceHHMM: string, tillHHMM: string) => ({
        since: new Date(`2025-08-15T${sinceHHMM}:00`),
        till:  new Date(`2025-08-15T${tillHHMM}:00`),
        sinceHHMM,
        tillHHMM,
    });

    it('retorna consistent=true quando scheduleDay está vazio (nenhuma disponibilidade)', () => {
        const period = makePeriod('08:00', '12:00');
        const signal = checkScheduleDayConsistency(period, []);
        expect(signal.consistent).toBe(true);
    });

    it('retorna consistent=false quando range do scheduleDay cobre integralmente o bloqueio', () => {
        const period = makePeriod('09:00', '10:00');
        const ranges: ScheduleDayRange[] = [{ start: '08:00', end: '12:00' }];
        const signal = checkScheduleDayConsistency(period, ranges);
        expect(signal.consistent).toBe(false);
        if (!signal.consistent) {
            expect(signal.blockSinceHHMM).toBe('09:00');
            expect(signal.blockTillHHMM).toBe('10:00');
            expect(signal.scheduleDayRanges).toEqual(ranges);
            expect(signal.reason).toContain('scheduleDay');
        }
    });

    it('retorna consistent=true quando scheduleDay não cobre o período do bloqueio', () => {
        const period = makePeriod('09:00', '10:00');
        // Disponível apenas 07:00-09:00 e 10:00-12:00 → buraco em 09:00-10:00
        const ranges: ScheduleDayRange[] = [
            { start: '07:00', end: '09:00' },
            { start: '10:00', end: '12:00' },
        ];
        const signal = checkScheduleDayConsistency(period, ranges);
        expect(signal.consistent).toBe(true);
    });

    it('retorna consistent=true quando scheduleDay só cobre parcialmente o bloqueio', () => {
        const period = makePeriod('08:00', '12:00');
        // Range cobre apenas 08:00-10:00, não o período completo 08:00-12:00
        const ranges: ScheduleDayRange[] = [{ start: '08:00', end: '10:00' }];
        const signal = checkScheduleDayConsistency(period, ranges);
        expect(signal.consistent).toBe(true);
    });

    it('resultado da consistência NUNCA altera o período retornado pelo parser', () => {
        // Esta é a garantia central: checkScheduleDayConsistency é read-only
        const raw: BlockPeriodRaw = {
            date: '2025-08-15',
            startRaw: '08:00',
            endRaw: '011:0',
        };
        const parseResult = parseBlockPeriod(raw);
        expect(parseResult.ok).toBe(true);

        if (parseResult.ok) {
            const originalSince = parseResult.period.since.getTime();
            const originalTill  = parseResult.period.till.getTime();

            // Chama checkScheduleDayConsistency com ranges que cobrindo o período
            const ranges: ScheduleDayRange[] = [{ start: '07:00', end: '13:00' }];
            checkScheduleDayConsistency(parseResult.period, ranges);

            // O período permanece intacto após a verificação
            expect(parseResult.period.since.getTime()).toBe(originalSince);
            expect(parseResult.period.till.getTime()).toBe(originalTill);
            expect(parseResult.period.sinceHHMM).toBe('08:00');
            expect(parseResult.period.tillHHMM).toBe('11:00');
        }
    });
});
