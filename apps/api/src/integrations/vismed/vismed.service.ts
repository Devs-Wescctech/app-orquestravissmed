import { Injectable, Logger } from '@nestjs/common';
import * as https from 'https';
import * as http from 'http';

/**
 * Erro tipado para timeout de chamadas HTTP à VisMed.
 * Distinguível de erros HTTP (>=400) e de erros de rede pelo `code`.
 */
export class VismedTimeoutError extends Error {
    readonly code = 'VISMED_TIMEOUT';
    constructor(url: string, timeoutMs: number) {
        super(`VisMed HTTP timeout após ${timeoutMs}ms: ${url}`);
        this.name = 'VismedTimeoutError';
    }
}

export class VismedRequestAbortedError extends Error {
    readonly code = 'VISMED_REQUEST_ABORTED';
    constructor() {
        super('VisMed HTTP request aborted because the booking claim session was lost');
        this.name = 'VismedRequestAbortedError';
    }
}

// Timeouts padrão (sempre muito menores que o lease de 5min da fila).
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_WRITE_TIMEOUT_MS = 60_000;

function parseTimeoutEnv(raw: string | undefined, fallback: number): number {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

@Injectable()
export class VismedService {
    private readonly logger = new Logger(VismedService.name);
    private readonly defaultBaseUrl = 'https://app.vissmed.com.br/api-vissmed-7';
    private readonly readTimeoutMs = parseTimeoutEnv(process.env.VISMED_READ_TIMEOUT_MS, DEFAULT_READ_TIMEOUT_MS);
    private readonly writeTimeoutMs = parseTimeoutEnv(process.env.VISMED_WRITE_TIMEOUT_MS, DEFAULT_WRITE_TIMEOUT_MS);

    /**
     * Aplica dois limites à request:
     * 1. Deadline TOTAL: timer iniciado na criação da request que destrói a
     *    request com VismedTimeoutError ao estourar — cobre respostas
     *    "gota a gota" que mantêm o socket ativo sem nunca terminar. O timer
     *    é limpo no evento `close` (emitido em qualquer conclusão: sucesso,
     *    erro ou destroy).
     * 2. Timeout de inatividade de socket (`setTimeout`): proteção adicional;
     *    o evento `timeout` sozinho NÃO encerra a request, por isso o handler
     *    executa `req.destroy(...)`, garantindo que a Promise rejeite via o
     *    `req.on('error')` já existente.
     */
    private applyTimeout(req: http.ClientRequest, url: string, timeoutMs: number): void {
        const deadline = setTimeout(() => {
            req.destroy(new VismedTimeoutError(url, timeoutMs));
        }, timeoutMs);
        // não segurar o event loop vivo por causa do timer
        if (typeof (deadline as any)?.unref === 'function') (deadline as any).unref();
        req.on('close', () => clearTimeout(deadline));
        req.setTimeout(timeoutMs, () => {
            req.destroy(new VismedTimeoutError(url, timeoutMs));
        });
    }

    private normalizeBaseUrl(raw: string): string {
        let url = raw.trim().replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(url)) {
            url = `https://${url}`;
        }
        url = url.replace(/\/api\/v1\.0\/?$/i, '').replace(/\/+$/, '');
        return url;
    }

    private buildApiUrl(path: string, baseUrl?: string): string {
        const raw = baseUrl || this.defaultBaseUrl;
        const base = this.normalizeBaseUrl(raw);
        return `${base}/api/v1.0/${path}`;
    }

    private bindAbortSignal(req: http.ClientRequest, signal?: AbortSignal): void {
        if (!signal) return;
        const abort = () => req.destroy(new VismedRequestAbortedError());
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener('abort', abort, { once: true });
        req.once('close', () => signal.removeEventListener('abort', abort));
    }

    private requestData(path: string, baseUrl?: string, signal?: AbortSignal): Promise<any> {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(new VismedRequestAbortedError());
            const url = this.buildApiUrl(path, baseUrl);
            this.logger.log(`[VISMED-API] GET ${url}`);

            const req = https.get(url, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                    try {
                        const json = JSON.parse(data);
                        resolve(json || []);
                    } catch (e) {
                        reject(new Error(`Failed to parse JSON response: ${e.message}`));
                    }
                });
            });

            req.on('error', (e) => {
                reject(e);
            });
            this.bindAbortSignal(req, signal);
            this.applyTimeout(req, url, this.readTimeoutMs);
        });
    }

    private postFormData(path: string, fields: Record<string, string | number>, baseUrl?: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const url = this.buildApiUrl(path, baseUrl);
            const boundary = `----vismed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const parts: string[] = [];
            for (const [k, v] of Object.entries(fields)) {
                parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v)}\r\n`);
            }
            parts.push(`--${boundary}--\r\n`);
            const body = Buffer.from(parts.join(''), 'utf8');

            this.logger.log(`[VISMED-API] POST (multipart) ${url} fields=${Object.keys(fields).join(',')}`);

            const parsed = new URL(url);
            const options: https.RequestOptions = {
                hostname: parsed.hostname,
                port: parsed.port || 443,
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': body.length,
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        resolve({ raw: data, statusCode: res.statusCode });
                    }
                });
            });

            req.on('error', (e) => { reject(e); });
            this.applyTimeout(req, url, this.writeTimeoutMs);
            req.write(body);
            req.end();
        });
    }

    private postData(path: string, body: Record<string, any>, baseUrl?: string, signal?: AbortSignal): Promise<any> {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(new VismedRequestAbortedError());
            const url = this.buildApiUrl(path, baseUrl);
            const postBody = JSON.stringify(body);
            this.logger.log(`[VISMED-API] POST ${url}`);

            const parsed = new URL(url);
            const options: https.RequestOptions = {
                hostname: parsed.hostname,
                port: parsed.port || 443,
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postBody),
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        resolve({ raw: data, statusCode: res.statusCode });
                    }
                });
            });

            req.on('error', (e) => { reject(e); });
            this.bindAbortSignal(req, signal);
            this.applyTimeout(req, url, this.writeTimeoutMs);
            req.write(postBody);
            req.end();
        });
    }

    async getUnidades(idEmpresaGestora: number, baseUrl?: string): Promise<any[]> {
        try {
            this.logger.log(`Buscando unidades para empresa gestora: ${idEmpresaGestora} na Base URL: ${baseUrl || 'padrão'}`);
            return await this.requestData(`unidade-by-idempresagestora?idempresagestora=${idEmpresaGestora}`, baseUrl);
        } catch (error) {
            this.logger.error(`Erro ao buscar unidades VisMed: ${error.message}`);
            throw error;
        }
    }

    async getProfissionais(idEmpresaGestora: number, baseUrl?: string): Promise<any[]> {
        try {
            this.logger.log(`Buscando profissionais para empresa gestora: ${idEmpresaGestora} na Base URL: ${baseUrl || 'padrão'}`);
            return await this.requestData(`profissionais-by-idempresagestora?idempresagestora=${idEmpresaGestora}`, baseUrl);
        } catch (error) {
            this.logger.error(`Erro ao buscar profissionais VisMed: ${error.message}`);
            throw error;
        }
    }

    async getEspecialidades(idEmpresaGestora: number, baseUrl?: string): Promise<any[]> {
        try {
            this.logger.log(`Buscando especialidades para empresa gestora: ${idEmpresaGestora} na Base URL: ${baseUrl || 'padrão'}`);
            return await this.requestData(`especialidades-by-idempresagestora?idempresagestora=${idEmpresaGestora}`, baseUrl);
        } catch (error) {
            this.logger.error(`Erro ao buscar especialidades VisMed: ${error.message}`);
            throw error;
        }
    }

    async getConvenios(idEmpresaGestora: number, baseUrl?: string): Promise<any[]> {
        try {
            this.logger.log(`Buscando convênios para empresa gestora: ${idEmpresaGestora} na Base URL: ${baseUrl || 'padrão'}`);
            return await this.requestData(`convenio-by-idempresagestora?idempresagestora=${idEmpresaGestora}`, baseUrl);
        } catch (error) {
            this.logger.error(`Erro ao buscar convênios VisMed: ${error.message}`);
            throw error;
        }
    }

    async getScheduleSpecialties(idEmpresaGestora: number, baseUrl?: string): Promise<any[]> {
        try {
            this.logger.log(`Buscando especialidades de agendamento para empresa: ${idEmpresaGestora}`);
            return await this.requestData(`schedule/online/medicalspecialties?idempresagestora=${idEmpresaGestora}`, baseUrl);
        } catch (error) {
            this.logger.error(`Erro ao buscar especialidades de agendamento VisMed: ${error.message}`);
            throw error;
        }
    }

    async getScheduleDates(idEmpresaGestora: number, idCategoriaServico: number, date: string, baseUrl?: string): Promise<any> {
        try {
            this.logger.log(`Buscando datas disponíveis para especialidade ${idCategoriaServico} em ${date}`);
            return await this.requestData(
                `schedule/online/schedule?idempresagestora=${idEmpresaGestora}&idcategoriaservico=${idCategoriaServico}&date=${date}`,
                baseUrl
            );
        } catch (error) {
            this.logger.error(`Erro ao buscar datas disponíveis VisMed: ${error.message}`);
            throw error;
        }
    }

    async getScheduleDay(idEmpresaGestora: number, idCategoriaServico: number, dataAgendamento: string, baseUrl?: string): Promise<any> {
        try {
            this.logger.log(`Buscando horários disponíveis para especialidade ${idCategoriaServico} em ${dataAgendamento}`);
            return await this.requestData(
                `schedule/online/scheduleDay?idempresagestora=${idEmpresaGestora}&idcategoriaservico=${idCategoriaServico}&dataagendamento=${dataAgendamento}`,
                baseUrl
            );
        } catch (error) {
            this.logger.error(`Erro ao buscar horários disponíveis VisMed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Lista os bloqueios de agenda dos profissionais de uma empresa gestora.
     * Cada item: { idprofissional, dataagendamento:"YYYY-MM-DD", horarioagendamento:"HH:MM", horarioagendamentofinal:"HH:MM" }.
     * ATENÇÃO: o campo `horarioagendamentofinal` vem com serialização instável/malformada (ex.: "011:0"),
     * por isso NÃO deve ser usado para parse exato de horário — só como sinal de mudança (diff/hash).
     * A disponibilidade real é recalculada via scheduleDay.
     */
    async getBloqueiosProfissional(idEmpresaGestora: number, baseUrl?: string): Promise<any[]> {
        try {
            this.logger.log(`Buscando bloqueios de profissionais para empresa gestora: ${idEmpresaGestora}`);
            const res = await this.requestData(
                `bloqueios-profissional-by-idempresagestora?idempresagestora=${idEmpresaGestora}`,
                baseUrl
            );
            return Array.isArray(res) ? res : [];
        } catch (error) {
            this.logger.error(`Erro ao buscar bloqueios de profissionais VisMed: ${error.message}`);
            throw error;
        }
    }

    async getAgendamentos(
        unidade: number,
        baseUrl?: string,
        options?: { dataini?: string; datafim?: string; profissional?: number; signal?: AbortSignal },
    ): Promise<any[]> {
        try {
            let path = `get-agendamento-filtros?unidade=${unidade}`;
            if (options?.dataini) path += `&dataini=${encodeURIComponent(options.dataini)}`;
            if (options?.datafim) path += `&datafim=${encodeURIComponent(options.datafim)}`;
            if (options?.profissional) path += `&profissional=${options.profissional}`;
            this.logger.log(`Buscando agendamentos VisMed: unidade=${unidade}`);

            const actualBase = baseUrl || 'https://app.vissmed.com.br/api-vissmed-4';
            return await this.requestData(path, actualBase, options?.signal);
        } catch (error) {
            this.logger.error(`Erro ao buscar agendamentos VisMed: ${error.message}`);
            throw error;
        }
    }

    async cancelarAgendamento(idPacienteAgendamento: number | string, baseUrl?: string): Promise<any> {
        try {
            const id = String(idPacienteAgendamento).trim();
            if (!id) throw new Error('idPacienteAgendamento vazio');
            this.logger.log(`Cancelando agendamento VisMed id=${id}`);
            const actualBase = baseUrl || 'https://app.vissmed.com.br/api-vissmed-4';
            return await this.postFormData('delete-agendamento', { id }, actualBase);
        } catch (error) {
            this.logger.error(`Erro ao cancelar agendamento VisMed id=${idPacienteAgendamento}: ${error.message}`);
            throw error;
        }
    }

    /** URL completa usada na criação de agendamento (para auditoria persistida). */
    getCreateAppointmentUrl(baseUrl?: string): string {
        return this.buildApiUrl('schedule/online/schedule/pacient', baseUrl);
    }

    async createAppointment(payload: {
        tipo: string;
        idcategoriaservico: number;
        horarios_profissional: string;
        idempresagestora: number;
        data_agendamento: string;
        nome: string;
        telefone: string;
        cpf?: string;
        data_nascimento?: string;
        sexo?: number;
    }, baseUrl?: string, signal?: AbortSignal): Promise<any> {
        try {
            this.logger.log(`Criando agendamento VisMed para ${payload.nome} em ${payload.data_agendamento} às ${payload.horarios_profissional}`);
            return await this.postData('schedule/online/schedule/pacient', payload, baseUrl, signal);
        } catch (error) {
            this.logger.error(`Erro ao criar agendamento VisMed: ${error.message}`);
            throw error;
        }
    }
}
