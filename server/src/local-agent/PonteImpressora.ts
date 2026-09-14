/**
 * A PONTE COM A IMPRESSORA TÉRMICA (GAP-PRD-082).
 *
 * O servidor entrega o cupom já em ESC/POS; aqui ele vira bytes na porta da
 * impressora. Quatro caminhos, os que as térmicas do mercado oferecem:
 *
 *   tcp:IP:porta      socket cru (a porta 9100 das impressoras de rede);
 *   \\PC\IMPRESSORA   a fila compartilhada do Windows (driver "genérico /
 *                     somente texto" recebe os bytes sem mexer);
 *   COMn / LPTn       porta serial ou paralela, aberta como dispositivo.
 *
 * O endereço é conferido DE NOVO aqui (`lerDestinoDaImpressora`, o mesmo
 * código do servidor): o agente nunca escreve num caminho que não seja uma
 * impressora, venha o endereço de onde vier.
 *
 * O `EscritorDeImpressora` é injetável para o teste escrever num dublê.
 */
import { connect } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { lerDestinoDaImpressora, type DestinoDaImpressora } from '../services/core/destinoDaImpressora.js';

export interface EscritorDeImpressora {
  escrever(destino: DestinoDaImpressora, bytes: Uint8Array): Promise<void>;
}

/** Escreve pelo socket e só resolve quando a impressora recebeu tudo. */
export function escreverPorTcp(host: string, porta: number, bytes: Uint8Array, prazoMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: porta });
    let terminou = false;
    const acabar = (erro?: Error) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(relogio);
      if (erro) {
        socket.destroy();
        reject(erro);
      } else resolve();
    };
    const relogio = setTimeout(
      () => acabar(new Error(`A impressora em ${host}:${porta} não respondeu em ${Math.round(prazoMs / 1000)} s.`)),
      prazoMs,
    );
    socket.once('error', (err) =>
      acabar(new Error(`Não foi possível falar com a impressora em ${host}:${porta}: ${err.message}`)),
    );
    socket.once('connect', () => {
      socket.end(Buffer.from(bytes), () => acabar());
    });
  });
}

export const escritorDoSistema: EscritorDeImpressora = {
  async escrever(destino, bytes) {
    if (destino.tipo === 'tcp') {
      await escreverPorTcp(String(destino.host), Number(destino.porta), bytes);
      return;
    }
    // Compartilhamento, serial e paralela: o Windows abre como arquivo de dispositivo.
    await writeFile(String(destino.caminho), Buffer.from(bytes));
  },
};

/** Confere o endereço e escreve. Endereço fora dos quatro formatos: erro, nada escrito. */
export async function imprimirNoDestino(
  endereco: string,
  bytes: Uint8Array,
  escritor: EscritorDeImpressora = escritorDoSistema,
): Promise<void> {
  const lido = lerDestinoDaImpressora(endereco);
  if (!lido.ok) throw new Error(lido.motivo);
  await escritor.escrever(lido.destino, bytes);
}
