/**
 * ============================================================================
 * A IMAGEM DOCKER LEVA CÓDIGO — E O DADO FICA NO VOLUME
 * ============================================================================
 *
 * Três defeitos do Docker como estava entregue, todos de LEITURA de arquivo —
 * não havia `docker` na máquina da auditoria nem há aqui, e nenhum deles
 * precisa de um para ser provado:
 *
 *   GAP-PRD-061  não existia `.dockerignore`. O `COPY . .` do builder levava
 *                3,6 GB de backups, o banco operacional com o `-wal`, o `.env`
 *                com os segredos e os dois `node_modules` para a camada do
 *                builder — dado de cliente na cache de quem builda.
 *   GAP-PRD-062  as fotos iam para `/app/data/uploads` (a raiz do repositório
 *                dentro da imagem), FORA do único volume, que montava
 *                `/app/server/data`. Recriar o container apagava todas as
 *                fotos de produto, de loja e de OS — e o banco continuava
 *                apontando para elas. A imagem rodava como root e o
 *                HEALTHCHECK batia em /health (o processo respira), não em
 *                /readiness (o banco abre).
 *   GAP-PRD-151  o `docker-compose.yml` publicava com `DEVORA_API_ENV:
 *                development`; só o `NODE_ENV` do Dockerfile segurava as
 *                travas.
 *
 * O `.dockerignore` é conferido de dois jeitos: contra uma lista de caminhos
 * que NUNCA podem entrar (o que a instalação da loja tem e esta worktree não),
 * e contra a árvore REAL do repositório, percorrida com as mesmas regras.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function ler(arquivo: string): string {
  const caminho = resolve(RAIZ, arquivo);
  expect(existsSync(caminho), `${arquivo} não existe`).toBe(true);
  return readFileSync(caminho, 'utf8');
}

// ============================================================================
// O `.dockerignore`, com a semântica do Docker
// ============================================================================

interface Regra {
  negada: boolean;
  re: RegExp;
}

/**
 * As regras do `.dockerignore` como o Docker as lê (moby/patternmatcher):
 * `*` não atravessa `/`, `**` atravessa quantos níveis quiser, a barra inicial
 * não significa nada, `!` reinclui, e a ÚLTIMA regra que casa é a que vale.
 * Uma pasta excluída leva tudo o que está embaixo dela.
 */
function regrasDoDockerignore(texto: string): Regra[] {
  const regras: Regra[] = [];
  for (const bruta of texto.split(/\r?\n/)) {
    let linha = bruta.trim();
    if (!linha || linha.startsWith('#')) continue;
    const negada = linha.startsWith('!');
    if (negada) linha = linha.slice(1).trim();
    linha = posix.normalize(linha.replace(/^\/+/, '')).replace(/\/+$/, '');
    let re = '';
    for (let i = 0; i < linha.length; i += 1) {
      const c = linha[i];
      if (c === '*' && linha[i + 1] === '*') {
        const barraDepois = linha[i + 2] === '/';
        re += barraDepois ? '(?:.*/)?' : '.*';
        i += barraDepois ? 2 : 1;
      } else if (c === '*') {
        re += '[^/]*';
      } else if (c === '?') {
        re += '[^/]';
      } else {
        re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
    }
    regras.push({ negada, re: new RegExp(`^${re}$`) });
  }
  return regras;
}

/** O caminho (relativo à raiz, com `/`) fica FORA do contexto? */
function excluido(regras: Regra[], caminho: string): boolean {
  const partes = caminho.split('/');
  const candidatos = partes.map((_, i) => partes.slice(0, i + 1).join('/'));
  let fora = false;
  for (const regra of regras) {
    if (candidatos.some((c) => regra.re.test(c))) fora = !regra.negada;
  }
  return fora;
}

const regras = regrasDoDockerignore(ler('.dockerignore'));

describe('o contexto do build é só código (GAP-PRD-061)', () => {
  /*
    O que a instalação da loja TEM no disco — medido pela auditoria — e que
    esta worktree não tem. É por isso que a lista é escrita à mão: percorrer a
    árvore daqui não encontraria o banco operacional nem os 3,6 GB de backups.
  */
  const NUNCA_ENTRA = [
    '.env',
    '.env.local',
    '.env.production',
    '.env.bak-2026-08-30',
    'server/.env',
    'server/data/grupo-sampaio.db',
    'server/data/grupo-sampaio.db-wal',
    'server/data/grupo-sampaio.db-shm',
    'server/data/backups/devora-2026-08-23.db',
    'server/data/snapshots/pre-migracao-84.db',
    'server/data/uploads/produtos/foto.png',
    'server/data/quarentena/x.png',
    'server/backups/devora-backup-2026-08-07.json',
    'data/uploads/produtos/3f2a.webp',
    'data/uploads/os/9c1e.jpg',
    'data/grupo-sampaio.db',
    'node_modules/react/index.js',
    'server/node_modules/express/index.js',
    'out/index.html',
    'server/dist/index.js',
    '.git/HEAD',
    '.claude/worktrees/rem-dep/package.json',
    'certificados/empresa.pfx',
    'server/tests/fixtures/empresa.p12',
    'chave.pem',
    'api.log',
    'vitest-full-out.txt',
  ];

  for (const caminho of NUNCA_ENTRA) {
    it(`${caminho} fica fora da imagem`, () => {
      expect(excluido(regras, caminho), `${caminho} entraria no contexto do build`).toBe(true);
    });
  }

  /*
    E O BUILD CONTINUA TENDO O QUE PRECISA. Um `.dockerignore` que exclui
    demais não vaza nada — e também não builda. `npm run build` é o `vite
    build` da raiz e o `tsc` do servidor.
  */
  const O_BUILD_PRECISA = [
    'package.json',
    'package-lock.json',
    'server/package.json',
    'server/package-lock.json',
    'server/tsconfig.json',
    'server/src/index.ts',
    'server/src/config/env.ts',
    'index.html',
    'vite.config.ts',
    'tsconfig.json',
    'tsconfig.app.json',
    'tsconfig.node.json',
    'tailwind.config.ts',
    'postcss.config.ts',
    'auto-imports.d.ts',
    'vite-env.d.ts',
    'src/main.tsx',
    'src/lib/api/client.ts',
    'public/sw.js',
    'public/favicon.svg',
    // Os XSD oficiais e o manifesto (GAP-PRD-097): o builder os copia do
    // contexto para o estágio final — ver o caso "leva os XSD fiscais" abaixo.
    'server/fiscal-schemas/PL_010b_V1.30/MANIFESTO.json',
  ];

  for (const caminho of O_BUILD_PRECISA) {
    it(`${caminho} continua no contexto`, () => {
      expect(excluido(regras, caminho), `${caminho} ficaria fora e o build quebraria`).toBe(false);
    });
  }

  it('percorrendo a árvore real, nada que seja dado, segredo ou dependência entra', () => {
    /*
      A mesma regra aplicada ao que EXISTE aqui, podando as pastas excluídas
      como o Docker poda. Pega o arquivo novo que ninguém pensou em listar —
      um `server/data/algo.db` criado por um script, um `.env.qualquer`.
    */
    const suspeito = /(^|\/)(\.env($|\.)|node_modules\/)|\.(db|db-wal|db-shm|pfx|p12|pem|key)$|^server\/(data|backups)\//;
    const entrariam: string[] = [];
    let bytes = 0;
    const visitar = (pasta: string): void => {
      for (const nome of readdirSync(pasta)) {
        const absoluto = join(pasta, nome);
        const rel = relative(RAIZ, absoluto).split(sep).join('/');
        if (excluido(regras, rel)) continue;
        const info = statSync(absoluto);
        if (info.isDirectory()) {
          visitar(absoluto);
          continue;
        }
        bytes += info.size;
        if (suspeito.test(rel) && !rel.endsWith('.example')) entrariam.push(rel);
      }
    };
    visitar(RAIZ);
    expect(entrariam, 'arquivos que o COPY . . levaria para a imagem').toEqual([]);
    // O código inteiro, com docs e testes, é da ordem de dezenas de MB. Um
    // contexto maior que isso é sinal de que alguma pasta de dado escapou.
    expect(bytes).toBeLessThan(80 * 1024 * 1024);
  });
});

// ============================================================================
// O Dockerfile
// ============================================================================

/** Instruções do Dockerfile, com as continuações `\` já juntadas. */
function instrucoes(texto: string): Array<{ nome: string; argumento: string }> {
  const juntado = texto.replace(/\\\r?\n/g, ' ');
  return juntado
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [nome, ...resto] = l.split(/\s+/);
      return { nome: nome.toUpperCase(), argumento: resto.join(' ') };
    });
}

/** As instruções do ÚLTIMO estágio — é ele que vira a imagem. */
function estagioFinal(): Array<{ nome: string; argumento: string }> {
  const todas = instrucoes(ler('Dockerfile'));
  const inicio = todas.map((i) => i.nome).lastIndexOf('FROM');
  return todas.slice(inicio);
}

/** `ENV A=1 B="2"` → { A: '1', B: '2' }. */
function envDoDockerfile(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const i of estagioFinal().filter((x) => x.nome === 'ENV')) {
    for (const par of i.argumento.match(/[A-Z_][A-Z0-9_]*=("[^"]*"|\S*)/g) ?? []) {
      const eq = par.indexOf('=');
      env[par.slice(0, eq)] = par.slice(eq + 1).replace(/^"|"$/g, '');
    }
  }
  return env;
}

function volumesDoDockerfile(): string[] {
  return estagioFinal()
    .filter((x) => x.nome === 'VOLUME')
    .flatMap((x) => {
      const arg = x.argumento.trim();
      return arg.startsWith('[') ? (JSON.parse(arg) as string[]) : arg.split(/\s+/);
    });
}

const DADOS = ['DEVORA_DATABASE_PATH', 'DEVORA_UPLOADS_DIR', 'DEVORA_BACKUP_DIR'] as const;

function dentroDe(caminho: string, pasta: string): boolean {
  const p = posix.normalize(caminho);
  const base = posix.normalize(pasta).replace(/\/+$/, '');
  return p === base || p.startsWith(`${base}/`);
}

describe('a imagem: dado em volume, usuário sem privilégio, sonda que prova o banco (GAP-PRD-062)', () => {
  it('declara onde fica cada dado — banco, fotos e backups — com caminho absoluto', () => {
    const env = envDoDockerfile();
    for (const chave of DADOS) {
      expect(env[chave], `${chave} não está no ENV da imagem`).toMatch(/^\//);
    }
  });

  it('e cada um desses caminhos mora dentro de um VOLUME declarado', () => {
    const env = envDoDockerfile();
    const volumes = volumesDoDockerfile();
    expect(volumes.length).toBeGreaterThan(0);
    for (const chave of DADOS) {
      expect(
        volumes.some((v) => dentroDe(env[chave], v)),
        `${chave}=${env[chave]} fica fora de ${volumes.join(', ')} — some ao recriar o container`,
      ).toBe(true);
    }
  });

  it('as fotos NÃO caem no padrão histórico `<raiz>/data/uploads`, que fica na camada efêmera', () => {
    expect(dentroDe(envDoDockerfile().DEVORA_UPLOADS_DIR, '/app/data')).toBe(false);
  });

  it('o processo não roda como root', () => {
    const usuarios = estagioFinal().filter((x) => x.nome === 'USER').map((x) => x.argumento);
    expect(usuarios.length, 'sem USER a API roda como root dentro do container').toBeGreaterThan(0);
    expect(usuarios[usuarios.length - 1]).not.toMatch(/^(root|0)(:|$)/);
  });

  it('o HEALTHCHECK pergunta se o banco abre (/readiness), não só se o processo respira', () => {
    const sonda = estagioFinal().find((x) => x.nome === 'HEALTHCHECK');
    expect(sonda, 'imagem sem HEALTHCHECK').toBeDefined();
    expect(sonda!.argumento).toContain('/api/v1/readiness');
  });

  it('a imagem é de produção pelos DOIS nomes (GAP-PRD-151)', () => {
    const env = envDoDockerfile();
    expect(env.NODE_ENV).toBe('production');
    expect(env.DEVORA_API_ENV).toBe('production');
  });

  it('o estágio final não copia nada do contexto — só o que o builder produziu', () => {
    const copias = estagioFinal().filter((x) => x.nome === 'COPY');
    for (const c of copias) {
      expect(c.argumento, `COPY sem --from no estágio final: ${c.argumento}`).toMatch(/--from=/);
    }
  });

  it('e leva os XSD fiscais para o lado de server/dist (GAP-PRD-097)', () => {
    /*
      O validador de leiaute procura o pacote em `../../../fiscal-schemas`
      a partir de `dist/services/core` — isto é, `server/fiscal-schemas`. A
      imagem copiava só `dist`, `node_modules` e as telas: em produção o
      pacote "não está na instalação", e o validador, que falha fechado,
      recusaria toda NF-e e NFC-e antes do número.
    */
    const copias = estagioFinal().filter((x) => x.nome === 'COPY').map((x) => x.argumento);
    expect(copias).toContainEqual(
      expect.stringMatching(/^--from=builder\s+\/app\/server\/fiscal-schemas\s+\.\/server\/fiscal-schemas$/),
    );
  });
});

// ============================================================================
// Os compose
// ============================================================================

type NoYaml = string | NoYaml[] | { [chave: string]: NoYaml };

/**
 * Leitor do SUBCONJUNTO de YAML que os compose deste repositório usam: mapas
 * em bloco, listas de escalares e escalares com ou sem aspas. Sem âncoras, sem
 * mapas em linha. Se um compose precisar de mais que isso, este leitor
 * reclama em vez de adivinhar — e aí vale trocar por uma biblioteca.
 */
function lerYaml(texto: string): NoYaml {
  const linhas = texto
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, '').replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
    .map((l) => ({ recuo: l.length - l.trimStart().length, conteudo: l.trim() }));
  let i = 0;
  const escalar = (v: string): string => v.trim().replace(/^(['"])(.*)\1$/, '$2');
  const bloco = (recuo: number): NoYaml => {
    if (linhas[i]?.conteudo.startsWith('- ')) {
      const lista: NoYaml[] = [];
      while (i < linhas.length && linhas[i].recuo === recuo && linhas[i].conteudo.startsWith('- ')) {
        lista.push(escalar(linhas[i].conteudo.slice(2)));
        i += 1;
      }
      return lista;
    }
    const mapa: Record<string, NoYaml> = {};
    while (i < linhas.length && linhas[i].recuo === recuo) {
      const { conteudo } = linhas[i];
      const m = conteudo.match(/^([^:]+):(?:\s+(.*))?$/);
      if (!m) throw new Error(`linha que o leitor não entende: ${conteudo}`);
      if (m[2]?.startsWith('{') || m[2]?.startsWith('[') || m[2]?.startsWith('&') || m[2]?.startsWith('*')) {
        throw new Error(`sintaxe fora do subconjunto: ${conteudo}`);
      }
      i += 1;
      if (m[2] !== undefined && m[2] !== '') {
        mapa[m[1].trim()] = escalar(m[2]);
      } else if (i < linhas.length && linhas[i].recuo > recuo) {
        mapa[m[1].trim()] = bloco(linhas[i].recuo);
      } else {
        mapa[m[1].trim()] = {};
      }
    }
    return mapa;
  };
  return bloco(0);
}

function mapa(no: NoYaml | undefined): Record<string, NoYaml> {
  return no && typeof no === 'object' && !Array.isArray(no) ? no : {};
}

function lista(no: NoYaml | undefined): string[] {
  return Array.isArray(no) ? (no as string[]) : [];
}

const COMPOSES = [
  { arquivo: 'docker-compose.yml', ambiente: 'production' },
  { arquivo: 'docker-compose.staging.yml', ambiente: 'staging' },
] as const;

for (const { arquivo, ambiente } of COMPOSES) {
  describe(`${arquivo}`, () => {
    const doc = mapa(lerYaml(ler(arquivo)));
    const api = mapa(mapa(doc.services).api);
    const environment = mapa(api.environment) as Record<string, string>;
    const montagens = lista(api.volumes);

    it('tem o serviço `api` com volumes e environment — senão o resto fica verde lendo nada', () => {
      expect(Object.keys(api).length).toBeGreaterThan(0);
      expect(montagens.length).toBeGreaterThan(0);
      expect(Object.keys(environment).length).toBeGreaterThan(0);
    });

    it(`declara DEVORA_API_ENV=${ambiente} e nenhuma variável aposentada do acesso sem senha (GAP-PRD-151)`, () => {
      expect(environment.DEVORA_API_ENV).toBe(ambiente);
      // O acesso sem senha saiu do sistema: nem ligada, nem "escrita false" —
      // a linha que não liga nada só ensina que existiu uma porta.
      expect(Object.keys(environment).filter((k) => /QUICK_LOGIN/.test(k))).toEqual([]);
      expect(ler(arquivo)).not.toMatch(/QUICK_LOGIN|acesso r[áa]pido/i);
    });

    it('banco, fotos e backups ficam dentro de volumes montados (GAP-PRD-062)', () => {
      const efetivo = { ...envDoDockerfile(), ...environment };
      const alvos = montagens.map((m) => m.split(':')[1]).filter(Boolean);
      for (const chave of DADOS) {
        const caminho = efetivo[chave];
        expect(caminho, `${chave} sem valor efetivo`).toBeTruthy();
        expect(
          alvos.some((alvo) => dentroDe(caminho, alvo)),
          `${chave}=${caminho} não está em nenhum volume (${alvos.join(', ')})`,
        ).toBe(true);
      }
    });

    it('usa volume NOMEADO — nunca monta a pasta `server/data` do host, onde mora o banco da loja', () => {
      for (const m of montagens) {
        const origem = m.split(':')[0];
        expect(origem, `montagem de pasta do host: ${m}`).not.toMatch(/^[./~]|^[A-Za-z]:\\/);
      }
    });

    it('não traz segredo: os dois vêm do ambiente do host, obrigatórios (GAP-PRD-060)', () => {
      for (const chave of ['DEVORA_JWT_SECRET', 'DEVORA_ENCRYPTION_KEY']) {
        expect(environment[chave], `${chave} com valor escrito no compose`).toMatch(
          new RegExp(`^\\$\\{${chave}:\\?.+\\}$`),
        );
      }
    });

    it('não carrega arquivo de EXEMPLO como env_file — ele traz valores publicados', () => {
      const envFile = api.env_file;
      const arquivos = Array.isArray(envFile) ? (envFile as string[]) : envFile ? [String(envFile)] : [];
      for (const f of arquivos) expect(f).not.toMatch(/example/);
    });
  });
}
