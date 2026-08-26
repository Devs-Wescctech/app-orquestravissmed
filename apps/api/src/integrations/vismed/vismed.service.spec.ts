import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter } from 'events';
import * as https from 'https';
import { VismedRequestAbortedError, VismedService, VismedTimeoutError } from './vismed.service';

jest.mock('https', () => ({
  get: jest.fn(),
  request: jest.fn(),
}));

/**
 * Fake de http.ClientRequest / IncomingMessage para testar as 3 primitivas
 * HTTP do VismedService (requestData / postFormData / postData) sem rede.
 */
class FakeRes extends EventEmitter {
  constructor(public statusCode: number) {
    super();
  }
}

class FakeReq extends EventEmitter {
  timeoutMs: number | null = null;
  timeoutCb: (() => void) | null = null;
  destroyed = false;
  destroyedWith: Error | undefined;
  written: any[] = [];
  ended = false;

  setTimeout(ms: number, cb: () => void) {
    this.timeoutMs = ms;
    this.timeoutCb = cb;
    return this;
  }

  destroy(err?: Error) {
    this.destroyed = true;
    this.destroyedWith = err;
    // Comportamento do Node: destroy(err) emite 'error' com err e depois 'close'.
    if (err) this.emit('error', err);
    this.emit('close');
    return this;
  }

  write(chunk: any) {
    this.written.push(chunk);
    return true;
  }

  end() {
    this.ended = true;
  }
}

function respond(req: FakeReq, cb: (res: any) => void, statusCode: number, body: string) {
  const res = new FakeRes(statusCode);
  cb(res);
  res.emit('data', body);
  res.emit('end');
  req.emit('close');
  return res;
}

describe('VismedService', () => {
  let service: VismedService;
  const getSpy = https.get as unknown as jest.Mock;
  const requestSpy = https.request as unknown as jest.Mock;

  beforeEach(async () => {
    getSpy.mockReset();
    requestSpy.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [VismedService],
    }).compile();

    service = module.get<VismedService>(VismedService);
  });

  afterEach(() => {
    delete process.env.VISMED_READ_TIMEOUT_MS;
    delete process.env.VISMED_WRITE_TIMEOUT_MS;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getAgendamentos', () => {
    it('mantém a URL destrutiva atual por default e adiciona sincronizar=0 somente no opt-in', async () => {
      const requestedUrls: string[] = [];
      getSpy.mockImplementation((url: any, cb: any) => {
        requestedUrls.push(String(url));
        const req = new FakeReq();
        setImmediate(() => respond(req, cb, 200, '[]'));
        return req as any;
      });

      const filters = {
        dataini: '20/08/2026',
        datafim: '20/08/2026',
        profissional: 123,
      };
      await service.getAgendamentos(11, 'https://vismed.test/api/v1.0', filters);
      await service.getAgendamentos(11, 'https://vismed.test/api/v1.0', {
        ...filters,
        nonDestructive: true,
      });

      expect(requestedUrls).toEqual([
        'https://vismed.test/api/v1.0/get-agendamento-filtros?unidade=11&dataini=20%2F08%2F2026&datafim=20%2F08%2F2026&profissional=123',
        'https://vismed.test/api/v1.0/get-agendamento-filtros?unidade=11&dataini=20%2F08%2F2026&datafim=20%2F08%2F2026&profissional=123&sincronizar=0',
      ]);
    });
  });

  describe('requestData (leitura)', () => {
    it('resposta normal intacta (JSON) e timeout de 30s aplicado', async () => {
      const req = new FakeReq();
      getSpy.mockImplementation((_url: any, cb: any) => {
        setImmediate(() => respond(req, cb, 200, '[{"id":1}]'));
        return req as any;
      });
      const result = await (service as any).requestData('unidade-by-idempresagestora?idempresagestora=1');
      expect(result).toEqual([{ id: 1 }]);
      expect(req.timeoutMs).toBe(30_000);
      expect(req.destroyed).toBe(false);
    });

    it('timeout rejeita com VismedTimeoutError e destrói a request', async () => {
      const req = new FakeReq();
      getSpy.mockImplementation((_url: any, _cb: any) => {
        // servidor nunca responde; dispara o evento de timeout
        setImmediate(() => req.timeoutCb!());
        return req as any;
      });
      const p = (service as any).requestData('x');
      await expect(p).rejects.toBeInstanceOf(VismedTimeoutError);
      await expect(p).rejects.toMatchObject({ code: 'VISMED_TIMEOUT' });
      await expect(p).rejects.toThrow(/30000ms/);
      expect(req.destroyed).toBe(true);
      expect(req.destroyedWith).toBeInstanceOf(VismedTimeoutError);
    });

    it('erro HTTP >= 400 rejeita como hoje (não é VismedTimeoutError)', async () => {
      const req = new FakeReq();
      getSpy.mockImplementation((_url: any, cb: any) => {
        setImmediate(() => respond(req, cb, 500, 'boom'));
        return req as any;
      });
      const p = (service as any).requestData('x');
      await expect(p).rejects.toThrow('HTTP 500: boom');
      await expect(p).rejects.not.toBeInstanceOf(VismedTimeoutError);
    });

    it('erro de conexão rejeita como hoje', async () => {
      const req = new FakeReq();
      getSpy.mockImplementation(() => {
        setImmediate(() => req.emit('error', new Error('ECONNREFUSED')));
        return req as any;
      });
      await expect((service as any).requestData('x')).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('contrato oficial de consulta por ID', () => {
    it('usa a rota e query oficiais com timeout de leitura', async () => {
      const req = new FakeReq();
      getSpy.mockImplementation((url: any, cb: any) => {
        expect(String(url)).toBe(
          'https://vismed.test/api/v1.0/get-agendamento-by-id?idagendamento=id%20com%20espa%C3%A7o',
        );
        setImmediate(() => respond(req, cb, 200, '[{"idpacienteagendamento":"id com espaço"}]'));
        return req as any;
      });

      await expect(service.getAgendamentoById(
        'id com espaço',
        'https://vismed.test/api/v1.0/',
      )).resolves.toEqual([{ idpacienteagendamento: 'id com espaço' }]);
      expect(req.timeoutMs).toBe(30_000);
    });

    it.each([204, 301, 404, 500])('rejeita status HTTP %s', async statusCode => {
      const req = new FakeReq();
      getSpy.mockImplementation((_url: any, cb: any) => {
        setImmediate(() => respond(req, cb, statusCode, '[]'));
        return req as any;
      });

      await expect(service.getAgendamentoById('123')).rejects.toThrow(`HTTP ${statusCode}`);
    });
  });

  describe('postFormData (escrita)', () => {
    it('resposta normal intacta e timeout de 60s aplicado', async () => {
      const req = new FakeReq();
      requestSpy.mockImplementation((_opts: any, cb: any) => {
        setImmediate(() => respond(req, cb, 200, '{"ok":true}'));
        return req as any;
      });
      const result = await (service as any).postFormData('delete-agendamento', { id: '123' });
      expect(result).toEqual({ ok: true });
      expect(req.timeoutMs).toBe(60_000);
      expect(req.ended).toBe(true);
      expect(req.destroyed).toBe(false);
    });

    it('timeout rejeita com VismedTimeoutError e destrói a request', async () => {
      const req = new FakeReq();
      requestSpy.mockImplementation(() => {
        setImmediate(() => req.timeoutCb!());
        return req as any;
      });
      const p = (service as any).postFormData('delete-agendamento', { id: '123' });
      await expect(p).rejects.toBeInstanceOf(VismedTimeoutError);
      expect(req.destroyed).toBe(true);
    });

    it('erro HTTP >= 400 rejeita como hoje', async () => {
      const req = new FakeReq();
      requestSpy.mockImplementation((_opts: any, cb: any) => {
        setImmediate(() => respond(req, cb, 422, 'invalid'));
        return req as any;
      });
      await expect((service as any).postFormData('x', { a: 1 })).rejects.toThrow('HTTP 422: invalid');
    });
  });

  describe('postData (escrita)', () => {
    it('resposta normal intacta e timeout de 60s aplicado', async () => {
      const req = new FakeReq();
      requestSpy.mockImplementation((_opts: any, cb: any) => {
        setImmediate(() => respond(req, cb, 200, '{"id":42}'));
        return req as any;
      });
      const result = await (service as any).postData('schedule/online/schedule/pacient', { nome: 'X' });
      expect(result).toEqual({ id: 42 });
      expect(req.timeoutMs).toBe(60_000);
    });

    it('timeout rejeita com VismedTimeoutError e destrói a request', async () => {
      const req = new FakeReq();
      requestSpy.mockImplementation(() => {
        setImmediate(() => req.timeoutCb!());
        return req as any;
      });
      const p = (service as any).postData('x', {});
      await expect(p).rejects.toBeInstanceOf(VismedTimeoutError);
      expect(req.destroyed).toBe(true);
    });

    it('erro de conexão rejeita como hoje', async () => {
      const req = new FakeReq();
      requestSpy.mockImplementation(() => {
        setImmediate(() => req.emit('error', new Error('socket hang up')));
        return req as any;
      });
      await expect((service as any).postData('x', {})).rejects.toThrow('socket hang up');
    });

    it('AbortSignal destrói a request em voo e rejeita com erro tipado', async () => {
      const req = new FakeReq();
      requestSpy.mockImplementation(() => req as any);
      const controller = new AbortController();
      const pending = (service as any).postData('x', {}, undefined, controller.signal);

      controller.abort();

      await expect(pending).rejects.toBeInstanceOf(VismedRequestAbortedError);
      await expect(pending).rejects.toMatchObject({ code: 'VISMED_REQUEST_ABORTED' });
      expect(req.destroyed).toBe(true);
    });

    it('AbortSignal já cancelado faz zero request HTTP', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        (service as any).postData('x', {}, undefined, controller.signal),
      ).rejects.toBeInstanceOf(VismedRequestAbortedError);
      expect(requestSpy).not.toHaveBeenCalled();
    });
  });

  describe('contrato oficial de recovery incremental', () => {
    it('serializa IDs separados por vírgula e aceita exclusivamente HTTP 200', async () => {
      const req = new FakeReq();
      requestSpy.mockImplementation((opts: any, cb: any) => {
        expect(opts.path).toBe('/api/v1.0/reenviar-para-docctoralia');
        setImmediate(() => respond(req, cb, 200, '{"accepted":true}'));
        return req as any;
      });

      await expect(service.requestRedelivery(
        ['appt-1', '42'],
        'https://vismed.test',
      )).resolves.toBeUndefined();
      expect(req.written).toEqual([
        JSON.stringify({ idagendamento: 'appt-1,42' }),
      ]);
      expect(req.timeoutMs).toBe(60_000);
    });

    it.each([201, 204, 301, 400, 500])('rejeita status HTTP %s sem inventar sucesso', async statusCode => {
      const req = new FakeReq();
      requestSpy.mockImplementation((_opts: any, cb: any) => {
        setImmediate(() => respond(req, cb, statusCode, '{}'));
        return req as any;
      });

      await expect(service.requestRedelivery(['123'])).rejects.toThrow(
        `HTTP ${statusCode}`,
      );
    });

    it('propaga timeout e falha de transporte', async () => {
      const timeoutReq = new FakeReq();
      requestSpy.mockImplementationOnce(() => {
        setImmediate(() => timeoutReq.timeoutCb!());
        return timeoutReq as any;
      });
      await expect(service.requestRedelivery(['123']))
        .rejects.toBeInstanceOf(VismedTimeoutError);

      const transportReq = new FakeReq();
      requestSpy.mockImplementationOnce(() => {
        setImmediate(() => transportReq.emit('error', new Error('ECONNRESET')));
        return transportReq as any;
      });
      await expect(service.requestRedelivery(['123']))
        .rejects.toThrow('ECONNRESET');
    });

    it.each([
      { ids: [] },
      { ids: [''] },
      { ids: ['authorized-1,unauthorized-2'] },
      { ids: ['line\nbreak'] },
    ])('rejeita lote inválido $ids antes de emitir request', async ({ ids }) => {
      await expect(service.requestRedelivery(ids)).rejects.toThrow(
        'Invalid VisMed appointment ID',
      );
      expect(requestSpy).not.toHaveBeenCalled();
    });
  });

  describe('deadline total (resposta gota a gota / sem atividade)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('leitura: resposta que pinga dados sem terminar é destruída no deadline de 30s', async () => {
      const req = new FakeReq();
      let resCb: any;
      getSpy.mockImplementation((_url: any, cb: any) => {
        resCb = cb;
        return req as any;
      });
      const p = (service as any).requestData('x');
      const expectation = expect(p).rejects.toBeInstanceOf(VismedTimeoutError);

      // resposta chega e fica emitindo bytes periodicamente, sem 'end':
      const res = new FakeRes(200);
      resCb(res);
      for (let i = 0; i < 5; i++) {
        jest.advanceTimersByTime(5_000);
        res.emit('data', 'chunk');
      }
      expect(req.destroyed).toBe(false); // 25s: ainda dentro do prazo
      jest.advanceTimersByTime(5_001); // cruza 30s totais
      expect(req.destroyed).toBe(true);
      expect(req.destroyedWith).toBeInstanceOf(VismedTimeoutError);
      await expectation;
    });

    it('escrita: request sem nenhuma resposta é destruída no deadline de 60s', async () => {
      const req = new FakeReq();
      requestSpy.mockImplementation(() => req as any);
      const p = (service as any).postData('x', {});
      const expectation = expect(p).rejects.toMatchObject({ code: 'VISMED_TIMEOUT' });
      jest.advanceTimersByTime(59_999);
      expect(req.destroyed).toBe(false);
      jest.advanceTimersByTime(2);
      expect(req.destroyed).toBe(true);
      await expectation;
    });

    it('sucesso antes do deadline limpa o timer (nenhum destroy tardio)', async () => {
      const req = new FakeReq();
      let resCb: any;
      getSpy.mockImplementation((_url: any, cb: any) => {
        resCb = cb;
        return req as any;
      });
      const p = (service as any).requestData('x');
      respond(req, resCb, 200, '[]'); // após listeners registrados
      await expect(p).resolves.toEqual([]);
      jest.advanceTimersByTime(120_000);
      expect(req.destroyed).toBe(false);
    });
  });

  describe('propagação pelo método público', () => {
    it('createAppointment relança VismedTimeoutError', async () => {
      const req = new FakeReq();
      requestSpy.mockImplementation(() => {
        setImmediate(() => req.timeoutCb!());
        return req as any;
      });
      const p = service.createAppointment({
        tipo: 'C',
        idcategoriaservico: 1,
        horarios_profissional: '10:00',
        idempresagestora: 1,
        data_agendamento: '2026-08-10',
        nome: 'Teste',
        telefone: '11999999999',
      });
      await expect(p).rejects.toBeInstanceOf(VismedTimeoutError);
      await expect(p).rejects.toMatchObject({ code: 'VISMED_TIMEOUT' });
    });
  });

  describe('timeouts configuráveis por env', () => {
    it('VISMED_READ_TIMEOUT_MS e VISMED_WRITE_TIMEOUT_MS sobrescrevem os padrões', async () => {
      process.env.VISMED_READ_TIMEOUT_MS = '5000';
      process.env.VISMED_WRITE_TIMEOUT_MS = '12000';
      const svc = new VismedService();

      const getReq = new FakeReq();
      getSpy.mockImplementation((_url: any, cb: any) => {
        setImmediate(() => respond(getReq, cb, 200, '[]'));
        return getReq as any;
      });
      await (svc as any).requestData('x');
      expect(getReq.timeoutMs).toBe(5000);

      const postReq = new FakeReq();
      requestSpy.mockImplementation((_opts: any, cb: any) => {
        setImmediate(() => respond(postReq, cb, 200, '{}'));
        return postReq as any;
      });
      await (svc as any).postData('x', {});
      expect(postReq.timeoutMs).toBe(12000);
    });

    it('env inválida cai no padrão', async () => {
      process.env.VISMED_READ_TIMEOUT_MS = 'abc';
      const svc = new VismedService();
      const req = new FakeReq();
      getSpy.mockImplementation((_url: any, cb: any) => {
        setImmediate(() => respond(req, cb, 200, '[]'));
        return req as any;
      });
      await (svc as any).requestData('x');
      expect(req.timeoutMs).toBe(30_000);
    });
  });
});
