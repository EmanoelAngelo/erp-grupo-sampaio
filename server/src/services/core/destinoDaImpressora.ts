/**
 * ONDE O AGENTE LOCAL ESCREVE O CUPOM — o mesmo código dos dois lados (GAP-PRD-082).
 *
 * A impressora de agente local mora num computador de caixa. O servidor guarda
 * o endereço dela (`core_printers.agent_device`) e o agente escreve os bytes
 * ESC/POS lá. Os dois lados conferem o endereço com ESTA função: o servidor
 * para recusar o cadastro errado na hora, o agente para nunca escrever num
 * lugar que não seja uma impressora — um endereço vindo do servidor não pode
 * virar "grave estes bytes em C:\Windows\...".
 *
 * Os quatro formatos aceitos cobrem as térmicas do mercado:
 *
 *   tcp:192.168.0.50:9100    impressora de rede (a porta "raw" 9100 é o padrão)
 *   \\CAIXA1\CUPOM           impressora USB compartilhada no Windows (a fila
 *                            "genérica / somente texto" recebe os bytes crus)
 *   COM3                     porta serial (ou USB-serial)
 *   LPT1                     porta paralela
 *
 * Este arquivo não lê banco nem ambiente: é aritmética de texto, importada
 * pelo servidor e pelo programa do agente.
 */

export type TipoDeDestino = 'tcp' | 'compartilhamento' | 'serial' | 'paralela';

export interface DestinoDaImpressora {
  tipo: TipoDeDestino;
  /** O texto original, normalizado (sem espaços nas pontas). */
  endereco: string;
  host?: string;
  porta?: number;
  /** Para compartilhamento, serial e paralela: o caminho que o Windows abre. */
  caminho?: string;
}

const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const PARTE_DE_COMPARTILHAMENTO = /^[^\\/:*?"<>|\r\n]{1,80}$/;

/**
 * Lê o endereço. Devolve `null` (com o motivo) quando não é um dos quatro
 * formatos — e nesse caso ninguém escreve nada.
 */
export function lerDestinoDaImpressora(
  bruto: unknown,
): { ok: true; destino: DestinoDaImpressora } | { ok: false; motivo: string } {
  const endereco = String(bruto ?? '').trim();
  if (!endereco) return { ok: false, motivo: 'Informe o endereço da impressora no computador do caixa.' };

  const tcp = /^tcp:([^:]+):(\d{1,5})$/i.exec(endereco);
  if (tcp) {
    const porta = Number(tcp[2]);
    if (!HOST.test(tcp[1]) || porta < 1 || porta > 65535) {
      return { ok: false, motivo: 'Endereço de rede inválido. Use tcp:IP:porta, por exemplo tcp:192.168.0.50:9100.' };
    }
    return { ok: true, destino: { tipo: 'tcp', endereco: `tcp:${tcp[1]}:${porta}`, host: tcp[1], porta } };
  }

  const serial = /^COM([1-9]\d?)$/i.exec(endereco);
  if (serial) {
    const nome = `COM${serial[1]}`;
    return { ok: true, destino: { tipo: 'serial', endereco: nome, caminho: `\\\\.\\${nome}` } };
  }
  const paralela = /^LPT([1-9])$/i.exec(endereco);
  if (paralela) {
    const nome = `LPT${paralela[1]}`;
    return { ok: true, destino: { tipo: 'paralela', endereco: nome, caminho: `\\\\.\\${nome}` } };
  }

  // \\computador\compartilhamento — exatamente dois nomes, nada de subpasta.
  if (endereco.startsWith('\\\\')) {
    const partes = endereco.slice(2).split('\\');
    if (
      partes.length === 2
      && HOST.test(partes[0])
      && PARTE_DE_COMPARTILHAMENTO.test(partes[1])
      && partes[1] !== '.'
      && partes[1] !== '..'
    ) {
      return { ok: true, destino: { tipo: 'compartilhamento', endereco, caminho: endereco } };
    }
  }

  return {
    ok: false,
    motivo:
      'Endereço de impressora não reconhecido. Use tcp:IP:porta (impressora de rede), '
      + '\\\\COMPUTADOR\\IMPRESSORA (compartilhada no Windows), COM3 (serial) ou LPT1 (paralela).',
  };
}
