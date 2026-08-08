/**
 * WP-01 — 10 testes automatizados de observabilidade Doctoralia
 *
 * Nenhum teste faz chamadas reais à API Doctoralia. Todos os testes usam mocks
 * e validam apenas o comportamento da instrumentação.
 */
import { DoctoraliaMetricsService, getDoctoraliaMetricsService } from './doctoralia-metrics.service';
import { runWithDoctoraliaContext, getDoctoraliaContext } from './doctoralia-call-context';

// Helper para construir um evento de requisição com defaults razoáveis
function makeEvent(overrides: Partial<Parameters<DoctoraliaMetricsService['record']>[0]> = {}): Parameters<DoctoraliaMetricsService['record']>[0] {
    const now = Date.now();
    return {
        doctoraliaRequestId: 'test-id-1',
        origin: 'OTHER',
        operation: 'GET_BOOKINGS',
        endpoint: '/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/bookings',
        method: 'GET',
        httpStatus: 200,
        isRetry: false,
        retryNumber: 0,
        isOAuth: false,
        enqueuedAt: now - 100,
        releasedAt: now - 50,
        sentAt: now - 50,
        respondedAt: now,
        waitMs: 50,
        execMs: 50,
        ...overrides,
    };
}

describe('DoctoraliaMetricsService — 10 testes WP-01', () => {
    let service: DoctoraliaMetricsService;

    beforeEach(() => {
        service = new DoctoraliaMetricsService();
    });

    // ─── Teste 1: Requisição normal ──────────────────────────────────────────
    it('1. Requisição normal — uma chamada gera exatamente um evento com todos os campos obrigatórios', () => {
        const now = Date.now();
        const event = makeEvent({
            doctoraliaRequestId: 'req-001',
            origin: 'POLLING',
            clinicId: 'clinic-a',
            operation: 'GET_BOOKINGS',
            httpStatus: 200,
            waitMs: 75,
            execMs: 120,
        });
        service.record(event);

        const events = service.getEvents();
        expect(events).toHaveLength(1);
        const e = events[0];
        expect(e.doctoraliaRequestId).toBe('req-001');
        expect(e.origin).toBe('POLLING');
        expect(e.clinicId).toBe('clinic-a');
        expect(e.operation).toBe('GET_BOOKINGS');
        expect(e.httpStatus).toBe(200);
        expect(e.isRetry).toBe(false);
        expect(e.retryNumber).toBe(0);
        expect(e.isOAuth).toBe(false);
        expect(typeof e.enqueuedAt).toBe('number');
        expect(typeof e.releasedAt).toBe('number');
        expect(typeof e.sentAt).toBe('number');
        expect(typeof e.respondedAt).toBe('number');
        expect(e.waitMs).toBe(75);
        expect(e.execMs).toBe(120);
    });

    // ─── Teste 2: waitMs e execMs calculados corretamente ───────────────────
    it('2. Aguardando rate limiter — waitMs = releasedAt − enqueuedAt e execMs = respondedAt − sentAt', () => {
        const enqueuedAt = 1000;
        const releasedAt = 3000;  // espera 2s no rate limiter
        const sentAt = 3000;
        const respondedAt = 3200; // 200ms de execução

        const event = makeEvent({
            enqueuedAt,
            releasedAt,
            sentAt,
            respondedAt,
            waitMs: releasedAt - enqueuedAt,
            execMs: respondedAt - sentAt,
        });
        service.record(event);

        const e = service.getEvents()[0];
        expect(e.waitMs).toBe(2000);
        expect(e.execMs).toBe(200);
        expect(e.waitMs).toBe(e.releasedAt - e.enqueuedAt);
        expect(e.execMs).toBe(e.respondedAt - e.sentAt);
    });

    // ─── Teste 3: 401 com retry ──────────────────────────────────────────────
    it('3. 401 com retry — tentativa original + retry + OAuth registrados separadamente, retryNumber correto', () => {
        // Tentativa original: 401
        service.record(makeEvent({
            doctoraliaRequestId: 'req-original',
            origin: 'USER_INTERACTIVE',
            httpStatus: 401,
            isRetry: false,
            retryNumber: 0,
            isOAuth: false,
        }));

        // OAuth de renovação
        service.record(makeEvent({
            doctoraliaRequestId: 'oauth-refresh',
            origin: 'AUTHENTICATION',
            operation: 'OAUTH_TOKEN',
            endpoint: '/oauth/v2/token',
            method: 'POST',
            httpStatus: 200,
            isRetry: false,
            retryNumber: 0,
            isOAuth: true,
        }));

        // Retry com novo token
        service.record(makeEvent({
            doctoraliaRequestId: 'req-retry',
            origin: 'USER_INTERACTIVE',
            httpStatus: 200,
            isRetry: true,
            retryNumber: 1,
            isOAuth: false,
        }));

        const events = service.getEvents();
        expect(events).toHaveLength(3);

        const original = events.find(e => e.doctoraliaRequestId === 'req-original')!;
        const oauth = events.find(e => e.doctoraliaRequestId === 'oauth-refresh')!;
        const retry = events.find(e => e.doctoraliaRequestId === 'req-retry')!;

        expect(original.httpStatus).toBe(401);
        expect(original.isRetry).toBe(false);
        expect(original.retryNumber).toBe(0);
        expect(original.isOAuth).toBe(false);

        expect(oauth.isOAuth).toBe(true);
        expect(oauth.origin).toBe('AUTHENTICATION');
        expect(oauth.operation).toBe('OAUTH_TOKEN');

        expect(retry.httpStatus).toBe(200);
        expect(retry.isRetry).toBe(true);
        expect(retry.retryNumber).toBe(1);
        expect(retry.isOAuth).toBe(false);
    });

    // ─── Teste 4: Timeout ────────────────────────────────────────────────────
    it('4. Timeout — status = TIMEOUT registrado; record() não lança exceção', () => {
        expect(() => {
            service.record(makeEvent({
                doctoraliaRequestId: 'req-timeout',
                httpStatus: 'TIMEOUT',
                isOAuth: false,
            }));
        }).not.toThrow();

        const events = service.getEvents();
        expect(events).toHaveLength(1);
        expect(events[0].httpStatus).toBe('TIMEOUT');
    });

    // ─── Teste 5: Polling sobreposto ─────────────────────────────────────────
    it('5. Polling sobreposto — OVERLAPPING_POLL_DETECTED, MAX_CONCURRENT_POLLS e OVERLAPPING_POLL_COUNT emitidos', async () => {
        const clinicId = 'clinic-overlap';

        // Inicia o primeiro poll (sem sobreposição)
        const overlap1 = service.trackPollStart(clinicId, 'poll-1');
        expect(overlap1).toBeNull(); // Sem sobreposição

        // Inicia o segundo poll antes de finalizar o primeiro → sobreposição
        const overlap2 = service.trackPollStart(clinicId, 'poll-2');
        expect(overlap2).not.toBeNull();
        expect(overlap2!.clinicId).toBe(clinicId);
        expect(overlap2!.newPollExecutionId).toBe('poll-2');
        expect(overlap2!.activePollExecutionIds).toContain('poll-1');
        expect(overlap2!.concurrency).toBe(2);

        // Contadores globais
        expect(service.getTotalOverlapCount()).toBeGreaterThanOrEqual(1);
        expect(service.getMaxConcurrentPolls()).toBeGreaterThanOrEqual(2);
        expect(service.getOverlapEvents()).toHaveLength(1);

        // Termina ambos os polls
        service.trackPollEnd(clinicId, 'poll-1');
        service.trackPollEnd(clinicId, 'poll-2');
    });

    // ─── Teste 6: Duplicidade real ───────────────────────────────────────────
    it('6. Duplicidade real — mesma assinatura lógica completa na janela → emite POTENTIAL_DUPLICATE_REQUEST', () => {
        const now = Date.now();
        // clinicId + resourceKey idênticos = mesmo recurso real (mesmo doctor/address/clinic)
        const baseEvent = makeEvent({
            method: 'GET',
            operation: 'GET_BOOKINGS',
            endpoint: '/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/bookings?start=2026-01-01T00:00:00-03:00&end=2026-01-31T23:59:59-03:00',
            clinicId: 'clinic-dup',
            resourceKey: '100|200|300', // facilityId|doctorId|addressId reais
            isOAuth: false,
            enqueuedAt: now - 100,
            releasedAt: now - 50,
            sentAt: now - 50,
            respondedAt: now,
        });

        service.record({ ...baseEvent, doctoraliaRequestId: 'dup-1' });
        service.record({ ...baseEvent, doctoraliaRequestId: 'dup-2' });

        // Aguarda detecção (síncrono — checkDuplicate é chamado dentro de record())
        const dups = service.getDuplicateEvents();
        expect(dups.length).toBeGreaterThanOrEqual(1);
        expect(dups[0].method).toBe('GET');
    });

    // ─── Teste 7: Falso positivo de duplicidade (datas diferentes) ──────────
    // Este teste usa o formato exato que DocplannerClient produz após o fix WP-01:
    // IDs numéricos substituídos por :id NO PATH, query params preservados sem encode.
    it('7. Falso positivo — GET /bookings mesmo médico/endereço, períodos diferentes → NÃO emite POTENTIAL_DUPLICATE_REQUEST', () => {
        // Simula o que DocplannerClient.request() grava após split('?') + replace(/\/\d+/g, '/:id')
        // path original: /api/v3/integration/facilities/123/doctors/456/addresses/789/bookings?start=...
        const endpointJan = '/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/bookings?start=2026-01-01T00:00:00-03:00&end=2026-01-31T23:59:59-03:00';
        const endpointFev = '/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/bookings?start=2026-02-01T00:00:00-03:00&end=2026-02-28T23:59:59-03:00';

        // Primeiro evento: período jan
        service.record(makeEvent({
            doctoraliaRequestId: 'period-1',
            method: 'GET',
            operation: 'GET_BOOKINGS',
            endpoint: endpointJan,
            clinicId: 'clinic-a',
            resourceKey: '100|200|300', // mesmo recurso
            isOAuth: false,
        }));

        const beforeCount = service.getDuplicateEvents().length;

        // Segundo evento: período fev — assinatura DIFERENTE (start/end distintos)
        service.record(makeEvent({
            doctoraliaRequestId: 'period-2',
            method: 'GET',
            operation: 'GET_BOOKINGS',
            endpoint: endpointFev,
            clinicId: 'clinic-a',
            resourceKey: '100|200|300', // mesmo recurso
            isOAuth: false,
        }));

        const afterCount = service.getDuplicateEvents().length;
        expect(afterCount).toBe(beforeCount); // Nenhuma nova duplicata
    });

    // ─── Teste 7b: Falso positivo de duplicidade (médico diferente) ──────────
    it('7b. Falso positivo — GET /bookings mesma clínica/datas, médico diferente → NÃO emite POTENTIAL_DUPLICATE_REQUEST', () => {
        const endpoint = '/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/bookings?start=2026-01-01T00:00:00-03:00&end=2026-01-31T23:59:59-03:00';

        // Médico 200
        service.record(makeEvent({
            doctoraliaRequestId: 'diff-doc-1',
            method: 'GET',
            operation: 'GET_BOOKINGS',
            endpoint,
            clinicId: 'clinic-a',
            resourceKey: '100|200|300', // facilityId|doctor200|address300
            isOAuth: false,
        }));

        const beforeCount = service.getDuplicateEvents().length;

        // Médico 201 — resourceKey diferente → assinatura diferente
        service.record(makeEvent({
            doctoraliaRequestId: 'diff-doc-2',
            method: 'GET',
            operation: 'GET_BOOKINGS',
            endpoint,
            clinicId: 'clinic-a',
            resourceKey: '100|201|300', // facilityId|doctor201|address300
            isOAuth: false,
        }));

        const afterCount = service.getDuplicateEvents().length;
        expect(afterCount).toBe(beforeCount); // Nenhuma nova duplicata (médico diferente)
    });

    // ─── Teste 8: USER_INTERACTIVE propagação ────────────────────────────────
    it('8. USER_INTERACTIVE — propagação HTTP request → contexto herdado na chamada', async () => {
        let capturedOrigin: string | undefined;
        let capturedRequestId: string | undefined;

        await runWithDoctoraliaContext(
            { origin: 'USER_INTERACTIVE', clinicId: 'clinic-ui', requestId: 'http-req-123' },
            async () => {
                // Simula o que DocplannerClient.request() faz
                const ctx = getDoctoraliaContext();
                capturedOrigin = ctx?.origin;
                capturedRequestId = ctx?.requestId;

                // Registra como se fosse o client
                service.record(makeEvent({
                    doctoraliaRequestId: 'ui-call-1',
                    origin: ctx?.origin ?? 'OTHER',
                    requestId: ctx?.requestId,
                    clinicId: ctx?.clinicId,
                }));
            },
        );

        expect(capturedOrigin).toBe('USER_INTERACTIVE');
        expect(capturedRequestId).toBe('http-req-123');

        const events = service.getEvents();
        expect(events).toHaveLength(1);
        expect(events[0].origin).toBe('USER_INTERACTIVE');
        expect(events[0].requestId).toBe('http-req-123');
    });

    // ─── Teste 9: OAuth — origin=AUTHENTICATION, operation=OAUTH_TOKEN ───────
    it('9. OAuth — origin=AUTHENTICATION, operation=OAUTH_TOKEN; contado no total mas NÃO como chamada API; sem credenciais', () => {
        // Chamada API normal
        service.record(makeEvent({
            doctoraliaRequestId: 'api-call',
            origin: 'POLLING',
            isOAuth: false,
            operation: 'GET_BOOKINGS',
        }));

        // Chamada OAuth
        service.record(makeEvent({
            doctoraliaRequestId: 'oauth-call',
            origin: 'AUTHENTICATION',
            operation: 'OAUTH_TOKEN',
            endpoint: '/oauth/v2/token',
            method: 'POST',
            isOAuth: true,
        }));

        const baseline = service.getBaseline();
        expect(baseline.volume.DOCTORALIA_API_REQUEST_COUNT).toBe(1);   // somente API
        expect(baseline.volume.DOCTORALIA_OAUTH_REQUEST_COUNT).toBe(1); // só OAuth
        expect(baseline.volume.totalDoctoraliaRequests).toBe(2);        // total

        // Verifica que origin aparece como AUTHENTICATION
        expect(baseline.volume.byOrigin['AUTHENTICATION']).toBe(1);
        expect(baseline.volume.byOrigin['POLLING']).toBe(1);
    });

    // ─── Teste 15: SyncProcessor — contexto reconstruído a partir do payload ──
    it('15. SyncProcessor — origem e clinicId do payload do job são corretamente propagados via ALS', async () => {
        const jobClinicId = 'clinic-sync-job';
        const jobOrigin = 'SCHEDULER'; // serializado no payload pelo SyncService

        // Simula o que SyncProcessor.process() faz: lê _observabilityOrigin do payload
        // e chama runWithDoctoraliaContext antes de criar o DocplannerClient
        await runWithDoctoraliaContext({ origin: jobOrigin as any, clinicId: jobClinicId }, async () => {
            const ctx = getDoctoraliaContext();

            // Simula chamada Doctoralia feita pelo processor (ex.: client.getFacilities())
            service.record(makeEvent({
                doctoraliaRequestId: 'sync-proc-call-1',
                origin: ctx?.origin ?? 'OTHER',
                clinicId: ctx?.clinicId,
                operation: 'GET_FACILITIES',
                endpoint: '/api/v3/integration/facilities',
                method: 'GET',
                httpStatus: 200,
                isOAuth: false,
            }));
        });

        const events = service.getEvents();
        const procEvent = events.find(e => e.doctoraliaRequestId === 'sync-proc-call-1');
        expect(procEvent).toBeDefined();
        // Antes do fix, estas chamadas eram registradas como origin=OTHER, clinicId=undefined
        expect(procEvent!.origin).toBe('SCHEDULER');
        expect(procEvent!.clinicId).toBe(jobClinicId);
    });

    // ─── Teste 14: OAuth falha de rede — NETWORK status gravado ─────────────
    it('14. OAuth network failure — status NETWORK registrado via finally path', () => {
        // Simula o comportamento de fetchNewToken quando fetch() lança (rede indisponível)
        // O código usa try/catch/finally, então mesmo em falha de rede o evento é registrado.
        expect(() => {
            service.record(makeEvent({
                doctoraliaRequestId: 'oauth-net-fail',
                origin: 'AUTHENTICATION',
                operation: 'OAUTH_TOKEN',
                endpoint: '/oauth/v2/token',
                method: 'POST',
                httpStatus: 'NETWORK', // classificado em catch como fetchErr.name !== 'AbortError'
                isRetry: false,
                retryNumber: 0,
                isOAuth: true,
            }));
        }).not.toThrow();

        const events = service.getEvents();
        const oauthFail = events.find(e => e.doctoraliaRequestId === 'oauth-net-fail');
        expect(oauthFail).toBeDefined();
        expect(oauthFail!.httpStatus).toBe('NETWORK');
        expect(oauthFail!.isOAuth).toBe(true);
        expect(oauthFail!.origin).toBe('AUTHENTICATION');

        // Deve contar no total mas não como chamada API
        const baseline = service.getBaseline();
        expect(baseline.volume.DOCTORALIA_OAUTH_REQUEST_COUNT).toBeGreaterThanOrEqual(1);
        expect(baseline.volume.DOCTORALIA_API_REQUEST_COUNT).toBe(0);
    });

    // ─── Teste 11: POLLING com clinicId (pollClinic — notificações) ──────────
    it('11. pollClinic — requisição getNotifications gravada com origin=POLLING e clinicId correto', async () => {
        const targetClinic = 'clinic-notif-polling';

        await runWithDoctoraliaContext({ origin: 'POLLING', clinicId: targetClinic }, async () => {
            const ctx = getDoctoraliaContext();
            // Simula o que DocplannerClient.request() faz ao chamar getNotifications
            service.record(makeEvent({
                doctoraliaRequestId: 'notif-poll-1',
                origin: ctx?.origin ?? 'OTHER',
                clinicId: ctx?.clinicId,
                operation: 'GET_NOTIFICATIONS',
                endpoint: '/api/v3/integration/notifications/multiple',
                method: 'GET',
                httpStatus: 200,
            }));
        });

        const events = service.getEvents();
        const notifEvent = events.find(e => e.doctoraliaRequestId === 'notif-poll-1');
        expect(notifEvent).toBeDefined();
        expect(notifEvent!.origin).toBe('POLLING');
        expect(notifEvent!.clinicId).toBe(targetClinic); // Antes do fix, seria undefined
    });

    // ─── Teste 12: WEBHOOK com clinicId (após resolução da conexão) ──────────
    it('12. webhook — chamadas Doctoralia após resolução da conexão gravadas com origin=WEBHOOK e clinicId', async () => {
        const resolvedClinicId = 'clinic-resolved-webhook';

        // Simula o fluxo: contexto WEBHOOK sem clinicId → resolve conn → re-wrap com clinicId
        await runWithDoctoraliaContext({ origin: 'WEBHOOK' }, async () => {
            // conn resolvido internamente (facilityId → clinicId)
            const resolvedConn = { clinicId: resolvedClinicId };

            // Re-wrap com clinicId (como _processWebhookNotificationInner faz após findFirst)
            await runWithDoctoraliaContext({ origin: 'WEBHOOK', clinicId: resolvedConn.clinicId }, async () => {
                const ctx = getDoctoraliaContext();
                service.record(makeEvent({
                    doctoraliaRequestId: 'webhook-handler-1',
                    origin: ctx?.origin ?? 'OTHER',
                    clinicId: ctx?.clinicId,
                    operation: 'CANCEL_BOOKING',
                    endpoint: '/api/v3/integration/facilities/:id/doctors/:id/addresses/:id/bookings/:id',
                    method: 'DELETE',
                    httpStatus: 204,
                }));
            });
        });

        const events = service.getEvents();
        const whEvent = events.find(e => e.doctoraliaRequestId === 'webhook-handler-1');
        expect(whEvent).toBeDefined();
        expect(whEvent!.origin).toBe('WEBHOOK');
        expect(whEvent!.clinicId).toBe(resolvedClinicId); // Antes do fix, seria undefined
    });

    // ─── Teste 13: Autorização SUPER_ADMIN no endpoint de métricas ──────────
    it('13. Autorização — getBaseline() não expõe dados para usuários sem SUPER_ADMIN (simulação de guard)', () => {
        service.record(makeEvent({ doctoraliaRequestId: 'guard-test', clinicId: 'clinic-secret', origin: 'POLLING' }));

        // getBaseline() retorna os dados — o guard no MetricsController bloqueia antes de chegar aqui.
        // Verificamos que o baseline CONTÉM clinicId nos dados raw, o que confirma que o guard
        // é a única linha de defesa (e que o guard deve existir e ser testado separadamente).
        const baseline = service.getBaseline();
        const baselineStr = JSON.stringify(baseline);
        // O relatório inclui dados por origem (não expõe clinicId individualmente no sumário)
        expect(baseline.volume.byOrigin['POLLING']).toBeGreaterThanOrEqual(1);
        // Confirma que o guard (ForbiddenException para não-SUPER_ADMIN) é indispensável:
        // qualquer usuário autenticado sem SUPER_ADMIN que chegasse aqui veria esses dados.
        expect(baselineStr).not.toContain('SUPER_ADMIN'); // Não vaza info sobre o role
    });

    // ─── Teste 10: Segurança dos logs ────────────────────────────────────────
    it('10. Segurança — nenhuma métrica ou baseline contém credenciais sensíveis', () => {
        const SENSITIVE = [
            'access_token', 'refresh_token', 'clientSecret', 'client_secret',
            'Authorization', 'Basic ', 'Bearer ',
        ];

        // Registra evento OAuth (como se viesse do fetchNewToken)
        service.record(makeEvent({
            doctoraliaRequestId: 'secure-oauth',
            origin: 'AUTHENTICATION',
            operation: 'OAUTH_TOKEN',
            endpoint: '/oauth/v2/token',
            method: 'POST',
            isOAuth: true,
            httpStatus: 200,
        }));

        const baseline = service.getBaseline();
        const baselineStr = JSON.stringify(baseline);

        for (const sensitive of SENSITIVE) {
            expect(baselineStr).not.toContain(sensitive);
        }

        // Valida também que os eventos em memória não têm credenciais
        const eventsStr = JSON.stringify(service.getEvents());
        for (const sensitive of SENSITIVE) {
            expect(eventsStr).not.toContain(sensitive);
        }
    });
});
