/**
 * NOME DE VARIÁVEL APOSENTADA NÃO VOLTA AO CÓDIGO DO PRODUTO (GAP-PRD-153).
 *
 * A reauditoria final achou o que o contrato de variáveis não via: a
 * homologação do Asaas ainda mandava o dono "configurar DEVORA_PUBLIC_BASE_URL",
 * que nada lê desde que a DEP a tirou do esquema — e o tipo da tela ainda a
 * listava como origem do endereço. Quem segue a mensagem preenche uma variável
 * sem efeito, que é o sintoma da ficha. `o-contrato-de-variaveis` confere
 * esquema × leitores × exemplos; ele não lê MENSAGEM.
 *
 * Aqui: nenhum nome da lista de variáveis sem efeito da conferência da
 * implantação (`VARIAVEIS_SEM_EFEITO`) aparece no código do produto — servidor
 * e telas, sem os comentários —, fora de quem as nomeia para AVISAR quem as
 * preencheu (QUEM_AVISA, com o motivo de cada arquivo).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VARIAVEIS_SEM_EFEITO } from '../src/services/implantacao/conferenciaDaImplantacao.js';

const RAIZ = resolve(__dirname, '..', '..');
const PASTAS = ['server/src', 'src'];
/**
 * Onde o nome aposentado APARECE DE PROPÓSITO — para avisar quem o preencheu, nunca para
 * ler o valor nem mandar configurá-lo. Arquivo novo aqui precisa de motivo.
 */
const QUEM_AVISA: Record<string, string> = {
  'server/src/services/implantacao/conferenciaDaImplantacao.ts': 'a lista das variáveis sem efeito (VARIAVEIS_SEM_EFEITO)',
  'server/src/services/sync/SyncService.ts': 'NOMES_LEGADOS: avisa que SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY foram renomeadas, sem aceitar o valor',
  'server/src/config/acessoSemSenhaAposentado.ts':
    'as variáveis do acesso sem senha: o boot recusa produção com elas ligadas e avisa fora dela — nunca liga nada',
};

function arquivos(pasta: string): string[] {
  const saida: string[] = [];
  for (const nome of readdirSync(join(RAIZ, pasta))) {
    if (nome === 'node_modules' || nome === '__tests__') continue;
    const caminho = join(RAIZ, pasta, nome);
    if (statSync(caminho).isDirectory()) saida.push(...arquivos(relative(RAIZ, caminho)));
    else if (/\.(ts|tsx)$/.test(nome) && !/\.test\.tsx?$/.test(nome)) saida.push(caminho);
  }
  return saida;
}

/** O código sem os comentários: a história de por que a variável saiu não é uso dela. */
function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('nome de variável aposentada não volta ao produto', () => {
  const fontes = PASTAS.flatMap(arquivos);

  it('a varredura enxerga o produto e a lista — senão ficaria verde lendo nada', () => {
    expect(fontes.length).toBeGreaterThan(500);
    expect(VARIAVEIS_SEM_EFEITO.map(([nome]) => nome)).toContain('DEVORA_PUBLIC_BASE_URL');
  });

  it('nenhum nome da lista de variáveis sem efeito aparece no código, fora da conferência', () => {
    const achados: string[] = [];
    for (const arquivo of fontes) {
      const rel = relative(RAIZ, arquivo).replace(/\\/g, '/');
      if (rel in QUEM_AVISA) continue;
      const codigo = semComentarios(readFileSync(arquivo, 'utf8'));
      for (const [nome] of VARIAVEIS_SEM_EFEITO) {
        if (new RegExp(`\\b${nome}\\b`).test(codigo)) achados.push(`${rel}: ${nome}`);
      }
    }
    expect(achados).toEqual([]);
  });
});
