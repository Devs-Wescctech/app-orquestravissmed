import { Injectable, Logger } from '@nestjs/common';
import * as https from 'https';

@Injectable()
export class VismedService {
    private readonly logger = new Logger(VismedService.name);
    private readonly defaultBaseUrl = 'https://app.vissmed.com.br/api-vissmed-7';

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

    private requestData(path: string, baseUrl?: string): Promise<any> {
        return new Promise((resolve, reject) => {
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
        });
    }

    private postData(path: string, body: Record<string, any>, baseUrl?: string): Promise<any> {
        return new Promise((resolve, reject) => {
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
    }, baseUrl?: string): Promise<any> {
        try {
            this.logger.log(`Criando agendamento VisMed para ${payload.nome} em ${payload.data_agendamento} às ${payload.horarios_profissional}`);
            return await this.postData('schedule/online/schedule/pacient', payload, baseUrl);
        } catch (error) {
            this.logger.error(`Erro ao criar agendamento VisMed: ${error.message}`);
            throw error;
        }
    }
}
