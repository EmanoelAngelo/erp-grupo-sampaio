#!/usr/bin/env node
/**
 * STACK DESCARTÁVEL — API + frontend sobre um banco novo, sem tocar na instalação da loja.
 *
 * Uso:
 *   node scripts/stack-descartavel.mjs --api 19050 --front 19060 [--semear] [--banco <arquivo.db>]
 *
 * Por que existe: durante a auditoria de prontidão, testes da própria auditoria
 * chegaram à API de produção (porta 8787), que gravou linhas no banco
 * operacional. Quem sobe uma stack de teste precisa de um caminho em que o erro
 * seja impossível, não só improvável. Este script:
 *
 *  - recusa as portas da instalação (8787 e 3000) e qualquer porta abaixo de 1024;
 *  - recusa banco que seja o operacional (`server/data/grupo-sampaio.db` de
 *    qualquer árvore) ou que não esteja numa pasta temporária do sistema;
 *  - liga `DEVORA_IGNORE_DOTENV=true`, para o `.env` da máquina (com credenciais
 *    reais) não entrar;
 *  - anuncia o banco como descartável (`TEST_DATABASE_PATH` = `DEVORA_DATABASE_PATH`);
 *  - desliga provedores reais: sem Supabase, sem SMTP, sem Asaas de produção,
 *    `DEVORA_API_ENV=test`;
 *  - aponta o frontend para a API descartável (`VITE_API_BASE_URL`).
 *
 * `--semear` roda, antes de subir, o BOOTSTRAP de produção (as seis empresas,
 * as bancadas e o `admin`) e o SEED DE DESENVOLVIMENTO (CARLOSGERENTE,
 * `<slug>.pdv`, mecânicos). As senhas vêm do ambiente de quem chama:
 * `DEVORA_BOOTSTRAP_ADMIN_PASSWORD` (obrigatória com `--semear`: é a senha do
 * admin desta pilha) e, se quiser senhas conhecidas para as contas de
 * demonstração, `GRUPO_SAMPAIO_MANAGEMENT_PASSWORD` e
 * `GRUPO_SAMPAIO_OPERATION_PASSWORD` — sem elas, cada conta ganha uma senha
 * gerada, impressa uma vez. Todas nascem provisórias.
 *
 * Encerre com Ctrl+C; os dois processos morrem juntos.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORTAS_DA_INSTALACAO = new Set([8787, 3000]);

function argumento(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  if (i < 0) return padrao;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

export function validarPorta(valor, rotulo) {
  const porta = Number(valor);
  if (!Number.isInteger(porta) || porta < 1024 || porta > 65535) {
    throw new Error(`${rotulo}: porta inválida (${valor}). Use uma porta entre 1024 e 65535.`);
  }
  if (PORTAS_DA_INSTALACAO.has(porta)) {
    throw new Error(`${rotulo}: a porta ${porta} é da instalação da loja. Stack descartável nunca usa 8787 nem 3000.`);
  }
  return porta;
}

export function validarBanco(caminho) {
  const absoluto = resolve(caminho);
  const normal = absoluto.replace(/\\/g, '/').toLowerCase();
  if (basename(normal) === 'grupo-sampaio.db' || normal.endsWith('/server/data/grupo-sampaio.db')) {
    throw new Error(`Banco recusado: ${absoluto} é o banco operacional (ou tem o nome dele).`);
  }
  const temp = resolve(tmpdir()).replace(/\\/g, '/').toLowerCase();
  if (!normal.startsWith(temp + '/')) {
    throw new Error(`Banco recusado: ${absoluto} não está na pasta temporária do sistema (${tmpdir()}).`);
  }
  return absoluto;
}

function main() {
  const semear = argumento('semear', false) === true;
  if (semear && !(process.env.DEVORA_BOOTSTRAP_ADMIN_PASSWORD ?? '').trim()) {
    throw new Error(
      '--semear precisa de DEVORA_BOOTSTRAP_ADMIN_PASSWORD no ambiente de quem chama: é a senha do admin desta pilha '
        + '(provisória). GRUPO_SAMPAIO_MANAGEMENT_PASSWORD e GRUPO_SAMPAIO_OPERATION_PASSWORD, se definidas, viram as '
        + 'senhas das contas de demonstração.',
    );
  }
  const portaApi = validarPorta(argumento('api', 19050), 'API');
  const portaFront = validarPorta(argumento('front', portaApi + 10), 'Frontend');
  const pasta = mkdtempSync(join(tmpdir(), 'devora-stack-'));
  const banco = validarBanco(argumento('banco', join(pasta, 'stack.db')));
  const uploads = join(pasta, 'uploads');
  mkdirSync(uploads, { recursive: true });

  const ambiente = {
    ...process.env,
    DEVORA_IGNORE_DOTENV: 'true',
    DEVORA_API_ENV: 'test',
    NODE_ENV: 'development',
    DEVORA_API_PORT: String(portaApi),
    DEVORA_DATABASE_PATH: banco,
    TEST_DATABASE_PATH: banco,
    DEVORA_UPLOADS_DIR: uploads,
    DEVORA_BACKUP_DIR: join(pasta, 'backups'),
    DEVORA_FRONTEND_ORIGIN: `http://localhost:${portaFront}`,
    DEVORA_SUPABASE_URL: '',
    DEVORA_SUPABASE_SERVICE_KEY: '',
    EMAIL_ENABLED: 'false',
    ASAAS_PRODUCTION_ENABLED: 'false',
    VITE_API_BASE_URL: `http://localhost:${portaApi}`,
  };

  console.log(`[stack] pasta descartável: ${pasta}`);
  console.log(`[stack] banco: ${banco}`);
  console.log(`[stack] API: http://localhost:${portaApi} · frontend: http://localhost:${portaFront}`);

  const filhos = [];
  const tsx = join(RAIZ, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (semear) {
    console.log('[stack] bootstrap (empresas, bancadas, admin) e seed de desenvolvimento (contas de demonstração)…');
    semearEmOrdem(['src/db/bootstrap-cli.ts', 'src/db/seedDeDesenvolvimento-cli.ts']);
  } else subir();

  function semearEmOrdem(passos) {
    const [passo, ...resto] = passos;
    if (!passo) { subir(); return; }
    const r = spawn(process.execPath, [tsx, passo], { cwd: join(RAIZ, 'server'), env: ambiente, stdio: 'inherit' });
    r.on('exit', (code) => { if (code !== 0) { console.error(`[stack] ${passo} falhou`); process.exit(code ?? 1); } semearEmOrdem(resto); });
  }

  function subir() {
    filhos.push(spawn(process.execPath, [tsx, 'src/index.ts'], { cwd: join(RAIZ, 'server'), env: ambiente, stdio: 'inherit' }));
    const vite = join(RAIZ, 'node_modules', 'vite', 'bin', 'vite.js');
    if (existsSync(vite)) {
      filhos.push(spawn(process.execPath, [vite, '--port', String(portaFront), '--strictPort', '--host', 'localhost'], { cwd: RAIZ, env: ambiente, stdio: 'inherit' }));
    }
  }
  const encerrar = () => { for (const f of filhos) { try { f.kill(); } catch { /* já morto */ } } process.exit(0); };
  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { main(); } catch (e) { console.error(`[stack] ${e.message}`); process.exit(2); }
}
