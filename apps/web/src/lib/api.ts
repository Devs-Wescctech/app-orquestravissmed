/**
 * API Compatibility Layer — Drop-in replacement for the old axios-based api.
 * 
 * Maps all existing api.get() / api.post() calls to Supabase Edge Functions.
 * The frontend code can continue using api.get('/auth/profile') etc.
 */
import { callEdgeFunction, supabase } from './supabase';
import Cookies from 'js-cookie';

// Route mapping: old NestJS path → Edge Function name + sub-path
function resolveRoute(url: string): { fn: string; path: string } {
  const clean = url.replace(/^\/+/, '');
  
  if (clean.startsWith('auth/')) return { fn: 'api-auth', path: '/' + clean.replace('auth/', '') };
  if (clean.startsWith('users'))  return { fn: 'api-users', path: '/' + clean.replace('users', '') };
  if (clean.startsWith('clinics')) return { fn: 'api-clinics', path: '/' + clean.replace('clinics', '') };
  if (clean.startsWith('doctors')) return { fn: 'api-doctors', path: '/' + clean.replace('doctors', '') };
  if (clean.startsWith('appointments')) return { fn: 'api-appointments', path: '/' + clean.replace('appointments', '') };
  if (clean.startsWith('mappings')) return { fn: 'api-mappings-v2', path: '/' + clean.replace('mappings', '') };
  if (clean.startsWith('sync'))  return { fn: 'api-sync-v10', path: '/' + clean.replace('sync', '') };
  
  // Default fallback
  return { fn: 'api-auth', path: '/' + clean };
}

function extractParams(url: string): { basePath: string; params: Record<string, string> } {
  const [basePath, queryString] = url.split('?');
  const params: Record<string, string> = {};
  if (queryString) {
    new URLSearchParams(queryString).forEach((v, k) => {
      params[k] = v;
    });
  }
  return { basePath, params };
}

// Axios-compatible wrapper
export const api = {
  async get(url: string, config?: any) {
    const { basePath, params } = extractParams(url);
    const route = resolveRoute(basePath);
    const allParams = { ...params, ...config?.params };
    const data = await callEdgeFunction(route.fn, {
      method: 'GET',
      path: route.path,
      params: Object.keys(allParams).length ? allParams : undefined,
    });
    return { data, status: 200 };
  },
  
  async post(url: string, body?: any, config?: any) {
    const { basePath, params } = extractParams(url);
    const route = resolveRoute(basePath);
    const allParams = { ...params, ...config?.params };
    const data = await callEdgeFunction(route.fn, {
      method: 'POST',
      path: route.path,
      body,
      params: Object.keys(allParams).length ? allParams : undefined,
    });
    return { data, status: 200 };
  },
  
  async put(url: string, body?: any, config?: any) {
    const { basePath, params } = extractParams(url);
    const route = resolveRoute(basePath);
    const allParams = { ...params, ...config?.params };
    const data = await callEdgeFunction(route.fn, {
      method: 'PUT',
      path: route.path,
      body,
      params: Object.keys(allParams).length ? allParams : undefined,
    });
    return { data, status: 200 };
  },
  
  async delete(url: string, config?: any) {
    const { basePath, params } = extractParams(url);
    const route = resolveRoute(basePath);
    const allParams = { ...params, ...config?.params };
    const data = await callEdgeFunction(route.fn, {
      method: 'DELETE',
      path: route.path,
      params: Object.keys(allParams).length ? allParams : undefined,
    });
    return { data, status: 200 };
  },
  
  async patch(url: string, body?: any, config?: any) {
    const { basePath, params } = extractParams(url);
    const route = resolveRoute(basePath);
    const allParams = { ...params, ...config?.params };
    const data = await callEdgeFunction(route.fn, {
      method: 'PATCH',
      path: route.path,
      body,
      params: Object.keys(allParams).length ? allParams : undefined,
    });
    return { data, status: 200 };
  },
};
