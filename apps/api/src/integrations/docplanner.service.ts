import { Injectable, Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { getDoctoraliaMetricsService } from '../metrics/doctoralia-metrics.service';
import { getDoctoraliaContext } from '../metrics/doctoralia-call-context';
import { randomUUID } from 'crypto';

interface CachedToken {
    token: string;
    /** epoch ms após o qual o token não deve mais ser usado */
    expiresAt: number;
}

@Injectable()
export class DocplannerClient {
    private readonly logger = new Logger(DocplannerClient.name);

    /**
     * Cache GLOBAL de tokens OAuth por (domínio + clientId), compartilhado entre todas as
     * instâncias do cliente. Sem isso, cada polling/sync/teste pedia um token novo
     * (~milhares de POSTs /oauth/v2/token por dia), o que o AWS WAF da Doctoralia pontua
     * como comportamento de robô abusivo e passa a responder com página de verificação
     * (405 + captcha). Um token vale ~1h; reutilizá-lo reduz a ~24 autenticações/dia.
     */
    private static tokenCache = new Map<string, CachedToken>();
    private static inflightAuth = new Map<string, Promise<string>>();

    /**
     * Limitador GLOBAL de vazão (todas as instâncias/conexões): o AWS WAF da Doctoralia
     * barra IPs fora do Brasil que excedem 500 requisições por janela de 5 minutos
     * (informado pelo suporte em 29/07/2026). Limitamos a 400/5min (margem de 20%),
     * enfileirando o excedente em vez de estourar a regra — o sync fica mais lento
     * nos picos, mas nunca dispara o bloqueio.
     */
    private static readonly RATE_LIMIT = 400;
    private static readonly RATE_WINDOW_MS = 5 * 60 * 1000;
    /** Timestamps (epoch ms) das requisições feitas dentro da janela corrente. */
    private static rateTimestamps: number[] = [];
    private static lastThrottleLogAt = 0;

    /**
     * Duas filas de espera pela vazão: a prioritária (varredura de segurança e outras
     * operações pequenas/urgentes) passa na frente da normal (sync global em massa).
     * IMPORTANTE: isso apenas REORDENA quem usa cada slot — o teto continua sendo
     * exatamente RATE_LIMIT (400) requisições por janela de 5 minutos.
     */
    private static waitingHigh: Array<() => void> = [];
    private static waitingLow: Array<() => void> = [];
    private static pumping = false;
    /** Grants prioritários consecutivos (para a cota anti-inanição da fila normal). */
    private static consecutiveHighGrants = 0;

    /** Contexto assíncrono: marca chamadas feitas dentro de runWithPriority(). */
    private static priorityAls = new AsyncLocalStorage<boolean>();

    /**
     * Executa fn com prioridade na fila de vazão da Doctoralia. Não aumenta o
     * limite de requisições — só garante que estas poucas chamadas não fiquem
     * horas atrás das milhares do sync global.
     */
    static runWithPriority<T>(fn: () => Promise<T>): Promise<T> {
        return DocplannerClient.priorityAls.run(true, fn);
    }

    private static async pumpRateQueue(logger: Logger): Promise<void> {
        if (DocplannerClient.pumping) return;
        DocplannerClient.pumping = true;
        try {
            while (DocplannerClient.waitingHigh.length || DocplannerClient.waitingLow.length) {
                for (;;) {
                    const now = Date.now();
                    const cutoff = now - DocplannerClient.RATE_WINDOW_MS;
                    const ts = DocplannerClient.rateTimestamps;
                    while (ts.length && ts[0] <= cutoff) ts.shift();
                    if (ts.length < DocplannerClient.RATE_LIMIT) {
                        ts.push(now);
                        break;
                    }
                    const waitMs = Math.max(ts[0] + DocplannerClient.RATE_WINDOW_MS - now, 250);
                    if (now - DocplannerClient.lastThrottleLogAt > 30_000) {
                        DocplannerClient.lastThrottleLogAt = now;
                        logger.warn(`[RATE-LIMIT] Janela de ${DocplannerClient.RATE_LIMIT} req/5min cheia — segurando requisições por ~${Math.ceil(waitMs / 1000)}s para não disparar o WAF da Doctoralia (fila: ${DocplannerClient.waitingHigh.length} prioritária(s), ${DocplannerClient.waitingLow.length} normal(is)).`);
                    }
                    await new Promise(r => setTimeout(r, waitMs));
                }
                // Anti-inanição: a cada 4 slots prioritários seguidos, cede 1 à fila normal.
                let next: (() => void) | undefined;
                if (
                    DocplannerClient.waitingLow.length &&
                    (DocplannerClient.consecutiveHighGrants >= 4 || !DocplannerClient.waitingHigh.length)
                ) {
                    next = DocplannerClient.waitingLow.shift();
                    DocplannerClient.consecutiveHighGrants = 0;
                } else {
                    next = DocplannerClient.waitingHigh.shift();
                    DocplannerClient.consecutiveHighGrants++;
                }
                if (next) next();
                else DocplannerClient.rateTimestamps.pop(); // slot reservado sem ninguém na fila (corrida rara): devolve
            }
        } finally {
            DocplannerClient.pumping = false;
        }
    }

    /** Aguarda (se necessário) até haver espaço na janela de vazão e registra a requisição. */
    private static acquireRateSlot(logger: Logger): Promise<void> {
        const priority = DocplannerClient.priorityAls.getStore() === true;
        const enqueuedAt = Date.now();
        return new Promise<void>(resolve => {
            (priority ? DocplannerClient.waitingHigh : DocplannerClient.waitingLow).push(() => {
                // Emite snapshot de fila sem alterar o algoritmo
                try {
                    const metrics = getDoctoraliaMetricsService();
                    if (metrics) {
                        const now = Date.now();
                        const cutoff = now - DocplannerClient.RATE_WINDOW_MS;
                        const ts = DocplannerClient.rateTimestamps;
                        const used = ts.filter(t => t > cutoff).length;
                        const remaining = DocplannerClient.RATE_LIMIT - used;
                        metrics.recordRateSnapshot({
                            usedInWindow: used,
                            remainingInWindow: remaining,
                            queueSizeHigh: DocplannerClient.waitingHigh.length,
                            queueSizeLow: DocplannerClient.waitingLow.length,
                        });
                    }
                } catch (_e) { /* fail-safe */ }
                resolve();
            });
            void DocplannerClient.pumpRateQueue(logger);
        });
    }

    private accessToken: string;
    private baseUrl: string;
    private authPromise: Promise<string> | null = null;
    private clientId: string | null = null;
    private clientSecret: string | null = null;
    /** Persistência opcional do token (banco), para sobreviver a restarts do container. */
    private persistLoad: (() => Promise<CachedToken | null>) | null = null;
    private persistSave: ((t: CachedToken) => Promise<void>) | null = null;

    constructor(private configService: ConfigService) {}

    setPersistence(load: () => Promise<CachedToken | null>, save: (t: CachedToken) => Promise<void>) {
        this.persistLoad = load;
        this.persistSave = save;
    }

    setAccessToken(token: string) {
        this.accessToken = token;
    }

    setBaseUrl(url: string) {
        let u = url.replace(/\/$/, '');
        // Normaliza domínios Doctoralia/ZnanyLekarz sem "www": a Doctoralia passou a
        // responder 301 no domínio raiz, e o redirect converte o POST de autenticação
        // em GET (→ 405 com página de verificação do WAF). Sempre usar o host www.
        u = u.replace(/^(https?:\/\/)?(doctoralia\.[a-z.]+|znanylekarz\.pl)$/i, (_m, proto, host) => `${proto || ''}www.${host}`);
        this.baseUrl = u;
    }

    private getBaseUrl(): string {
        return this.baseUrl || 'https://www.doctoralia.com.br';
    }

    /**
     * WP-06: identidade estável `domain|clientId` desta conexão, usada como prefixo
     * das chaves do StableDataCache. Acessor de leitura — não altera comportamento.
     */
    getCacheIdentity(): string {
        return `${this.getBaseUrl().replace(/^https?:\/\//, '')}|${this.clientId ?? ''}`;
    }

    async authenticate(clientId: string, clientSecret: string): Promise<string> {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.authPromise = this.getToken(false);
        return this.authPromise;
    }

    /**
     * Força a obtenção de um token NOVO (ignora memória e banco). Usado pelo renovador
     * em segundo plano quando o token atual está perto de expirar — sem forçar, o
     * getToken(false) devolveria o token ainda-válido e a renovação nunca aconteceria.
     */
    async forceTokenRefresh(clientId: string, clientSecret: string): Promise<string> {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.authPromise = this.getToken(true);
        return this.authPromise;
    }

    /** Obtém um token: do cache global se ainda válido; senão autentica (com dedupe de chamadas concorrentes). */
    private async getToken(forceRefresh: boolean): Promise<string> {
        const domain = this.getBaseUrl().replace(/^https?:\/\//, '');
        const cacheKey = `${domain}|${this.clientId}`;

        if (!forceRefresh) {
            const cached = DocplannerClient.tokenCache.get(cacheKey);
            if (cached && cached.expiresAt > Date.now()) {
                this.accessToken = cached.token;
                return cached.token;
            }
            // Memória vazia (ex.: restart do container): tenta o token persistido no banco.
            if (this.persistLoad) {
                try {
                    const persisted = await this.persistLoad();
                    if (persisted && persisted.expiresAt > Date.now()) {
                        DocplannerClient.tokenCache.set(cacheKey, persisted);
                        this.accessToken = persisted.token;
                        this.logger.log(`Token OAuth recuperado do banco para ${cacheKey.split('|')[0]} (válido por ~${Math.round((persisted.expiresAt - Date.now()) / 60000)}min).`);
                        return persisted.token;
                    }
                } catch (err: any) {
                    this.logger.warn(`Falha ao ler token persistido: ${err?.message}`);
                }
            }
        } else {
            DocplannerClient.tokenCache.delete(cacheKey);
        }

        // Dedupe: se outra instância já está autenticando este mesmo clientId, aguarda-a
        // em vez de disparar outro POST /oauth/v2/token.
        let inflight = DocplannerClient.inflightAuth.get(cacheKey);
        if (!inflight) {
            inflight = this.fetchNewToken(domain, cacheKey).finally(() => {
                DocplannerClient.inflightAuth.delete(cacheKey);
            });
            DocplannerClient.inflightAuth.set(cacheKey, inflight);
        }
        const token = await inflight;
        this.accessToken = token;
        return token;
    }

    /** IP público de saída no instante da chamada (cache de 5min; falha vira "desconhecido"). */
    private static egressIpCache: { ip: string; at: number } | null = null;
    private async getEgressIp(): Promise<string> {
        const c = DocplannerClient.egressIpCache;
        if (c && Date.now() - c.at < 5 * 60 * 1000) return c.ip;
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 5000);
            const res = await fetch('https://api.ipify.org', { signal: ctrl.signal });
            clearTimeout(t);
            const ip = (await res.text()).trim();
            DocplannerClient.egressIpCache = { ip, at: Date.now() };
            return ip;
        } catch {
            return 'desconhecido';
        }
    }

    private async fetchNewToken(domain: string, cacheKey: string): Promise<string> {
        const url = `https://${domain}/oauth/v2/token`;
        const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

        const _oauthEnqueuedAt = Date.now();
        await DocplannerClient.acquireRateSlot(this.logger);
        const _oauthReleasedAt = Date.now();
        const _oauthSentAt = Date.now();
        // WP-01: httpStatus default para NETWORK; será sobrescrito se fetch retornar
        let _oauthHttpStatus: number | 'TIMEOUT' | 'NETWORK' | 'OTHER' = 'NETWORK';
        let response: Awaited<ReturnType<typeof fetch>> | undefined;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${basicAuth}`,
                    // O fetch do Node não envia User-Agent; o WAF da Doctoralia pontua
                    // requisições sem identificação como robô suspeito.
                    'User-Agent': 'Orquestrador/1.0 (VisMed integration)',
                },
                body: 'grant_type=client_credentials&scope=integration',
            });
            _oauthHttpStatus = response.status;
        } catch (fetchErr: any) {
            _oauthHttpStatus = fetchErr?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
            throw fetchErr;
        } finally {
            // WP-01: registra chamada OAuth em finally — cobre sucesso, HTTP error E network failure
            const _oauthRespondedAt = Date.now();
            try {
                const metrics = getDoctoraliaMetricsService();
                if (metrics) {
                    metrics.record({
                        doctoraliaRequestId: randomUUID(),
                        origin: 'AUTHENTICATION',
                        operation: 'OAUTH_TOKEN',
                        endpoint: '/oauth/v2/token',
                        method: 'POST',
                        httpStatus: _oauthHttpStatus,
                        isRetry: false,
                        retryNumber: 0,
                        isOAuth: true,
                        enqueuedAt: _oauthEnqueuedAt,
                        releasedAt: _oauthReleasedAt,
                        sentAt: _oauthSentAt,
                        respondedAt: _oauthRespondedAt,
                        waitMs: _oauthReleasedAt - _oauthEnqueuedAt,
                        execMs: _oauthRespondedAt - _oauthSentAt,
                    });
                }
            } catch (_e) { /* fail-safe: metrics never propagate */ }
        }

        if (!response!.ok) {
            const errorText = await response.text();
            // Diagnóstico forense do bloqueio WAF: registra cabeçalhos da resposta,
            // content-type e o IP público de saída NO INSTANTE da falha, para
            // comparação entre execuções que funcionam e que falham.
            const diag = [
                `content-type=${response.headers.get('content-type')}`,
                `server=${response.headers.get('server')}`,
                `via=${response.headers.get('via')}`,
                `x-amzn-waf-action=${response.headers.get('x-amzn-waf-action')}`,
                `x-amzn-requestid=${response.headers.get('x-amzn-requestid')}`,
                `x-amz-cf-id=${response.headers.get('x-amz-cf-id')}`,
                `x-amz-cf-pop=${response.headers.get('x-amz-cf-pop')}`,
                `x-cache=${response.headers.get('x-cache')}`,
            ].join(' | ');
            const egressIp = await this.getEgressIp();
            this.logger.error(
                `[AUTH-DIAG] Falha OAuth ${response.status} em ${url} | ip_saida=${egressIp} | ${diag} | corpo(200c)=${errorText.slice(0, 200).replace(/\s+/g, ' ')}`,
            );
            throw new Error(`Failed to authenticate with Docplanner: ${response.status} ${errorText}`);
        }

        this.logger.log(`[AUTH-DIAG] OAuth OK em ${url} | ip_saida=${await this.getEgressIp()}`);

        const data = await response.json() as any;
        // expires_in em segundos (padrão OAuth); margem de 60s para não usar token na iminência
        // de expirar. Fallback conservador de 50min se o campo não vier.
        const ttlMs = (typeof data.expires_in === 'number' && data.expires_in > 120)
            ? (data.expires_in - 60) * 1000
            : 50 * 60 * 1000;
        const entry: CachedToken = { token: data.access_token, expiresAt: Date.now() + ttlMs };
        DocplannerClient.tokenCache.set(cacheKey, entry);
        this.logger.log(`Novo token OAuth obtido para ${cacheKey.split('|')[0]} (válido por ~${Math.round(ttlMs / 60000)}min).`);
        if (this.persistSave) {
            this.persistSave(entry).catch(err => this.logger.warn(`Falha ao persistir token: ${err?.message}`));
        }
        return data.access_token;
    }

    /**
     * WP-05: Deduplicação de GETs idênticos in-flight (mesmo padrão do inflightAuth).
     * Mapa GLOBAL (static) porque DocplannerService.createClient() cria uma instância
     * nova por uso. Chave: domain|clientId|method|path (path inclui a query completa).
     * NÃO é cache: a entrada sai do mapa em finally — sucesso OU erro — e a próxima
     * chamada após conclusão faz requisição nova. Erros jamais ficam armazenados.
     */
    private static inflightGets = new Map<string, Promise<any>>();

    /**
     * Cada awaiter recebe cópia independente do resultado, para que a mutação local
     * de um consumidor não afete o outro. structuredClone é nativo do Node ≥17
     * (sem dependência nova); fallback JSON para o improvável caso não-clonável.
     */
    private static cloneResult(result: any): any {
        if (result === null || result === undefined || typeof result !== 'object') return result;
        try {
            return structuredClone(result);
        } catch {
            return JSON.parse(JSON.stringify(result));
        }
    }

    private async request(method: string, path: string, data?: any, isRetry = false): Promise<any> {
        // WP-05: dedup APENAS para GET, excluindo GET_NOTIFICATIONS (stream consumível).
        // Mutações (POST/PUT/PATCH/DELETE) e OAuth ficam explicitamente fora.
        // O join acontece AQUI, ANTES de acquireRateSlot — o segundo chamador não
        // consome slot WAF nem posição na fila de vazão.
        if (method === 'GET' && !isRetry && this.inferOperation(method, path) !== 'GET_NOTIFICATIONS') {
            const domain = this.getBaseUrl().replace(/^https?:\/\//, '');
            const key = `${domain}|${this.clientId ?? ''}|${method}|${path}`;
            const existing = DocplannerClient.inflightGets.get(key);
            if (existing) {
                this.logger.debug(`[DEDUP] GET idêntico já em voo — juntando-se à requisição existente: ${path}`);
                try {
                    getDoctoraliaMetricsService()?.recordDedupedGet();
                } catch (_e) { /* fail-safe */ }
                return DocplannerClient.cloneResult(await existing);
            }
            const flight = this.executeRequest(method, path, data, isRetry).finally(() => {
                DocplannerClient.inflightGets.delete(key);
            });
            DocplannerClient.inflightGets.set(key, flight);
            return DocplannerClient.cloneResult(await flight);
        }
        return this.executeRequest(method, path, data, isRetry);
    }

    private async executeRequest(method: string, path: string, data?: any, isRetry = false): Promise<any> {
        if (this.clientId) {
            // Sempre passa pelo cache: pega token válido, renova se expirado, e re-tenta
            // autenticar mesmo que a autenticação inicial (fire-and-forget do createClient)
            // tenha falhado por um erro transitório — falha de auth não é cacheada.
            await this.getToken(false);
        } else if (this.authPromise) {
            await this.authPromise;
        }
        const domain = this.getBaseUrl().replace(/^https?:\/\//, '');
        const url = `https://${domain}${path}`;

        // WP-01: captura contexto e prepara instrumentação
        const ctx = getDoctoraliaContext();
        const doctoraliaRequestId = randomUUID();
        const enqueuedAt = Date.now();

        // Adquire o slot ANTES de armar o timeout de 30s — a espera na fila de vazão
        // não pode consumir o tempo da requisição em si.
        await DocplannerClient.acquireRateSlot(this.logger);
        const releasedAt = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        let httpStatus: number | 'TIMEOUT' | 'NETWORK' | 'OTHER' | undefined;
        const sentAt = Date.now();

        try {
            const headers: any = {
                'Authorization': `Bearer ${this.accessToken}`,
                'User-Agent': 'Orquestrador/1.0 (VisMed integration)',
            };

            const options: RequestInit = {
                method,
                headers,
                signal: controller.signal,
            };

            if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
                headers['Content-Type'] = 'application/json';
                options.body = JSON.stringify(data);
            }

            this.logger.verbose(`Calling Docplanner API: ${method} ${url}`);
            const response = await fetch(url, options);
            httpStatus = response.status;

            if (method === 'PUT' || method === 'PATCH') {
                this.logger.log(`API Response: ${method} ${path} → status=${response.status}, content-type=${response.headers.get('content-type')}`);
            }

            if (!response.ok) {
                // Token do cache pode ter sido revogado/expirado no servidor.
                // Sempre renova o token para que a próxima chamada use um token válido,
                // mas só repete a operação se ela for comprovadamente idempotente.
                if (response.status === 401 && this.clientId) {
                    await response.text().catch(() => undefined);
                    const operation401 = this.inferOperation(method, path);
                    const canRetry = !isRetry && this.isRetryableOperation(method, operation401);
                    // Renovação SEMPRE ocorre — independente de repetir ou não.
                    await this.getToken(true);
                    if (canRetry) {
                        this.logger.warn(`401 em ${method} ${path} (${operation401}) — token renovado, repetindo a chamada.`);
                        // WP-05: retry direto em executeRequest — permanece DENTRO do voo
                        // único do dedup (não cria nem se junta a outra entrada do mapa).
                        return this.executeRequest(method, path, data, true);
                    }
                    const reason = isRetry
                        ? 'já é retry'
                        : `operação ${operation401} não é idempotente`;
                    this.logger.warn(`401 em ${method} ${path} (${operation401}) — token renovado mas NÃO repetindo (${reason}).`);
                    const err401 = new Error(`Docplanner API Error: 401 Unauthorized`);
                    (err401 as any).status = 401;
                    throw err401;
                }
                const errorText = await response.text();
                this.logger.error(`Docplanner API Error: ${response.status} ${errorText} URL: ${url}`);
                const error = new Error(`Docplanner API Error: ${response.status} ${errorText}`);
                (error as any).status = response.status;
                (error as any).details = errorText;
                throw error;
            }

            if (response.status === 204) {
                return null;
            }

            if (response.status === 201) {
                const location = response.headers.get('Location') || response.headers.get('location');
                let body = null;
                const text = await response.text();
                if (text && text.trim()) {
                    try { body = JSON.parse(text); } catch {}
                }
                return { ...(body || {}), _location: location, _status: 201 };
            }

            const text = await response.text();
            if (!text || !text.trim()) return null;
            try { return JSON.parse(text); } catch { return null; }
        } catch (err: any) {
            // Classifica o tipo de erro para métricas
            if (!httpStatus) {
                const isAbort = err?.name === 'AbortError';
                httpStatus = isAbort ? 'TIMEOUT' : 'NETWORK';
            }
            throw err;
        } finally {
            clearTimeout(timeout);
            // WP-01: registra evento de forma fail-safe
            const respondedAt = Date.now();
            try {
                const metrics = getDoctoraliaMetricsService();
                if (metrics) {
                    // WP-01: extrair IDs reais DO PATH antes de sanitizar (para resourceKey de assinatura)
                    const rawIdMatches = path.split('?')[0].match(/\/(\d+)/g);
                    const resourceKey = rawIdMatches ? rawIdMatches.map(s => s.slice(1)).join('|') : '';
                    // Sanitizar IDs no path mas PRESERVAR query params para assinatura de duplicatas
                    const [pathPart, queryPart] = path.split('?', 2);
                    const sanitized = pathPart.replace(/\/\d+/g, '/:id') + (queryPart ? '?' + queryPart : '');
                    const operation = this.inferOperation(method, path);
                    metrics.record({
                        doctoraliaRequestId,
                        origin: ctx?.origin ?? 'OTHER',
                        clinicId: ctx?.clinicId,
                        operation,
                        endpoint: sanitized,
                        resourceKey,
                        method,
                        httpStatus: httpStatus ?? 'OTHER',
                        isRetry,
                        retryNumber: isRetry ? 1 : 0,
                        isOAuth: false,
                        enqueuedAt,
                        releasedAt,
                        sentAt,
                        respondedAt,
                        waitMs: releasedAt - enqueuedAt,
                        execMs: respondedAt - sentAt,
                        requestId: ctx?.requestId,
                        pollExecutionId: ctx?.pollExecutionId,
                    });
                }
            } catch (_e) { /* fail-safe: metrics never propagate */ }
        }
    }

    /**
     * Determina se uma operação pode ser repetida automaticamente após 401.
     *
     * Apenas operações **IDEMPOTENTE_COMPROVADA** recebem retry automático:
     * - Todos os GETs (leitura pura — repetiçao nunca altera estado)
     * - REPLACE_SLOTS via PUT (substituição total do calendário; mesmo payload → mesmo estado)
     *
     * Classificação completa de todas as operações Doctoralia:
     *
     * | Operação                          | HTTP   | Classificação           | Justificativa                                          |
     * |-----------------------------------|--------|-------------------------|--------------------------------------------------------|
     * | GET_FACILITIES                    | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_DOCTORS                       | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_ADDRESSES                     | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_SERVICES                      | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_CALENDAR                      | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_INSURANCES                    | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_INSURANCE_PROVIDERS           | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_INSURANCE_PLANS               | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_ADDRESS_INSURANCE_PROVIDERS   | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_FACILITY_SERVICES             | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_FACILITY_SERVICES_CATALOG     | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_SERVICES_DICTIONARY           | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_BOOKINGS                      | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_SLOTS                         | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_BREAKS                        | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | GET_NOTIFICATIONS                 | GET    | IDEMPOTENTE_COMPROVADA  | Leitura pura                                           |
     * | REPLACE_SLOTS                     | PUT    | IDEMPOTENTE_COMPROVADA  | Substituição total; mesmo payload → mesmo estado final |
     * | PUT_ADDRESS_INSURANCE_PROVIDER    | PUT    | DESCONHECIDA            | Semântica não confirmada pelo contrato; conservador    |
     * | ADD_ADDRESS_SERVICE               | POST   | NÃO_IDEMPOTENTE         | Cria recurso; segundo POST cria duplicata              |
     * | ADD_ADDRESS_INSURANCE_PROVIDER    | POST   | NÃO_IDEMPOTENTE         | Cria vínculo; segundo POST pode criar duplicata        |
     * | BOOK_SLOT                         | POST   | NÃO_IDEMPOTENTE         | Cria booking; segundo POST cria booking duplicado      |
     * | ENABLE_CALENDAR                   | POST   | NÃO_IDEMPOTENTE         | Dispara ação                                           |
     * | DISABLE_CALENDAR                  | POST   | NÃO_IDEMPOTENTE         | Dispara ação                                           |
     * | RELEASE_NOTIFICATIONS             | POST   | NÃO_IDEMPOTENTE         | Consome/libera notificações                            |
     * | MOVE_BOOKING                      | POST   | NÃO_IDEMPOTENTE         | Move booking; segundo POST pode mover novamente        |
     * | ADD_BREAK                         | POST   | NÃO_IDEMPOTENTE         | Cria break; segundo POST cria break duplicado          |
     * | PATCH_ADDRESSES                   | PATCH  | NÃO_IDEMPOTENTE         | Atualização parcial; contrato não garante idempotência |
     * | PATCH_SERVICES                    | PATCH  | NÃO_IDEMPOTENTE         | Atualização parcial                                    |
     * | MOVE_BREAK                        | PATCH  | NÃO_IDEMPOTENTE         | Move break; segundo PATCH pode mover novamente         |
     * | DELETE_SLOTS                      | DELETE | NÃO_IDEMPOTENTE         | Segundo DELETE pode retornar 404 ou erro               |
     * | DELETE_SERVICES                   | DELETE | NÃO_IDEMPOTENTE         | Segundo DELETE pode retornar 404                       |
     * | DELETE_ADDRESS_INSURANCE_PROVIDER | DELETE | NÃO_IDEMPOTENTE         | Segundo DELETE pode retornar 404                       |
     * | DELETE_BREAK                      | DELETE | NÃO_IDEMPOTENTE         | Segundo DELETE pode retornar 404                       |
     * | CANCEL_BOOKING                    | DELETE | NÃO_IDEMPOTENTE         | Segundo DELETE pode retornar 404 ou efeito colateral   |
     */
    private isRetryableOperation(method: string, operation: string): boolean {
        // Todos os GETs são leitura pura — sempre idempotentes.
        if (method === 'GET') return true;
        // REPLACE_SLOTS é substituição total (PUT): mesmo payload → mesmo estado final.
        if (method === 'PUT' && operation === 'REPLACE_SLOTS') return true;
        // Tudo o mais (POST, DELETE, PATCH e outros PUTs) não tem idempotência comprovada.
        return false;
    }

    /** Infere nome de operação legível a partir do método HTTP e caminho. */
    private inferOperation(method: string, path: string): string {
        const p = path.toLowerCase();
        if (p.includes('/bookings') && method === 'GET') return 'GET_BOOKINGS';
        if (p.includes('/bookings') && method === 'DELETE') return 'CANCEL_BOOKING';
        if (p.includes('/bookings') && method === 'POST' && p.includes('/move')) return 'MOVE_BOOKING';
        if (p.includes('/bookings')) return `${method}_BOOKING`;
        if (p.includes('/slots') && p.includes('/book')) return 'BOOK_SLOT';
        if (p.includes('/slots') && method === 'PUT') return 'REPLACE_SLOTS';
        if (p.includes('/slots') && method === 'DELETE') return 'DELETE_SLOTS';
        if (p.includes('/slots') && method === 'GET') return 'GET_SLOTS';
        if (p.includes('/breaks') && method === 'GET') return 'GET_BREAKS';
        if (p.includes('/breaks') && method === 'POST') return 'ADD_BREAK';
        if (p.includes('/breaks') && method === 'DELETE') return 'DELETE_BREAK';
        if (p.includes('/breaks') && method === 'PATCH') return 'MOVE_BREAK';
        if (p.includes('/calendar/enable')) return 'ENABLE_CALENDAR';
        if (p.includes('/calendar/disable')) return 'DISABLE_CALENDAR';
        if (p.includes('/calendar')) return 'GET_CALENDAR';
        if (p.includes('/notifications/release')) return 'RELEASE_NOTIFICATIONS';
        if (p.includes('/notifications')) return 'GET_NOTIFICATIONS';
        if (p.includes('/addresses')) return `${method}_ADDRESSES`;
        if (p.includes('/doctors')) return `${method}_DOCTORS`;
        if (p.includes('/facilities')) return `${method}_FACILITIES`;
        if (p.includes('/services')) return `${method}_SERVICES`;
        if (p.includes('/insurance')) return `${method}_INSURANCE`;
        return `${method}_OTHER`;
    }

    async getFacilities(): Promise<any> {
        return this.request('GET', '/api/v3/integration/facilities');
    }

    async getDoctors(facilityId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors`);
    }

    async getAddresses(facilityId: string, doctorId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses`);
    }

    async getServices(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/services`);
    }

    async getCalendarStatus(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/calendar`);
    }

    async getInsurances(facilityId: string): Promise<any> {
        try {
            return await this.request('GET', `/api/v3/integration/facilities/${facilityId}/insurances`);
        } catch (e) {
            return { _items: [] };
        }
    }

    async getInsuranceProviders(): Promise<any> {
        return this.request('GET', '/api/v3/integration/insurance-providers');
    }

    async getInsurancePlans(insuranceProviderId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/insurance-providers/${insuranceProviderId}/plans`);
    }

    async getAddressInsuranceProviders(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/insurance-providers`);
    }

    async addAddressInsuranceProvider(facilityId: string, doctorId: string, addressId: string, insuranceProviderId: string, insurancePlans?: { insurance_plan_id: string }[]): Promise<any> {
        const payload: any = { insurance_provider_id: String(insuranceProviderId) };
        if (insurancePlans && insurancePlans.length > 0) {
            payload.insurance_plans = insurancePlans;
        }
        return this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/insurance-providers`, payload);
    }

    async putAddressInsuranceProvider(facilityId: string, doctorId: string, addressId: string, insuranceProviderId: string, insurancePlans?: { insurance_plan_id: string }[]): Promise<any> {
        const payload: any = { insurance_provider_id: String(insuranceProviderId) };
        if (insurancePlans && insurancePlans.length > 0) {
            payload.insurance_plans = insurancePlans;
        }
        return this.request('PUT', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/insurance-providers`, payload);
    }

    async deleteAddressInsuranceProvider(facilityId: string, doctorId: string, addressId: string, insuranceProviderId: string): Promise<any> {
        return this.request('DELETE', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/insurance-providers/${insuranceProviderId}`);
    }

    async getFacilityServices(facilityId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/services`);
    }

    async getFacilityServicesCatalog(facilityId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/services/catalog`);
    }

    async getServicesDictionary(): Promise<any> {
        return this.request('GET', '/api/v3/integration/services');
    }

    async getBookings(facilityId: string, doctorId: string, addressId: string, start: string, end: string): Promise<any> {
        const s = start.includes('T') ? start : `${start}T00:00:00-03:00`;
        const e = end.includes('T') ? end : `${end}T23:59:59-03:00`;
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/bookings?start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}`);
    }

    async getBooking(facilityId: string, doctorId: string, addressId: string, bookingId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/bookings/${bookingId}`);
    }

    async getSlots(facilityId: string, doctorId: string, addressId: string, start: string, end: string): Promise<any> {
        const s = start.includes('T') ? start : `${start}T00:00:00-03:00`;
        const e = end.includes('T') ? end : `${end}T23:59:59-03:00`;
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/slots?start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}`);
    }

    async replaceSlots(facilityId: string, doctorId: string, addressId: string, payload: any): Promise<any> {
        const slotCount = payload?.slots?.length || 0;
        this.logger.log(`replaceSlots: sending ${slotCount} slots for doctor ${doctorId}, address ${addressId}`);
        const result = await this.request('PUT', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/slots`, payload);
        this.logger.log(`replaceSlots: response=${JSON.stringify(result)}`);
        return result;
    }

    async bookSlot(facilityId: string, doctorId: string, addressId: string, slotStart: string, payload: any): Promise<any> {
        const encodedStart = encodeURIComponent(slotStart);
        return this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/slots/${encodedStart}/book`, payload);
    }

    async deleteSlots(facilityId: string, doctorId: string, addressId: string, date: string): Promise<any> {
        const dateOnly = date.includes('T') ? date.split('T')[0] : date;
        return this.request('DELETE', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/slots/${dateOnly}`);
    }

    async updateAddress(facilityId: string, doctorId: string, addressId: string, payload: any): Promise<any> {
        return this.request('PATCH', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}`, payload);
    }

    async addAddressService(facilityId: string, doctorId: string, addressId: string, payload: any): Promise<any> {
        return this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/services`, payload);
    }

    async updateAddressService(facilityId: string, doctorId: string, addressId: string, serviceId: string, payload: any): Promise<any> {
        return this.request('PATCH', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/services/${serviceId}`, payload);
    }

    async deleteAddressService(facilityId: string, doctorId: string, addressId: string, serviceId: string): Promise<any> {
        return this.request('DELETE', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/services/${serviceId}`);
    }

    async enableCalendar(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        this.logger.log(`enableCalendar: POST .../addresses/${addressId}/calendar/enable`);
        const result = await this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/calendar/enable`);
        this.logger.log(`enableCalendar: response=${JSON.stringify(result)}`);
        return result;
    }

    async disableCalendar(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        this.logger.log(`disableCalendar: POST .../addresses/${addressId}/calendar/disable`);
        const result = await this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/calendar/disable`);
        this.logger.log(`disableCalendar: response=${JSON.stringify(result)}`);
        return result;
    }

    async getCalendar(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/calendar`);
    }

    async getCalendarBreaks(facilityId: string, doctorId: string, addressId: string, since?: string, till?: string): Promise<any> {
        let path = `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/breaks`;
        const params: string[] = [];
        if (since) params.push(`since=${encodeURIComponent(since)}`);
        if (till) params.push(`till=${encodeURIComponent(till)}`);
        if (params.length) path += `?${params.join('&')}`;
        return this.request('GET', path);
    }

    async addCalendarBreak(facilityId: string, doctorId: string, addressId: string, payload: { since: string; till: string }): Promise<any> {
        return this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/breaks`, payload);
    }

    async getCalendarBreak(facilityId: string, doctorId: string, addressId: string, breakId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/breaks/${breakId}`);
    }

    async moveCalendarBreak(facilityId: string, doctorId: string, addressId: string, breakId: string, payload: { since: string; till: string }): Promise<any> {
        return this.request('PATCH', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/breaks/${breakId}`, payload);
    }

    async deleteCalendarBreak(facilityId: string, doctorId: string, addressId: string, breakId: string): Promise<any> {
        return this.request('DELETE', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/breaks/${breakId}`);
    }

    async cancelBooking(facilityId: string, doctorId: string, addressId: string, bookingId: string, reason?: string): Promise<any> {
        this.logger.log(`cancelBooking: DELETE booking ${bookingId} for doctor ${doctorId}`);
        const body = reason ? { reason } : undefined;
        return this.request('DELETE', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/bookings/${bookingId}`, body);
    }

    async moveBooking(facilityId: string, doctorId: string, addressId: string, bookingId: string, payload: {
        address_service_id: number;
        duration: number;
        start: string;
        address_id?: number;
    }): Promise<any> {
        this.logger.log(`moveBooking: POST move booking ${bookingId} to ${payload.start}`);
        return this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/bookings/${bookingId}/move`, payload);
    }

    async getNotifications(limit: number = 100): Promise<any> {
        return this.request('GET', `/api/v3/integration/notifications/multiple?limit=${limit}`);
    }

    async releaseFailedNotifications(): Promise<any> {
        this.logger.log('releaseFailedNotifications: triggering re-queue of failed notifications');
        return this.request('POST', '/api/v3/integration/notifications/release');
    }
}

@Injectable()
export class DocplannerService {
    constructor(
        private configService: ConfigService,
        private prisma: PrismaService,
    ) { }

    createClient(domain: string, clientId: string, clientSecret: string): DocplannerClient {
        const client = new DocplannerClient(this.configService);
        client.setBaseUrl(domain);
        // Persistência do token no banco (sobrevive a restarts; token Doctoralia vale ~24h).
        client.setPersistence(
            async () => {
                const conn = await this.prisma.integrationConnection.findFirst({
                    where: { provider: 'doctoralia', clientId },
                    select: { cachedToken: true, tokenExpiresAt: true },
                });
                if (!conn?.cachedToken || !conn.tokenExpiresAt) return null;
                return { token: conn.cachedToken, expiresAt: conn.tokenExpiresAt.getTime() };
            },
            async (t) => {
                await this.prisma.integrationConnection.updateMany({
                    where: { provider: 'doctoralia', clientId },
                    data: { cachedToken: t.token, tokenExpiresAt: new Date(t.expiresAt) },
                });
            },
        );
        // We start authentication but don't await here to match existing sync usage pattern.
        // In a real scenario, the first call to the client would await this or authenticate would be called explicitly.
        client.authenticate(clientId, clientSecret).catch(err => {
            console.error('Docplanner background authentication failed:', err.message);
        });
        return client;
    }
}
