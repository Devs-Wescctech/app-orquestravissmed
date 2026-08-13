'use strict';
/**
 * Mock Doctoralia — servidor HTTPS local (loopback APENAS) com certificado de teste.
 * Cobre OAuth, notifications, bookings, facilities/doctors/addresses/services,
 * insurance, slots (GET/PUT), breaks e calendar. Respostas derivadas do dataset.
 * Cada chamada é registrada (CallLog) p/ auditoria de budget e duplicatas.
 */
const https = require('node:https');
const { CallLog } = require('./call-log');
const { WAF_BODY } = require('./fault-injector');

function items(arr) { return { _items: arr }; }

class MockDoctoralia {
    constructor({ dataset, tls, port, faultInjector = null }) {
        this.dataset = dataset;
        this.tls = tls;
        this.port = port;
        this.faults = faultInjector; // WP-13: plano de falhas opcional (avaliado antes dos handlers)
        this.log = new CallLog('doctoralia');
        this.oauthCount = 0;
        // Índices por facility
        this.byFacility = new Map();
        for (const clinic of dataset.clinics) this.byFacility.set(clinic.facilityId, clinic);
        // Bookings criados dinamicamente via POST (fluxo VisMed→Doctoralia)
        this.dynamicBookings = new Map(); // key: f|d|a → array
        this.breaks = new Map(); // key: f|d|a → array de breaks criados
        this.breakSeq = 1;
    }

    async start() {
        this.server = https.createServer({ key: this.tls.key, cert: this.tls.cert }, (req, res) => {
            const arrivedAt = Date.now(); // WP-12C: timestamp de CHEGADA da requisição
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                try { this.handle(req, res, body, arrivedAt); }
                catch (err) {
                    this.log.record({ method: req.method, path: req.url, body, matched: false, status: 500, arrivedAt, correlationId: req.headers['x-loadtest-correlation-id'] });
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
        if (this.faults) this.faults.stop(); // destrói sockets pendurados do timeout
        if (this.server) await new Promise(r => this.server.close(r));
    }

    reply(res, status, payload, meta, headers = {}) {
        this.log.record({ ...meta, status });
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(payload === null ? '' : JSON.stringify(payload));
    }

    handle(req, res, body, arrivedAt) {
        const method = req.method;
        const url = new URL(req.url, 'https://mock');
        const p = url.pathname;
        const meta = {
            method, path: req.url, body, authHeader: req.headers.authorization,
            arrivedAt, correlationId: req.headers['x-loadtest-correlation-id'],
        };
        const send = (status, payload, matched = true) => this.reply(res, status, payload, { ...meta, matched });

        // ── WP-13: fault injection (avaliado ANTES dos handlers) ────────────
        let oauthExpiresIn = 3600;
        if (this.faults) {
            const rule = this.faults.evaluate(method, p, arrivedAt);
            if (rule) {
                meta.faultTag = rule.tag;
                switch (rule.action) {
                    case 'http429':
                        return this.reply(res, 429, { error: 'rate limited (injected)' }, { ...meta, matched: true },
                            rule.params.retryAfterSec != null ? { 'retry-after': String(rule.params.retryAfterSec) } : {});
                    case 'http503':
                        return this.reply(res, 503, { error: 'service unavailable (injected)' }, { ...meta, matched: true });
                    case 'waf': {
                        // Contrato EXATO do classificador produtivo: 405 + body WAF.
                        this.log.record({ ...meta, matched: true, status: 405 });
                        res.writeHead(405, { 'content-type': 'text/html' });
                        return res.end(WAF_BODY);
                    }
                    case 'timeout':
                        // Nunca responde: cliente aborta em 30s; socket é rastreado
                        // e destruído no stop() se ainda estiver pendurado.
                        this.log.record({ ...meta, matched: true, status: 0 });
                        return this.faults.holdSocket(res);
                    case 'reset':
                        this.log.record({ ...meta, matched: true, status: 0 });
                        return res.socket.destroy();
                    case 'delay': {
                        const ms = rule.params.delayMs ?? 1000;
                        setTimeout(() => {
                            try { this.route(req, res, body, meta, p, method, oauthExpiresIn); }
                            catch (err) {
                                this.reply(res, 500, { error: String(err.message) }, { ...meta, matched: false });
                            }
                        }, ms);
                        return;
                    }
                    case 'shortToken':
                        oauthExpiresIn = rule.params.expiresInSec ?? 180;
                        break; // segue para o handler normal do OAuth
                }
            }
        }
        return this.route(req, res, body, meta, p, method, oauthExpiresIn);
    }

    route(req, res, body, meta, p, method, oauthExpiresIn = 3600) {
        const send = (status, payload, matched = true) => this.reply(res, status, payload, { ...meta, matched });

        // ── OAuth ────────────────────────────────────────────────────────────
        if (p === '/oauth/v2/token' && method === 'POST') {
            this.oauthCount++;
            return send(200, { access_token: `lt-token-${this.oauthCount}`, expires_in: oauthExpiresIn, token_type: 'bearer' });
        }

        const api = p.startsWith('/api/v3/integration/') ? p.slice('/api/v3/integration/'.length) : null;
        if (api === null) return send(404, { error: 'not integration api' }, false);
        const seg = api.split('/').filter(Boolean);

        // ── Notifications ────────────────────────────────────────────────────
        if (seg[0] === 'notifications') {
            if (seg[1] === 'multiple' && method === 'GET') return send(200, items([]));
            if (seg[1] === 'release' && method === 'POST') return send(200, { ok: true });
        }

        // ── Dicionários globais ──────────────────────────────────────────────
        if (api === 'services' && method === 'GET') {
            const all = [];
            for (const c of this.dataset.clinics)
                for (const d of c.doctors)
                    for (const a of d.addresses)
                        for (const s of a.services)
                            if (!all.some(x => x.id === s.service_id)) all.push({ id: s.service_id, name: s.name });
            return send(200, items(all));
        }
        if (api === 'insurance-providers' && method === 'GET') return send(200, items([]));
        if (seg[0] === 'insurance-providers' && seg[2] === 'plans' && method === 'GET') return send(200, items([]));

        // ── Facilities ───────────────────────────────────────────────────────
        if (seg[0] === 'facilities') {
            if (seg.length === 1 && method === 'GET') {
                return send(200, items(this.dataset.clinics.map(c => ({ id: c.facilityId, name: c.name }))));
            }
            const clinic = this.byFacility.get(seg[1]);
            if (!clinic) return send(404, { error: `facility ${seg[1]} desconhecida` }, false);

            if (seg[2] === 'insurances' && method === 'GET') return send(200, items([]));
            if (seg[2] === 'services' && seg[3] === 'catalog' && method === 'GET') {
                const all = [];
                for (const d of clinic.doctors)
                    for (const a of d.addresses)
                        for (const s of a.services)
                            if (!all.some(x => x.id === s.service_id)) all.push({ id: s.service_id, name: s.name });
                return send(200, items(all));
            }
            if (seg[2] === 'doctors') {
                if (seg.length === 3 && method === 'GET') {
                    return send(200, items(clinic.doctors.map(d => ({
                        id: d.doctoraliaDoctorId,
                        name: d.name.split(' ')[0],
                        surname: d.name.split(' ').slice(1).join(' '),
                        title: 'Dr.',
                    }))));
                }
                const doctor = clinic.doctors.find(d => d.doctoraliaDoctorId === seg[3]);
                if (!doctor) return send(404, { error: `doctor ${seg[3]} desconhecido` }, false);

                if (seg[4] === 'addresses') {
                    if (seg.length === 5 && method === 'GET') {
                        // Stateful: PATCHes anteriores refletem no GET (como na API real),
                        // senão o push re-convergiria (e re-escreveria) a cada ciclo.
                        return send(200, items(doctor.addresses.map(a => ({ id: a.id, name: a.name, ...(a.patched ?? {}) }))));
                    }
                    const address = doctor.addresses.find(a => a.id === seg[5]);
                    if (!address) return send(404, { error: `address ${seg[5]} desconhecido` }, false);
                    if (seg.length === 6 && method === 'PATCH') {
                        address.patched = { ...(address.patched ?? {}), ...safeJson(body) };
                        return send(200, { ok: true });
                    }
                    const sub = seg[6];

                    if (sub === 'services') {
                        if (method === 'GET') return send(200, items(address.services));
                        if (method === 'POST') {
                            const parsed = safeJson(body);
                            const created = {
                                id: `LT-ADDRSVC-NEW-${this.breakSeq++}`,
                                service_id: parsed.service_id ?? null,
                                name: parsed.name ?? 'Serviço novo',
                                default_duration: parsed.default_duration ?? 30,
                                price: parsed.price ?? 0,
                                is_price_from: parsed.is_price_from ?? false,
                            };
                            address.services.push(created); // stateful
                            return send(201, { ...created, _status: 201 });
                        }
                        if (method === 'DELETE') {
                            address.services = address.services.filter(s => s.id !== seg[7]); // stateful
                            return send(204, null);
                        }
                    }
                    if (sub === 'insurance-providers') {
                        if (method === 'GET') return send(200, items([]));
                        return send(method === 'POST' ? 201 : 200, { ok: true });
                    }
                    if (sub === 'slots') {
                        if (method === 'GET') return send(200, items([]));
                        if (method === 'PUT') return send(200, { ok: true });
                    }
                    if (sub === 'calendar') return send(200, { ok: true });
                    if (sub === 'breaks') {
                        const key = `${seg[1]}|${seg[3]}|${seg[5]}`;
                        if (method === 'GET') return send(200, items(this.breaks.get(key) ?? []));
                        if (method === 'POST') {
                            const br = { id: `LT-BREAK-${this.breakSeq++}`, ...safeJson(body) };
                            const arr = this.breaks.get(key) ?? [];
                            arr.push(br);
                            this.breaks.set(key, arr);
                            return send(201, { ...br, _status: 201 });
                        }
                        if (method === 'DELETE') {
                            const arr = (this.breaks.get(key) ?? []).filter(b => !p.endsWith(`/${b.id}`));
                            this.breaks.set(key, arr);
                            return send(204, null);
                        }
                    }
                    if (sub === 'bookings') {
                        const key = `${seg[1]}|${seg[3]}|${seg[5]}`;
                        const dyn = this.dynamicBookings.get(key) ?? [];
                        if (seg.length === 7 && method === 'GET') {
                            return send(200, items([...doctor.doctoraliaBookings, ...dyn]));
                        }
                        if (seg.length === 8 && method === 'GET') {
                            const bk = [...doctor.doctoraliaBookings, ...dyn].find(b => b.id === seg[7]);
                            if (!bk) return send(404, { error: 'booking não encontrado' }, false);
                            return send(200, { visit_booking: bk });
                        }
                        if (seg.length === 7 && method === 'POST') {
                            const parsed = safeJson(body);
                            const bk = {
                                id: `LT-DYNBOOK-${key}-${dyn.length + 1}`,
                                start_at: parsed.start_at ?? parsed.start ?? null,
                                status: 'booked', canceled: false,
                                patient: parsed.patient ?? { name: 'Paciente', surname: 'Dinâmico' },
                            };
                            dyn.push(bk);
                            this.dynamicBookings.set(key, dyn);
                            return send(201, { visit_booking: bk, id: bk.id, _status: 201 });
                        }
                        if (method === 'DELETE' || (seg.length >= 8 && method === 'POST')) return send(200, { ok: true });
                    }
                }
            }
        }

        // Fallback: registra como não-mapeado, responde vazio p/ não travar o fluxo.
        return send(200, items([]), false);
    }
}

function safeJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

module.exports = { MockDoctoralia };
