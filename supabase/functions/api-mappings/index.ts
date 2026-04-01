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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const url = new URL(req.url);
  
  // Robust routing: get segments after the function name
  const allSegments = url.pathname.split('/').filter(Boolean);
  const funcIndex = allSegments.findIndex(s => s === 'api-mappings' || s === 'api-mappings-v2');
  let segments = funcIndex !== -1 ? allSegments.slice(funcIndex + 1) : allSegments;
  
  // Clinic ID priority: Search param (standard) -> First path segment (fallback)
  const clinicId = url.searchParams.get('clinicId') || (segments[0]?.length === 36 ? segments[0] : '');
  
  // If the first segment is the clinicId, shift segments so routing logic remains clean
  if (segments[0] === clinicId) segments.shift();

  try {
    // GET / — List all mappings
    if (req.method === 'GET' && segments.length === 0) {
      const entityType = url.searchParams.get('type');
      let query = supabase.from('mappings').select('*').eq('clinic_id', clinicId).order('updated_at', { ascending: false });
      if (entityType) query = query.eq('entity_type', entityType);
      const { data: mappings } = await query;
      if (!mappings) return json([]);

      // Enrich mappings with VisMed and Doctoralia data efficiently
      const mappedIds = mappings.filter((m: any) => !!m.vismed_id).map((m: any) => m.vismed_id);
      const extInsIds = mappings.filter((m: any) => m.entity_type === 'INSURANCE' && !!m.external_id).map((m: any) => m.external_id);
      
      const [doctorsData, servicesData, unitsData, insurancesData, dInsData] = await Promise.all([
        supabase.from('vismed_doctors').select('*').in('id', mappedIds),
        supabase.from('vismed_specialties').select('*').in('id', mappedIds),
        supabase.from('vismed_units').select('*').in('id', mappedIds),
        supabase.from('vismed_insurances').select('*').in('id', mappedIds),
        supabase.from('doctoralia_insurances').select('*').in('doctoralia_insurance_id', extInsIds),
      ]);

      const doctorsMap = new Map((doctorsData.data || []).map((d: any) => [d.id, d]));
      const servicesMap = new Map((servicesData.data || []).map((s: any) => [s.id, s]));
      const unitsMap = new Map((unitsData.data || []).map((u: any) => [u.id, u]));
      const insurancesMap = new Map((insurancesData.data || []).map((i: any) => [i.id, i]));
      const dInsMap = new Map((dInsData.data || []).map((i: any) => [i.doctoralia_insurance_id, i]));

      const result = mappings.map((m: any) => {
        let vismedEntity = null;
        if (m.vismed_id) {
          if (m.entity_type === 'DOCTOR') vismedEntity = doctorsMap.get(m.vismed_id);
          else if (m.entity_type === 'SERVICE') vismedEntity = servicesMap.get(m.vismed_id);
          else if (m.entity_type === 'LOCATION') vismedEntity = unitsMap.get(m.vismed_id);
          else if (m.entity_type === 'INSURANCE') vismedEntity = insurancesMap.get(m.vismed_id);
        }

        let doctoraliaCounterpart = null;
        if (m.entity_type === 'INSURANCE' && m.external_id) {
          doctoraliaCounterpart = dInsMap.get(m.external_id);
        }

        return { 
          id: m.id, 
          clinicId: m.clinic_id,
          vismedId: m.vismed_id, 
          externalId: m.external_id, 
          entityType: m.entity_type,
          status: m.status,
          conflictData: m.conflict_data,
          vismedEntity,
          doctoraliaCounterpart
        };
      });
      return json(result);
    }

    // POST /:id/resolve
    if (req.method === 'POST' && segments.length === 2 && segments[1] === 'resolve') {
      const body = await req.json();
      const { dataToKeep } = body;
      const { data: mapping } = await supabase.from('mappings').select('*').eq('id', segments[0]).single();
      if (!mapping || mapping.status !== 'CONFLICT') throw new Error('Not in conflict state');

      await supabase.from('audit_logs').insert({ action: 'RESOLVE_MAPPING_CONFLICT', entity: 'MAPPING', entity_id: segments[0], details: { dataToKeep, previousData: mapping.conflict_data } });
      const { data: updated } = await supabase.from('mappings').update({ status: 'LINKED', conflict_data: null, last_sync_at: new Date().toISOString() }).eq('id', segments[0]).select().single();
      return json(updated);
    }

    // GET /professionals
    if (req.method === 'GET' && segments[0] === 'professionals') {
      // Get generic doctor mappings
      const { data: genericMappings } = await supabase.from('mappings').select('*').eq('clinic_id', clinicId).eq('entity_type', 'DOCTOR');
      const mappingMap = new Map<string, any>();
      (genericMappings || []).forEach((m: any) => {
        if (m.vismed_id) mappingMap.set(m.vismed_id, m);
        if (m.external_id) mappingMap.set(m.external_id, m);
      });

      // 1. Get all doctors from this clinic (both linked and unlinked)
      const { data: mappings } = await supabase.from('mappings').select('vismed_id, external_id').eq('clinic_id', clinicId).eq('entity_type', 'DOCTOR');
      
      const directDrIds = (mappings || []).filter(m => m.vismed_id && m.vismed_id.length === 36).map(m => m.vismed_id);
      const vmDrIds = (mappings || []).filter(m => !m.vismed_id).map(m => Number(m.external_id)).filter(id => !isNaN(id));

      // 2. Combine direct UUIDs with IDs looked up from VisMed legacy IDs
      let drIds = [...directDrIds];
      if (vmDrIds.length > 0) {
        const { data: dbDrs } = await supabase.from('vismed_doctors').select('id').in('vismed_id', vmDrIds);
        drIds = Array.from(new Set([...drIds, ...(dbDrs || []).map(d => d.id)]));
      }

      // 3. Query doctors filtering by these IDs
      let doctorsQuery = supabase
        .from('vismed_doctors')
        .select(`
          *,
          vismed_units(*),
          vismed_professional_specialties(
            *,
            vismed_specialties(
              *,
              specialty_service_mappings(*, doctoralia_services(*))
            )
          ),
          professional_unified_mappings(
            *,
            doctoralia_doctors(
              *,
              doctoralia_address_services(*, doctoralia_services(*))
            )
          )
        `);
      
      if (clinicId && drIds.length > 0) {
        doctorsQuery = doctorsQuery.in('id', drIds);
      } else if (clinicId) {
        return json([]); // No doctors mapped to this clinic yet
      }
      
      const { data: doctors } = await doctorsQuery.order('name');

      // Helper to find the best mapping for a given Vissmed doctor ID
      const getBestMapping = (vismedId: string) => {
        const matches = (genericMappings || []).filter(m => m.vismed_id === vismedId);
        return matches.find(m => m.status === 'LINKED') || matches[0] || null;
      };

      // NEW: Fetch all doctoralia_doctors that have mappings for this clinic
      const externalIds = Array.from(new Set((genericMappings || []).map(m => m.external_id).filter(Boolean)));
      let dProfsMap = new Map<string, any>();
      if (externalIds.length > 0) {
        const { data: dProfs } = await supabase.from('doctoralia_doctors').select('*').in('doctoralia_doctor_id', externalIds);
        if (dProfs) dProfs.forEach(dp => dProfsMap.set(dp.doctoralia_doctor_id, dp));
      }

      const result = (doctors || []).map((d: any) => {
        const um = d.professional_unified_mappings?.find((u: any) => u.is_active);
        const externalId = um?.doctoralia_doctors?.doctoralia_doctor_id;
        const m = getBestMapping(d.id);
        const cd = m?.conflict_data || {};
        
        // Final Doctoralia identification
        const extProf = um?.doctoralia_doctors || (m?.external_id ? dProfsMap.get(m.external_id) : null);
        const drName = extProf ? (extProf.surname ? `${extProf.name} ${extProf.surname}` : extProf.name) : null;

        return {
          id: d.id, vismedId: d.vismed_id, name: d.name, formalName: d.formal_name,
          documentNumber: d.document_number, documentType: d.document_type,
          gender: d.gender, isActive: d.is_active,
          unit: d.vismed_units ? { name: d.vismed_units.name, city: d.vismed_units.city_name } : null,
          specialties: (() => {
            const rawSpecs = (d.vismed_professional_specialties || []).map((ps: any) => {
              const spec = ps.vismed_specialties;
              const activeMapping = spec?.specialty_service_mappings?.find((ssm: any) => ssm.is_active);
              return {
                id: spec?.id, name: spec?.name, normalizedName: spec?.normalized_name,
                activeMatch: activeMapping ? {
                  matchType: activeMapping.match_type, confidenceScore: activeMapping.confidence_score,
                  requiresReview: activeMapping.requires_review, doctoraliaService: activeMapping.doctoralia_services?.name
                } : null
              };
            });
            
            // De-duplicate by name, prioritizing records with an active mapping
            const uniqueMap = new Map<string, any>();
            rawSpecs.forEach((s: any) => {
              if (!s.name) return;
              const existing = uniqueMap.get(s.name);
              if (!existing || (!existing.activeMatch && s.activeMatch)) {
                uniqueMap.set(s.name, s);
              }
            });
            return Array.from(uniqueMap.values());
          })(),
          doctoraliaCounterpart: extProf ? {
            name: drName || extProf.name,
            doctoraliaDoctorId: extProf.doctoralia_doctor_id,
            calendarStatus: cd.calendarStatus || 'disabled',
            services: (extProf.doctoralia_address_services || []).map((as: any) => as.doctoralia_services?.name).filter(Boolean)
          } : (m?.external_id ? {
            name: (cd.name && cd.name !== d.name) ? cd.name : 'Perfil Doctoralia',
            doctoraliaDoctorId: m.external_id,
            calendarStatus: cd.calendarStatus || 'disabled', services: []
          } : null)
        };
      });
      return json(result);
    }

    // GET /units
    if (req.method === 'GET' && segments[0] === 'units') {
      const { data: mappings } = await supabase.from('mappings').select('vismed_id, external_id').eq('clinic_id', clinicId).eq('entity_type', 'LOCATION');
      
      const directUnitIds = (mappings || []).filter(m => m.vismed_id && m.vismed_id.length === 36).map(m => m.vismed_id);
      const vmUnitIds = (mappings || []).filter(m => !m.vismed_id).map(m => Number(m.external_id)).filter(id => !isNaN(id));
      
      let unitIds = [...directUnitIds];
      if (vmUnitIds.length > 0) {
        const { data: dbUnits } = await supabase.from('vismed_units').select('id').in('vismed_id', vmUnitIds);
        unitIds = Array.from(new Set([...unitIds, ...(dbUnits || []).map(u => u.id)]));
      }

      let unitsQuery = supabase
        .from('vismed_units')
        .select('*, vismed_doctors(id, name, is_active)');
        
      if (clinicId && unitIds.length > 0) {
        unitsQuery = unitsQuery.in('id', unitIds);
      } else if (clinicId) {
        return json([]);
      }
      
      const { data: units } = await unitsQuery.order('name');

      const result = await Promise.all((units || []).map(async (u: any) => {
        // Try linked mapping
        let { data: m } = await supabase.from('mappings').select('*').eq('clinic_id', clinicId).eq('entity_type', 'LOCATION').eq('vismed_id', u.id).not('external_id', 'is', null).single();

        if (!m) {
          // Try auto-link orphan Doctoralia mapping
          const { data: dpM } = await supabase.from('mappings').select('*').eq('clinic_id', clinicId).eq('entity_type', 'LOCATION').is('vismed_id', null).not('external_id', 'is', null).eq('status', 'UNLINKED').limit(1).single();

          if (dpM) {
            // Clean up dummy
            await supabase.from('mappings').delete().eq('clinic_id', clinicId).eq('entity_type', 'LOCATION').eq('vismed_id', u.id).is('external_id', null);
            const { data: updated } = await supabase.from('mappings').update({ vismed_id: u.id, status: 'LINKED' }).eq('id', dpM.id).select().single();
            m = updated;
          } else {
            const { data: vmOnly } = await supabase.from('mappings').select('*').eq('clinic_id', clinicId).eq('entity_type', 'LOCATION').eq('vismed_id', u.id).is('external_id', null).single();
            m = vmOnly;
          }
        }

        const cd = m?.conflict_data || {};
        return {
          id: u.id, vismedId: u.vismed_id, name: u.name, cityName: u.city_name, cnpj: u.cnpj,
          isActive: u.is_active, doctorCount: (u.vismed_doctors || []).length, doctors: u.vismed_doctors || [],
          doctoraliaCounterpart: m?.external_id ? { name: cd.name || u.name, externalId: m.external_id, status: m.status } : null
        };
      }));
      return json(result);
    }

    // GET /specialties/matches
    if (req.method === 'GET' && segments[0] === 'specialties' && segments[1] === 'matches') {
      const reviewParam = url.searchParams.get('requiresReview');
      
      // 1. Get all doctor IDs for this clinic to filter the pivot
      const { data: mappings } = await supabase.from('mappings').select('vismed_id, external_id').eq('clinic_id', clinicId).eq('entity_type', 'DOCTOR');
      
      const directDrIds = (mappings || []).filter(m => m.vismed_id && m.vismed_id.length === 36).map(m => m.vismed_id);
      const vmDrIds = (mappings || []).filter(m => !m.vismed_id).map(m => Number(m.external_id)).filter(id => !isNaN(id));

      let drIds = [...directDrIds];
      if (vmDrIds.length > 0) {
        const { data: dbDrs } = await supabase.from('vismed_doctors').select('id').in('vismed_id', vmDrIds);
        drIds = Array.from(new Set([...drIds, ...(dbDrs || []).map(d => d.id)]));
      }

      const { data: pivot } = await supabase
        .from('vismed_professional_specialties')
        .select('vismed_specialty_id')
        .in('vismed_doctor_id', drIds);
        
      const specialtyIds = Array.from(new Set((pivot || []).map(p => p.vismed_specialty_id)));
      
      if (specialtyIds.length === 0) return json([]);

      // 2. Query these specialties and their active AI mappings
      let query = supabase
        .from('vismed_specialties')
        .select('*, specialty_service_mappings(*, doctoralia_services(*))')
        .in('id', specialtyIds);
        
      const { data: specs } = await query;
      if (!specs) return json([]);

      // 3. Map to the frontend camelCase format
      const rawResults = specs.map((s: any) => {
        const activeMapping = s.specialty_service_mappings?.find((m: any) => m.is_active);
        
        // Filter by review status if param is present
        if (reviewParam === 'true' && !activeMapping?.requires_review) return null;
        if (reviewParam === 'false' && activeMapping?.requires_review) return null;

        return {
          id: s.id, // Specialty UUID
          vismedSpecialtyId: s.id,
          doctoraliaServiceId: activeMapping?.doctoralia_service_id || null,
          matchType: activeMapping?.match_type || 'NONE',
          confidenceScore: activeMapping?.confidence_score || 0,
          requiresReview: activeMapping?.requires_review || false,
          isActive: activeMapping?.is_active || false,
          vismedSpecialty: {
            name: s.name,
            normalizedName: s.normalized_name
          },
          doctoraliaService: activeMapping?.doctoralia_services ? {
            name: activeMapping.doctoralia_services.name
          } : null
        };
      }).filter(Boolean);

      // 4. De-duplicate by name, prioritizing records with an active mapping
      const uniqueSpecs = new Map<string, any>();
      rawResults.forEach((res: any) => {
        const name = res.vismedSpecialty?.name;
        if (!name) return;
        const existing = uniqueSpecs.get(name);
        if (!existing || (!existing.isActive && res.isActive)) {
          uniqueSpecs.set(name, res);
        }
      });

      return json(Array.from(uniqueSpecs.values()));
    }

    // POST /specialties/approve
    if (req.method === 'POST' && segments[0] === 'specialties' && segments[1] === 'approve') {
      const body = await req.json();
      const { data } = await supabase.from('specialty_service_mappings')
        .update({ requires_review: false })
        .eq('vismed_specialty_id', body.vismedSpecialtyId)
        .eq('doctoralia_service_id', body.doctoraliaServiceId)
        .select().single();
      await supabase.from('audit_logs').insert({ action: 'APPROVE_SPECIALTY_MATCH', entity: 'SPECIALTY_MAPPING', entity_id: `${body.vismedSpecialtyId}_${body.doctoraliaServiceId}`, details: { previousState: 'REQUIRES_REVIEW', newState: 'APPROVED' } });
      return json(data);
    }

    // POST /specialties/reject
    if (req.method === 'POST' && segments[0] === 'specialties' && segments[1] === 'reject') {
      const body = await req.json();
      const { data } = await supabase.from('specialty_service_mappings')
        .update({ is_active: false, requires_review: false })
        .eq('vismed_specialty_id', body.vismedSpecialtyId)
        .eq('doctoralia_service_id', body.doctoraliaServiceId)
        .select().single();
      await supabase.from('audit_logs').insert({ action: 'REJECT_SPECIALTY_MATCH', entity: 'SPECIALTY_MAPPING', entity_id: `${body.vismedSpecialtyId}_${body.doctoraliaServiceId}`, details: { reason: 'MANUAL_REJECTION' } });
      return json(data);
    }

    // POST /specialties/manual
    if (req.method === 'POST' && segments[0] === 'specialties' && segments[1] === 'manual') {
      const body = await req.json();
      // Deactivate previous
      await supabase.from('specialty_service_mappings').update({ is_active: false }).eq('vismed_specialty_id', body.vismedSpecialtyId).eq('is_active', true);
      // Upsert
      const { data } = await supabase.from('specialty_service_mappings').upsert({
        vismed_specialty_id: body.vismedSpecialtyId,
        doctoralia_service_id: body.doctoraliaServiceId,
        match_type: 'MANUAL', confidence_score: 1.0,
        requires_review: false, is_active: true
      }, { onConflict: 'vismed_specialty_id,doctoralia_service_id' }).select().single();
      await supabase.from('audit_logs').insert({ action: 'CREATE_MANUAL_SPECIALTY_MATCH', entity: 'SPECIALTY_MAPPING', entity_id: `${body.vismedSpecialtyId}_${body.doctoraliaServiceId}`, details: { source: 'MANUAL_OVERRIDE' } });
      return json(data);
    }

    // GET /insurances/catalog
    if (req.method === 'GET' && segments[0] === 'insurances' && segments[1] === 'catalog') {
        const { data } = await supabase.from('doctoralia_insurances').select('*').order('name');
        return json(data || []);
    }

    // GET /insurances (Specific for Mapping UI)
    if (req.method === 'GET' && segments[0] === 'insurances') {
        const { data: mappings } = await supabase.from('mappings').select('*').eq('clinic_id', clinicId).eq('entity_type', 'INSURANCE');
        const result = await Promise.all((mappings || []).map(async (m: any) => {
            let vismedEntity = null;
            if (m.vismed_id) {
                const { data } = await supabase.from('vismed_insurances').select('*').eq('id', m.vismed_id).single();
                vismedEntity = data;
            }
            
            let doctoraliaCounterpart = null;
            if (m.status === 'LINKED' && m.external_id) {
                const { data } = await supabase.from('doctoralia_insurances').select('*').eq('doctoralia_insurance_id', m.external_id).maybeSingle();
                doctoraliaCounterpart = data;
            }

            return {
                id: m.id,
                vismedId: m.vismed_id,
                externalId: m.external_id,
                status: m.status,
                vismedEntity,
                doctoraliaCounterpart
            };
        }));
        return json(result);
    }

    return json({ error: 'Not found' }, 404);
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});
