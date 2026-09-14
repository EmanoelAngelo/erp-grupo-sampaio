/**
 * O `secret:scan` RECUSA ARQUIVO RASTREADO COM A VARIÁVEL DO ATALHO LIGADA.
 *
 * O acesso sem senha saiu do sistema, e as três variáveis que o ligavam
 * (`DEVORA_DEV_QUICK_LOGIN`, `VITE_DEV_QUICK_LOGIN`, `GRUPO_SAMPAIO_QUICK_LOGIN`)
 * ficaram aposentadas: em produção a API recusa subir com qualquer uma ligada.
 * Falta a outra ponta: um arquivo DO REPOSITÓRIO que as escreva ligadas — um
 * exemplo de `.env`, um compose, um Dockerfile — é o caminho para alguém
 * copiar a linha para a loja. A varredura roda no CI e antes de todo commit.
 *
 * Diferente dos segredos, esta regra lê também os `*.example` (é deles que se
 * copia). Fica de fora o registro histórico da auditoria (`docs/audits/`), que
 * cita a linha ligada para contar o que foi achado — e os testes, que ligam a
 * variável justamente para provar que ela não abre nada.
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

const { achadosNoArquivo, varrerRastreados } = await import('../src/scripts/varredura-de-segredos.js');

const LIGADAS: Array<[string, string]> = [
  ['.env.production.example', 'DEVORA_DEV_QUICK_LOGIN=true\n'],
  ['.env.example', '# atalho\nVITE_DEV_QUICK_LOGIN=true\n'],
  ['.env.staging.example', 'GRUPO_SAMPAIO_QUICK_LOGIN = 1\n'],
  ['docker-compose.yml', "services:\n  api:\n    environment:\n      DEVORA_DEV_QUICK_LOGIN: 'true'\n"],
  ['docker-compose.staging.yml', '    environment:\n      - VITE_DEV_QUICK_LOGIN=TRUE\n'],
  ['Dockerfile', 'ENV DEVORA_DEV_QUICK_LOGIN=true\n'],
  ['deploy/linux/loja.env', 'DEVORA_DEV_QUICK_LOGIN=sim\n'],
  ['scripts/sobe.mjs', "const env = { DEVORA_DEV_QUICK_LOGIN: 'true' };\n"],
  ['README.md', 'Para entrar sem senha: `DEVORA_DEV_QUICK_LOGIN=true`.\n'],
  /*
    OS ARQUIVOS QUE LEVAM A CONFIGURAÇÃO ATÉ A LOJA — e que a regra não abria.

    A varredura só lia `.ts/.json/.env/.md/.yml/.example` e o `Dockerfile`
    exato. Ficavam de fora justamente os que sobem o serviço: a unit do
    systemd, o instalador do Windows, script de shell/cmd, variante de
    Dockerfile — e o `.env.production`/`.env.staging`, que o `.gitignore` NÃO
    ignora (só `.env`, `.env.local`, `.env.*.local`) e é o nome natural de
    quem copia o `.env.production.example`.
  */
  ['.env.production', 'DEVORA_API_ENV=production\nDEVORA_DEV_QUICK_LOGIN=true\n'],
  ['.env.staging', 'VITE_DEV_QUICK_LOGIN=true\n'],
  ['deploy/linux/grupo-sampaio-api.service', '[Service]\nEnvironment=DEVORA_DEV_QUICK_LOGIN=true\n'],
  ['deploy/windows/instalar-servico.ps1', "$env:DEVORA_DEV_QUICK_LOGIN = 'true'\n"],
  ['deploy/windows/sobe.cmd', 'set DEVORA_DEV_QUICK_LOGIN=true\r\n'],
  ['scripts/sobe.sh', 'export GRUPO_SAMPAIO_QUICK_LOGIN=1\n'],
  ['Dockerfile.prod', 'ENV DEVORA_DEV_QUICK_LOGIN=true\n'],
  ['.env.example', 'DEVORA_DEV_QUICK_LOGIN=true   # para entrar rapido\n'],
];

describe('a regra do acesso sem senha', () => {
  for (const [arquivo, texto] of LIGADAS) {
    it(`recusa ${arquivo} com a variável ligada`, () => {
      expect(achadosNoArquivo(arquivo, texto).join(' ')).toMatch(/acesso sem senha/i);
    });
  }

  it('desligada (`false`) não é achado — o que se recusa é a porta ligada', () => {
    expect(achadosNoArquivo('.env.production.example', 'DEVORA_DEV_QUICK_LOGIN=false\n')).toEqual([]);
    expect(achadosNoArquivo('docker-compose.yml', "      DEVORA_DEV_QUICK_LOGIN: 'false'\n")).toEqual([]);
  });

  it('o registro da auditoria conta o que achou sem virar achado', () => {
    expect(
      achadosNoArquivo('docs/audits/DEVORA-PRODUCTION-READINESS-AUDIT-FINAL.md', 'o .env tinha DEVORA_DEV_QUICK_LOGIN=true\n'),
    ).toEqual([]);
  });

  it('os testes ligam a variável para provar que ela não abre nada — não são achado', () => {
    expect(achadosNoArquivo('server/tests/qualquer.test.ts', "process.env.DEVORA_DEV_QUICK_LOGIN = 'true';\n")).toEqual([]);
    expect(achadosNoArquivo('src/pages/gs/__tests__/x.test.tsx', "vi.stubEnv('VITE_DEV_QUICK_LOGIN', 'true')\n")).toEqual([]);
  });

  it('as regras antigas continuam de pé (segredo no compose)', () => {
    expect(achadosNoArquivo('docker-compose.yml', '      DEVORA_JWT_SECRET: um-segredo-escrito\n')).not.toEqual([]);
  });
});

describe('o repositório de hoje', () => {
  it('nenhum arquivo rastreado liga o acesso sem senha, nem tem segredo escrito', () => {
    const raiz = resolve(__dirname, '..', '..');
    const { conferidos, achados } = varrerRastreados(raiz);
    // Guarda contra varredura que lê nada e fica verde.
    expect(conferidos).toBeGreaterThan(500);
    expect(achados).toEqual([]);
  });
});
