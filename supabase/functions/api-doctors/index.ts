import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
  getFacilities() { return this.req('GET', '/api/v3/integration/facilities'); }
  getDoctors(fId: string) { return this.req('GET', `/api/v3/integration/facilities/${fId}/doctors`); }
  getAddresses(fId: string, dId: string) { return this.req('GET', `/api/v3/integration/facilities/${fId}/doctors/${dId}/addresses`); }
  getServices(fId: string, dId: string, aId: string) { return this.req('GET', `/api/v3/integration/facilities/${fId}/doctors/${dId}/addresses/${aId}/services`); }
  getCalendarStatus(fId: string, dId: string, aId: string) { return this.req('GET', `/api/v3/integration/facilities/${fId}/doctors/${dId}/addresses/${aId}/calendar-status`); }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const url = new URL(req.url);
  const path = url.pathname.replace('/api-doctors', '');
  const segments = path.split('/').filter(Boolean);
  const clinicId = url.searchParams.get('clinicId') || '';

  try {
    // GET /count
    if (req.method === 'GET' && segments[0] === 'count') {
      const { count: total } = await supabase.from('mappings').select('*', { count: 'exact', head: true }).eq('clinic_id', clinicId).eq('entity_type', 'DOCTOR');
      const { count: linked } = await supabase.from('mappings').select('*', { count: 'exact', head: true }).eq('clinic_id', clinicId).eq('entity_type', 'DOCTOR').eq('status', 'LINKED');
      const { count: unlinked } = await supabase.from('mappings').select('*', { count: 'exact', head: true }).eq('clinic_id', clinicId).eq('entity_type', 'DOCTOR').eq('status', 'UNLINKED');
      return json({ total: total || 0, linked: linked || 0, unlinked: unlinked || 0 });
    }

    // POST /sync — Fetch live from Doctoralia
    if (req.method === 'POST' && segments[0] === 'sync') {
      const { data: conn } = await supabase.from('integration_connections').select('*').eq('clinic_id', clinicId).eq('provider', 'doctoralia').single();
      if (!conn?.client_id) throw new Error('Integração Doctoralia não configurada');

      const client = new DocplannerClient(conn.domain || 'doctoralia.com.br', conn.client_id, conn.client_secret || '');
      await client.authenticate();
      const facRes = await client.getFacilities();
      const facilities = facRes._items || [];
      if (!facilities.length) return json([]);

      const facilityId = String(facilities[0].id);
      const facilityName = facilities[0].name;
      const docRes = await client.getDoctors(facilityId);
      const doctorsList = docRes._items || [];

      const enriched: any[] = [];
      for (const doc of doctorsList) {
        const doctorId = String(doc.id);
        let address: any = null, services: any[] = [], calendarStatus = 'unknown';

        try {
          const addrRes = await client.getAddresses(facilityId, doctorId);
          const addrs = addrRes._items || [];
          if (addrs.length > 0) {
            address = addrs[0];
            try { const s = await client.getServices(facilityId, doctorId, String(address.id)); services = s._items || []; } catch {}\n            try { const c = await client.getCalendarStatus(facilityId, doctorId, String(address.id)); calendarStatus = c.status || 'unknown'; } catch {}\n          }\n        } catch {}\n\n        const conflictData = {\n          name: doc.name, surname: doc.surname || '', externalId: doc.id, facilityId, facilityName,\n          address: address ? { id: address.id, name: address.name, city: address.city_name, street: address.street, postCode: address.post_code } : null,\n          services: services.map((s: any) => ({ id: s.id, name: s.name, serviceId: s.service_id })),\n          calendarStatus,\n        };\n\n        // Upsert mapping\n        const { data: existing } = await supabase.from('mappings')\n          .select('id, status')\n          .eq('clinic_id', clinicId).eq('entity_type', 'DOCTOR').eq('external_id', doctorId)\n          .single();\n\n        if (existing) {\n          await supabase.from('mappings').update({ conflict_data: conflictData }).eq('id', existing.id);\n        } else {\n          await supabase.from('mappings').insert({ clinic_id: clinicId, entity_type: 'DOCTOR', external_id: doctorId, status: 'UNLINKED', conflict_data: conflictData });\n        }\n\n        enriched.push({ externalId: doctorId, name: doc.name, surname: doc.surname || '', fullName: `${doc.name} ${doc.surname || ''}`.trim(), address: conflictData.address, services: conflictData.services, calendarStatus, status: existing?.status || 'UNLINKED' });\n      }\n      return json(enriched);\n    }\n\n    // GET / — List synced doctors\n    if (req.method === 'GET' && segments.length === 0) {\n      const { data: mappings } = await supabase.from('mappings').select('*').eq('clinic_id', clinicId).eq('entity_type', 'DOCTOR').order('created_at', { ascending: false });\n      if (!mappings) return json([]);\n\n      const result = await Promise.all(mappings.map(async (m: any) => {\n        let vismedDoc: any = null;\n        if (m.vismed_id) {\n          const { data } = await supabase.from('vismed_doctors').select('*').eq('id', m.vismed_id).single();\n          vismedDoc = data;\n        }\n        const cd = m.conflict_data || {};\n        const fallbackName = vismedDoc?.name || 'Desconhecido';\n        const name = cd.name || fallbackName;\n        const surname = cd.surname || '';\n        return {\n          id: m.id, externalId: m.external_id, name, surname, fullName: surname ? `${name} ${surname}` : name,\n          address: cd.address || null, services: cd.services || [], calendarStatus: cd.calendarStatus || 'unknown',\n          status: m.status, vismedId: m.vismed_id, syncedAt: m.updated_at,\n          source: m.external_id && m.vismed_id ? 'BOTH' : (m.vismed_id ? 'VISMED' : 'DOCTORALIA')\n        };\n      }));\n      return json(result);\n    }\n\n    return json({ error: 'Not found' }, 404);\n  } catch (e: any) {\n    return json({ error: e.message }, 500);\n  }\n});
