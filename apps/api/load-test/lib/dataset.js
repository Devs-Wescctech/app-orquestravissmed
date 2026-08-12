'use strict';
/**
 * Gerador de dataset sintético determinístico (por seed) para o harness WP-12A.
 * O dataset alimenta simultaneamente:
 *  - o seed do banco Postgres de teste (via lib/seed.js)
 *  - as fixtures dos mocks Doctoralia (HTTPS) e VisMed (HTTPS)
 * Assim, mock ↔ banco são coerentes por construção.
 */
const { makeRng } = require('./rng');
const { PROFILES } = require('./profiles');

const FIRST = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fábio', 'Gabriela', 'Hugo', 'Iara', 'João', 'Karina', 'Luís'];
const LAST = ['Silva', 'Souza', 'Oliveira', 'Pereira', 'Costa', 'Rodrigues', 'Almeida', 'Nascimento', 'Lima', 'Araújo'];
const SPECS = ['Cardiologia', 'Dermatologia', 'Ortopedia', 'Pediatria', 'Clínica Geral', 'Neurologia', 'Ginecologia'];
const INSURANCES = ['Unimed Teste', 'Bradesco Saúde Teste', 'SulAmérica Teste', 'Amil Teste'];

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

/** Data local YYYY-MM-DD, com offset em dias a partir de hoje (00:00). */
function dateStr(daysFromNow) {
    const d = new Date();
    d.setDate(d.getDate() + daysFromNow);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Gera o dataset completo.
 * @param {object} opts { profile: 'small'|'medium'|'heavy', seed: string|number, clinics: number,
 *                        doctoraliaHost: '127.0.0.1:45443', vismedBaseUrl: 'https://127.0.0.1:45444' }
 */
function generateDataset(opts) {
    const profile = PROFILES[opts.profile];
    if (!profile) throw new Error(`Perfil desconhecido: ${opts.profile}`);
    const rng = makeRng(`${opts.seed}|${opts.profile}|${opts.clinics}`);
    const clinics = [];

    for (let c = 1; c <= opts.clinics; c++) {
        const empresaId = 1000 + c;
        const facilityId = `LT-FAC-${c}`;
        const unitVismedId = 9000 + c;
        const clinic = {
            id: `lt-clinic-${c}`,
            name: `Clínica LoadTest ${c}`,
            empresaId,
            facilityId,
            doctoralia: {
                domain: opts.doctoraliaHost,           // domínio "nu" — o cliente força https://
                clientId: `lt-client-${c}`,
                clientSecret: `lt-secret-${c}`,
            },
            vismed: {
                domain: opts.vismedBaseUrl,            // baseUrl completo com esquema
                clientId: String(empresaId),
            },
            unit: {
                vismedId: unitVismedId,
                codUnidade: c,
                name: `Unidade LT ${c}`,
                cnpj: `00.000.00${c}/0001-0${c}`,
                cityName: 'São Paulo',
            },
            specialties: [],
            insurances: [],
            doctors: [],
            vismedAppointments: [],
        };

        for (let s = 0; s < profile.specialtiesPerClinic; s++) {
            clinic.specialties.push({
                vismedId: c * 100 + s + 1,
                name: `${SPECS[(c + s) % SPECS.length]}`,
            });
        }
        for (let i = 0; i < profile.insurancesPerClinic; i++) {
            clinic.insurances.push({
                vismedId: c * 100 + i + 1,
                name: INSURANCES[(c + i) % INSURANCES.length],
            });
        }

        for (let d = 1; d <= profile.doctorsPerClinic; d++) {
            const first = FIRST[rng.int(0, FIRST.length - 1)];
            const last = LAST[rng.int(0, LAST.length - 1)];
            const vismedDoctorId = empresaId * 100 + d;
            const doctoraliaDoctorId = `LT-DOC-${c}-${d}`;
            const spec = clinic.specialties[d % clinic.specialties.length];
            const doctor = {
                vismedId: vismedDoctorId,
                doctoraliaDoctorId,
                name: `${first} ${last}`,
                formalName: `Dr(a). ${first} ${last}`,
                cpf: `${pad(rng.int(100, 999), 3)}.${pad(rng.int(100, 999), 3)}.${pad(rng.int(100, 999), 3)}-${pad(rng.int(10, 99))}`,
                crm: `CRM${pad(rng.int(10000, 99999), 5)}`,
                gender: rng.pick(['M', 'F']),
                specialtyVismedId: spec.vismedId,
                specialtyName: spec.name,
                turnoM: '08:00 - 12:00',
                turnoT: '13:00 - 18:00',
                addresses: [],
                doctoraliaBookings: [],
            };

            for (let a = 1; a <= profile.addressesPerDoctor; a++) {
                const addressId = `LT-ADDR-${c}-${d}-${a}`;
                const address = { id: addressId, name: `Consultório ${a}`, services: [] };
                for (let s = 1; s <= profile.servicesPerAddress; s++) {
                    address.services.push({
                        id: `LT-ADDRSVC-${c}-${d}-${a}-${s}`,   // address_service link id
                        service_id: `LT-SVC-${c}-${s}`,
                        name: `Consulta ${spec.name}${s > 1 ? ` ${s}` : ''}`,
                        default_duration: 30,
                        price: rng.int(100, 500),
                        is_price_from: false,
                    });
                }
                doctor.addresses.push(address);
            }

            // Slots determinísticos (scheduleDay): mesmos horários todo dia útil.
            doctor.slotTimes = [];
            for (let s = 0; s < profile.slotsPerDay; s++) {
                const hour = 8 + Math.floor(s / 2);
                const min = (s % 2) * 30;
                doctor.slotTimes.push(`${pad(hour)}:${pad(min)}`);
            }

            // Bookings pré-existentes do lado Doctoralia (aparecem no sweep).
            for (let b = 1; b <= profile.doctoraliaBookingsPerDoctor; b++) {
                const day = dateStr(b + 1);
                const time = doctor.slotTimes[b % doctor.slotTimes.length];
                doctor.doctoraliaBookings.push({
                    id: `LT-BOOK-${c}-${d}-${b}`,
                    start_at: `${day}T${time}:00-03:00`,
                    end_at: `${day}T${time}:00-03:00`,
                    booked_at: `${dateStr(0)}T08:00:00-03:00`,
                    status: 'booked',
                    canceled: false,
                    patient: {
                        name: `${FIRST[rng.int(0, FIRST.length - 1)]}`,
                        surname: LAST[rng.int(0, LAST.length - 1)],
                        phone: `+55119${pad(rng.int(10000000, 99999999), 8)}`,
                    },
                });
            }
            clinic.doctors.push(doctor);
        }

        // Agendamentos pré-existentes do lado VisMed (aparecem no poll VisMed).
        for (let v = 1; v <= profile.vismedAppointmentsPerUnit; v++) {
            const doc = clinic.doctors[v % clinic.doctors.length];
            const day = dateStr(v + 2);
            const time = doc.slotTimes[(v * 2) % doc.slotTimes.length];
            const [hh, mm] = time.split(':').map(Number);
            const endTime = `${pad(mm === 30 ? hh + 1 : hh)}:${pad(mm === 30 ? 0 : 30)}`;
            clinic.vismedAppointments.push({
                idpacienteagendamento: empresaId * 1000 + v,
                dataagendamento: day,
                horarioagendamento: time,
                horarioagendamentofinal: endTime,
                idprofissional: doc.vismedId,
                nomepaciente: `Paciente VM ${c}-${v}`,
                telefonepaciente: `+55118${pad(rng.int(10000000, 99999999), 8)}`,
                cancelado: '0',
                naocompareceu: '0',
                confirmado: '0',
                agendamentoonline: '0',
                idpaciente: empresaId * 10 + v,
            });
        }

        clinics.push(clinic);
    }

    return {
        seed: String(opts.seed),
        profile: profile.name,
        generatedAtNote: 'datas relativas a "hoje" no momento da geração',
        superAdmin: { email: 'loadtest-admin@example.com', password: 'loadtest-password-1' },
        clinics,
        profileConfig: profile,
    };
}

module.exports = { generateDataset };
