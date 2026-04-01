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

function mapClinic(c: any) {
  if (!c) return c;
  const integrations = (c.integration_connections || []).map((i: any) => ({
    ...i,
    clientId: i.client_id,
    clientSecret: i.client_secret,
  }));
  return { ...c, integrations };
}

async function getAuthUser(req: Request, supabase: any) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return null;
  const { data: profile } = await supabase
    .from('users')
    .select('*, user_clinic_roles(*, clinics(*))')
    .eq('auth_id', user.id)
    .single();
  return profile;
}

// ---------- Docplanner Client ----------
class DocplannerClient {
  private accessToken = '';
  private baseUrl: string;

  constructor(private domain: string, private clientId: string, private clientSecret: string) {
    let d = domain || 'www.doctoralia.com.br';
    this.baseUrl = d.startsWith('http') ? d : `https://${d}`;
    this.baseUrl = this.baseUrl.replace(/\/$/, '');
  }

  async authenticate() {
    // Trim to avoid accidental whitespace issues
    const cId = this.clientId.trim();
    const cSec = this.clientSecret.trim();

    const domain = this.baseUrl.replace(/^https?:\/\//, '');
    const url = `https://${domain}/oauth/v2/token`;

    // Try Basic Auth first as it is standard in our previous implementation
    const basicAuth = btoa(`${cId}:${cSec}`);

    const body = new URLSearchParams();
    body.append('grant_type', 'client_credentials');
    body.append('scope', 'integration');
    // Also include in body as some Docplanner regions prefer it
    body.append('client_id', cId);
    body.append('client_secret', cSec);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`
      },
      body: body,
    });

    if (!response.ok) {
      const respText = await response.text();
      // Try again WITHOUT Basic header, just body, if first one fails
      console.warn(`Auth Step 1 failed for ${url}: ${respText}. Trying body-only auth.`);

      const retryResponse = await fetch(url, {
        method: 'POST',
        body: body,
      });

      if (!retryResponse.ok) {
        const retryText = await retryResponse.text();
        console.error(`Auth Step 2 failed: ${retryText}`);
        throw new Error(`Auth failed (credentials rejected): ${retryResponse.status} - ${retryText}`);
      }

      const data = await retryResponse.json();
      this.accessToken = data.access_token;
    } else {
      const data = await response.json();
      this.accessToken = data.access_token;
    }
  }

  async request(method: string, path: string, body?: any) {
    const domain = this.baseUrl.replace(/^https?:\/\//, '');
    const url = `https://${domain}${path}`;
    const headers: any = { 'Authorization': `Bearer ${this.accessToken}` };
    const opts: RequestInit = { method, headers };
    if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Docplanner API: ${res.status} ${text}`) as any;
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  getFacilities() { return this.request('GET', '/api/v3/integration/facilities'); }
  getDoctors(fId: string) { return this.request('GET', `/api/v3/integration/facilities/${fId}/doctors`); }
  getAddresses(fId: string, dId: string) { return this.request('GET', `/api/v3/integration/facilities/${fId}/doctors/${dId}/addresses`); }
}

// ---------- VisMed Client ----------
async function vismedRequest(path: string, baseUrl?: string) {
  let host = baseUrl || 'https://app.vissmed.com.br/api-vissmed-4/api/v1.0';
  if (!host.endsWith('/api/v1.0')) host = host.replace(/\/$/, '') + '/api/v1.0';
  const url = `${host}/${path}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`VisMed HTTP ${res.status}`);
  return res.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const url = new URL(req.url);
  const path = url.pathname.replace('/api-clinics', '');
  const segments = path.split('/').filter(Boolean);

  try {
    // GET /my — clinics for logged-in user
    if (req.method === 'GET' && segments[0] === 'my') {
      const user = await getAuthUser(req, supabase);
      if (!user) return json({ error: 'Unauthorized' }, 401);

      const isSuperAdmin = user.user_clinic_roles?.some((r: any) => r.role === 'SUPER_ADMIN');
      if (isSuperAdmin) {
        const { data } = await supabase
          .from('clinics')
          .select('*, integration_connections(*), user_clinic_roles(*, users(id, name, email))')
          .order('name');
        return json((data || []).map(mapClinic));
      }

      const { data } = await supabase
        .from('user_clinic_roles')
        .select('*, clinics(*, integration_connections(*))')
        .eq('user_id', user.id);

      const mapped = data?.map((ur: any) => {
         const clinicMapped = mapClinic(ur.clinics);
         return { ...clinicMapped, userRole: ur.role };
      }) || [];
      return json(mapped);
    }

    // LIST /
    if (req.method === 'GET' && segments.length === 0) {
      const { data } = await supabase
        .from('clinics')
        .select('*, integration_connections(*), user_clinic_roles(*, users(id, name, email))')
        .order('name');
      return json((data || []).map(mapClinic));
    }

    // GET /:id
    if (req.method === 'GET' && segments.length === 1 && segments[0] !== 'my') {
      const { data, error } = await supabase
        .from('clinics')
        .select('*, integration_connections(*), user_clinic_roles(*, users(id, name, email))')
        .eq('id', segments[0])
        .single();
      if (error) return json({ error: 'Clinic not found' }, 404);
      return json(mapClinic(data));
    }

    // POST /
    if (req.method === 'POST' && segments.length === 0) {
      const body = await req.json();
      const { integrationArgs, users, integration_connections, integrations, ...clinicData } = body;
      const { data: clinic, error } = await supabase.from('clinics').insert(clinicData).select().single();
      if (error) throw error;

      if (integrationArgs) {
        let dbArgs: any = { ...integrationArgs };
        if (integrationArgs.clientId) dbArgs.client_id = integrationArgs.clientId;
        if (integrationArgs.clientSecret) dbArgs.client_secret = integrationArgs.clientSecret;
        delete dbArgs.clientId;
        delete dbArgs.clientSecret;

        await supabase.from('integration_connections').insert({ ...dbArgs, clinic_id: clinic.id });
      }

      const { data: result } = await supabase
        .from('clinics')
        .select('*, integration_connections(*), user_clinic_roles(*, users(id, name, email))')
        .eq('id', clinic.id)
        .single();
      return json(mapClinic(result), 201);
    }

    // PUT /:id
    if (req.method === 'PUT' && segments.length === 1) {
      const body = await req.json();
      const { integrationArgs, users, integration_connections, integrations, user_clinic_roles, ...clinicData } = body;

      await supabase.from('clinics').update(clinicData).eq('id', segments[0]);

      if (integrationArgs) {
        let dbArgs: any = { ...integrationArgs };
        if (integrationArgs.clientId) dbArgs.client_id = integrationArgs.clientId;
        if (integrationArgs.clientSecret) dbArgs.client_secret = integrationArgs.clientSecret;
        delete dbArgs.clientId;
        delete dbArgs.clientSecret;

        const { data: existing } = await supabase
          .from('integration_connections')
          .select('id')
          .eq('clinic_id', segments[0])
          .eq('provider', integrationArgs.provider || 'doctoralia')
          .single();

        if (existing) {
          await supabase.from('integration_connections').update(dbArgs).eq('id', existing.id);
        } else {
          await supabase.from('integration_connections').insert({ ...dbArgs, clinic_id: segments[0] });
        }
      }

      const { data: result } = await supabase
        .from('clinics')
        .select('*, integration_connections(*), user_clinic_roles(*, users(id, name, email))')
        .eq('id', segments[0])
        .single();
      return json(mapClinic(result));
    }

    // DELETE /:id
    if (req.method === 'DELETE' && segments.length === 1) {
      await supabase.from('clinics').delete().eq('id', segments[0]);
      return json({ deleted: true });
    }

    // POST /:id/test-integration — Doctoralia
    if (req.method === 'POST' && segments.length === 2 && segments[1] === 'test-integration') {
      const { data: conn } = await supabase
        .from('integration_connections')
        .select('*')
        .eq('clinic_id', segments[0])
        .eq('provider', 'doctoralia')
        .single();

      if (!conn?.client_id) return json({ success: false, message: 'Integração Doctoralia não configurada' });

      try {
        const client = new DocplannerClient(conn.domain || 'www.doctoralia.com.br', conn.client_id, conn.client_secret || '');
        await client.authenticate();
        const facilities = await client.getFacilities();
        const items = facilities._items || [];

        await supabase.from('integration_connections').update({ status: 'connected', last_test_at: new Date().toISOString() }).eq('id', conn.id);
        return json({ success: true, message: `Conexão OK — ${items.length} facility(ies)`, facilities: items.map((f: any) => ({ id: f.id, name: f.name })) });
      } catch (e: any) {
        await supabase.from('integration_connections').update({ status: 'error', last_test_at: new Date().toISOString() }).eq('id', conn.id);
        return json({ success: false, message: e.message || 'Erro deconhecido' });
      }
    }

    // POST /:id/test-vismed — VisMed
    if (req.method === 'POST' && segments.length === 2 && segments[1] === 'test-vismed') {
      const { data: conn } = await supabase
        .from('integration_connections')
        .select('*')
        .eq('clinic_id', segments[0])
        .eq('provider', 'vismed')
        .single();

      if (!conn?.client_id) return json({ success: false, message: 'Integração VisMed não configurada' });

      try {
        const unidades = await vismedRequest(`unidade-by-idempresagestora?idempresagestora=${conn.client_id}`, conn.domain || undefined);
        if (!unidades || unidades.length === 0) throw new Error(`Nenhuma unidade localizada para Empresa ${conn.client_id}`);
        await supabase.from('integration_connections').update({ status: 'connected', last_test_at: new Date().toISOString() }).eq('id', conn.id);
        return json({ success: true, message: `Conexão OK — ${unidades.length} unidade(s)` });
      } catch (e: any) {
        await supabase.from('integration_connections').update({ status: 'error', last_test_at: new Date().toISOString() }).eq('id', conn.id);
        return json({ success: false, message: `Falha: ${e.message}` });
      }
    }

    return json({ error: 'Not found' }, 404);
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});
