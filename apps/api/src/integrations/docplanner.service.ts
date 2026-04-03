import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class DocplannerClient {
    private readonly logger = new Logger(DocplannerClient.name);
    private accessToken: string;
    private baseUrl: string;
    private authPromise: Promise<string> | null = null;

    constructor(private configService: ConfigService) {}

    setAccessToken(token: string) {
        this.accessToken = token;
    }

    setBaseUrl(url: string) {
        this.baseUrl = url.replace(/\/$/, '');
    }

    private getBaseUrl(): string {
        return this.baseUrl || 'https://www.doctoralia.com.br';
    }

    async authenticate(clientId: string, clientSecret: string): Promise<string> {
        this.authPromise = (async () => {
            const domain = this.getBaseUrl().replace(/^https?:\/\//, '');
            const url = `https://${domain}/oauth/v2/token`;
            const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${basicAuth}`,
                },
                body: 'grant_type=client_credentials&scope=integration',
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to authenticate with Docplanner: ${response.status} ${errorText}`);
            }

            const data = await response.json() as any;
            this.accessToken = data.access_token;
            return this.accessToken;
        })();
        
        return this.authPromise;
    }

    private async request(method: string, path: string, data?: any): Promise<any> {
        if (this.authPromise) {
            await this.authPromise;
        }
        const domain = this.getBaseUrl().replace(/^https?:\/\//, '');
        const url = `https://${domain}${path}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        try {
            const headers: any = {
                'Authorization': `Bearer ${this.accessToken}`,
            };

            const options: RequestInit = {
                method,
                headers,
                signal: controller.signal,
            };

            if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
                headers['Content-Type'] = 'application/json';
                options.body = JSON.stringify(data);
            }

            this.logger.verbose(`Calling Docplanner API: ${method} ${url}`);
            const response = await fetch(url, options);

            if (method === 'PUT' || method === 'PATCH') {
                this.logger.log(`API Response: ${method} ${path} → status=${response.status}, content-type=${response.headers.get('content-type')}`);
            }

            if (!response.ok) {
                const errorText = await response.text();
                this.logger.error(`Docplanner API Error: ${response.status} ${errorText} URL: ${url}`);
                const error = new Error(`Docplanner API Error: ${response.status} ${errorText}`);
                (error as any).status = response.status;
                (error as any).details = errorText;
                throw error;
            }

            if (response.status === 204) {
                return null;
            }

            if (response.status === 201) {
                const location = response.headers.get('Location') || response.headers.get('location');
                let body = null;
                const text = await response.text();
                if (text && text.trim()) {
                    try { body = JSON.parse(text); } catch {}
                }
                return { ...(body || {}), _location: location, _status: 201 };
            }

            const text = await response.text();
            if (!text || !text.trim()) return null;
            try { return JSON.parse(text); } catch { return null; }
        } finally {
            clearTimeout(timeout);
        }
    }

    async getFacilities(): Promise<any> {
        return this.request('GET', '/api/v3/integration/facilities');
    }

    async getDoctors(facilityId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors`);
    }

    async getAddresses(facilityId: string, doctorId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses`);
    }

    async getServices(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/services`);
    }

    async getCalendarStatus(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/calendar`);
    }

    async getInsurances(facilityId: string): Promise<any> {
        try {
            return await this.request('GET', `/api/v3/integration/facilities/${facilityId}/insurances`);
        } catch (e) {
            return { _items: [] };
        }
    }

    async getInsuranceProviders(): Promise<any> {
        return this.request('GET', '/api/v3/integration/insurance-providers');
    }

    async getInsurancePlans(insuranceProviderId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/insurance-providers/${insuranceProviderId}/insurance-plans`);
    }

    async getAddressInsuranceProviders(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/insurance-providers`);
    }

    async addAddressInsuranceProvider(facilityId: string, doctorId: string, addressId: string, insuranceProviderId: string, insurancePlans?: { insurance_plan_id: string }[]): Promise<any> {
        const payload: any = { insurance_provider_id: String(insuranceProviderId) };
        if (insurancePlans && insurancePlans.length > 0) {
            payload.insurance_plans = insurancePlans;
        }
        return this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/insurance-providers`, payload);
    }

    async putAddressInsuranceProvider(facilityId: string, doctorId: string, addressId: string, insuranceProviderId: string, insurancePlans?: { insurance_plan_id: string }[]): Promise<any> {
        const payload: any = { insurance_provider_id: String(insuranceProviderId) };
        if (insurancePlans && insurancePlans.length > 0) {
            payload.insurance_plans = insurancePlans;
        }
        return this.request('PUT', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/insurance-providers`, payload);
    }

    async deleteAddressInsuranceProvider(facilityId: string, doctorId: string, addressId: string, insuranceProviderId: string): Promise<any> {
        return this.request('DELETE', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/insurance-providers/${insuranceProviderId}`);
    }

    async getFacilityServices(facilityId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/services`);
    }

    async getFacilityServicesCatalog(facilityId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/services/catalog`);
    }

    async getServicesDictionary(): Promise<any> {
        return this.request('GET', '/api/v3/integration/services');
    }

    async getBookings(facilityId: string, doctorId: string, addressId: string, start: string, end: string): Promise<any> {
        const s = start.includes('T') ? start : `${start}T00:00:00-03:00`;
        const e = end.includes('T') ? end : `${end}T23:59:59-03:00`;
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/bookings?start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}`);
    }

    async getSlots(facilityId: string, doctorId: string, addressId: string, start: string, end: string): Promise<any> {
        const s = start.includes('T') ? start : `${start}T00:00:00-03:00`;
        const e = end.includes('T') ? end : `${end}T23:59:59-03:00`;
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/slots?start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}`);
    }

    async replaceSlots(facilityId: string, doctorId: string, addressId: string, payload: any): Promise<any> {
        const slotCount = payload?.slots?.length || 0;
        this.logger.log(`replaceSlots: sending ${slotCount} slots for doctor ${doctorId}, address ${addressId}`);
        const result = await this.request('PUT', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/slots`, payload);
        this.logger.log(`replaceSlots: response=${JSON.stringify(result)}`);
        return result;
    }

    async bookSlot(facilityId: string, doctorId: string, addressId: string, slotStart: string, payload: any): Promise<any> {
        const encodedStart = encodeURIComponent(slotStart);
        return this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/slots/${encodedStart}/book`, payload);
    }

    async deleteSlots(facilityId: string, doctorId: string, addressId: string, date: string): Promise<any> {
        const dateOnly = date.includes('T') ? date.split('T')[0] : date;
        return this.request('DELETE', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/slots/${dateOnly}`);
    }

    async updateAddress(facilityId: string, doctorId: string, addressId: string, payload: any): Promise<any> {
        return this.request('PATCH', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}`, payload);
    }

    async addAddressService(facilityId: string, doctorId: string, addressId: string, payload: any): Promise<any> {
        return this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/services`, payload);
    }

    async updateAddressService(facilityId: string, doctorId: string, addressId: string, serviceId: string, payload: any): Promise<any> {
        return this.request('PATCH', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/services/${serviceId}`, payload);
    }

    async deleteAddressService(facilityId: string, doctorId: string, addressId: string, serviceId: string): Promise<any> {
        return this.request('DELETE', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/services/${serviceId}`);
    }

    async enableCalendar(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        this.logger.log(`enableCalendar: POST .../addresses/${addressId}/calendar/enable`);
        const result = await this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/calendar/enable`);
        this.logger.log(`enableCalendar: response=${JSON.stringify(result)}`);
        return result;
    }

    async disableCalendar(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        this.logger.log(`disableCalendar: POST .../addresses/${addressId}/calendar/disable`);
        const result = await this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/calendar/disable`);
        this.logger.log(`disableCalendar: response=${JSON.stringify(result)}`);
        return result;
    }

    async getCalendar(facilityId: string, doctorId: string, addressId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/calendar`);
    }

    async getCalendarBreaks(facilityId: string, doctorId: string, addressId: string, since?: string): Promise<any> {
        let path = `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/breaks`;
        if (since) path += `?since=${encodeURIComponent(since)}`;
        return this.request('GET', path);
    }

    async addCalendarBreak(facilityId: string, doctorId: string, addressId: string, payload: { since: string; till: string }): Promise<any> {
        return this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/breaks`, payload);
    }

    async getCalendarBreak(facilityId: string, doctorId: string, addressId: string, breakId: string): Promise<any> {
        return this.request('GET', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/breaks/${breakId}`);
    }

    async moveCalendarBreak(facilityId: string, doctorId: string, addressId: string, breakId: string, payload: { since: string; till: string }): Promise<any> {
        return this.request('PUT', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/breaks/${breakId}`, payload);
    }

    async deleteCalendarBreak(facilityId: string, doctorId: string, addressId: string, breakId: string): Promise<any> {
        return this.request('DELETE', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/breaks/${breakId}`);
    }

    async cancelBooking(facilityId: string, doctorId: string, addressId: string, bookingId: string, reason?: string): Promise<any> {
        this.logger.log(`cancelBooking: DELETE booking ${bookingId} for doctor ${doctorId}`);
        const body = reason ? { reason } : undefined;
        return this.request('DELETE', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/bookings/${bookingId}`, body);
    }

    async moveBooking(facilityId: string, doctorId: string, addressId: string, bookingId: string, payload: {
        address_service_id: number;
        duration: number;
        start: string;
        address_id?: number;
    }): Promise<any> {
        this.logger.log(`moveBooking: POST move booking ${bookingId} to ${payload.start}`);
        return this.request('POST', `/api/v3/integration/facilities/${facilityId}/doctors/${doctorId}/addresses/${addressId}/bookings/${bookingId}/move`, payload);
    }

    async getNotifications(limit: number = 100): Promise<any> {
        return this.request('GET', `/api/v3/integration/notifications/multiple?limit=${limit}`);
    }

    async releaseFailedNotifications(): Promise<any> {
        this.logger.log('releaseFailedNotifications: triggering re-queue of failed notifications');
        return this.request('POST', '/api/v3/integration/notifications/release');
    }
}

@Injectable()
export class DocplannerService {
    constructor(private configService: ConfigService) { }

    createClient(domain: string, clientId: string, clientSecret: string): DocplannerClient {
        const client = new DocplannerClient(this.configService);
        client.setBaseUrl(domain);
        // We start authentication but don't await here to match existing sync usage pattern.
        // In a real scenario, the first call to the client would await this or authenticate would be called explicitly.
        client.authenticate(clientId, clientSecret).catch(err => {
            console.error('Docplanner background authentication failed:', err.message);
        });
        return client;
    }
}
