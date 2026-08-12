'use strict';
/**
 * Stub VisMed — servidor HTTPS local (loopback APENAS) com o mesmo cert de teste.
 * Obs.: o plano dizia "http é aceitável", mas o cliente VisMed do projeto usa o
 * módulo `https` do Node incondicionalmente em GETs, então o stub roda em HTTPS
 * com o cert de teste confiado via NODE_EXTRA_CA_CERTS (mesma abordagem segura).
 *
 * Stateful: agendamentos criados via schedule/pacient passam a aparecer em
 * get-agendamento-filtros (a verificação pós-criação do orquestrador exige isso)
 * e delete-agendamento os remove.
 */
const https = require('node:https');
const { CallLog } = require('./call-log');

function pad(n) { return String(n).padStart(2, '0'); }

class MockVismed {
    constructor({ dataset, tls, port }) {
        this.dataset = dataset;
        this.tls = tls;
        this.port = port;
        this.log = new CallLog('vismed');
        this.byEmpresa = new Map();
        for (const c of dataset.clinics) this.byEmpresa.set(String(c.empresaId), c);
        this.byUnit = new Map();
        for (const c of dataset.clinics) this.byUnit.set(String(c.unit.vismedId), c);
        // Agendamentos dinâmicos por unidade (criados pelo fluxo Doctoralia→VisMed)
        this.dynamicAppointments = new Map(); // unitId → array
        this.createdSeq = 500000;
    }

    async start() {
        this.server = https.createServer({ key: this.tls.key, cert: this.tls.cert }, (req, res) => {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                try { this.handle(req, res, body); }
                catch (err) {
                    this.log.record({ method: req.method, path: req.url, body, matched: false, status: 500 });
                    res.writeHead(500, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: String(err.message) }));
                }
            });
        });
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.port, '127.0.0.1', resolve); // loopback only
        });
    }

    async stop() {
        if (this.server) await new Promise(r => this.server.close(r));
    }

    reply(res, status, payload, meta) {
        this.log.record({ ...meta, status });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
    }

    handle(req, res, body) {
        const method = req.method;
        const url = new URL(req.url, 'https://mock');
        const p = url.pathname.replace(/\/+$/, '');
        const q = url.searchParams;
        const meta = { method, path: req.url, body, authHeader: req.headers.authorization };
        const send = (status, payload, matched = true) => this.reply(res, status, payload, { ...meta, matched });
        const clinicByEmpresa = () => this.byEmpresa.get(String(q.get('idempresagestora') ?? ''));

        if (p.endsWith('/unidade-by-idempresagestora')) {
            const c = clinicByEmpresa();
            return send(200, c ? [{
                idunidade: c.unit.vismedId, codunidade: c.unit.codUnidade,
                nomeunidade: c.unit.name, cnpj: c.unit.cnpj, nomecidade: c.unit.cityName,
            }] : []);
        }
        if (p.endsWith('/especialidades-by-idempresagestora')) {
            const c = clinicByEmpresa();
            return send(200, c ? c.specialties.map(s => ({ idcategoriaservico: s.vismedId, nomecategoriaservico: s.name })) : []);
        }
        if (p.endsWith('/profissionais-by-idempresagestora')) {
            const c = clinicByEmpresa();
            return send(200, c ? c.doctors.map(d => ({
                idprofissional: d.vismedId,
                nomecompleto: d.name,
                nomeformal: d.formalName,
                cpf: d.cpf,
                numerodocumento: d.crm,
                siglaprofissionaltipodocumento: 'CRM',
                sexo: d.gender,
                ativo: '1',
                idunidadevinculada: c.unit.vismedId,
                turno_m: d.turnoM, turno_t: d.turnoT, turno_n: null,
                especialidades: d.specialtyName,
            })) : []);
        }
        if (p.endsWith('/convenio-by-idempresagestora')) {
            const c = clinicByEmpresa();
            return send(200, c ? c.insurances.map(i => ({
                idconvenio: i.vismedId, nomeconvenio: i.name, ativo: '1',
                idconveniotipo: 1, razaosocialconveniado: i.name, cnpjconveniado: null,
                datainicio: null, datafinal: null, agendamentoonline: '1',
            })) : []);
        }
        if (p.endsWith('/schedule/online/medicalspecialties')) {
            const c = clinicByEmpresa();
            return send(200, c ? c.specialties.map(s => ({ idcategoriaservico: s.vismedId, nomecategoriaservico: s.name })) : []);
        }
        if (p.endsWith('/schedule/online/scheduleDay')) {
            const c = clinicByEmpresa();
            const cat = Number(q.get('idcategoriaservico'));
            if (!c) return send(200, []);
            // Slots determinísticos: mesmos horários em toda chamada → hash estável
            // (2ª janela deve cair no skip incremental do slot push).
            const out = c.doctors
                .filter(d => !cat || d.specialtyVismedId === cat)
                .map(d => ({
                    idprofissional: d.vismedId,
                    horarios: d.slotTimes.map(t => {
                        const [hh, mm] = t.split(':').map(Number);
                        const fim = mm === 30 ? `${pad(hh + 1)}:00` : `${pad(hh)}:30`;
                        return { inicio: t, fim };
                    }),
                }));
            return send(200, out);
        }
        if (p.endsWith('/schedule/online/schedule')) {
            return send(200, []); // datas disponíveis — scheduleDay é a fonte de verdade
        }
        if (p.endsWith('/bloqueios-profissional-by-idempresagestora')) {
            return send(200, []);
        }
        if (p.endsWith('/get-agendamento-filtros')) {
            const unidade = String(q.get('unidade') ?? '');
            const c = this.byUnit.get(unidade);
            if (!c) return send(200, []);
            const dyn = this.dynamicAppointments.get(unidade) ?? [];
            const prof = q.get('profissional');
            let all = [...c.vismedAppointments, ...dyn];
            if (prof) all = all.filter(a => String(a.idprofissional) === String(prof));
            return send(200, all);
        }
        if (p.endsWith('/schedule/online/schedule/pacient') && method === 'POST') {
            const parsed = safeJson(body);
            const id = ++this.createdSeq;
            const appt = this.buildAppointmentFromPayload(parsed, id);
            const unitKey = String(appt._unitId ?? '');
            const arr = this.dynamicAppointments.get(unitKey) ?? [];
            arr.push(appt.record);
            this.dynamicAppointments.set(unitKey, arr);
            return send(200, { idpacienteagendamento: id, success: true });
        }
        if (p.endsWith('/delete-agendamento') && method === 'POST') {
            const id = extractIdFromMultipart(body) ?? safeJson(body).idpacienteagendamento;
            for (const [k, arr] of this.dynamicAppointments) {
                this.dynamicAppointments.set(k, arr.filter(a => String(a.idpacienteagendamento) !== String(id)));
            }
            for (const c of this.dataset.clinics) {
                c.vismedAppointments = c.vismedAppointments.filter(a => String(a.idpacienteagendamento) !== String(id));
            }
            return send(200, { success: true });
        }

        return send(200, [], false);
    }

    /** Constrói um registro de agenda a partir do payload de criação (defensivo). */
    buildAppointmentFromPayload(parsed, id) {
        const profRaw = parsed.idprofissional ?? parsed.profissional
            ?? String(parsed.horarios_profissional ?? '').match(/^(\d+)/)?.[1];
        const idprofissional = Number(profRaw) || 0;
        // Localiza a clínica dona do profissional p/ obter a unidade
        let unitId = null;
        for (const c of this.dataset.clinics) {
            if (c.doctors.some(d => d.vismedId === idprofissional)) { unitId = c.unit.vismedId; break; }
        }
        if (unitId === null) unitId = this.dataset.clinics[0]?.unit.vismedId;

        let data = String(parsed.data_agendamento ?? parsed.dataagendamento ?? '');
        const dm = data.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (dm) data = `${dm[3]}-${dm[2]}-${dm[1]}`;
        const hora = String(parsed.horarios_profissional ?? parsed.horarioagendamento ?? '').match(/(\d{2}:\d{2})/)?.[1] ?? '08:00';
        const [hh, mm] = hora.split(':').map(Number);
        const fim = mm === 30 ? `${pad(hh + 1)}:00` : `${pad(hh)}:30`;

        return {
            _unitId: unitId,
            record: {
                idpacienteagendamento: id,
                dataagendamento: data || null,
                horarioagendamento: hora,
                horarioagendamentofinal: fim,
                idprofissional,
                nomepaciente: parsed.nome ?? parsed.nomepaciente ?? 'Paciente Dinâmico',
                telefonepaciente: parsed.telefone ?? parsed.celular ?? null,
                cancelado: '0', naocompareceu: '0', confirmado: '0',
                agendamentoonline: '1',
                idpaciente: id,
            },
        };
    }
}

function safeJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }
function extractIdFromMultipart(body) {
    const m = String(body ?? '').match(/name="?idpacienteagendamento"?\s*\r?\n\r?\n(\d+)/i);
    return m ? m[1] : null;
}

module.exports = { MockVismed };
