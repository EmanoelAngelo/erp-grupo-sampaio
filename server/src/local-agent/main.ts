/**
 * devora-agente — o programa do computador do caixa (GAP-PRD-014, GAP-PRD-082).
 *
 *   node dist/local-agent/main.js parear --servidor https://erp.loja.com.br/api/v1 --codigo A1B2C3D4 \
 *        [--config devora-agente.json] [--req C:\TEF_DIAL\REQ] [--resp C:\TEF_DIAL\RESP] [--pix] [--sem-tef]
 *   node dist/local-agent/main.js saude  [--config devora-agente.json]
 *   node dist/local-agent/main.js rodar  [--config devora-agente.json]
 *
 * `parear` troca o código gerado em Configurações › Maquininhas pelo segredo
 * do agente e grava a configuração (arquivo só do usuário que roda o agente).
 * `--sem-tef` pareia um agente que só IMPRIME (caixa com térmica e sem PinPad
 * integrado).
 *
 * `rodar` fica no ar com duas filas ao mesmo tempo: os comandos do PinPad
 * (sinal a cada 30 s e retirada em long-poll) e os cupons da impressora de
 * agente deste caixa — cadastrada em Configurações › Impressoras, com o
 * endereço dela neste computador (tcp:IP:9100, \\PC\IMPRESSORA, COM3, LPT1).
 * Para rodar como serviço do Windows, use o gerenciador de serviços da loja
 * (NSSM, Agendador de Tarefas "ao iniciar") apontando para `rodar`.
 */
import { hostname } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClienteDoServidor, parearComOServidor } from './ClienteDoServidor.js';
import { ExecutorDoAgente, armazemEmArquivo } from './ExecutorDoAgente.js';
import { ImpressorDoAgente } from './ImpressorDoAgente.js';
import type { PonteTef } from './PonteTef.js';
import { PonteSemTef } from './PonteSemTef.js';
import { PonteTefDial, type ConfiguracaoTefDial } from './PonteTefDial.js';

export const VERSAO_DO_AGENTE = '1.1.0';

export interface ConfiguracaoDoAgente {
  servidor: string;
  agentId: string;
  segredo: string;
  pdvTerminalId: string | null;
  /** `nenhuma`: o agente só imprime (pareado com `--sem-tef`). */
  ponte: ({ tipo: 'tef_dial' } & ConfiguracaoTefDial) | { tipo: 'nenhuma' };
  arquivoDeEstado: string;
}

export function lerArgumentos(argv: string[]): { comando: string; opcoes: Record<string, string | true> } {
  const [comando = 'ajuda', ...resto] = argv;
  const opcoes: Record<string, string | true> = {};
  for (let i = 0; i < resto.length; i += 1) {
    const a = resto[i];
    if (!a.startsWith('--')) continue;
    const chave = a.slice(2);
    const prox = resto[i + 1];
    if (prox === undefined || prox.startsWith('--')) opcoes[chave] = true;
    else {
      opcoes[chave] = prox;
      i += 1;
    }
  }
  return { comando, opcoes };
}

function texto(v: string | true | undefined, padrao: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : padrao;
}

export function lerConfiguracao(caminho: string): ConfiguracaoDoAgente {
  if (!existsSync(caminho)) {
    throw new Error(`Configuração não encontrada em ${caminho}. Rode "parear" primeiro.`);
  }
  return JSON.parse(readFileSync(caminho, 'utf8')) as ConfiguracaoDoAgente;
}

/** A configuração gravada depois do pareamento — sem rede, para o teste conferir. */
export function configuracaoDoPareamento(
  opcoes: Record<string, string | true>,
  par: { agentId: string; segredo: string; pdvTerminalId: string | null },
  caminho: string,
): ConfiguracaoDoAgente {
  return {
    servidor: texto(opcoes.servidor, ''),
    agentId: par.agentId,
    segredo: par.segredo,
    pdvTerminalId: par.pdvTerminalId,
    ponte:
      opcoes['sem-tef'] === true
        ? { tipo: 'nenhuma' }
        : {
            tipo: 'tef_dial',
            dirReq: texto(opcoes.req, 'C:\\TEF_DIAL\\REQ'),
            dirResp: texto(opcoes.resp, 'C:\\TEF_DIAL\\RESP'),
            pix: opcoes.pix === true,
          },
    arquivoDeEstado: `${caminho}.estado`,
  };
}

export async function parear(opcoes: Record<string, string | true>): Promise<ConfiguracaoDoAgente> {
  const servidor = texto(opcoes.servidor, '');
  const codigo = texto(opcoes.codigo, '');
  if (!servidor || !codigo) throw new Error('Informe --servidor <url da API> e --codigo <código de pareamento>.');
  const caminho = resolve(texto(opcoes.config, 'devora-agente.json'));
  const par = await parearComOServidor(servidor, codigo, { version: VERSAO_DO_AGENTE, hostname: hostname() });
  const config = configuracaoDoPareamento(opcoes, par, caminho);
  // O segredo não sai deste arquivo: permissão só do dono (onde o SO respeita).
  writeFileSync(caminho, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  return config;
}

function montar(config: ConfiguracaoDoAgente) {
  const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
  const cliente = new ClienteDoServidor({ servidor: config.servidor, agentId: config.agentId, segredo: config.segredo });
  const ponte: PonteTef = config.ponte.tipo === 'nenhuma' ? new PonteSemTef() : new PonteTefDial(config.ponte);
  const executor = new ExecutorDoAgente(cliente, ponte, {
    estado: armazemEmArquivo(config.arquivoDeEstado),
    versao: VERSAO_DO_AGENTE,
    hostname: hostname(),
    log,
  });
  const impressor = new ImpressorDoAgente(cliente, { log });
  return { cliente, ponte, executor, impressor };
}

async function principal(argv: string[]): Promise<number> {
  const { comando, opcoes } = lerArgumentos(argv);
  if (comando === 'parear') {
    const config = await parear(opcoes);
    console.log(`Agente pareado (${config.agentId}). Configuração gravada. Agora rode: node dist/local-agent/main.js rodar`);
    return 0;
  }
  const config = lerConfiguracao(resolve(texto(opcoes.config, 'devora-agente.json')));
  const { executor, impressor, ponte } = montar(config);
  if (comando === 'saude') {
    const s = await ponte.saude();
    console.log(JSON.stringify(s));
    await executor.sinal();
    // O agente que só imprime não tem gerenciador TEF para estar "ok".
    return s.tefClient === 'ok' || config.ponte.tipo === 'nenhuma' ? 0 : 2;
  }
  if (comando === 'rodar') {
    const controle = new AbortController();
    process.on('SIGINT', () => controle.abort());
    process.on('SIGTERM', () => controle.abort());
    console.log(`devora-agente ${VERSAO_DO_AGENTE} no ar — ${config.servidor}`);
    // O PinPad e a impressora andam juntos: um cupom não espera uma cobrança.
    await Promise.all([executor.rodar(controle.signal), impressor.rodar(controle.signal)]);
    return 0;
  }
  console.log('Uso: main.js parear --servidor <url> --codigo <código> [--sem-tef] | saude | rodar  [--config arquivo]');
  return comando === 'ajuda' ? 0 : 1;
}

// Só roda quando chamado direto (`node main.js ...`); importado pelo teste, não.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal(process.argv.slice(2))
    .then((codigo) => process.exit(codigo))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
