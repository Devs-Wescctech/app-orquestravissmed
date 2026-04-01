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

function mapSyncRun(run: any) {
  if (!run) return run;
  return {
    ...run,
    clinicId: run.clinic_id,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    totalRecords: run.total_records,
    events: run.sync_events || [],
  };
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
    const cId = this.clientId.trim();
    const cSec = this.clientSecret.trim();
    const d = this.baseUrl.replace(/^https?:\/\//, '');
    
    const body = new URLSearchParams();
    body.append('grant_type', 'client_credentials');
    body.append('scope', 'integration');
    body.append('client_id', cId);
    body.append('client_secret', cSec);

    const basicAuth = btoa(`${cId}:${cSec}`);
    const res = await fetch(`https://${d}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${basicAuth}` },
      body,
    });
    
    if (!res.ok) {
        const text = await res.text();
        const retryRes = await fetch(`https://${d}/oauth/v2/token`, { method: 'POST', body });
        if (!retryRes.ok) throw new Error(`Auth failed: ${retryRes.status} ${text}`);
        const retryText = await retryRes.text();
        this.accessToken = retryText ? JSON.parse(retryText).access_token : '';
    } else {
        const text = await res.text();
        this.accessToken = text ? JSON.parse(text).access_token : '';
    }
  }
  async req(method: string, path: string, body?: any) {
    const d = this.baseUrl.replace(/^https?:\/\//, '');
    const h: any = { 'Authorization': `Bearer ${this.accessToken}` };
    const o: RequestInit = { method, headers: h };
    if (body && ['POST','PUT','PATCH'].includes(method)) { h['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    const r = await fetch(`https://${d}${path}`, o);
    if (!r.ok) { const t = await r.text(); throw new Error(`API ${r.status} ${t}`); }
    if (r.status === 204) return null;
    const text = await r.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch (e) {
      console.error(`Docplanner JSON error at ${path}:`, text);
      return null;
    }
  }
  getFacilities() { return this.req('GET', '/api/v3/integration/facilities'); }
  getDoctors(fId: string) { return this.req('GET', `/api/v3/integration/facilities/${fId}/doctors`); }
  getAddresses(fId: string, dId: string) { return this.req('GET', `/api/v3/integration/facilities/${fId}/doctors/${dId}/addresses`); }
  getServices(fId: string, dId: string, aId: string) { return this.req('GET', `/api/v3/integration/facilities/${fId}/doctors/${dId}/addresses/${aId}/services`); }
  getFacilityServicesCatalog(fId: string) { return this.req('GET', `/api/v3/integration/facilities/${fId}/services`).catch(() => ({ _items: [] })); }
  getInsurances(fId: string) { return this.req('GET', `/api/v3/integration/facilities/${fId}/insurances`).catch(() => ({ _items: [] })); }
  getInsuranceProviders(offset = 0) { return this.req('GET', `/api/v3/integration/insurance-providers?offset=${offset}&limit=100`).catch(() => ({ _items: [] })); }
  addAddressInsurance(fId: string, dId: string, aId: string, body: any) {
    return this.req('POST', `/api/v3/integration/facilities/${fId}/doctors/${dId}/addresses/${aId}/insurances`, body);
  }
}

// VisMed API helper
async function vismedRequest(path: string, baseUrl?: string) {
  let host = baseUrl || 'https://app.vissmed.com.br/api-vissmed-4/api/v1.0';
  if (!host.endsWith('/api/v1.0')) host = host.replace(/\/$/, '') + '/api/v1.0';
  const res = await fetch(`${host}/${path}`);
  if (!res.ok) throw new Error(`VisMed HTTP ${res.status}`);
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : [];
  } catch (e) {
    console.error(`VisMed JSON error at ${path}:`, text);
    return [];
  }
}

async function logEvent(sb: any, runId: string, type: string, action: string, message: string, externalId?: string) {
  try {
     await sb.from('sync_events').insert({ sync_run_id: runId, entity_type: type, action, message, external_id: externalId });
  } catch(e) {}
}

async function upsertMapping(sb: any, clinicId: string, entityType: string, doctoraliaId: string | null, conflictData: any, vismedId?: string) {
    if (vismedId) {
        // Syncing a record that exists in VisMed
        const { data: existing } = await sb.from('mappings')
            .select('*')
            .eq('clinic_id', clinicId)
            .eq('entity_type', entityType)
            .eq('vismed_id', vismedId)
            .maybeSingle();

        let finalDoctoraliaId = doctoraliaId || null;

        // Auto-link logic for INSURANCES by name
        if (!finalDoctoraliaId && entityType === 'INSURANCE' && conflictData?.name) {
           const { data: catMatch } = await sb.from('doctoralia_insurances')
             .select('doctoralia_insurance_id')
             .ilike('name', conflictData.name)
             .limit(1)
             .maybeSingle();
           if (catMatch) {
             finalDoctoraliaId = catMatch.doctoralia_insurance_id;
           }
        }

        if (!existing) {
            await sb.from('mappings').insert({
                clinic_id: clinicId,
                entity_type: entityType,
                vismed_id: vismedId,
                external_id: finalDoctoraliaId,
                status: finalDoctoraliaId ? 'LINKED' : 'UNLINKED',
                conflict_data: conflictData
            });
        } else {
            const updateData: any = {};
            if (finalDoctoraliaId && !existing.external_id) {
                updateData.external_id = finalDoctoraliaId;
                updateData.status = 'LINKED';
            }
            // Merge conflict_data instead of overwriting. 
            // If existing has a name that seems more complete (e.g. from Doctoralia), keep it.
            const existingCd = existing.conflict_data || {};
            const incomingName = conflictData?.name || '';
            const existingName = existingCd.name || '';
            
            // Only update name if existing is empty or if incoming is from a "stronger" source (not null doctoraliaId)
            const shouldUpdateName = !existingName || (doctoraliaId && incomingName);
            
            updateData.conflict_data = { 
              ...existingCd, 
              ...conflictData,
              name: shouldUpdateName ? incomingName : existingName
            };
            await sb.from('mappings').update(updateData).eq('id', existing.id);
        }
    } else if (doctoraliaId) {
        // Syncing a record that exists in Doctoralia
        const { data: existing } = await sb.from('mappings')
            .select('*')
            .eq('clinic_id', clinicId)
            .eq('entity_type', entityType)
            .eq('external_id', doctoraliaId)
            .maybeSingle();

        if (!existing) {
            await sb.from('mappings').insert({
                clinic_id: clinicId,
                entity_type: entityType,
                external_id: doctoraliaId,
                status: 'UNLINKED',
                conflict_data: conflictData
            });
        } else {
            // Update conflict_data if it's different or to enrich it
            await sb.from('mappings').update({ 
              conflict_data: { ...existing.conflict_data, ...conflictData } 
            }).eq('id', existing.id);
        }
    }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const url = new URL(req.url);
  const allSegments = url.pathname.split('/').filter(Boolean);
  const funcIndex = allSegments.findIndex(s => s === 'api-sync' || s === 'api-sync-v3');
  let segments = funcIndex !== -1 ? allSegments.slice(funcIndex + 1) : allSegments;

  try {
    if (req.method === 'GET' && segments[0] === 'vismed' && segments[1] === 'stats') {
      const { count: units } = await supabase.from('vismed_units').select('*', { count: 'exact', head: true });
      const { count: doctors } = await supabase.from('vismed_doctors').select('*', { count: 'exact', head: true });
      const { count: specialties } = await supabase.from('vismed_specialties').select('*', { count: 'exact', head: true });
      return json({ units: units || 0, doctors: doctors || 0, specialties: specialties || 0 });
    }

    if (req.method === 'GET' && segments.length === 2 && segments[1] === 'history') {
      const { data } = await supabase.from('sync_runs').select('*, sync_events(*)').eq('clinic_id', segments[0]).order('started_at', { ascending: false }).limit(20);
      return json((data || []).map(mapSyncRun));
    }

    if (req.method === 'POST' && segments.length === 3 && segments[1] === 'insurances' && segments[2] === 'push') {
        const clinicId = segments[0];
        const { insuranceProviderId } = await req.json();
        
        const pushTask = (async () => {
            try {
                const { data: conn } = await supabase.from('integration_connections').select('*').eq('clinic_id', clinicId).eq('provider', 'doctoralia').maybeSingle();
                if (!conn?.client_id) return;
                
                const client = new DocplannerClient(conn.domain || 'doctoralia.com.br', conn.client_id, conn.client_secret || '');
                await client.authenticate();
                
                const facRes = await client.getFacilities();
                for (const fac of (facRes?._items || [])) {
                    const facId = String(fac.id);
                    const drRes = await client.getDoctors(facId);
                    for (const dr of (drRes?._items || [])) {
                        const drId = String(dr.id);
                        const addrRes = await client.getAddresses(facId, drId);
                        for (const addr of (addrRes?._items || [])) {
                            const addrId = String(addr.id);
                            // Ensure we send insurance_provider_id as a number
                            await client.addAddressInsurance(facId, drId, addrId, { insurance_provider_id: Number(insuranceProviderId) }).catch(() => null);
                        }
                    }
                }
            } catch (err) {}
        })();

        if (typeof (globalThis as any).EdgeRuntime !== 'undefined') {
            (globalThis as any).EdgeRuntime.waitUntil(pushTask);
        }
        return json({ success: true, message: 'Processo de push iniciado em segundo plano.' });
    }

    if (req.method === 'POST' && segments.length === 2 && segments[1] === 'global') {
      const clinicId = segments[0];
      const body = await req.json().catch(() => ({}));
      const idEmpresaGestora = body.idEmpresaGestora || 286;

      const { data: vismedRun } = await supabase.from('sync_runs').insert({ clinic_id: clinicId, type: 'vismed-full', status: 'running' }).select().single();
      const { data: dpRun } = await supabase.from('sync_runs').insert({ clinic_id: clinicId, type: 'full', status: 'running' }).select().single();
      const runVMId = vismedRun!.id;
      const runDPId = dpRun!.id;

      const syncTask = (async () => {
        try {
          // 1. VisMed Sync
          try {
            const { data: connVM } = await supabase.from('integration_connections').select('*').eq('clinic_id', clinicId).eq('provider', 'vismed').maybeSingle();
            const baseUrl = connVM?.domain || undefined;
            const empId = connVM?.client_id ? Number(connVM.client_id) : idEmpresaGestora;
            let totalVM = 0;

            const unidades = await vismedRequest(`unidade-by-idempresagestora?idempresagestora=${empId}`, baseUrl);
            for (const u of (unidades || [])) {
              const { data: unitRecord } = await supabase.from('vismed_units').upsert({
                vismed_id: Number(u.idunidade), cod_unidade: u.codunidade ? Number(u.codunidade) : null, name: u.nomeunidade,
                cnpj: u.cnpj || u.cnpjcpfunidade, city_name: u.nomecidade, is_active: true
              }, { onConflict: 'vismed_id' }).select('id').single();
              // Pass NULL to doctoraliaId to keep it as unlinked VisMed record initially
              await upsertMapping(supabase, clinicId, 'LOCATION', null, { ...u, name: u.nomeunidade }, unitRecord?.id);
              totalVM++;
            }

            const convenios = await vismedRequest(`convenio-by-idempresagestora?idempresagestora=${empId}`, baseUrl);
            for (const c of (convenios || [])) {
               const name = c.nomeconvenio || 'Convênio sem nome';
               if (name.toUpperCase().includes('ORÇAMENTO') || String(c.ativo) !== '1') continue;
               const { data: insRecord } = await supabase.from('vismed_insurances').upsert({ vismed_id: Number(c.idconvenio), name, is_active: true }, { onConflict: 'vismed_id' }).select('id').single();
               await upsertMapping(supabase, clinicId, 'INSURANCE', null, { ...c, name: name }, insRecord?.id);
               totalVM++;
            }

            const profs = await vismedRequest(`profissionais-by-idempresagestora?idempresagestora=${empId}`, baseUrl);
            for (const p of (profs || [])) {
              if(!p.idprofissional) continue;
              const { data: docRecord } = await supabase.from('vismed_doctors').upsert({
                vismed_id: Number(p.idprofissional), name: p.nomecompleto || 'Sem Nome', formal_name: p.nomeformal, cpf: p.cpf, is_active: String(p.ativo) === '1'
              }, { onConflict: 'vismed_id' }).select('id').single();
              await upsertMapping(supabase, clinicId, 'DOCTOR', null, { ...p, name: p.nomecompleto }, docRecord?.id);
              totalVM++;
            }
            await supabase.from('sync_runs').update({ status: 'completed', ended_at: new Date().toISOString(), total_records: totalVM }).eq('id', runVMId);
          } catch (e: any) {
            await supabase.from('sync_runs').update({ status: 'failed', metrics: { error: e.message } }).eq('id', runVMId);
          }

          // 2. Doctoralia Sync
          try {
            const { data: conn } = await supabase.from('integration_connections').select('*').eq('clinic_id', clinicId).eq('provider', 'doctoralia').maybeSingle();
            if (conn?.client_id) {
              const client = new DocplannerClient(conn.domain || 'doctoralia.com.br', conn.client_id, conn.client_secret || '');
              await client.authenticate();
              let totalDP = 0;

              // 2.1 Fetch Global Catalog (Optimized to only run if catalog is small)
              const { count: currentCatCount } = await supabase.from('doctoralia_insurances').select('*', { count: 'exact', head: true });
              if ((currentCatCount || 0) < 500) {
                let offset = 0;
                while (offset < 1000) {
                  const providersRes = await client.getInsuranceProviders(offset);
                  const items = providersRes?._items || [];
                  if (items.length === 0) break;
                  for (const prov of items) {
                    await supabase.from('doctoralia_insurances').upsert({ 
                        doctoralia_insurance_id: String(prov.insurance_provider_id), 
                        name: prov.name, 
                        synced_at: new Date().toISOString() 
                    }, { onConflict: 'doctoralia_insurance_id' });
                  }
                  offset += 100;
                  if (items.length < 100) break;
                }
              }

              // 2.2 Facility Specific Sync
              const facRes = await client.getFacilities();
              const facilities = facRes?._items || [];
              for (const fac of facilities) {
                const facId = String(fac.id);
                // Passing NULL as vismedId during Doctoralia sync to keep it as unlinked DP record initially
                await upsertMapping(supabase, clinicId, 'LOCATION', facId, fac);
                
                // 2.2.1 Sync Doctors for this Facility
                const drRes = await client.getDoctors(facId);
                for (const dr of (drRes?._items || [])) {
                  const drId = String(dr.id);
                  const fullName = dr.surname ? `${dr.name} ${dr.surname}` : dr.name;
                  
                  // Upsert into doctoralia_doctors and get our internal UUID
                  const { data: dprofRecord } = await supabase.from('doctoralia_doctors').upsert({
                    doctoralia_doctor_id: drId,
                    doctoralia_facility_id: facId,
                    name: dr.name,
                    surname: dr.surname || '',
                    synced_at: new Date().toISOString()
                  }, { onConflict: 'doctoralia_doctor_id' }).select('id').single();
                  
                  // Pass a conflictData object that has the full name to the mapping
                  await upsertMapping(supabase, clinicId, 'DOCTOR', drId, { ...dr, name: fullName });

                  // NEW: If this doctor has a known VisMed mapping, ensure the unified table is also populated
                  const { data: m } = await supabase.from('mappings')
                    .select('vismed_id')
                    .eq('clinic_id', clinicId)
                    .eq('entity_type', 'DOCTOR')
                    .eq('external_id', drId)
                    .not('vismed_id', 'is', null)
                    .maybeSingle();

                  if (m?.vismed_id && dprofRecord?.id) {
                    await supabase.from('professional_unified_mappings').upsert({
                      vismed_doctor_id: m.vismed_id,
                      doctoralia_doctor_id: dprofRecord.id,
                      is_active: true
                    }, { onConflict: 'vismed_doctor_id,doctoralia_doctor_id' });
                  }
                  totalDP++;
                }

                const insRes = await client.getInsurances(facId);
                for(const ins of (insRes?._items || [])) {
                  const insId = String(ins.insurance_provider_id || ins.id);
                  await supabase.from('doctoralia_insurances').upsert({ 
                      doctoralia_insurance_id: insId, 
                      name: ins.name || 'Convênio Doc', 
                      synced_at: new Date().toISOString() 
                  }, { onConflict: 'doctoralia_insurance_id' });
                  
                  await upsertMapping(supabase, clinicId, 'INSURANCE', insId, ins);
                  totalDP++;
                }
              }
              await supabase.from('sync_runs').update({ status: 'completed', ended_at: new Date().toISOString(), total_records: totalDP }).eq('id', runDPId);
            }
          } catch (e: any) {
            await supabase.from('sync_runs').update({ status: 'failed', metrics: { error: e.message } }).eq('id', runDPId);
          }
        } catch (err: any) {
          console.error("Global Background Sync Failure:", err);
        }
      })();

      // Use EdgeRuntime.waitUntil if available (Standard Supabase)
      if (typeof (globalThis as any).EdgeRuntime !== 'undefined') {
        (globalThis as any).EdgeRuntime.waitUntil(syncTask);
      }

      return json({ success: true, vismedRunId: runVMId, doctoraliaRunId: runDPId });
    }
    return json({ error: 'Endpoint not found' }, 404);
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});
