// E2E DA PREÇO JUSTO — sobe a pilha DESCARTÁVEL da árvore indicada (API 19592, tela 19602, banco novo numa
// pasta temporária, BOOTSTRAP de produção com os logins padrão), roda o E2E contra ela e derruba tudo.
// Nunca toca 8787/3000 nem o banco operacional. Todas as senhas nascem aleatórias a cada execução e só
// passam pelo ambiente dos filhos: nada é impresso nem gravado.
// uso: node rodar-e2e-pj.cjs <repo> <saida.txt>
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const [repo, saida] = process.argv.slice(2);
if (!repo || !saida) throw new Error('uso: node rodar-e2e-pj.cjs <repo> <saida.txt>');
const AQUI = __dirname;
const API = 19592;
const FRONT = 19602;
const senha = (p) => `${p}!${crypto.randomBytes(18).toString('base64url')}9z`;
const SENHAS = {
  admin: senha('Ad'),
  logins: senha('Lg'),
  gestao: senha('Gs'),
  operacao: senha('Op'),
};

const portaLivre = (p) => new Promise((ok) => {
  const s = net.createServer().once('error', () => ok(false)).once('listening', () => s.close(() => ok(true))).listen(p, 'localhost');
});
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (const p of [API, FRONT]) if (!(await portaLivre(p))) throw new Error(`porta ${p} ocupada — outra pilha no ar?`);
  const logPilha = fs.openSync(path.join(AQUI, 'stackE2E-pj.log'), 'w');
  const pilha = spawn(process.execPath, ['scripts/stack-descartavel.mjs', '--api', String(API), '--front', String(FRONT), '--semear'], {
    cwd: repo,
    env: {
      ...process.env,
      DEVORA_BOOTSTRAP_ADMIN_PASSWORD: SENHAS.admin,
      DEVORA_BOOTSTRAP_LOGINS_PASSWORD: SENHAS.logins,
      GRUPO_SAMPAIO_MANAGEMENT_PASSWORD: SENHAS.gestao,
      GRUPO_SAMPAIO_OPERATION_PASSWORD: SENHAS.operacao,
    },
    stdio: ['ignore', logPilha, logPilha],
  });
  const derrubar = () => { try { execFileSync('taskkill', ['/PID', String(pilha.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* já caiu */ } };
  let codigo = 1;
  try {
    let saude = false;
    for (let i = 0; i < 150 && !saude; i += 1) {
      await esperar(2000);
      if (pilha.exitCode !== null) throw new Error(`a pilha saiu com ${pilha.exitCode} (ver stackE2E-pj.log)`);
      try { saude = (await fetch(`http://localhost:${API}/api/v1/health`)).status === 200; } catch { /* ainda subindo */ }
    }
    if (!saude) throw new Error('a API descartável não respondeu /health em 300 s');
    const out = fs.openSync(saida, 'w');
    const e2e = spawn(process.execPath, [path.join(AQUI, 'e2e', 'e2e-preco-justo.mjs')], {
      cwd: path.join(AQUI, 'e2e'),
      env: { ...process.env, E2E_ADMIN_PASSWORD: SENHAS.admin, E2E_LOGINS_PASSWORD: SENHAS.logins, E2E_API_PORT: String(API) },
      stdio: ['ignore', out, out],
    });
    codigo = await new Promise((r) => e2e.on('exit', (c) => r(c ?? 1)));
  } finally {
    derrubar();
    await esperar(1500);
    try { execFileSync('git', ['-C', repo, 'checkout', '--', 'auto-imports.d.ts'], { stdio: 'ignore' }); } catch { /* sem mudança */ }
  }
  const texto = fs.readFileSync(saida, 'utf8');
  for (const s of Object.values(SENHAS)) if (texto.includes(s)) { console.error('[rodar-e2e-pj] SENHA NA SAÍDA — relatório descartado'); fs.writeFileSync(saida, ''); process.exit(3); }
  console.log(texto.split('\n').filter((l) => /^(FAIL|INFO)|RESUMO/.test(l)).join('\n') || '(sem linha de resumo)');
  console.log(`e2e exit=${codigo}; portas livres de novo: ${await portaLivre(API)} / ${await portaLivre(FRONT)}`);
  process.exit(codigo);
})().catch((e) => { console.error(`[rodar-e2e-pj] ${e.message}`); process.exit(2); });
