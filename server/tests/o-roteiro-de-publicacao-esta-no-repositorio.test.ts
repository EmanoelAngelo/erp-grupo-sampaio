/**
 * ============================================================================
 * O ROTEIRO DE PUBLICAÇÃO ESTÁ NO REPOSITÓRIO (GAP-PRD-013)
 * ============================================================================
 *
 * "Não existe nginx.conf/Caddyfile/serve script no repositório; DEPLOY.md diz
 * 'este repositório não fixa um supervisor nem instala unidade nenhuma'."
 *
 * `deploy/` traz agora a publicação de referência para os três jeitos de pôr
 * o sistema no ar — Windows (a loja), Linux e Docker — e este arquivo segura o
 * que cada exemplo PRECISA ter para funcionar. Não há Caddy, nginx nem
 * systemd nesta máquina para rodá-los; o que se cobra é o conteúdo que, se
 * sumir, quebra a publicação em silêncio: o fallback de SPA, o encaminhamento
 * de /api e /uploads, o HTTPS com HSTS, o reinício automático.
 *
 * Os dois scripts do Windows são conferidos pelo parser do próprio PowerShell
 * (que só lê o arquivo, não executa nada).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function ler(caminho: string): string {
  const absoluto = resolve(RAIZ, caminho);
  expect(existsSync(absoluto), `${caminho} não existe`).toBe(true);
  return readFileSync(absoluto, 'utf8');
}

/** O texto sem as linhas comentadas — o que o programa de fato lê. */
function semComentario(texto: string): string {
  return texto
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
}

describe('Caddy (HTTPS automático)', () => {
  const caddy = ler('deploy/caddy/Caddyfile.example');
  const ativo = semComentario(caddy);

  it('encaminha para a API na 8787, com HSTS', () => {
    expect(ativo).toMatch(/reverse_proxy\s+127\.0\.0\.1:8787/);
    expect(ativo).toMatch(/Strict-Transport-Security/);
  });

  it('o modo em que o Caddy serve as telas tem o fallback de SPA e roteia /api e /uploads', () => {
    expect(caddy).toMatch(/try_files \{path\} \/index\.html/);
    expect(caddy).toMatch(/handle \/api\/\*/);
    expect(caddy).toMatch(/handle \/uploads\/\*/);
  });

  it('o do compose usa o domínio do ambiente e o serviço `api`', () => {
    const docker = semComentario(ler('deploy/caddy/Caddyfile.docker'));
    expect(docker).toMatch(/\{\$DEVORA_DOMINIO\}/);
    expect(docker).toMatch(/reverse_proxy\s+api:8787/);
  });
});

describe('nginx', () => {
  const nginx = semComentario(ler('deploy/nginx/grupo-sampaio.conf.example'));

  it('HTTP vira HTTPS, com certificado e HSTS', () => {
    expect(nginx).toMatch(/return 301 https:\/\/\$host\$request_uri/);
    expect(nginx).toMatch(/ssl_certificate\s/);
    expect(nginx).toMatch(/Strict-Transport-Security/);
  });

  it('as telas com fallback de SPA', () => {
    expect(nginx).toMatch(/try_files \$uri \$uri\/ \/index\.html;/);
  });

  it('/api e /uploads vão para a 8787, dizendo à API que a conexão é HTTPS', () => {
    expect(nginx).toMatch(/location \/api\/ \{[^}]*proxy_pass http:\/\/127\.0\.0\.1:8787;/s);
    expect(nginx).toMatch(/location \/uploads\/ \{[^}]*proxy_pass http:\/\/127\.0\.0\.1:8787;/s);
    expect(nginx).toMatch(/X-Forwarded-Proto \$scheme/);
  });

  it('o corpo aceita as fotos em base64 (a API aceita 8 MB nessas rotas)', () => {
    const m = nginx.match(/client_max_body_size\s+(\d+)m;/);
    expect(m, 'sem client_max_body_size o nginx corta em 1 MB').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(8);
  });
});

describe('Linux (systemd)', () => {
  const unidade = ler('deploy/linux/grupo-sampaio-api.service');

  it('reinicia sempre, e dá à API tempo de descer limpa', () => {
    expect(unidade).toMatch(/^Restart=always$/m);
    expect(unidade).toMatch(/^ExecStart=.*node server\/dist\/index\.js$/m);
    expect(unidade).toMatch(/^KillSignal=SIGTERM$/m);
    const prazo = Number(unidade.match(/^TimeoutStopSec=(\d+)$/m)?.[1] ?? 0);
    // O desligamento da API tem prazo de 8 s (cicloDoProcesso).
    expect(prazo).toBeGreaterThan(8);
  });

  it('não roda como root', () => {
    expect(unidade).toMatch(/^User=(?!root$).+$/m);
  });
});

describe('Windows (tarefa que sobe com a máquina)', () => {
  const instalar = ler('deploy/windows/instalar-servico.ps1');

  it('registra o supervisor na partida do Windows, e confere a implantação antes', () => {
    expect(instalar).toContain('server\\dist\\scripts\\supervisionar-api.js');
    expect(instalar).toContain('server\\dist\\scripts\\conferir-implantacao.js');
    expect(instalar).toMatch(/New-ScheduledTaskTrigger -AtStartup/);
    expect(instalar).toMatch(/-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
    expect(instalar).toMatch(/-Ensaio/);
  });

  it('os scripts existem nos lugares que o código cita', () => {
    expect(existsSync(resolve(RAIZ, 'server/src/scripts/supervisionar-api.ts'))).toBe(true);
    expect(existsSync(resolve(RAIZ, 'server/src/scripts/conferir-implantacao.ts'))).toBe(true);
    expect(existsSync(resolve(RAIZ, 'server/src/scripts/parar-api.ts'))).toBe(true);
  });

  it('remover o serviço pede a parada limpa ANTES de encerrar a tarefa', () => {
    /*
      No Windows a API está no "job" do supervisor: encerrar a tarefa a
      derruba na hora. O remover fala primeiro com o canal de controle.
    */
    const remover = ler('deploy/windows/remover-servico.ps1');
    const pedeParada = remover.indexOf('server\\dist\\scripts\\parar-api.js');
    const encerra = remover.indexOf('Stop-ScheduledTask');
    expect(pedeParada).toBeGreaterThan(0);
    expect(encerra).toBeGreaterThan(pedeParada);
  });

  it('são só ASCII — o PowerShell 5.1 lê arquivo sem BOM como ANSI e estragaria o acento', () => {
    for (const arquivo of ['deploy/windows/instalar-servico.ps1', 'deploy/windows/remover-servico.ps1']) {
      // eslint-disable-next-line no-control-regex
      expect(ler(arquivo), arquivo).toMatch(/^[\x00-\x7F]*$/);
    }
  });

  it.runIf(process.platform === 'win32')('o parser do PowerShell lê os dois sem erro', () => {
    const script = [
      '$falhas = 0',
      "foreach ($f in @('deploy\\windows\\instalar-servico.ps1','deploy\\windows\\remover-servico.ps1')) {",
      '  $e = $null',
      '  [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $f).Path, [ref]$null, [ref]$e)',
      '  $falhas += $e.Count',
      '}',
      'Write-Output $falhas',
    ].join('\n');
    const saida = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: RAIZ,
      encoding: 'utf8',
    });
    expect(saida.trim()).toBe('0');
  }, 60_000);
});

describe('Docker', () => {
  it('a imagem serve as telas, buildadas para a mesma origem', () => {
    const dockerfile = ler('Dockerfile');
    expect(dockerfile).toMatch(/ARG VITE_API_BASE_URL=\//);
    expect(dockerfile).toMatch(/DEVORA_SERVIR_FRONTEND=true/);
    expect(dockerfile).toMatch(/COPY --from=builder \/app\/out \.\/out/);
  });

  it('o compose de produção traz o HTTPS num perfil próprio', () => {
    const compose = ler('docker-compose.yml');
    expect(compose).toMatch(/proxy:\n\s+image: caddy:/);
    expect(compose).toMatch(/profiles:\n\s+- https/);
    expect(compose).toContain('./deploy/caddy/Caddyfile.docker:/etc/caddy/Caddyfile:ro');
  });
});

describe('os comandos', () => {
  it('a raiz tem os atalhos da conferência e do supervisor', () => {
    const scripts = (JSON.parse(ler('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['implantacao:conferir']).toContain('conferir-implantacao.ts');
    expect(scripts['api:supervisionar']).toContain('server/dist/scripts/supervisionar-api.js');
  });
});
