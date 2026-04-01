import { api } from './api';

export async function fetchProfessionalMappings(clinicId: string) {
  try {
    const response = await api.get('/mappings/professionals', { 
      params: { clinicId } 
    });
    return response.data || [];
  } catch (error) {
    console.error('fetchProfessionalMappings error:', error);
    return [];
  }
}

export async function fetchSpecialtyMatches(clinicId: string, requiresReview?: boolean) {
  try {
    const response = await api.get('/mappings/specialties/matches', { 
      params: { clinicId, requiresReview } 
    });
    return response.data || [];
  } catch (error) {
    console.error('fetchSpecialtyMatches error:', error);
    return [];
  }
}

export async function fetchUnitMappings(clinicId: string) {
  try {
    const response = await api.get('/mappings/units', { 
      params: { clinicId } 
    });
    return response.data || [];
  } catch (error) {
    console.error('fetchUnitMappings error:', error);
    return [];
  }
}

export async function fetchLegacyMappings(clinicId: string, type: string) {
  try {
    const response = await api.get('/mappings', { 
      params: { clinicId, type } 
    });
    return response.data || [];
  } catch (error) {
    console.error('fetchLegacyMappings error:', error);
    return [];
  }
}
