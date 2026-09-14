/**
 * A PONTE PELA TROCA DE ARQUIVOS — "TEF Discado / Gerenciador Padrão" (GAP-PRD-014).
 *
 * ## O protocolo
 *
 * A automação comercial (este agente) e o gerenciador TEF conversam por
 * arquivos de texto em duas pastas:
 *
 *   REQ/IntPos.001   o pedido, escrito como IntPos.tmp e RENOMEADO (o
 *                    gerenciador nunca lê um arquivo pela metade)
 *   RESP/IntPos.Sts  o recibo do pedido: "peguei a operação N"
 *   RESP/IntPos.001  a resposta: aprovada ou não, NSU, autorização, comprovante
 *
 * Cada linha é `NNN-NNN = valor`. As operações usadas aqui:
 *
 *   ATV  o gerenciador está ativo?                    (só IntPos.Sts)
 *   CRT  cobrança                                     (Sts + resposta)
 *   CNC  cancelamento de uma transação aprovada        (Sts + resposta)
 *   CNF  confirma a transação (depois de registrada)   (só Sts)
 *   NCN  desfaz a transação (não foi registrada)       (só Sts)
 *
 * ## As três regras que fazem o dinheiro bater
 *
 * 1. Sem IntPos.Sts dentro do prazo, o gerenciador NÃO pegou o pedido: o
 *    arquivo de pedido é APAGADO antes de responder "falhou, nada cobrado" —
 *    para ele não ser pego depois, quando ninguém está mais esperando.
 * 2. Com o Sts e sem resposta dentro do prazo, ninguém sabe o que o PinPad
 *    fez: "não confirmada" (`uncertain`), nunca "recusada".
 * 3. Transação aprovada fica PENDENTE no gerenciador até a automação dizer
 *    CNF (registrei) ou NCN (desfaça). Quem decide é o executor do agente,
 *    depois de o servidor aceitar o resultado — não esta ponte.
 *
 * ## Campos lidos na resposta
 *
 *   009-000 status (0 = aprovada)         010-000 rede/adquirente
 *   012-000 NSU                           013-000 autorização
 *   022-000 data DDMMAAAA                 023-000 hora HHMMSS
 *   027-000 finalização (volta no CNF)    030-000 mensagem ao operador
 *   040-000 bandeira/administradora       740-000 cartão mascarado (quando vem)
 *   712/713 via do cliente                714/715 via do estabelecimento
 *   028/029 comprovante único (quando não há as duas vias separadas)
 *
 * A homologação com a TEF house (externa) confere estes campos no
 * gerenciador que o dono contratar; as pastas e os prazos são configuráveis.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DadosDeConfirmacao,
  EtapaDaCobranca,
  PedidoDeCancelamento,
  PedidoDeCobranca,
  PonteTef,
  ResultadoDaPonte,
  SaudeDaPonte,
} from './PonteTef.js';

export interface ConfiguracaoTefDial {
  /** Pasta de pedidos do gerenciador (ex.: C:\TEF_DIAL\REQ). */
  dirReq: string;
  /** Pasta de respostas do gerenciador (ex.: C:\TEF_DIAL\RESP). */
  dirResp: string;
  /** Prazo para o gerenciador acusar o pedido (IntPos.Sts). */
  esperaStatusMs?: number;
  /** Prazo para a resposta da operação, depois do Sts (cliente digitando a senha). */
  esperaRespostaMs?: number;
  /** De quanto em quanto tempo olhar a pasta de respostas. */
  intervaloMs?: number;
  /** O gerenciador instalado cobra PIX pelo PinPad? */
  pix?: boolean;
}

type Campos = Map<string, string>;

const FIM = '999-999';

export function lerCampos(texto: string): Campos {
  const campos: Campos = new Map();
  for (const linha of texto.split(/\r?\n/)) {
    const m = /^(\d{3}-\d{3})\s*=\s*(.*)$/.exec(linha.trim());
    if (!m) continue;
    let valor = m[2];
    // As linhas de comprovante vêm entre aspas: "   VIA CLIENTE   ".
    if (valor.length >= 2 && valor.startsWith('"') && valor.endsWith('"')) valor = valor.slice(1, -1);
    campos.set(m[1], valor);
  }
  return campos;
}

export function escreverCampos(campos: Array<[string, string]>): string {
  const linhas = campos.map(([k, v]) => `${k} = ${v}`);
  if (!campos.some(([k]) => k === FIM)) linhas.push(`${FIM} = 0`);
  return `${linhas.join('\r\n')}\r\n`;
}

/** Junta as linhas NNN-001..NNN-qtd de um comprovante. */
function comprovante(campos: Campos, chaveQtd: string, prefixo: string): string | null {
  const qtd = Number(campos.get(chaveQtd) ?? 0);
  if (!Number.isInteger(qtd) || qtd <= 0) return null;
  const linhas: string[] = [];
  for (let i = 1; i <= qtd; i += 1) linhas.push(campos.get(`${prefixo}-${String(i).padStart(3, '0')}`) ?? '');
  return linhas.join('\n');
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class PonteTefDial implements PonteTef {
  readonly nome = 'tef_dial';
  private readonly cfg: Required<ConfiguracaoTefDial>;
  private sequencia = 0;

  constructor(cfg: ConfiguracaoTefDial) {
    this.cfg = {
      esperaStatusMs: 7000,
      esperaRespostaMs: 170_000,
      intervaloMs: 250,
      pix: false,
      ...cfg,
    };
  }

  /** Identificação numérica (até 10 dígitos) — o gerenciador ecoa em 001-000. */
  novaIdentificacao(): string {
    this.sequencia = (this.sequencia + 1) % 1000;
    const base = Math.floor(Date.now() / 1000) % 10_000_000;
    return `${base}${String(this.sequencia).padStart(3, '0')}`.slice(-10);
  }

  private get arquivoPedido() {
    return join(this.cfg.dirReq, 'IntPos.001');
  }

  private get arquivoStatus() {
    return join(this.cfg.dirResp, 'IntPos.Sts');
  }

  private get arquivoResposta() {
    return join(this.cfg.dirResp, 'IntPos.001');
  }

  private async enviar(campos: Array<[string, string]>): Promise<void> {
    await mkdir(this.cfg.dirReq, { recursive: true });
    // Resposta velha na pasta confundiria a leitura desta operação.
    await rm(this.arquivoStatus, { force: true });
    await rm(this.arquivoResposta, { force: true });
    const tmp = join(this.cfg.dirReq, 'IntPos.tmp');
    await writeFile(tmp, escreverCampos(campos), 'latin1');
    await rename(tmp, this.arquivoPedido);
  }

  /** Espera um arquivo de resposta cuja identificação (001-000) é a nossa. */
  private async esperarArquivo(caminho: string, identificacao: string, prazoMs: number): Promise<Campos | null> {
    const limite = Date.now() + prazoMs;
    while (Date.now() <= limite) {
      if (existsSync(caminho)) {
        try {
          const campos = lerCampos(await readFile(caminho, 'latin1'));
          if (campos.get('001-000') === identificacao && campos.has(FIM)) {
            await rm(caminho, { force: true });
            return campos;
          }
        } catch {
          // o gerenciador ainda está escrevendo: tenta na próxima volta
        }
      }
      await dormir(this.cfg.intervaloMs);
    }
    return null;
  }

  /**
   * Manda o pedido e espera o recibo. Sem recibo, apaga o pedido — o
   * gerenciador não o pegou e não pode pegá-lo depois.
   */
  private async enviarEAcusar(campos: Array<[string, string]>, identificacao: string): Promise<boolean> {
    await this.enviar(campos);
    const sts = await this.esperarArquivo(this.arquivoStatus, identificacao, this.cfg.esperaStatusMs);
    if (!sts) {
      await rm(this.arquivoPedido, { force: true });
      return false;
    }
    return true;
  }

  async saude(): Promise<SaudeDaPonte> {
    const id = this.novaIdentificacao();
    try {
      const ativo = await this.enviarEAcusar([['000-000', 'ATV'], ['001-000', id]], id);
      return {
        tefClient: ativo ? 'ok' : 'unavailable',
        pinpad: null,
        bridge: this.nome,
        message: ativo ? null : 'O gerenciador TEF não respondeu à verificação (ATV). Ele está aberto?',
      };
    } catch (err) {
      return {
        tefClient: 'unavailable',
        pinpad: null,
        bridge: this.nome,
        message: `Pastas do gerenciador TEF inacessíveis: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private resultadoDaResposta(campos: Campos, identificacao: string): ResultadoDaPonte {
    const aprovada = campos.get('009-000') === '0';
    const viaCliente = comprovante(campos, '712-000', '713');
    const viaLoja = comprovante(campos, '714-000', '715');
    const unico = comprovante(campos, '028-000', '029');
    const rede = campos.get('010-000') ?? null;
    const nsu = campos.get('012-000') ?? null;
    const finalizacao = campos.get('027-000') ?? '';
    return {
      status: aprovada ? 'approved' : 'declined',
      message: campos.get('030-000') ?? null,
      nsu,
      authorizationCode: campos.get('013-000') ?? null,
      acquirer: rede,
      cardBrand: campos.get('040-000') ?? null,
      maskedCard: campos.get('740-000') ?? null,
      providerTransactionId: nsu,
      data: campos.get('022-000') ?? null,
      hora: campos.get('023-000') ?? null,
      merchantReceipt: viaLoja ?? unico,
      customerReceipt: viaCliente ?? unico,
      confirmacao: aprovada && rede && nsu ? { rede, nsu, finalizacao, referencia: identificacao } : null,
    };
  }

  async cobrar(pedido: PedidoDeCobranca, aoAndar?: (etapa: EtapaDaCobranca) => void): Promise<ResultadoDaPonte> {
    if (pedido.metodo === 'pix' && !this.cfg.pix) {
      return {
        status: 'failed',
        message: 'PIX pelo PinPad não está habilitado neste agente: o gerenciador TEF instalado não foi configurado para PIX. Nada foi cobrado.',
      };
    }
    const id = pedido.referencia;
    const campos: Array<[string, string]> = [
      ['000-000', 'CRT'],
      ['001-000', id],
      ['002-000', pedido.documento],
      ['003-000', String(pedido.valorEmCentavos)],
      ['004-000', '0'],
    ];
    if (pedido.parcelas > 1) campos.push(['018-000', String(pedido.parcelas)]);
    const acusado = await this.enviarEAcusar(campos, id);
    if (!acusado) {
      return {
        status: 'failed',
        message: 'O gerenciador TEF não pegou a cobrança (sem IntPos.Sts). NADA foi cobrado — confira se ele está aberto.',
      };
    }
    aoAndar?.({ stage: 'awaiting_customer', message: 'Siga as instruções no PinPad.' });
    const resposta = await this.esperarArquivo(this.arquivoResposta, id, this.cfg.esperaRespostaMs);
    if (!resposta) {
      return {
        status: 'uncertain',
        message: 'O gerenciador TEF pegou a cobrança e não respondeu a tempo. Confira no gerenciador antes de cobrar de novo.',
      };
    }
    return this.resultadoDaResposta(resposta, id);
  }

  async cancelar(pedido: PedidoDeCancelamento): Promise<ResultadoDaPonte> {
    if (pedido.valorEmCentavos !== pedido.valorOriginalEmCentavos) {
      return {
        status: 'declined',
        message: 'O cancelamento pelo gerenciador TEF (CNC) desfaz o valor inteiro: estorno parcial não é suportado por este caminho.',
      };
    }
    if (!pedido.rede || !pedido.nsu) {
      return { status: 'declined', message: 'Faltam a rede e o NSU da transação original para cancelar no gerenciador.' };
    }
    const id = pedido.referencia;
    const campos: Array<[string, string]> = [
      ['000-000', 'CNC'],
      ['001-000', id],
      ['003-000', String(pedido.valorEmCentavos)],
      ['010-000', pedido.rede],
      ['012-000', pedido.nsu],
    ];
    if (pedido.data) campos.push(['022-000', pedido.data]);
    if (pedido.hora) campos.push(['023-000', pedido.hora]);
    const acusado = await this.enviarEAcusar(campos, id);
    if (!acusado) {
      return { status: 'failed', message: 'O gerenciador TEF não pegou o cancelamento. Nada foi feito.' };
    }
    const resposta = await this.esperarArquivo(this.arquivoResposta, id, this.cfg.esperaRespostaMs);
    if (!resposta) {
      return { status: 'failed', message: 'O gerenciador TEF não respondeu ao cancelamento a tempo. Confira nele antes de repetir.' };
    }
    return this.resultadoDaResposta(resposta, id);
  }

  /**
   * A troca de arquivos não tem "consulta de transação": quem resolve a
   * pendência é o próprio gerenciador (e o relatório dele). A resposta
   * honesta é "não sei" — a conferência continua com o gestor.
   */
  async consultar(): Promise<ResultadoDaPonte> {
    return {
      status: 'uncertain',
      message: 'O gerenciador TEF (troca de arquivos) não oferece consulta: confira no relatório do gerenciador ou no extrato.',
    };
  }

  private async fechar(operacao: 'CNF' | 'NCN', dados: DadosDeConfirmacao): Promise<void> {
    const id = this.novaIdentificacao();
    const ok = await this.enviarEAcusar(
      [
        ['000-000', operacao],
        ['001-000', id],
        ['010-000', dados.rede],
        ['012-000', dados.nsu],
        ['027-000', dados.finalizacao],
      ],
      id,
    );
    if (!ok) {
      throw new Error(`O gerenciador TEF não acusou o ${operacao} da transação NSU ${dados.nsu}.`);
    }
  }

  confirmar(dados: DadosDeConfirmacao): Promise<void> {
    return this.fechar('CNF', dados);
  }

  desfazer(dados: DadosDeConfirmacao): Promise<void> {
    return this.fechar('NCN', dados);
  }
}
