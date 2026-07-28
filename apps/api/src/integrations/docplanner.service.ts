import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

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

        const response = await fetch(url, {
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

        if (!response.ok) {
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

    private async request(method: string, path: string, data?: any, isRetry = false): Promise<any> {
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
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

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

            if (method === 'PUT' || method === 'PATCH') {
                this.logger.log(`API Response: ${method} ${path} → status=${response.status}, content-type=${response.headers.get('content-type')}`);
            }

            if (!response.ok) {
                // Token do cache pode ter sido revogado/expirado no servidor: renova UMA vez e repete.
                if (response.status === 401 && !isRetry && this.clientId) {
                    this.logger.warn(`401 em ${method} ${path} — renovando token OAuth e repetindo a chamada.`);
                    await response.text().catch(() => undefined);
                    await this.getToken(true);
                    return this.request(method, path, data, true);
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
        } finally {
            clearTimeout(timeout);
        }
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
