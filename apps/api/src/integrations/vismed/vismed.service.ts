import { Injectable, Logger } from '@nestjs/common';
import * as https from 'https';

@Injectable()
export class VismedService {
    private readonly logger = new Logger(VismedService.name);
    private readonly defaultBaseUrl = 'https://app.vissmed.com.br/api-vissmed-4/api/v1.0';

    private requestData(path: string, baseUrl?: string): Promise<any[]> {
        return new Promise((resolve, reject) => {
            let host = baseUrl || this.defaultBaseUrl;

            // Garantir que termina com a versão da API se não estiver presente
            if (!host.endsWith('/api/v1.0')) {
                host = host.replace(/\/$/, '') + '/api/v1.0';
            }

            const url = `${host}/${path}`;
            this.logger.log(`[VISMED-API] GET ${url}`);

            const req = https.get(url, { rejectUnauthorized: false }, (res) => {
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
}
