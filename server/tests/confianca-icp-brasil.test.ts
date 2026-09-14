/**
 * O SERVIDOR PRECISA CONFIAR NA RAIZ DO ICP-BRASIL — rodada 60.
 *
 * ============================================================================
 * O DEFEITO, DIAGNOSTICADO CONTRA A SEFAZ DE VERDADE
 * ============================================================================
 *
 * O dono testou a comunicação e leu:
 *
 *     unable to get local issuer certificate
 *
 * O erro NÃO era do certificado dele. Era do certificado que a SEFAZ
 * apresenta. A cadeia do webservice do RS é
 *
 *     *.sefazrs.rs.gov.br  ←  AC do SERPRO SSLv1  ←  AC Raiz Brasileira v10
 *
 * e essa raiz é do ICP-Brasil. O Node embute a lista de autoridades da
 * Mozilla, que NÃO inclui a Raiz Brasileira — ela vive no truststore do
 * Windows, que é onde o navegador e o PowerShell a encontram.
 *
 * Foi por isso que o primeiro diagnóstico enganou: o shell tinha
 * `NODE_USE_SYSTEM_CA=1` e a conexão passava; o processo do servidor não
 * tinha, e falhava. Mesma máquina, mesmo Node, truststores diferentes.
 *
 * ============================================================================
 * POR QUE A RAIZ VAI NO REPOSITÓRIO, E NÃO NUMA VARIÁVEL DE AMBIENTE
 * ============================================================================
 *
 * `NODE_USE_SYSTEM_CA=1` resolveria em uma linha e quebraria no dia da
 * mudança de servidor: num contêiner, num Linux de produção, numa máquina
 * nova, a variável não existe e o sistema volta a falhar — com uma mensagem
 * que ninguém liga a essa causa, porque ela fala de certificado e o problema
 * é de configuração de processo.
 *
 * A raiz no repositório viaja com o código. O arquivo é o certificado
 * público da AC Raiz Brasileira v10 do ITI — público por definição, é o que
 * todo navegador carrega — e está fixado pelo `subject` e pela validade, para
 * que uma troca silenciosa do arquivo apareça aqui.
 */
import { describe, expect, it } from 'vitest';
import forge from 'node-forge';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { autoridadesConfiaveis, RAIZ_ICP_BRASIL_SUBJECT } = await import(
  '../src/services/core/IcpBrasilTrust.js'
);

// ============================================================================

describe('as autoridades do ICP-Brasil viajam com o código', () => {
  it('a raiz é carregada do repositório, não do sistema', () => {
    const cas = autoridadesConfiaveis();
    expect(cas.length).toBeGreaterThan(0);
    expect(cas.every((pem) => pem.includes('-----BEGIN CERTIFICATE-----'))).toBe(true);
  });

  it('é a AC Raiz Brasileira v10 do ITI — e o arquivo não pode ser trocado em silêncio', () => {
    const [pem] = autoridadesConfiaveis();
    const cert = forge.pki.certificateFromPem(pem);

    const cn = cert.subject.getField('CN')?.value;
    const org = cert.subject.getField('O')?.value;
    expect(cn).toBe(RAIZ_ICP_BRASIL_SUBJECT);
    expect(org).toBe('ICP-Brasil');

    /*
      RAIZ é autoassinada: emissor igual ao titular. Se o arquivo virar uma
      intermediária, a cadeia não fecha e a conexão volta a falhar — com o
      mesmo erro de antes, e ninguém lembraria de olhar aqui.
    */
    expect(cert.issuer.getField('CN')?.value).toBe(cn);

    // A validade importa: raiz vencida derruba a emissão fiscal inteira, e o
    // aviso precisa vir de um teste, não do fisco recusando a nota.
    expect(cert.validity.notAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it('a raiz é código compilado, não arquivo lido do disco', async () => {
    /*
      O DEFEITO QUE SÓ APARECERIA EM PRODUÇÃO.

      A primeira versão guardava o certificado num `.pem` ao lado e o lia com
      `readFileSync`. Funcionava aqui e morreria lá: o servidor de produção
      roda de `dist/`, e o `tsc` compila `.ts` — não copia `.pem`. A emissão
      fiscal inteira cairia com "arquivo não encontrado" no primeiro dia, com
      esta suíte verde do começo ao fim.

      Este teste guarda a decisão: se alguém voltar a ler do disco, ele fica
      vermelho aqui, e não no balcão.
    */
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const modulo = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../src/services/core/IcpBrasilTrust.ts',
    );
    const fonte = readFileSync(modulo, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(fonte).not.toMatch(/readFileSync|readFile\(/);
    // O certificado vem de um módulo TypeScript, que o build carrega junto.
    expect(fonte).toMatch(/from '\.\/icp-brasil\/raizes\.js'/);
  });

  it('a raiz vence depois de 2030 — quando encostar, o teste avisa antes do fisco', () => {
    const [pem] = autoridadesConfiaveis();
    const cert = forge.pki.certificateFromPem(pem);
    /*
      Um ano de folga antes do vencimento. Quando este teste ficar vermelho,
      é hora de trazer a raiz nova do ITI — e o vermelho chega com tempo, em
      vez de a emissão parar num dia de movimento.
    */
    const umAnoAntes = cert.validity.notAfter.getTime() - 365 * 86400000;
    expect(Date.now()).toBeLessThan(umAnoAntes);
  });
});

// ============================================================================

describe('nenhum cliente do fisco esquece as autoridades', () => {
  it('todo https.request que fala com a SEFAZ declara `ca`', async () => {
    /*
      VARREDURA, pelo mesmo motivo da cadeia (rodada 59): o defeito nasce
      onde alguém escrever o PRÓXIMO cliente TLS, e `rejectUnauthorized: true`
      sozinho lê como código seguro — é seguro, e é justamente por ser
      rigoroso que ele recusa o fisco sem as raízes do ICP-Brasil.

      A regra: quem valida certificado de servidor da SEFAZ precisa dizer
      contra QUAIS autoridades. Um teste de caminho protegeria os dois
      clientes que existem hoje; isto protege o terceiro.
    */
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join, resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
    const arquivos: string[] = [];
    (function varrer(dir: string) {
      for (const nome of readdirSync(dir)) {
        const caminho = join(dir, nome);
        if (statSync(caminho).isDirectory()) varrer(caminho);
        else if (nome.endsWith('.ts')) arquivos.push(caminho);
      }
    })(raiz);

    const semCa: string[] = [];
    for (const arquivo of arquivos) {
      const conteudo = readFileSync(arquivo, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      // Quem manda certificado de cliente está falando com o fisco.
      const falaComOFisco = /\bcert:\s*[A-Za-z_$][\w$.]*\.chainPem\b/.test(conteudo);
      if (falaComOFisco && !/\bca:\s*/.test(conteudo)) {
        semCa.push(arquivo.replace(raiz, 'server/src'));
      }
    }

    expect(
      semCa,
      'Estes falam com a SEFAZ sem declarar as autoridades do ICP-Brasil. O '
        + 'Node não conhece a Raiz Brasileira e a conexão morre com "unable to '
        + 'get local issuer certificate".\n' + semCa.join('\n'),
    ).toEqual([]);
  });
});

// ============================================================================

describe('o transporte da SEFAZ apresenta essas autoridades', () => {
  it('o adapter passa as CAs do ICP-Brasil na conexão', async () => {
    const { SefazRealAdapter } = await import('../src/services/core/SefazRealAdapter.js');

    let opcoes: { ca?: string[] } | null = null;
    const adapter = new SefazRealAdapter({
      cert: {
        subject: 'X', issuer: 'Y', cnpj: '11222333000181', serialNumber: '1',
        validFrom: new Date().toISOString(), validTo: new Date(Date.now() + 86400000).toISOString(),
        certPem: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
        chainPem: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
        keyPem: '-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----',
      },
      postSoap: async (input) => {
        opcoes = { ca: input.ca };
        return {
          status: 200,
          body: '<retConsStatServ><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo></retConsStatServ>',
        };
      },
    });

    await adapter.statusServico({ uf: 'RS', environment: 'homologation' });

    /*
      Sem isto, o Node valida o certificado da SEFAZ só contra a lista da
      Mozilla, que não tem a Raiz Brasileira — e a conexão morre com
      "unable to get local issuer certificate", que foi exatamente o que o
      dono leu na tela.
    */
    expect(opcoes).not.toBeNull();
    expect(opcoes!.ca?.length).toBeGreaterThan(0);
    expect(opcoes!.ca!.join('')).toContain('-----BEGIN CERTIFICATE-----');
  });
});
