/**
 * ============================================================================
 * A CHAVE PADRÃO DE DESENVOLVIMENTO NÃO ENTRA EM PRODUÇÃO
 * ============================================================================
 *
 * `DEVORA_ENCRYPTION_KEY` sela o `.pfx` do certificado, as chaves do Asaas e a
 * senha da caixa de e-mail. Quando ela falta, o sistema cai numa padrão
 * conhecida — que está escrita neste repositório e, portanto, é conhecida por
 * qualquer um que o leia.
 *
 * Isso não é uma preferência de configuração: uma cópia do banco somada a um
 * `git clone` abriria os cinco segredos. Produção com essa chave é o mesmo que
 * produção sem cofre nenhum.
 *
 * O guarda já existia e cobria a metade certa. Faltava a outra: ele olhava só
 * `DEVORA_API_ENV`, cujo padrão é `development` — e quem sobe
 * `NODE_ENV=production node dist/index.js` sem declarar a outra variável
 * passava direto. É o mesmo buraco que o atalho sem senha (hoje removido)
 * tinha, pelo mesmo motivo: `NODE_ENV` é definida por hospedagem e container SOZINHOS;
 * `DEVORA_API_ENV` só existe se alguém escrever.
 *
 * Nenhum valor de chave aparece neste arquivo além da PADRÃO — que não é
 * segredo: ela está no código-fonte, e é exatamente por isso que produção
 * precisa recusá-la.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

/** A raiz do repositório: os arquivos de exemplo moram lá, não em . */
const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const { loadEnv, resetEnvCacheForTests } = await import('../src/config/env.js');

/** A padrão que o código usa quando ninguém declara. Pública por definição. */
const PADRAO_DE_DESENVOLVIMENTO = 'dev-local-encryption-key-32';
const FORTE = 'uma-chave-de-producao-longa-o-bastante-para-passar';
const JWT_FORTE = 'um-jwt-de-producao-longo-o-bastante-para-passar';

const ORIGINAL = { ...process.env };

function ambiente(vars: Record<string, string | undefined>): void {
  process.env.DEVORA_IGNORE_DOTENV = 'true';
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCacheForTests();
}

/*
  Este arquivo NÃO pode ler o `.env` da máquina.

  Ele simula chave ausente apagando a variável — e `loadDotEnvFiles` a repunha
  a partir do `.env` de quem está desenvolvendo. Enquanto aquele arquivo
  estava incompleto o teste passava por sorte; no dia em que a chave foi
  gerada de verdade, ficou vermelho sem uma linha de produção ter mudado.
*/
beforeEach(() => {
  process.env = { ...ORIGINAL };
  process.env.DEVORA_IGNORE_DOTENV = 'true';
  resetEnvCacheForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  resetEnvCacheForTests();
});

// ============================================================================

describe('produção recusa subir sem chave própria', () => {
  it('DEVORA_API_ENV=production com a chave PADRÃO é recusado', () => {
    ambiente({
      NODE_ENV: undefined,
      DEVORA_API_ENV: 'production',
      DEVORA_JWT_SECRET: JWT_FORTE,
      DEVORA_ENCRYPTION_KEY: PADRAO_DE_DESENVOLVIMENTO,    });
    expect(() => loadEnv()).toThrow(/DEVORA_ENCRYPTION_KEY/);
  });

  it('e com NODE_ENV=production também — a hospedagem define essa, não a nossa', () => {
    ambiente({
      NODE_ENV: 'production',
      DEVORA_API_ENV: undefined,
      DEVORA_JWT_SECRET: JWT_FORTE,
      DEVORA_ENCRYPTION_KEY: PADRAO_DE_DESENVOLVIMENTO,    });
    expect(() => loadEnv()).toThrow(/DEVORA_ENCRYPTION_KEY/);
  });

  it('chave AUSENTE em produção é recusada — o padrão silencioso é o defeito', () => {
    ambiente({
      NODE_ENV: 'production',
      DEVORA_API_ENV: undefined,
      DEVORA_JWT_SECRET: JWT_FORTE,
      DEVORA_ENCRYPTION_KEY: undefined,    });
    expect(() => loadEnv()).toThrow(/DEVORA_ENCRYPTION_KEY/);
  });

  it('chave curta demais é recusada', () => {
    ambiente({
      NODE_ENV: 'production',
      DEVORA_API_ENV: undefined,
      DEVORA_JWT_SECRET: JWT_FORTE,
      DEVORA_ENCRYPTION_KEY: 'curta-demais',    });
    expect(() => loadEnv()).toThrow(/DEVORA_ENCRYPTION_KEY/);
  });

  it('o JWT padrão continua sendo recusado junto', () => {
    ambiente({
      NODE_ENV: 'production',
      DEVORA_API_ENV: undefined,
      DEVORA_JWT_SECRET: 'dev-local-jwt-secret',
      DEVORA_ENCRYPTION_KEY: FORTE,    });
    expect(() => loadEnv()).toThrow(/DEVORA_JWT_SECRET/);
  });
});

// ============================================================================

describe('e o que é legítimo continua subindo', () => {
  it('produção com as duas chaves fortes sobe', () => {
    ambiente({
      NODE_ENV: 'production',
      DEVORA_API_ENV: 'production',
      DEVORA_JWT_SECRET: JWT_FORTE,
      DEVORA_ENCRYPTION_KEY: FORTE,    });
    expect(() => loadEnv()).not.toThrow();
  });

  it('desenvolvimento com a chave padrão continua subindo — é para isso que ela existe', () => {
    ambiente({
      NODE_ENV: 'development',
      DEVORA_API_ENV: 'development',
      DEVORA_JWT_SECRET: undefined,
      DEVORA_ENCRYPTION_KEY: undefined,    });
    expect(() => loadEnv()).not.toThrow();
  });

  it('a suíte, que roda em test, não é afetada', () => {
    ambiente({
      NODE_ENV: 'test',
      DEVORA_API_ENV: 'test',
      DEVORA_JWT_SECRET: undefined,
      DEVORA_ENCRYPTION_KEY: undefined,    });
    expect(() => loadEnv()).not.toThrow();
  });
});

// ============================================================================

/*
  O QUE O GUARDA AINDA DEIXAVA PASSAR.

  Ele recusava a chave PADRÃO — `dev-local-encryption-key-32` — e recusava
  chave curta. Mas os arquivos de exemplo deste repositório trazem OUTROS
  valores prontos:

      .env.example          DEVORA_JWT_SECRET=change-me-in-production
                            DEVORA_ENCRYPTION_KEY=change-me-32-chars-minimum-key!!
      .env.staging.example  DEVORA_JWT_SECRET=change-me-staging-jwt-secret
                            DEVORA_ENCRYPTION_KEY=change-me-staging-32-chars-key!!

  Todos com o comprimento exigido. Todos diferentes da padrão. Todos passavam.

  E todos estão ESCRITOS no repositório, que é a única coisa que importa: uma
  chave publicada não é chave. O caminho para isso acontecer é o mais comum que
  existe — copiar o exemplo, preencher o que se entende, subir. Quem copia
  `.env.example` para produção e esquece essas duas linhas ganha um cofre que
  qualquer leitor do repositório abre, e um `DEVORA_JWT_SECRET` com que qualquer
  um assina o próprio token de administrador.

  O `change-me` no nome é um recado para humanos. O guarda não lê recados.
*/
describe('valor publicado no repositório não é chave', () => {
  const PUBLICADOS: Array<[string, string, string]> = [
    ['.env.example', 'DEVORA_JWT_SECRET', 'change-me-in-production'],
    ['.env.example', 'DEVORA_ENCRYPTION_KEY', 'change-me-32-chars-minimum-key!!'],
    ['.env.staging.example', 'DEVORA_JWT_SECRET', 'change-me-staging-jwt-secret'],
    ['.env.staging.example', 'DEVORA_ENCRYPTION_KEY', 'change-me-staging-32-chars-key!!'],
  ];

  for (const [arquivo, variavel, valor] of PUBLICADOS) {
    it(`${variavel} com o valor de ${arquivo} é recusado em produção`, () => {
      ambiente({
        NODE_ENV: undefined,
        DEVORA_API_ENV: 'production',
        DEVORA_JWT_SECRET: variavel === 'DEVORA_JWT_SECRET' ? valor : JWT_FORTE,
        DEVORA_ENCRYPTION_KEY: variavel === 'DEVORA_ENCRYPTION_KEY' ? valor : FORTE,
      });
      expect(() => loadEnv()).toThrow(new RegExp(variavel));
    });
  }

  it('e a lista do guarda não fica para trás dos arquivos de exemplo', () => {
    /*
      Este caso é o que impede a lista de envelhecer. Ele LÊ os arquivos de
      exemplo e cobra que cada valor preenchido ali seja recusado por produção.
      Acrescentar um exemplo novo com placeholder novo fica vermelho aqui, e
      não seis meses depois, num servidor.
    */
    const naoRecusados: string[] = [];
    for (const arquivo of ['.env.example', '.env.staging.example', '.env.production.example']) {
      const caminho = resolve(RAIZ, arquivo);
      if (!existsSync(caminho)) continue;
      const texto = readFileSync(caminho, 'utf8');
      for (const variavel of ['DEVORA_JWT_SECRET', 'DEVORA_ENCRYPTION_KEY'] as const) {
        const m = texto.match(new RegExp(`^${variavel}=(.*)$`, 'm'));
        const valor = m?.[1]?.trim();
        // Exemplo com o campo VAZIO é o formato certo: não sugere valor nenhum.
        if (!valor) continue;

        ambiente({
          NODE_ENV: undefined,
          DEVORA_API_ENV: 'production',
          DEVORA_JWT_SECRET: variavel === 'DEVORA_JWT_SECRET' ? valor : JWT_FORTE,
          DEVORA_ENCRYPTION_KEY: variavel === 'DEVORA_ENCRYPTION_KEY' ? valor : FORTE,
        });
        let recusou = false;
        try {
          loadEnv();
        } catch {
          recusou = true;
        }
        if (!recusou) naoRecusados.push(`${arquivo}: ${variavel}`);
      }
    }

    expect(
      naoRecusados,
      'valor de exemplo que produção ACEITA: ou esvazie o campo no arquivo, '
        + 'ou acrescente o valor à lista de publicados em env.ts',
    ).toEqual([]);
  });

  /*
    OS ARQUIVOS DO DOCKER TAMBÉM SÃO REPOSITÓRIO (GAP-PRD-060).

    A leitura acima olhava só os `.env.*.example`. O `docker-compose.staging.yml`
    subia homologação com `DEVORA_JWT_SECRET` e `DEVORA_ENCRYPTION_KEY` escritos
    no próprio arquivo — 25 e 29 caracteres, bastante entropia, fora da lista.
    A régua aceitava, e o cofre de homologação (onde o `.pfx` REAL é carregado
    para falar com a SEFAZ) ficava selado com uma chave que qualquer leitor do
    repositório conhece.

    O compose agora pede os dois ao ambiente do host (`${VAR:?}`) e não traz
    valor nenhum. Estes casos seguram as duas metades: nenhum compose volta a
    escrever valor literal que o ambiente aceite, e os valores que ele já
    publicou — estão no histórico do git para sempre — continuam recusados.
  */
  it('e nenhum docker-compose escreve segredo literal que o ambiente aceite', () => {
    const naoRecusados: string[] = [];
    for (const arquivo of ['docker-compose.yml', 'docker-compose.staging.yml']) {
      const caminho = resolve(RAIZ, arquivo);
      if (!existsSync(caminho)) continue;
      const texto = readFileSync(caminho, 'utf8');
      const ambienteDoArquivo = texto.match(/^\s+DEVORA_API_ENV:\s*['"]?([a-z]+)/m)?.[1] ?? 'production';
      for (const variavel of ['DEVORA_JWT_SECRET', 'DEVORA_ENCRYPTION_KEY'] as const) {
        const m = texto.match(new RegExp(`^\\s+${variavel}:\\s*['"]?([^'"\\s#]+)`, 'm'));
        const valor = m?.[1]?.trim();
        // `${VAR:?mensagem}` é o formato certo: o valor vem do host, não daqui.
        if (!valor || valor.startsWith('${')) continue;
        for (const alvo of [ambienteDoArquivo, 'production']) {
          ambiente({
            NODE_ENV: 'production',
            DEVORA_API_ENV: alvo,
            DEVORA_JWT_SECRET: variavel === 'DEVORA_JWT_SECRET' ? valor : JWT_FORTE,
            DEVORA_ENCRYPTION_KEY: variavel === 'DEVORA_ENCRYPTION_KEY' ? valor : FORTE,          });
          let recusou = false;
          try {
            loadEnv();
          } catch {
            recusou = true;
          }
          if (!recusou) naoRecusados.push(`${arquivo}: ${variavel} aceito em ${alvo}`);
        }
      }
    }
    expect(
      naoRecusados,
      'segredo literal no compose que o ambiente ACEITA: troque por ${VAR:?} e '
        + 'acrescente o valor antigo à lista de publicados em env.ts',
    ).toEqual([]);
  });

  const PUBLICADOS_PELOS_COMPOSE: Array<[string, string, string]> = [
    ['docker-compose.staging.yml (até o lote D1)', 'DEVORA_JWT_SECRET', 'staging-docker-jwt-secret'],
    ['docker-compose.staging.yml (até o lote D1)', 'DEVORA_ENCRYPTION_KEY', 'staging-docker-encryption-key'],
    ['docker-compose.yml (até o lote D1)', 'DEVORA_JWT_SECRET', 'dev-docker-jwt-secret'],
    ['docker-compose.yml (até o lote D1)', 'DEVORA_ENCRYPTION_KEY', 'dev-docker-encryption-key-32'],
  ];

  for (const [origem, variavel, valor] of PUBLICADOS_PELOS_COMPOSE) {
    for (const alvo of ['staging', 'production'] as const) {
      it(`${variavel} publicado em ${origem} é recusado em ${alvo}`, () => {
        ambiente({
          NODE_ENV: undefined,
          DEVORA_API_ENV: alvo,
          DEVORA_JWT_SECRET: variavel === 'DEVORA_JWT_SECRET' ? valor : JWT_FORTE,
          DEVORA_ENCRYPTION_KEY: variavel === 'DEVORA_ENCRYPTION_KEY' ? valor : FORTE,        });
        expect(() => loadEnv()).toThrow(new RegExp(variavel));
      });
    }
  }
});

// ============================================================================

/*
  CHAVE COMPRIDA E SEM ENTROPIA.

  `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` tem trinta caracteres e passa em qualquer
  régua de comprimento. Não é ataque teórico: é o que sai quando alguém precisa
  subir o servidor agora e "depois arruma".
*/
describe('comprimento não é a mesma coisa que força', () => {
  it('chave longa de um caractere só é recusada', () => {
    ambiente({
      NODE_ENV: undefined,
      DEVORA_API_ENV: 'production',
      DEVORA_JWT_SECRET: JWT_FORTE,
      DEVORA_ENCRYPTION_KEY: 'a'.repeat(40),
    });
    expect(() => loadEnv()).toThrow(/DEVORA_ENCRYPTION_KEY/);
  });

  it('e o mesmo vale para o JWT', () => {
    ambiente({
      NODE_ENV: undefined,
      DEVORA_API_ENV: 'production',
      DEVORA_JWT_SECRET: '12341234123412341234123412341234',
      DEVORA_ENCRYPTION_KEY: FORTE,
    });
    expect(() => loadEnv()).toThrow(/DEVORA_JWT_SECRET/);
  });

  it('uma chave de verdade — 32 bytes aleatórios — passa', () => {
    // É o formato que a ferramenta de rotação gera. Se este caso ficar
    // vermelho, a régua nova está recusando o que ela mesma produz.
    ambiente({
      NODE_ENV: undefined,
      DEVORA_API_ENV: 'production',
      DEVORA_JWT_SECRET: randomBytes(32).toString('base64url'),
      DEVORA_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
    });
    expect(() => loadEnv()).not.toThrow();
  });
});

// ============================================================================

/*
  HOMOLOGAÇÃO É O ENSAIO DE PRODUÇÃO.

  O atalho sem senha (hoje removido) já recusava subir em `staging`, pelo
  motivo escrito lá: é em homologação que se descobre que "só faltava tirar
  aquilo". A chave do cofre
  não seguia a mesma régua — e homologação é justamente onde o `.pfx` de
  verdade é carregado para transmitir à SEFAZ.
*/
describe('homologação segue a mesma régua', () => {
  it('staging com a chave padrão é recusado', () => {
    ambiente({
      NODE_ENV: undefined,
      DEVORA_API_ENV: 'staging',
      DEVORA_JWT_SECRET: JWT_FORTE,
      DEVORA_ENCRYPTION_KEY: PADRAO_DE_DESENVOLVIMENTO,
    });
    expect(() => loadEnv()).toThrow(/DEVORA_ENCRYPTION_KEY/);
  });

  it('staging com chave ausente é recusado', () => {
    ambiente({
      NODE_ENV: undefined,
      DEVORA_API_ENV: 'staging',
      DEVORA_JWT_SECRET: JWT_FORTE,
      DEVORA_ENCRYPTION_KEY: undefined,
    });
    expect(() => loadEnv()).toThrow(/DEVORA_ENCRYPTION_KEY/);
  });

  it('staging com as duas fortes sobe', () => {
    ambiente({
      NODE_ENV: undefined,
      DEVORA_API_ENV: 'staging',
      DEVORA_JWT_SECRET: JWT_FORTE,
      DEVORA_ENCRYPTION_KEY: FORTE,
    });
    expect(() => loadEnv()).not.toThrow();
  });

  it('mas DESENVOLVIMENTO continua subindo com a padrão', () => {
    // A régua é para os ambientes que atendem gente de fora. A bancada não.
    ambiente({
      NODE_ENV: undefined,
      DEVORA_API_ENV: 'development',
      DEVORA_JWT_SECRET: undefined,
      DEVORA_ENCRYPTION_KEY: undefined,
    });
    expect(() => loadEnv()).not.toThrow();
  });
});
