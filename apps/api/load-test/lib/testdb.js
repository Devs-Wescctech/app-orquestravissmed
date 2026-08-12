'use strict';
/**
 * Postgres de teste efêmero: cluster novo via initdb em diretório do harness,
 * escutando SOMENTE em 127.0.0.1, banco `loadtest_db`. Criado e destruído
 * exclusivamente pelo runner (teardown = pg_ctl stop + rm -rf do cluster).
 */
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PG_PORT = 55442;
const DB_NAME = 'loadtest_db';
const DB_USER = 'loadtester';

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
    if (r.status !== 0) {
        throw new Error(`[TESTDB] ${cmd} ${args.join(' ')} falhou (exit ${r.status}):\n${r.stderr || r.stdout}`);
    }
    return r.stdout;
}

class TestDb {
    constructor(runtimeDir) {
        this.dataDir = path.join(runtimeDir, 'pg');
        this.logFile = path.join(runtimeDir, 'pg.log');
        this.port = PG_PORT;
        this.url = `postgresql://${DB_USER}@127.0.0.1:${PG_PORT}/${DB_NAME}`;
        this.adminUrl = `postgresql://${DB_USER}@127.0.0.1:${PG_PORT}/postgres`;
    }

    create() {
        this.destroy(); // limpa restos de execução anterior
        fs.mkdirSync(this.dataDir, { recursive: true });
        run('initdb', ['-D', this.dataDir, '-U', DB_USER, '-A', 'trust', '--no-sync']);
        // pg_stat_statements se disponível; listen só em loopback.
        fs.appendFileSync(path.join(this.dataDir, 'postgresql.conf'), [
            '', `port = ${PG_PORT}`, "listen_addresses = '127.0.0.1'",
            "unix_socket_directories = ''",
            "shared_preload_libraries = 'pg_stat_statements'",
            'fsync = off', 'full_page_writes = off',
        ].join('\n') + '\n');
        try {
            run('pg_ctl', ['-D', this.dataDir, '-l', this.logFile, '-w', 'start']);
        } catch (err) {
            // pg_stat_statements pode não existir no build — remove e tenta de novo.
            const conf = path.join(this.dataDir, 'postgresql.conf');
            fs.writeFileSync(conf, fs.readFileSync(conf, 'utf8').replace(/^shared_preload_libraries.*$/m, ''));
            run('pg_ctl', ['-D', this.dataDir, '-l', this.logFile, '-w', 'start']);
            this.statStatementsUnavailable = true;
        }
        run('createdb', ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', DB_USER, DB_NAME]);
        if (!this.statStatementsUnavailable) {
            try {
                run('psql', ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', DB_USER, '-d', DB_NAME,
                    '-c', 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements']);
            } catch { this.statStatementsUnavailable = true; }
        }
        return this.url;
    }

    /** Aplica o schema Prisma no banco de teste (sem tocar o banco de dev). */
    pushSchema(apiDir) {
        run('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
            cwd: apiDir,
            env: { ...process.env, DATABASE_URL: this.url },
        });
    }

    isRunning() {
        const r = spawnSync('pg_ctl', ['-D', this.dataDir, 'status'], { encoding: 'utf8' });
        return r.status === 0;
    }

    destroy() {
        if (fs.existsSync(this.dataDir)) {
            spawnSync('pg_ctl', ['-D', this.dataDir, '-m', 'immediate', 'stop'], { encoding: 'utf8' });
            fs.rmSync(this.dataDir, { recursive: true, force: true });
        }
    }
}

module.exports = { TestDb, PG_PORT, DB_NAME };
