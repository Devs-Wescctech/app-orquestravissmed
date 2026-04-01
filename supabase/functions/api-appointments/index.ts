import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Docplanner Client
class DocplannerClient {
  private accessToken = '';
  private baseUrl: string;
  constructor(private domain: string, private clientId: string, private clientSecret: string) {
    this.baseUrl = domain.startsWith('http') ? domain : `https://${domain}`;
    this.baseUrl = this.baseUrl.replace(/\/$/, '');
  }
  async authenticate() {
    const d = this.baseUrl.replace(/^https?:\/\//, '');
    const res = await fetch(`https://${d}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}` },
      body: 'grant_type=client_credentials&scope=integration',
    });
    if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
    this.accessToken = (await res.json()).access_token;
  }
  async req(method: string, path: string, body?: any) {
    const d = this.baseUrl.replace(/^https?:\/\//, '');
    const url = `https://${d}${path}`;
    const h: any = { 'Authorization': `Bearer ${this.accessToken}` };
    const o: RequestInit = { method, headers: h };
    if (body && ['POST','PUT','PATCH'].includes(method)) { h['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    const r = await fetch(url, o);
    if (!r.ok) { const t = await r.text(); const e = new Error(`API ${r.status} ${t}`) as any; e.status = r.status; throw e; }
    if (r.status === 204) return null;
    return r.json();
  }
  getBookings(fId: string, dId: string, aId: string, s: string, e: string) {
    const st = s.includes('T') ? s : `${s}T00:00:00-0300`;
    const en = e.includes('T') ? e : `${e}T23:59:59-0300`;
    return this.req('GET', `/api/v3/integration/facilities/${fId}/doctors/${dId}/addresses/${aId}/bookings?start=${encodeURIComponent(st)}&end=${encodeURIComponent(en)}`);
  }
  getSlots(fId: string, dId: string, aId: string, s: string, e: string) {
    const st = s.includes('T') ? s : `${s}T00:00:00-0300`;
    const en = e.includes('T') ? e : `${e}T23:59:59-0300`;
    return this.req('GET', `/api/v3/integration/facilities/${fId}/doctors/${dId}/addresses/${aId}/slots?start=${encodeURIComponent(st)}&end=${encodeURIComponent(en)}`);
  }
  replaceSlots(fId: string, dId: string, aId: string, payload: any) { return this.req('PUT', `/api/v3/integration/facilities/${fId}/doctors/${dId}/addresses/${aId}/slots`, payload); }
  bookSlot(fId: string, dId: string, aId: string, payload: any) { return this.req('POST', `/api/v3/integration/facilities/${fId}/doctors/${dId}/addresses/${aId}/bookings`, payload); }
  deleteSlots(fId: string, dId: string, aId: string, s: string, e: string) {
    const st = s.includes('T') ? s : `${s}T00:00:00-0300`;
    const en = e.includes('T') ? e : `${e}T23:59:59-0300`;
    return this.req('DELETE', `/api/v3/integration/facilities/${fId}/doctors/${dId}/addresses/${aId}/slots?start=${encodeURIComponent(st)}&end=${encodeURIComponent(en)}`);
  }
  getCalendarState(fId: string, dId: string, aId: string) { return this.req('GET', `/api/v3/integration/facilities/${fId}/doctors/${dId}/addresses/${aId}/calendar-status`); }
  enableCalendar(fId: string, dId: string, aId: string) { return this.req('POST', `/api/v3/integration/facilities/${fId}/doctors/${dId}/addresses/${aId}/calendar-status`, { status: 'enabled' }); }
  disableCalendar(fId: string, dId: string, aId: string) { return this.req('POST', `/api/v3/integration/facilities/${fId}/doctors/${dId}/addresses/${aId}/calendar-status`, { status: 'disabled' }); }
  getServices(fId: string, dId: string, aId: string) { return this.req('GET', `/api/v3/integration/facilities/${fId}/doctors/${dId}/addresses/${aId}/services`); }
}

async function getClient(supabase: any, clinicId: string) {
  const { data: conn } = await supabase.from('integration_connections').select('*').eq('clinic_id', clinicId).eq('provider', 'doctoralia').single();
  if (!conn?.client_id) return null;
  const c = new DocplannerClient(conn.domain || 'doctoralia.com.br', conn.client_id, conn.client_secret || '');
  await c.authenticate();
  return c;
}

async function logAudit(supabase: any, data: any) {
  try { await supabase.from('audit_logs').insert(data); } catch {}
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const url = new URL(req.url);
  const path = url.pathname.replace('/api-appointments', '');
  const segments = path.split('/').filter(Boolean);
  const clinicId = url.searchParams.get('clinicId') || '';

  function defaultDates(s?: string | null, e?: string | null) {
    const today = new Date();
    const week = new Date(); week.setDate(week.getDate() + 7);
    return { start: s || today.toISOString().split('T')[0], end: e || week.toISOString().split('T')[0] };
  }

  try {
    // GET /calendar-status
    if (req.method === 'GET' && segments[0] === 'calendar-status') {
      const { data: conn } = await supabase.from('integration_connections').select('*').eq('clinic_id', clinicId).eq('provider', 'doctoralia').single();
      if (!conn?.client_id) return json({ integrated: false, message: 'Integração Doctoralia não configurada' });

      const { data: mappings } = await supabase.from('mappings').select('*').eq('clinic_id', clinicId).eq('entity_type', 'DOCTOR').eq('status', 'LINKED');
      const doctors = (mappings || []).map((m: any) => {
        const cd = m.conflict_data || {};
        return { externalId: m.external_id, name: `${cd.name || ''} ${cd.surname || ''}`.trim(), calendarStatus: cd.calendarStatus || 'unknown', addressId: cd.address?.id || null, facilityId: cd.facilityId || null };
      });
      const hasAnyEnabled = doctors.some((d: any) => d.calendarStatus === 'enabled');
      return json({ integrated: true, calendarEnabled: hasAnyEnabled, doctors, message: hasAnyEnabled ? 'Calendar ativo' : 'Calendar desabilitado para todos' });
    }

    // GET /bookings
    if (req.method === 'GET' && segments[0] === 'bookings') {
      const doctorId = url.searchParams.get('doctorId');
      const dates = defaultDates(url.searchParams.get('start'), url.searchParams.get('end'));

      if (doctorId) {
        // Single doctor bookings
        const { data: mapping } = await supabase.from('mappings').select('*').eq('clinic_id', clinicId).eq('entity_type', 'DOCTOR').eq('external_id', doctorId).single();
        if (!mapping) return json({ bookings: [], error: 'Médico não encontrado' });
        const cd = mapping.conflict_data || {};
        if (cd.calendarStatus !== 'enabled') return json({ bookings: [], calendarStatus: cd.calendarStatus, blocked: true, error: 'Calendar desabilitado' });
        if (!cd.facilityId || !cd.address?.id) return json({ bookings: [], error: 'Dados de endereço incompletos.' });

        const client = await getClient(supabase, clinicId);
        if (!client) return json({ bookings: [], error: 'Integração não configurada' });
        const res = await client.getBookings(cd.facilityId, doctorId, cd.address.id, dates.start, dates.end);
        const list = Array.isArray(res) ? res : (res?._items || []);
        return json({ bookings: list, calendarStatus: cd.calendarStatus });
      }

      // All bookings
      const client = await getClient(supabase, clinicId);
      if (!client) return json({ bookings: [], calendarEnabled: false, error: 'Integração não configurada' });

      const { data: mappings } = await supabase.from('mappings').select('*').eq('clinic_id', clinicId).eq('entity_type', 'DOCTOR');
      const allBookings: any[] = []; let calEnabled = false;
      for (const m of (mappings || [])) {
        const cd = m.conflict_data || {};
        if (cd.calendarStatus === 'enabled' && cd.facilityId && cd.address?.id) {
          calEnabled = true;
          try {
            const res = await client.getBookings(cd.facilityId, m.external_id, cd.address.id, dates.start, dates.end);
            const items = (res._items || []).map((b: any) => ({ ...b, doctorName: `${cd.name || ''} ${cd.surname || ''}`.trim(), doctorExternalId: m.external_id }));
            allBookings.push(...items);
          } catch {}
        }
      }
      return json({ bookings: allBookings, calendarEnabled: calEnabled });
    }

    // GET /slots
    if (req.method === 'GET' && segments[0] === 'slots') {
      const doctorId = url.searchParams.get('doctorId');
      if (!doctorId) return json({ slots: [], error: 'doctorId obrigatório' });
      const dates = defaultDates(url.searchParams.get('start'), url.searchParams.get('end'));

      const { data: mapping } = await supabase.from('mappings').select('*').eq('clinic_id', clinicId).eq('entity_type', 'DOCTOR').eq('external_id', doctorId).single();
      if (!mapping) return json({ slots: [], error: 'Médico não encontrado' });
      const cd = mapping.conflict_data || {};
      if (cd.calendarStatus !== 'enabled') return json({ slots: [], calendarStatus: cd.calendarStatus, blocked: true, error: 'Calendar desabilitado' });
      if (!cd.facilityId || !cd.address?.id) return json({ slots: [], error: 'Dados de endereço incompletos.' });

      const client = await getClient(supabase, clinicId);
      if (!client) return json({ slots: [], error: 'Integração não configurada' });
      const res = await client.getSlots(cd.facilityId, doctorId, cd.address.id, dates.start, dates.end);
      const list = Array.isArray(res) ? res : (res?._items || []);
      return json({ slots: list, calendarStatus: cd.calendarStatus });
    }

    // PUT /slots — Replace slots
    if (req.method === 'PUT' && segments[0] === 'slots') {
      const body = await req.json();
      const { data: mapping } = await supabase.from('mappings').select('*').eq('clinic_id', body.clinicId || clinicId).eq('entity_type', 'DOCTOR').eq('external_id', body.doctorId).single();
      if (!mapping) throw new Error('Médico não encontrado');
      const cd = mapping.conflict_data || {};
      if (!cd.facilityId || !cd.address?.id) throw new Error('Dados incompletos.');
      const client = await getClient(supabase, body.clinicId || clinicId);
      if (!client) throw new Error('Integração não configurada');

      // Fix default service IDs
      let defaultSvcId = 0;
      for (const slot of (body.slots || [])) {
        for (const srv of (slot.address_services || [])) {
          if (!srv.address_service_id || srv.address_service_id === 0) {
            if (defaultSvcId === 0) { try { const s = await client.getServices(cd.facilityId, body.doctorId, cd.address.id); defaultSvcId = s._items?.[0]?.id || 0; } catch {} }
            srv.address_service_id = defaultSvcId;
          }
        }
      }
      const res = await client.replaceSlots(cd.facilityId, body.doctorId, cd.address.id, { slots: body.slots });
      return json(res);
    }

    // POST /slots/book
    if (req.method === 'POST' && segments[0] === 'slots' && segments[1] === 'book') {
      const body = await req.json();
      const { clinicId: cId, doctorId, ...payload } = body;
      const cid = cId || clinicId;
      const { data: mapping } = await supabase.from('mappings').select('*').eq('clinic_id', cid).eq('entity_type', 'DOCTOR').eq('external_id', doctorId).single();
      if (!mapping) throw new Error('Médico não encontrado');
      const cd = mapping.conflict_data || {};
      const client = await getClient(supabase, cid);
      if (!client) throw new Error('Integração não configurada');
      const res = await client.bookSlot(cd.facilityId, doctorId, cd.address.id, payload);
      return json(res);
    }

    // DELETE /slots
    if (req.method === 'DELETE' && segments[0] === 'slots') {
      const doctorId = url.searchParams.get('doctorId');
      const start = url.searchParams.get('start');
      const end = url.searchParams.get('end');
      if (!doctorId || !start || !end) throw new Error('doctorId, start e end obrigatórios');
      const { data: mapping } = await supabase.from('mappings').select('*').eq('clinic_id', clinicId).eq('entity_type', 'DOCTOR').eq('external_id', doctorId).single();
      if (!mapping) throw new Error('Médico não encontrado');
      const cd = mapping.conflict_data || {};
      const client = await getClient(supabase, clinicId);
      if (!client) throw new Error('Integração não configurada');
      const res = await client.deleteSlots(cd.facilityId, doctorId, cd.address.id, start, end);
      return json(res);
    }

    // GET /stats
    if (req.method === 'GET' && segments[0] === 'stats') {
      const { data: conn } = await supabase.from('integration_connections').select('*').eq('clinic_id', clinicId).eq('provider', 'doctoralia').single();
      if (!conn?.client_id) return json({ calendarEnabled: false, totalDoctors: 0, doctorsWithCalendar: 0, message: 'Integração não configurada' });
      const { data: mappings } = await supabase.from('mappings').select('conflict_data').eq('clinic_id', clinicId).eq('entity_type', 'DOCTOR').eq('status', 'LINKED');
      const doctors = mappings || [];
      const withCal = doctors.filter((m: any) => m.conflict_data?.calendarStatus === 'enabled').length;
      return json({ calendarEnabled: withCal > 0, totalDoctors: doctors.length, doctorsWithCalendar: withCal, message: withCal > 0 ? 'Calendar ativo' : 'Calendar desabilitado' });
    }

    // POST /calendar-status
    if (req.method === 'POST' && segments[0] === 'calendar-status') {
      const body = await req.json();
      const cid = body.clinicId || clinicId;
      const doctorExternalId = body.doctoraliaDoctorId;
      const status = body.status;

      const { data: mapping } = await supabase.from('mappings').select('*').eq('clinic_id', cid).eq('entity_type', 'DOCTOR').eq('external_id', doctorExternalId).single();
      if (!mapping) return json({ error: 'Mapeamento não encontrado' }, 404);
      const cd = mapping.conflict_data || {};
      if (!cd.facilityId || !cd.address?.id) return json({ error: 'Dados de endereço ausentes' }, 400);

      const client = await getClient(supabase, cid);
      if (!client) return json({ error: 'Integração não configurada' }, 400);

      if (status === 'enabled') {
        try { await client.enableCalendar(cd.facilityId, doctorExternalId, cd.address.id); } catch (e: any) { if (e.status !== 409) throw e; }
      } else {
        try { await client.disableCalendar(cd.facilityId, doctorExternalId, cd.address.id); } catch (e: any) { if (e.status !== 409) throw e; }
      }

      const current = await client.getCalendarState(cd.facilityId, doctorExternalId, cd.address.id);
      const verifiedStatus = (current?.enabled === true || current?.status === 'enabled') ? 'enabled' : 'disabled';

      await supabase.from('mappings').update({ conflict_data: { ...cd, calendarStatus: verifiedStatus } }).eq('id', mapping.id);
      await logAudit(supabase, { action: 'UPDATE_CALENDAR_STATUS', entity: 'Mapping', entity_id: mapping.id, details: { doctorExternalId, requestedStatus: status, finalStatus: verifiedStatus } });

      return json({ success: true, status: verifiedStatus });
    }

    return json({ error: 'Not found' }, 404);
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});
